# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3]

### Fixed

- Fixed [#2](https://github.com/MuTsunTsai/playwright-recorder-plus/issues/2): when the page changed during a `pause()` window, the post-`resume()` part of the recording would back-fill with the *pre-pause* frame until CDP delivered another frame -- so a "click → pause through loading → resume on the new screen" sequence would show the old screen for several seconds after resume. `resume()` now refreshes the back-fill baseline the same way `start()` does, so the post-resume static window reflects the actual page state at resume time.

## [0.1.2] - 2026-05-04

### Fixed

- Fixed [#1](https://github.com/MuTsunTsai/playwright-recorder-plus/issues/1): when `attachRecorder` ran before the page produced its content (e.g. the recorder was attached before `page.goto()` and the user then waited for `networkidle` before calling `recorder.start()`), CDP would deliver no frames between `start()` and the next page change, and the encoder back-filled the static window with the *first post-change* CDP frame. On a "static page → click → next page" sequence the first seconds of the recording therefore showed the page state from *after* the click, not before. `start()` / `autoStart` now fires off a `page.screenshot({ type: "jpeg", scale: "css" })` baseline that's used to back-fill the pre-first-CDP-frame slots, so the recording opens on the actual t=0 page state. (`scale: "css"` is required to match the screencast frame size on browsers with `deviceScaleFactor > 1`, notably WebKit.)

## [0.1.1] - 2026-04-27

### Fixed

- README and source comments cited the wrong upstream Playwright issues for the "ffmpeg config is hardcoded" pain. Replaced with the actually-relevant threads: [#8683](https://github.com/microsoft/playwright/issues/8683), [#12056](https://github.com/microsoft/playwright/issues/12056), [#17217](https://github.com/microsoft/playwright/issues/17217), [#31424](https://github.com/microsoft/playwright/issues/31424).

## [0.1.0] - 2026-04-27

Initial public release.

### Added

- `attachRecorder(page, options)` — record a single `Page` to a video file via Playwright 1.59+'s `page.screencast` API and a separately-shipped ffmpeg.
- `attachRecorderForContext(context, options)` — auto-attach recorders to every `Page` in a `BrowserContext`, including pages opened later (popups, `target=_blank`).
- **Fixed two-pass pipeline.** First pass is always H.264 `ultrafast` so the encoder cannot fall behind realtime. Second pass transcodes to the user-chosen codec/container and muxes any scheduled audio.
- **Built-in second-pass presets:** `youtube` (H.264 mp4) and `web` (VP9 webm). Auto-picked from the output extension; override with `preset` or fully customise via `ffmpegArgs`.
- **Wall-clock-faithful timing.** Frame numbering is anchored to `recorder.start()` (not the first CDP frame), so pages that stay visually static after start (Pyodide / WASM warm-up, slow font loads) still produce a video whose duration matches real time. Same-slot CDP frames are deduplicated; gaps are padded with the previous frame; `stop()` pads up to wall-clock now.
- `pause()` / `resume()` — skip recording during long setup or build phases without producing a separate file.
- `autoStart: false` — defer recording until the page is presentable.
- `crop` option, compatible with `Locator.boundingBox()`.
- `recorder.audio(path, { offset, absolute })` — schedule audio clips inline at wall-clock offsets; ffmpeg muxes them into the second pass.
- `recorder.finalized` — promise that resolves when the second pass finishes and the final file is on disk. `stop()` returns once the first pass has flushed; `finalized` is the wait-for-final-file hook.
- Cross-browser smoke tests (`test/smoke.spec.ts`) covering Chromium, Firefox, WebKit; includes a 10-second wall-clock fidelity regression test.

### Notes

- This package does not capture page-played audio. Like Playwright's built-in `recordVideo`, CDP screencast is video-only. Use `recorder.audio()` to schedule external audio (TTS, voice-over, sound effects) into the recording.
- ffmpeg is shipped via [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static); no system ffmpeg required.
- Requires Playwright `>= 1.59.0` and Node `>= 18`.
