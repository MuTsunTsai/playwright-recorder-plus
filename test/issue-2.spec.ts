// Local reproduction for https://github.com/MuTsunTsai/playwright-recorder-plus/issues/2.
//
// `recorder.resume()` is the dual of the issue #1 bug. Frames received
// while paused are dropped by `ingestFrame`, so `_lastJpeg` keeps the
// last pre-pause frame. After `resume()` the page may sit static for a
// while before CDP delivers a fresh frame; in that gap the encoder pads
// with `_lastJpeg`, which is now stale -- it shows what the page looked
// like at pause time, not at resume time.
//
// Reproduction recipe:
//   1. setContent a red page, attachRecorder + start.
//   2. Brief settle so the red frame is observed (some _lastJpeg present).
//   3. recorder.pause().
//   4. setContent green. CDP delivers a frame, but state == paused so
//      ingestFrame discards it -- _lastJpeg stays red.
//   5. recorder.resume(). Page is now actually green, but _lastJpeg is
//      still red; the page is static so CDP won't send anything.
//   6. Wait ~3s, then setContent blue (and stop shortly after) so the
//      first post-resume CDP frame arrives. With the bug, slots 0..N-1
//      since resume get padded with red. Without the bug, with green.
//   7. Stop.
//
// Expectation: a frame sampled mid-way through the post-resume static
// window should be GREEN. With the bug it's RED.
//
// Open `test/out/issue-2.mp4` and inspect manually.

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

test("issue #2 reproduction: resume() picks up post-pause page state", async ({ page }) => {
	test.setTimeout(60_000);
	const out = resolve(OUT_DIR, "issue-2.mp4");

	await page.setViewportSize({ width: 1280, height: 720 });

	// Start on red so the encoder has a known pre-pause state.
	await page.setContent(`<!doctype html>
		<html><head><style>
			html, body { margin: 0; height: 100%; background: #ff0000; }
		</style></head><body></body></html>`);
	// eslint-disable-next-line playwright/no-wait-for-timeout
	await page.waitForTimeout(300);

	const recorder = await attachRecorder(page, {
		path: out,
		autoStart: false,
		fps: 30,
	});

	try {
		await recorder.start();
		// Give the encoder a beat with the red page so the recording
		// opens cleanly and _lastJpeg gets populated by a real CDP frame.
		// eslint-disable-next-line playwright/no-wait-for-timeout
		await page.waitForTimeout(1_000);

		await recorder.pause();
		// Page changes during pause: CDP delivers a green frame, but
		// `ingestFrame` drops it because state == paused. _lastJpeg
		// keeps the pre-pause red frame.
		await page.setContent(`<!doctype html>
			<html><head><style>
				html, body { margin: 0; height: 100%; background: #00aa00; }
			</style></head><body></body></html>`);
		// eslint-disable-next-line playwright/no-wait-for-timeout
		await page.waitForTimeout(500);

		await recorder.resume();
		// Sit on the green page. CDP sends nothing because the page is
		// static. With the bug, padding uses the stale red `_lastJpeg`.
		// eslint-disable-next-line playwright/no-wait-for-timeout
		await page.waitForTimeout(3_000);

		// Trigger one post-resume CDP frame so the bug surfaces visibly,
		// then stop.
		await page.setContent(`<!doctype html>
			<html><head><style>
				html, body { margin: 0; height: 100%; background: #0000ff; }
			</style></head><body></body></html>`);
		// eslint-disable-next-line playwright/no-wait-for-timeout
		await page.waitForTimeout(300);
	} finally {
		await recorder.stop();
		await recorder.finalized;
	}

	expect(existsSync(out)).toBe(true);

	// The encoded video timeline (since recorder.start()):
	//   t = 0.0 .. 1.0     red (pre-pause)
	//   t = 1.0            pause -- pause interval excluded from timeline
	//   t = 1.0 .. 4.0     post-resume static window (should be GREEN)
	//   t = 4.0+           blue
	//
	// Sample at t = 2.5 -- middle of the post-resume static window.
	const sample = await frameAverage(out, 2.5);
	expect(sample.g).toBeGreaterThan(100);
	expect(sample.r).toBeLessThan(80);
	expect(sample.b).toBeLessThan(80);
});
