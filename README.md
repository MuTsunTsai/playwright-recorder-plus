# playwright-recorder-plus

[![npm version](https://img.shields.io/npm/v/playwright-recorder-plus.svg)](https://www.npmjs.com/package/playwright-recorder-plus)
[![license](https://img.shields.io/npm/l/playwright-recorder-plus.svg)](https://github.com/MuTsunTsai/playwright-recorder-plus/blob/main/LICENSE)
[![playwright peer](https://img.shields.io/badge/playwright-%E2%89%A51.59-brightgreen.svg)](https://playwright.dev/)

A higher-quality, configurable alternative to Playwright's built-in `recordVideo`. High quality video, pause/resume, crop, multi-page contexts, and inline audio scheduling.

## Why

Playwright's `recordVideo` produces visibly compressed VP8 webm with mosquito noise around glyph edges. The ffmpeg arguments are hardcoded to a low-bitrate realtime preset -- fine for CI test artifacts, painful for tutorial recordings, demo videos, and bug reproductions.

The maintainers have repeatedly declined to expose tuning options ([#8683](https://github.com/microsoft/playwright/issues/8683), [#12056](https://github.com/microsoft/playwright/issues/12056), [#17217](https://github.com/microsoft/playwright/issues/17217), [#31424](https://github.com/microsoft/playwright/issues/31424)) on the grounds that ffmpeg is an internal implementation detail. This package wraps Playwright 1.59+'s public `page.screencast` API, pipes the raw JPEG frames into a separately-shipped ffmpeg, and gives you back full control over the encoder.

What you get on top of `recordVideo`:

- **Two-pass pipeline by default** -- first pass is always H.264 `ultrafast` so the encoder cannot fall behind realtime; second pass transcodes to your chosen codec/container and muxes any scheduled audio. You get small, sharp files without sacrificing capture fidelity.
- **Built-in presets** -- `youtube` (H.264 / mp4) and `web` (VP9 / webm) cover the common targets. Auto-picked from the output extension; override with `preset` or fully customise via `ffmpegArgs`.
- **Configurable encoder** -- swap to x265, AV1, or any ffmpeg invocation through `ffmpegArgs`.
- **`pause()` / `resume()`** -- skip recording during long setup or build phases without producing a separate file.
- **`autoStart: false`** -- defer recording until your page is actually presentable (useful for SPA / WASM warm-up).
- **`crop`** -- record a sub-region; compatible with `Locator.boundingBox()` for element-level capture.
- **Multi-page contexts** -- `attachRecorderForContext()` auto-attaches popups and `target=_blank` pages.
- **Inline audio scheduling** -- `recorder.audio(path, { offset })` schedules clips at wall-clock offsets; ffmpeg muxes them into the second pass.

## Compared to Playwright's built-in `recordVideo`

|                              | Playwright `recordVideo`           | playwright-recorder-plus                                   |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| Codec                        | ⚠️ VP8 only (hardcoded)            | ✅ H.264 / VP9 / anything you can pass to ffmpeg           |
| Container                    | ⚠️ webm only                       | ✅ mp4, webm, ogg, mov, ...                                |
| Bitrate / quality control    | ❌ hardcoded 1 Mbps realtime       | ✅ `preset` (`youtube` / `web`) or full `ffmpegArgs` override |
| Pause / resume               | ❌                                 | ✅ `pause()` / `resume()`                                  |
| Defer recording start        | ❌                                 | ✅ `autoStart: false` + `start()`                          |
| Crop to sub-region / element | ❌                                 | ✅ `crop` option, `Locator.boundingBox()`-compatible       |
| Audio mux                    | ❌                                 | ✅ `recorder.audio(path, { offset })`                       |
| Wall-clock-faithful timing   | ⚠️ varies; first-frame anchored    | ✅ `start()`-anchored, with same-slot dedup and tail padding |
| ffmpeg build                 | ⚠️ libvpx-VP8-only build           | ✅ `ffmpeg-static` (full encoder set)                      |

## Install

```sh
pnpm add -D playwright-recorder-plus
# or
npm install --save-dev playwright-recorder-plus
```

The package depends on [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static), which downloads a platform-specific ffmpeg binary on install (~50 MB). No system ffmpeg required.

Requires Node `>= 18` and Playwright `>= 1.59.0`.

## Quick start

```ts
import { chromium } from "playwright";
import { attachRecorder } from "playwright-recorder-plus";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

// Attach our recorder
const recorder = await attachRecorder(page, { path: "out.mp4" });
try {
	await page.goto("https://example.com");
	// ... interactions ...
} finally {
	await recorder.stop();    // ends recording (returns fast)
	await context.close();    // browser cleanup happens while the second pass runs in the background
	await browser.close();
	await recorder.finalized; // wait for the final file to land
}
```

The output extension picks the second-pass codec automatically: `.mp4` -> H.264, `.webm` -> VP9. Override with `preset: "youtube" | "web"` or supply your own `ffmpegArgs` for the second pass.

## How the two-pass pipeline works

```
              attachRecorder()
                      |
                      v
    page.screencast.start({ onFrame })
                      |
                      v
+--------------------------------------------+
|  Pass 1 (always running, can't be tuned)   |
|  - libx264 -preset ultrafast -crf 18       |
|  - writes <path>.intermediate.mp4          |
|  - cannot fall behind realtime             |
+--------------------------------------------+
                      |
             recorder.stop()  <-- "recording stopped" verb
                      |        returns once pass 1 has flushed
                      v
+--------------------------------------------+
|  Pass 2 (background, awaits via finalized) |
|  - chosen by `preset` / `ffmpegArgs`       |
|  - mux scheduled audio() clips             |
|  - on success: deletes intermediate        |
|  - on failure: keeps intermediate so the   |
|    capture isn't lost                      |
+--------------------------------------------+
                      |
                      v
           await recorder.finalized
                      |
                      v
              final file on disk
```

> Why a fixed first pass? Encoding speed must stay above realtime. If ffmpeg falls behind, stdin backpressure stalls the Node-side `onFrame` callback, which delays the wall-clock anchored timeline that ingestion uses to assign frame numbers. The result is a video shorter than reality. Pinning the first pass to H.264 ultrafast removes this whole class of bug and makes capture fidelity independent of how slow your final-format encode is.

## API

### `attachRecorder(page, options)`

Attach a recorder to a single `Page`. Returns a `Recorder` controller.

```ts
interface RecorderOptions {
	// Final output file. Container is determined by extension.
	path: string;

	// Default: true. When false, the recorder waits until you call `recorder.start()`.
	autoStart?: boolean;

	// Frame size. Default: page.viewportSize().
	size?: { width: number; height: number };

	// Constant output frame rate. Default: 25.
	fps?: number;

	// JPEG quality of the screencast frames before re-encoding. Default: 100.
	jpegQuality?: number;

	// Crop the recording to a sub-region. Compatible with Locator.boundingBox().
	crop?: { x: number; y: number; width: number; height: number };

	// Built-in second-pass preset. Auto-detected from the path extension
	// when omitted: .mp4 -> "youtube", .webm/.ogg/.ogv -> "web".
	// Mutually exclusive with `ffmpegArgs`.
	preset?: "youtube" | "web";

	// Replace the second-pass argv tail (codec / filter / container flags).
	// First-pass args are NOT user-configurable -- see "How the two-pass
	// pipeline works" above. Mutually exclusive with `preset`.
	ffmpegArgs?: string[];

	// Where the H.264 ultrafast intermediate file is written.
	// Default: `<path-without-ext>.intermediate.mp4` next to `path`.
	// Kept on disk if the second pass fails.
	intermediatePath?: string;

	// Override the ffmpeg binary path. Default: the one shipped by ffmpeg-static.
	ffmpegPath?: string;

	// Suppress runtime warnings about misuse (e.g. pause() before start()). Default: false.
	silenceWarnings?: boolean;
}

interface Recorder {
	readonly frameCount: number;

	// Resolves once the second pass + audio mux is complete and the final
	// file is on disk. Rejects on second-pass failure (the intermediate
	// is preserved at `options.intermediatePath` so the capture isn't lost).
	readonly finalized: Promise<StopResult>;

	start(): Promise<void>;
	pause(): Promise<void>;
	resume(): Promise<void>;
	// Ends recording. Returns once the first-pass capture has flushed.
	// Does NOT wait for the second pass -- await `finalized` for that.
	stop(): Promise<StopResult>;

	// Schedule an audio file to be muxed at a chosen point on the video
	// timeline. With no `offset`, the clip is anchored to "now" (wall-clock
	// elapsed since `start()`). With `offset` only, the clip plays
	// `offset` seconds after "now". With `absolute: true`, `offset` is an
	// absolute video timestamp from t=0.
	audio(path: string, options?: { offset?: number; absolute?: boolean }): void;
}
```

## Lifecycle

By default (`autoStart: true`) recording begins as soon as `attachRecorder()` resolves -- the simplest usage is `try { ... } finally { await rec.stop() }`. Pass `autoStart: false` to defer until you call `rec.start()` yourself.

`pause()` and `resume()` are inverses; calling either at the wrong time is a no-op (with a `console.warn` you can suppress via `silenceWarnings`). `stop()` is a control verb -- it ends recording and returns once the first pass has flushed; the second pass runs in the background. Await `recorder.finalized` to block until the final file is on disk.

Calls that don't make sense -- `pause()` before `start()`, anything after `stop()` -- are no-ops with a warning, so a defensive `await rec.stop()` in a `finally` block is always safe.

If `autoStart: false` was set and `start()` was never called, `stop()` produces no file at all (the result has `written: false`). This is intentional and supports conditional recording: always call `rec.stop()` in `finally`, and only call `rec.start()` when you actually want a recording.

### `attachRecorderForContext(context, options)`

Attach recorders to **every** `Page` in a `BrowserContext`, including pages opened later (popups, `target=_blank`).

```ts
import { attachRecorderForContext } from "playwright-recorder-plus";

const recorders = await attachRecorderForContext(context, {
	pathTemplate: "videos/page-{index}.mp4",
});
try {
	await page.goto("https://opens-popup.example");
	// popup pages are auto-attached as they appear
} finally {
	const results = await recorders.stopAll();
	console.log(`recorded ${results.length} pages`);
}
```

`{index}` in `pathTemplate` is replaced with a 0-based per-page counter. All other options pass through unchanged.

`stopAll()` waits for every recorder's `stop()` to flush. To wait for all final files to land on disk, additionally `await Promise.all(recorders.recorders.map(r => r.finalized))`.

### Pause / resume

Skip recording during long setup or build steps without producing a separate file:

```ts
const rec = await attachRecorder(page, { path: "tutorial.mp4" });
await page.click("#start");
await rec.pause();
// 60 seconds of build output omitted from final video
await waitForBuildToComplete();
await rec.resume();
await page.click("#finish");
await rec.stop();
await rec.finalized;
```

The output appears as one continuous video with the paused interval simply absent.

### Manual start (skip startup)

For tutorial recordings where the page takes time to become "presentable" (heavy SPA bundle, Pyodide / WASM load, etc.), use `autoStart: false`:

```ts
const rec = await attachRecorder(page, { path: "demo.mp4", autoStart: false });
await page.goto(url);
await page.waitForLoadState("networkidle");
await waitForAppReady(page);
await rec.start();           // recording begins here
await runDemoSteps(page);
await rec.stop();
await rec.finalized;
```

## Cropping

```ts
const rec = await attachRecorder(page, {
	path: "panel.mp4",
	crop: { x: 100, y: 50, width: 800, height: 600 },
});
```

Coordinates are in viewport CSS pixels. The shape matches what `Locator.boundingBox()` returns, so cropping to a specific element is one line:

```ts
const box = await page.locator("#main-panel").boundingBox();
if (box) {
	const rec = await attachRecorder(page, { path: "panel.mp4", crop: box });
	// ...
}
```

## Audio mux

The recorder does **not** capture audio that the page itself plays -- see [Page audio is not captured](#page-audio-is-not-captured) below. Instead, you schedule audio inline as you drive the page; the second pass muxes it in:

```ts
const rec = await attachRecorder(page, { path: "tutorial.mp4" });

await page.click("#step-1");
rec.audio("step-1-narration.mp3");   // plays from this exact moment

await page.waitForSelector(".step-1-done");
await page.click("#step-2");
rec.audio("step-2-narration.mp3");

// Schedule a click sound 0.8 s in the future (e.g. for an animation
// that hasn't fired yet but you know its timing):
rec.audio("click.wav", { offset: 0.8 });

// Schedule at an absolute video timestamp (escape hatch):
rec.audio("intro.mp3", { offset: 0, absolute: true });

await rec.stop();
await rec.finalized;
```

`audio()` resolves the timeline position from `recorder.start()` using wall-clock elapsed (`performance.now() - startTime - pausedAccum`). It stays accurate across `pause()` / `resume()` -- paused intervals don't advance the clock. Calling `audio()` with no `offset` while paused logs a warning, since the resolved position is the moment you paused (rarely intended).

Multiple `audio()` calls accumulate; ffmpeg combines them with `amix` during the second pass. If two scheduled tracks overlap on the timeline, ffmpeg averages them -- effectively ducking each. Choose call timings that don't overlap if you want each clip at full volume.

If `stop()` is called without any recording having taken place (autoStart off, never called `start()`), the scheduled audio is discarded along with the empty capture.

## Presets and custom encoder

The second pass picks defaults from the output extension:

| Output extension       | Default preset | Codec / container |
| ---------------------- | -------------- | ----------------- |
| `.mp4` (or anything else not below) | `youtube` | H.264 main profile, AAC, +faststart |
| `.webm`, `.ogg`, `.ogv`             | `web`     | VP9 CRF 30, Opus  |

Override the choice explicitly:

```ts
await attachRecorder(page, { path: "out.webm", preset: "web" });
```

For full control, supply `ffmpegArgs` for the second pass. The argv tail goes between `-i <intermediate>` and the output path -- do not include `-i`, `-y`, or the output path; the recorder adds those:

```ts
// AV1 via libsvtav1
await attachRecorder(page, {
	path: "out.mp4",
	ffmpegArgs: [
		"-c:v", "libsvtav1",
		"-preset", "8",
		"-crf", "30",
		"-pix_fmt", "yuv420p",
		"-movflags", "+faststart",
	],
});
```

`preset` and `ffmpegArgs` are mutually exclusive; passing both throws.

The first pass is fixed at H.264 `ultrafast` and is not user-configurable, so capture fidelity is independent of whatever the second pass costs.

## Limitations

### Page audio is not captured

Like Playwright's built-in `recordVideo`, this package captures video frames only. CDP has no audio stream to attach to. If your page plays audio you want in the final file, you have two options:

1. **Schedule audio externally** -- drive your own audio files (TTS narration, voice-over, sound effects) via `recorder.audio(path)`. This is the typical tutorial-recording workflow and is what `recorder.audio()` is designed for.
2. **Capture page audio yourself** -- inject `getDisplayMedia({ audio: true })` plus `MediaRecorder` into the page, ship the encoded chunks back to Node via `page.exposeBinding`, and pass the resulting webm/mp3 to `recorder.audio()`. Out of scope for this package; see Chrome's [tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) docs for the underlying mechanism.

### Attach order matters

`attachRecorder` calls `page.screencast.start()` internally. Playwright's screencast server **locks the frame size to the first client's request**. If `context.tracing.start({ screenshots: true })` (or any other screencast consumer) starts before the recorder, the recorder gets a downscaled 800×450 stream regardless of what `size` it asked for.

The recorder verifies dimensions on the first frame and **throws** if the server delivered something other than the requested size. If you see this error, move `attachRecorder` ahead of any `tracing.start` call.

### Frame rate

CDP screencast is variable rate -- idle pages don't emit frames. The recorder converts this to a constant-rate stream: each incoming frame is assigned `frameNumber = floor((nowMs - startMs) * fps / 1000)`, gaps are filled with copies of the previous frame, and `stop()` pads up to wall-clock now so the file covers the full recording duration even if the last few seconds were idle.

If the page is still visually static when `start()` is called (typical for SPAs warming up Pyodide / WASM), CDP may not deliver its first frame for several seconds. The recorder back-fills those leading slots with the first frame it eventually receives -- so the encoded video starts at wall-clock t = 0, not t = first-frame-arrival.

### Encoder must keep up with realtime

The first pass is always H.264 `ultrafast` for exactly this reason -- it runs comfortably above realtime on modern CPUs. The second pass can be slower without skewing the timeline because it reads from a finished file rather than a live frame pipe.

If you replace the second pass via `ffmpegArgs` with something extreme (libsvtav1 at preset 0, libaom-av1 at cpu-used 0, etc.), `stop()` still returns fast but `await recorder.finalized` may take a long time. That's the expected trade-off and is not a fidelity issue.

### Cross-browser

Tested against Chromium, Firefox, and WebKit. `page.screencast` is implemented uniformly across all three since Playwright 1.59, and the smoke tests in `test/smoke.spec.ts` exercise each browser in CI.

### License of the bundled ffmpeg

`ffmpeg-static` ships a GPL ffmpeg build. Calling it via `child_process` (which this package does) does not propagate the GPL into your project. See [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static#license) for the full discussion.

## License

MIT
