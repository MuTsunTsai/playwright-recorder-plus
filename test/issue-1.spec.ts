// Local reproduction for https://github.com/MuTsunTsai/playwright-recorder-plus/issues/1.
//
// What the bug is: `ingestFrame` back-fills the early slots of the encoded
// video with the *first CDP frame that arrives after `recorder.start()`*.
// If `_lastJpeg` is null at start time AND the page is static enough that
// CDP delivers no frames until something changes, that "first frame" can
// be the post-change content -- so the static window at the start of the
// recording shows the wrong page.
//
// The non-obvious trigger is the relative ordering of `attachRecorder()`
// and the page-content setup. Frames that CDP delivers while the recorder
// is still in `state === "initial"` are dropped by `ingestFrame` and do
// NOT populate `_lastJpeg`. So:
//
//   - If `attachRecorder()` runs AFTER the page has already painted and
//     settled, the screencast attaches to a stable page; CDP sends a
//     short burst of frames and a few of them arrive after `start()`, so
//     `_lastJpeg` ends up populated with the correct pre-change content.
//     The bug is hidden.
//   - If `attachRecorder()` runs BEFORE the page-content setup, every CDP
//     frame from that setup is delivered while state is still "initial"
//     and is discarded. By the time `start()` is called the page is
//     already idle and CDP has throttled itself; nothing flows into
//     `_lastJpeg` until the next real change. The bug surfaces.
//
// This spec uses the second ordering on purpose. The user's original
// report (which uses a real SPA via `page.goto`) hits the same condition
// because they call `attachRecorder` before the navigation.
//
// Reproduction recipe:
//   1. attachRecorder (autoStart: false) on a blank page.
//   2. setContent a red page that schedules a setTimeout flipping the
//      background to green 5s later. No animation, no rAF, no other DOM
//      mutation -- the page must be fully static between paint and flip.
//   3. Wait 500ms so the red paint's CDP traffic settles. All these
//      frames arrive in state "initial" and are discarded.
//   4. recorder.start() -- t=0, _lastJpeg is null.
//   5. Wait 7s. CDP sends nothing for the first 5s; the first frame in
//      state "recording" is the post-flip green frame.
//   6. stop().
//
// Expectation: the first 5s of the encoded video should show RED. With
// the bug, the entire video is GREEN -- back-fill uses the only
// available frame.
//
// Open `test/out/issue-1.mp4` and inspect manually.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { attachRecorder } from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "out");

mkdirSync(OUT_DIR, { recursive: true });

/**
 * Decode a single frame at `seconds` into a P6 PPM (raw RGB), parse it,
 * and return the channel-wise average. We use ffmpeg's PPM output so we
 * don't need a JPEG/PNG decoder dependency.
 */
async function frameAverage(file: string, seconds: number): Promise<{ r: number, g: number, b: number }> {
	const ffmpegPath = ffmpegStatic as unknown as string;
	const ppm = `${file}.t${seconds.toFixed(2)}.ppm`;
	const args = ["-y", "-hide_banner", "-loglevel", "error",
		"-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "image2", "-c:v", "ppm", ppm];
	await new Promise<void>((res, rej) => {
		const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "inherit"] });
		p.on("error", rej);
		p.on("close", code => code === 0 ? res() : rej(new Error(`ffmpeg seek failed: ${code}`)));
	});

	const buf = readFileSync(ppm);
	unlinkSync(ppm);
	let pos = 0;
	const isWs = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
	const readToken = (): string => {
		while(pos < buf.length && isWs(buf[pos])) pos++;
		if(buf[pos] === 0x23) {
			while(pos < buf.length && buf[pos] !== 0x0a) pos++;
			return readToken();
		}
		const start = pos;
		while(pos < buf.length && !isWs(buf[pos])) pos++;
		return buf.subarray(start, pos).toString("ascii");
	};
	const magic = readToken();
	if(magic !== "P6") throw new Error(`expected P6 PPM, got ${magic}`);
	readToken(); // width
	readToken(); // height
	readToken(); // maxval
	pos++; // single whitespace before pixel data
	const pixels = buf.subarray(pos);
	let r = 0, g = 0, b = 0, n = 0;
	for(let i = 0; i + 2 < pixels.length; i += 3 * 256) {
		r += pixels[i];
		g += pixels[i + 1];
		b += pixels[i + 2];
		n++;
	}
	return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

test("issue #1 reproduction: static red -> setTimeout flip to green", async ({ page }) => {
	test.setTimeout(60_000);
	const out = resolve(OUT_DIR, "issue-1.mp4");

	await page.setViewportSize({ width: 1280, height: 720 });

	// Attach BEFORE setContent so the screencast frames produced by the
	// red paint all arrive while state is still "initial" and are
	// discarded by ingestFrame -- this is what leaves _lastJpeg null at
	// start() time and surfaces the bug.
	const recorder = await attachRecorder(page, {
		path: out,
		autoStart: false,
		fps: 30,
	});

	// Solid red page with a setTimeout that flips the background to green
	// after 5s. No animation, no rAF, no other DOM mutation -- the page
	// must be fully static between the initial paint and the flip, or CDP
	// will keep streaming frames and `_lastJpeg` will get populated before
	// the flip (hiding the bug).
	await page.setContent(`<!doctype html>
		<html><head><style>
			html, body { margin: 0; height: 100%; background: #ff0000; }
		</style></head><body>
		<script>
			setTimeout(() => { document.body.style.background = "#00aa00"; }, 5000);
		</script>
		</body></html>`);
	// Let CDP drain whatever frames it produced for the red paint -- they
	// all arrive in state "initial" and get discarded. After this beat the
	// page is fully idle and CDP has stopped sending frames.
	// eslint-disable-next-line playwright/no-wait-for-timeout
	await page.waitForTimeout(500);

	try {
		await recorder.start();
		// Sit through the static window (5s of red) and a couple of seconds
		// post-flip (green). With the bug, the recorded first 5s shows green,
		// not red.
		// eslint-disable-next-line playwright/no-wait-for-timeout
		await page.waitForTimeout(7_000);
	} finally {
		await recorder.stop();
		await recorder.finalized;
	}

	expect(existsSync(out)).toBe(true);

	// The first frame of the encoded video must be the pre-flip red, not
	// the post-flip green. With the bug, both samples would be green.
	const first = await frameAverage(out, 0);
	expect(first.r).toBeGreaterThan(150);
	expect(first.g).toBeLessThan(80);
	expect(first.b).toBeLessThan(80);
});
