// playwright-recorder-plus
//
// High-quality video recording for Playwright. Wraps page.screencast (1.59+)
// with a configurable ffmpeg encoder, replacing Playwright's built-in
// recordVideo whose ffmpeg arguments are hardcoded to a low-bitrate VP8
// realtime preset (microsoft/playwright#8683, #12056, #17217, #31424).

import ffmpegStatic from "ffmpeg-static";

import {
	buildFirstPassArgs,
	buildSecondPassArgs,
	defaultIntermediatePath,
	defaultPresetForPath,
	DEFAULT_FPS,
	DEFAULT_JPEG_QUALITY,
	DEFAULT_VIEWPORT,
} from "./defaults";
import { RecorderImpl } from "./recorder";

import type { BrowserContext, Page } from "playwright-core";
import type { ContextRecorder, ContextRecorderOptions, Recorder, RecorderOptions, StopResult } from "./types";

export type {
	AudioTrack,
	ContextRecorder,
	ContextRecorderOptions,
	CropRegion,
	Recorder,
	RecorderOptions,
	RecorderState,
	SecondPassPreset,
	StopResult
} from "./types";

function resolveFfmpegPath(opts: RecorderOptions): string {
	const path = opts.ffmpegPath ?? (ffmpegStatic as unknown as string | null);
	if(!path) {
		throw new Error(
			"playwright-recorder-plus: ffmpeg-static did not provide a binary path " +
			"for this platform. Pass `ffmpegPath` explicitly."
		);
	}
	return path;
}

/**
 * Attach a recorder to a single Page. Returns a controller exposing
 * `start/pause/resume/stop`. Use `recorder.stop()` in a `try/finally` block
 * to ensure ffmpeg flushes even if the test throws.
 *
 * @example
 * ```ts
 * const rec = await attachRecorder(page, { path: "out.mp4" });
 * try {
 *   await page.goto("https://example.com");
 *   // ... interactions ...
 * } finally {
 *   await rec.stop();
 * }
 * ```
 */
export async function attachRecorder(page: Page, opts: RecorderOptions): Promise<Recorder> {
	if(!opts?.path) throw new Error("attachRecorder: options.path is required");
	if(opts.preset !== undefined && opts.ffmpegArgs !== undefined) {
		throw new Error("attachRecorder: `preset` and `ffmpegArgs` are mutually exclusive");
	}

	const fps = opts.fps ?? DEFAULT_FPS;
	const size = opts.size ?? page.viewportSize() ?? DEFAULT_VIEWPORT;
	const ffmpegPath = resolveFfmpegPath(opts);

	// First pass is fixed at H.264 ultrafast for realtime fidelity.
	// Second pass is either user-supplied `ffmpegArgs`, the named `preset`,
	// or auto-detected from the output extension.
	const firstPassArgs = buildFirstPassArgs(opts, fps);
	const secondPassArgs = opts.ffmpegArgs ?
		[...opts.ffmpegArgs] :
		buildSecondPassArgs(opts.preset ?? defaultPresetForPath(opts.path));
	const intermediatePath = opts.intermediatePath ?? defaultIntermediatePath(opts.path);

	const recorder = new RecorderImpl(
		page,
		{ ...opts, jpegQuality: opts.jpegQuality ?? DEFAULT_JPEG_QUALITY },
		ffmpegPath,
		firstPassArgs,
		secondPassArgs,
		intermediatePath,
		fps,
		size
	);
	await recorder.attach(opts.autoStart ?? true);
	return recorder;
}

/**
 * Attach recorders to **every page** in a context, including pages opened
 * later (popups, target=_blank links). Returns a controller that aggregates
 * `stop()` across all of them.
 *
 * Each page gets its own output file derived from `pathTemplate`. The
 * template supports `{index}` (0-based incrementing index per attached page).
 *
 * @example
 * ```ts
 * const recorders = await attachRecorderForContext(context, {
 *   pathTemplate: "videos/page-{index}.webm",
 * });
 * try {
 *   await page.goto("https://opens-popup.example");
 *   // ... popup work ...
 * } finally {
 *   const results = await recorders.stopAll();
 *   console.log(`recorded ${results.length} pages`);
 * }
 * ```
 */
export async function attachRecorderForContext(
	context: BrowserContext,
	opts: ContextRecorderOptions
): Promise<ContextRecorder> {
	const recorders: Recorder[] = [];
	let nextIndex = 0;

	// Strip pathTemplate from per-page recorder options; it lives at the
	// context level only.
	const { pathTemplate, ...recorderOpts } = opts;

	const attachOne = async (page: Page): Promise<void> => {
		const path = pathTemplate.replace("{index}", String(nextIndex));
		nextIndex++;
		const rec = await attachRecorder(page, { ...recorderOpts, path });
		recorders.push(rec);
	};

	for(const page of context.pages()) {
		// eslint-disable-next-line no-await-in-loop -- attaches must serialise so nextIndex is sequential
		await attachOne(page);
	}
	context.on("page", page => {
		attachOne(page).catch((err: unknown) => {
			console.warn(
				`[playwright-recorder-plus] failed to attach to new page: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		});
	});

	return {
		recorders,
		stopAll(): Promise<StopResult[]> {
			return Promise.all(recorders.map(r => r.stop()));
		},
	};
}
