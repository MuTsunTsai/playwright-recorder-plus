// Cross-browser smoke test for playwright-recorder-plus.
//
// Each browser project (chromium / firefox / webkit, configured in
// playwright.config.ts) runs the same case: attach the recorder to a
// blank page with some animated content, record for ~3s, stop, then
// ffprobe the output to confirm it's a non-trivial valid video.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { attachRecorder } from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "out");

test.beforeAll(() => {
	if(existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
	mkdirSync(OUT_DIR, { recursive: true });
});

interface ProbeResult {
	codec: string;
	width: number;
	height: number;
	duration: number;
}

/**
 * Probe a video file by running ffmpeg with `-i <file>` and parsing the
 * stream/duration info from stderr. ffmpeg-static doesn't ship ffprobe so
 * we use ffmpeg itself; the format is well-known and stable enough.
 */
function probe(file: string): Promise<ProbeResult> {
	const ffmpegPath = ffmpegStatic as unknown as string;
	// `-i` with no output makes ffmpeg dump container info to stderr and exit
	// with an error -- that's expected, we only want the parsed text.
	const args = ["-hide_banner", "-i", file];
	return new Promise<ProbeResult>((resolveProbe, reject) => {
		const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr.on("data", chunk => { stderr += chunk.toString(); });
		proc.on("error", reject);
		proc.on("close", () => {
			// e.g. "Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 1280x720, ..."
			const streamLine = stderr.split(/\r?\n/).find(l => /Stream #0:.*Video:/.test(l)) ?? "";
			const codecMatch = /Video: (\w+)/.exec(streamLine);
			// Match WxH where each dim is at least 2 digits, to skip
			// stream-id tokens like `[0x1]` that h264/mp4 streams carry.
			const sizeMatch = /(\d{2,})x(\d{2,})/.exec(streamLine);
			// e.g. "  Duration: 00:00:03.04, ..."
			const durationMatch = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
			const duration = durationMatch ?
				Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) :
				0;
			resolveProbe({
				codec: codecMatch?.[1] ?? "unknown",
				width: sizeMatch ? Number(sizeMatch[1]) : 0,
				height: sizeMatch ? Number(sizeMatch[2]) : 0,
				duration,
			});
		});
	});
}

test("attachRecorder produces a valid H.264 mp4", async ({ page, browserName }) => {
	const out = resolve(OUT_DIR, `${browserName}.mp4`);

	const recorder = await attachRecorder(page, { path: out });
	await page.setContent(`<!doctype html>
		<style>
			body { margin: 0; background: #111; color: #eee; font: 48px/1 sans-serif; }
			#box { width: 200px; height: 200px; background: #4af; animation: spin 1s infinite linear; }
			@keyframes spin { to { transform: rotate(360deg); } }
		</style>
		<body><div id="box"></div><p>Hello, world.</p></body>`);
	// Hold for ~3s so frames accumulate and ffmpeg has something to encode.
	// We're explicitly testing wall-clock recording duration, not waiting on
	// any page condition -- waitForTimeout is the right tool here.
	// eslint-disable-next-line playwright/no-wait-for-timeout
	await page.waitForTimeout(3000);
	const result = await recorder.stop();
	// stop() returns once first-pass capture has flushed; the second pass
	// (transcode) runs in the background. Wait for `finalized` before
	// probing the output file.
	await recorder.finalized;

	expect(result.written).toBe(true);
	expect(result.frameCount).toBeGreaterThan(0);
	expect(existsSync(out)).toBe(true);
	expect(statSync(out).size).toBeGreaterThan(1000);

	const probed = await probe(out);
	expect(probed.codec).toBe("h264");
	expect(probed.width).toBeGreaterThan(0);
	expect(probed.height).toBeGreaterThan(0);
	expect(probed.duration).toBeGreaterThan(1);
});

test("autoStart: false produces no file when stop is called immediately", async ({ page }) => {
	const out = resolve(OUT_DIR, "no-start.mp4");
	const recorder = await attachRecorder(page, {
		path: out,
		autoStart: false,
		silenceWarnings: true,
	});
	const result = await recorder.stop();
	expect(result.written).toBe(false);
	expect(result.frameCount).toBe(0);
	expect(existsSync(out)).toBe(false);
});

test("10s manual recording produces a video with duration ≈ 10s", async ({ page }) => {
	// Wall-clock fidelity regression test. Record for ~10s of wall time and
	// assert the resulting video has a matching duration. Guards against the
	// drift class of bugs in `ingestFrame`: same-slot duplicate frames must
	// be dropped, gaps must be padded with the previous frame, and stop()
	// must pad up to wall-now. A 60Hz animation at fps=25 delivers ~2.4 CDP
	// frames per slot -- without dedup, the encoded video runs ~2.4x slow.
	const out = resolve(OUT_DIR, "ten-seconds.mp4");
	const recorder = await attachRecorder(page, { path: out, autoStart: false });
	// Spinning element keeps CDP sending frames at the page's frame rate.
	// A static page would yield zero frames after the initial paint and
	// wouldn't exercise the same-slot dedup path.
	await page.setContent(`<!doctype html>
		<style>
			body { margin: 0; background: #222; color: #eee; font: 48px sans-serif; }
			#box { width: 200px; height: 200px; background: #4af; animation: spin 1s infinite linear; }
			@keyframes spin { to { transform: rotate(360deg); } }
		</style>
		<body><div id="box"></div><p>10s test</p></body>`);

	// Measure wall time *after* start() resolves -- starting the screencast
	// has non-trivial latency (CDP roundtrip) that should not count toward
	// the recording duration we're asserting on.
	await recorder.start();
	const startWall = performance.now();
	// eslint-disable-next-line playwright/no-wait-for-timeout
	await page.waitForTimeout(10_000);
	const wallSec = (performance.now() - startWall) / 1000;
	const result = await recorder.stop();
	await recorder.finalized;

	expect(result.written).toBe(true);
	const probed = await probe(out);
	// Tolerance: video duration within +-0.5s of measured wall time.
	expect(probed.duration).toBeGreaterThan(wallSec - 0.5);
	expect(probed.duration).toBeLessThan(wallSec + 0.5);
});

test("pause/resume keeps the file open", async ({ page }) => {
	const out = resolve(OUT_DIR, "pause-resume.mp4");
	const recorder = await attachRecorder(page, { path: out });
	await page.setContent("<body style='background:#222'>before</body>");
	// Wall-clock waits to drive recording phases; not waiting on page state.
	/* eslint-disable playwright/no-wait-for-timeout */
	await page.waitForTimeout(500);
	await recorder.pause();
	await page.waitForTimeout(500);
	await recorder.resume();
	await page.setContent("<body style='background:#888'>after</body>");
	await page.waitForTimeout(500);
	/* eslint-enable playwright/no-wait-for-timeout */
	const result = await recorder.stop();
	await recorder.finalized;

	expect(result.written).toBe(true);
	expect(result.frameCount).toBeGreaterThan(0);
});

test("preset 'web' transcodes the second pass to VP9/webm", async ({ page }) => {
	// Verifies that the intermediate (always H.264 mp4) is correctly
	// re-encoded in the second pass when the user picks a different
	// container. Also exercises the ext-based preset auto-detection.
	const out = resolve(OUT_DIR, "preset-web.webm");
	const recorder = await attachRecorder(page, { path: out });
	await page.setContent("<body style='background:#333;color:#eee;font:48px sans-serif'>web preset</body>");
	// eslint-disable-next-line playwright/no-wait-for-timeout
	await page.waitForTimeout(1500);
	await recorder.stop();
	await recorder.finalized;

	expect(existsSync(out)).toBe(true);
	const probed = await probe(out);
	expect(probed.codec).toBe("vp9");
	expect(probed.duration).toBeGreaterThan(0.5);
});

test("intermediate file is removed after a successful second pass", async ({ page }) => {
	// The default intermediate path is `<finalPath>.intermediate.mp4`
	// (without the original extension up to its last dot). For a final
	// path of `intermediate-cleanup.mp4`, the intermediate sits at
	// `intermediate-cleanup.intermediate.mp4`.
	const out = resolve(OUT_DIR, "intermediate-cleanup.mp4");
	const intermediate = resolve(OUT_DIR, "intermediate-cleanup.intermediate.mp4");
	const recorder = await attachRecorder(page, { path: out });
	await page.setContent("<body style='background:#444'>cleanup</body>");
	// eslint-disable-next-line playwright/no-wait-for-timeout
	await page.waitForTimeout(1000);
	await recorder.stop();
	await recorder.finalized;

	expect(existsSync(out)).toBe(true);
	expect(existsSync(intermediate)).toBe(false);
});
