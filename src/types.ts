export type RecorderState = "initial" | "recording" | "paused" | "closed";

export interface CropRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * One audio segment captured by `recorder.audio(path)`. Stored internally
 * with its frame-derived offset; muxed in during `stop()`.
 */
export interface AudioTrack {
	path: string;
	/** Offset in seconds, relative to the video start. */
	offset: number;
}

/**
 * Built-in second-pass codec/container choices.
 *
 * - `youtube` -- H.264 main profile / mp4 / AAC. Sensible upload defaults.
 *   Default for `.mp4` outputs.
 * - `web` -- VP9 / webm / Opus. Browser-native, smaller than H.264.
 *   Default for `.webm` / `.ogg` / `.ogv` outputs.
 */
export type SecondPassPreset = "youtube" | "web";

export interface RecorderOptions {
	/**
	 * Final output file path. Container is determined by extension
	 * (`.mp4`, `.webm`, ...). The recorder always captures via a
	 * fixed-format intermediate first (H.264 ultrafast mp4) for realtime
	 * fidelity, then a second pass transcodes to this path.
	 */
	path: string;

	/**
	 * Whether to start recording immediately on `attachRecorder()`. When
	 * `false`, you must call `recorder.start()` to begin capturing frames.
	 * @default true
	 */
	autoStart?: boolean;

	/**
	 * Frame size. Defaults to `page.viewportSize()`. **Must be set before any
	 * other screencast client (e.g. `context.tracing.start({ screenshots: true })`)
	 * starts** -- Playwright's screencast server locks the size to the first
	 * client's request. The recorder verifies this on the first frame and
	 * throws if a mismatch is detected.
	 */
	size?: { width: number, height: number };

	/**
	 * Output frames per second. The recorder pads the variable-rate CDP
	 * screencast stream with duplicate frames to hit this constant rate.
	 * @default 25
	 */
	fps?: number;

	/**
	 * JPEG quality of the CDP screencast stream that ffmpeg ingests. Higher
	 * values reduce mosquito noise on glyph edges before re-encoding.
	 * @default 100
	 */
	jpegQuality?: number;

	/**
	 * Crop the recording to a sub-region of the captured frames. Coordinates
	 * are in viewport CSS pixels. Compatible with the shape returned by
	 * `Locator.boundingBox()`.
	 */
	crop?: CropRegion;

	/**
	 * Pick the second-pass codec/container. See {@link SecondPassPreset}.
	 *
	 * If omitted, defaults are inferred from `path` extension:
	 * - `.mp4` -> `youtube`
	 * - `.webm` / `.ogg` / `.ogv` -> `web`
	 * - anything else -> `youtube`
	 *
	 * Mutually exclusive with `ffmpegArgs`.
	 */
	preset?: SecondPassPreset;

	/**
	 * Replace the **second-pass** ffmpeg argument tail (codec / filter /
	 * container flags). Slots in between `-i <intermediate>` and the
	 * output path; do not include `-i`, `-y`, the input path, or the
	 * output path -- the recorder adds those.
	 *
	 * Use this for codecs the built-in presets don't cover (libsvtav1,
	 * libaom-av1) or to fine-tune bitrate / preset.
	 *
	 * **First-pass args are not user-configurable.** They're fixed at
	 * H.264 `-preset ultrafast` to guarantee realtime ingestion; tweaking
	 * them risks dropped frames and timeline drift on long captures.
	 *
	 * Mutually exclusive with `preset`.
	 */
	ffmpegArgs?: string[];

	/**
	 * Override where the H.264 ultrafast intermediate file is written.
	 * Default: `<path-without-ext>.intermediate.mp4` next to `path`.
	 *
	 * The intermediate is normally deleted once the second pass succeeds.
	 * If the second pass fails, it is kept on disk so the recording isn't
	 * lost. To inspect or reuse the intermediate, point this somewhere
	 * stable.
	 */
	intermediatePath?: string;

	/**
	 * Path to the ffmpeg binary.
	 * @default the binary shipped by `ffmpeg-static`
	 */
	ffmpegPath?: string;

	/**
	 * Suppress runtime warnings (state-machine misuse, no-frames-captured,
	 * etc.). The recorder still throws on hard errors.
	 * @default false
	 */
	silenceWarnings?: boolean;
}

export interface StopResult {
	/**
	 * The final output file path. Same as `options.path`. Note that this
	 * file is *not* guaranteed to exist when `stop()` resolves -- `stop()`
	 * only waits for the first-pass capture to flush. Await
	 * `recorder.finalized` to wait for the second pass + audio mux.
	 */
	path: string;
	/** Total frames written to first-pass ffmpeg stdin (including padded CFR frames). */
	frameCount: number;
	/** False if no `start()` was ever called and no file was produced. */
	written: boolean;
}

export interface Recorder {
	readonly state: RecorderState;
	readonly frameCount: number;

	/**
	 * Resolves when the second pass (transcode + optional audio mux) has
	 * fully completed and `options.path` is the final file on disk.
	 *
	 * `stop()` is fast-return: it only waits for the first-pass capture
	 * to flush, since the verb "stop" is about ending recording, not
	 * about file IO. If you need the final file to exist (e.g. before
	 * uploading or attaching as a CI artifact), await this promise.
	 *
	 * If the second pass fails, this rejects with the underlying ffmpeg
	 * error and the intermediate file is kept on disk at
	 * `options.intermediatePath` so the recording isn't lost.
	 */
	readonly finalized: Promise<StopResult>;

	/** Begin recording. No-op (warn) if already recording or closed. */
	start(): Promise<void>;
	/** Pause frame writes without finalising the output. */
	pause(): Promise<void>;
	/** Resume after `pause()`. Equivalent to `start()` but signals "continuing". */
	resume(): Promise<void>;
	/**
	 * End recording. Resolves once the first-pass capture has flushed --
	 * does **not** wait for the second pass / audio mux. Await
	 * `recorder.finalized` if you need the final file to exist.
	 *
	 * Idempotent: a second `stop()` warns and returns the cached result.
	 */
	stop(): Promise<StopResult>;

	/**
	 * Schedule an audio file to be muxed into the recorded video.
	 *
	 * - `recorder.audio(path)` -- anchored to "now" (wall-clock elapsed
	 *   since `start()`, paused intervals excluded). The common case for
	 *   click sounds, narration triggered by an event, etc.
	 * - `recorder.audio(path, { offset })` -- offset seconds **after**
	 *   "now". Useful when you know a sound should play in the near
	 *   future (e.g. a button-press sound for an animation you've just
	 *   triggered) and want to schedule it before that moment arrives.
	 * - `recorder.audio(path, { offset, absolute: true })` -- offset is
	 *   an absolute video timestamp from t=0. The escape hatch for
	 *   timelines you compute externally.
	 *
	 * Multiple calls accumulate into a list that's combined with
	 * `-filter_complex amix` during the second pass. If two scheduled
	 * tracks would overlap on the timeline, ffmpeg averages them
	 * (effectively ducking each); the author is responsible for choosing
	 * call timings that don't cause unwanted overlap.
	 *
	 * Calling this without an explicit `offset` while paused logs a
	 * warning -- the resolved position is the moment recording was
	 * paused, which is rarely what callers want.
	 */
	audio(path: string, options?: { offset?: number, absolute?: boolean }): void;
}

export interface ContextRecorderOptions extends Omit<RecorderOptions, "path"> {
	/** Template for output paths. `{index}` is replaced with 0-based page index. */
	pathTemplate: string;
}

export interface ContextRecorder {
	readonly recorders: Recorder[];
	stopAll(): Promise<StopResult[]>;
}
