import { spawn } from "node:child_process";
import fs from "node:fs/promises";

import { parseJpegSize } from "./jpeg";
import { buildSecondPassFfmpegArgs, runFfmpeg } from "./secondPass";

import type { ChildProcess } from "node:child_process";
import type { Page } from "playwright-core";
import type { AudioTrack, Recorder, RecorderOptions, RecorderState, StopResult } from "./types";

/**
 * Resolved configuration for a single `RecorderImpl` instance. Defaults
 * have already been applied by `attachRecorder` (in `index.ts`); the
 * recorder treats every field as authoritative.
 */
export interface RecorderConfig {
	opts: RecorderOptions;
	ffmpegPath: string;
	firstPassArgs: string[];
	secondPassArgs: string[];
	intermediatePath: string;
	fps: number;
	size: { width: number, height: number };
}

const MS_PER_SECOND = 1000;

/**
 * Concrete `Recorder` implementation. State + first-pass ffmpeg child
 * process + finalisation promise all live as instance fields. Construct
 * via `attachRecorder()` in `index.ts` -- not directly.
 */
export class RecorderImpl implements Recorder {
	private _state: RecorderState = "initial";
	private _frameCount = 0;
	private _lastJpeg: Buffer | null = null;
	private _sizeChecked = false;
	private _ff: ChildProcess | null = null;
	private _writeChain: Promise<void> = Promise.resolve();
	private _audioTracks: AudioTrack[] = [];
	// Wall-clock anchor for the encoded video: set when `start()` (or
	// autoStart=true) transitions us to "recording". Frame numbering and
	// padToNow are computed relative to this. Using the *first CDP frame*
	// as the anchor instead would underrepresent the recording duration
	// whenever CDP delays the first frame -- CDP only sends frames when
	// the page changes, so a static page after start() can have several
	// seconds of "nothing happens" that should still appear in the file.
	private _startWallMs: number | null = null;
	private _lastFrameNumber = -1;
	private _pausedAccumMs = 0;
	private _pauseStartedAtMs: number | null = null;
	// Set false at every transition into RECORDING (start / autoStart /
	// resume). Set true the first time `ingestFrame` accepts a real CDP
	// frame, OR when the baseline screenshot writes itself in. The
	// background `captureBaselineJpeg` only overwrites `_lastJpeg` while
	// this is false. Without this flag, the baseline taken at resume()
	// would either get rejected (if we keep the issue #1 "skip when
	// _lastJpeg is set" rule) or stomp on a fresher CDP frame (if we
	// drop that rule).
	private _baselineConsumed = false;

	// Final-result promise: resolves when both first pass (capture) and
	// second pass (transcode + audio mux) have completed. Stored so a
	// repeated stop() returns the same result.
	private _finalized: Promise<StopResult> | null = null;

	constructor(
		private readonly page: Page,
		private readonly config: RecorderConfig
	) {}

	get state(): RecorderState { return this._state; }
	get frameCount(): number { return this._frameCount; }
	get finalized(): Promise<StopResult> {
		// `stop()` initialises `_finalized`. Awaiting `finalized` before
		// `stop()` was called is a programmer error; surface it loudly
		// rather than hanging on a never-resolving promise.
		if(!this._finalized) {
			return Promise.reject(new Error(
				"playwright-recorder-plus: `recorder.finalized` was awaited before `recorder.stop()` was called"
			));
		}
		return this._finalized;
	}

	/**
	 * Bind the recorder to its page's screencast stream. Resolves once the
	 * screencast has started. Frames arrive via `onFrame` and feed
	 * `ingestFrame`; the first-pass ffmpeg child is started lazily by
	 * `ensureFfmpeg()` when we transition to "recording".
	 */
	async attach(autoStart: boolean): Promise<void> {
		await this.page.screencast.start({
			size: this.config.size,
			quality: this.config.opts.jpegQuality,
			onFrame: ({ data }) => this.onFrame(data),
		});
		if(autoStart) this.transitionToRecording();
	}

	start(): Promise<void> {
		const warn = this.warn.bind(this);
		if(this._state === "initial") {
			this.transitionToRecording();
		} else if(this._state === "recording") {
			warn("start() called but already recording -- no-op");
		} else if(this._state === "paused") {
			warn("start() called while paused -- use resume() instead. Resuming anyway.");
			this.notePauseExit();
			this.transitionToRecording();
		} else {
			warn("start() called after stop() -- no-op");
		}
		return Promise.resolve();
	}

	pause(): Promise<void> {
		const warn = this.warn.bind(this);
		if(this._state === "initial") {
			warn("pause() called before start() -- no-op");
		} else if(this._state === "recording") {
			this.notePauseEnter();
			this._state = "paused";
		} else if(this._state === "paused") {
			warn("pause() called but already paused -- no-op");
		} else {
			warn("pause() called after stop() -- no-op");
		}
		return Promise.resolve();
	}

	resume(): Promise<void> {
		const warn = this.warn.bind(this);
		if(this._state === "initial") {
			warn("resume() called before start() -- use start() instead. Starting anyway.");
			this.transitionToRecording();
		} else if(this._state === "recording") {
			warn("resume() called but already recording -- no-op");
		} else if(this._state === "paused") {
			this.notePauseExit();
			this.transitionToRecording();
		} else {
			warn("resume() called after stop() -- no-op");
		}
		return Promise.resolve();
	}

	/**
	 * End recording. Resolves once the first pass has flushed; the second
	 * pass runs in the background and is exposed via `finalized`.
	 *
	 * Idempotent: calling `stop()` again returns the same `_finalized`
	 * result with a warning.
	 */
	async stop(): Promise<StopResult> {
		if(this._state === "closed") {
			this.warn("stop() called twice -- no-op");
			// Return a resolved snapshot of what we know now. Callers
			// who care about the final file should already be awaiting
			// `finalized`.
			return { path: this.config.opts.path, frameCount: this._frameCount, written: this._ff !== null };
		}

		const wasInitial = this._state === "initial";
		// If we're paused at stop time, finalise the paused interval so it
		// doesn't bleed into the wall-clock used by padToNow.
		if(this._state === "paused") this.notePauseExit();
		// Pad up to "now" so the file covers the full recording duration
		// (idle pages can leave seconds with no CDP frames otherwise).
		this.padToNow();
		this._state = "closed";

		// Stop the screencast and flush the first-pass writer. We always
		// wait on these before returning -- they're cheap and the caller
		// expects "stop = first-pass complete".
		try {
			await this.page.screencast.stop();
		} catch {
			/* may already be stopped if size check failed earlier */
		}

		if(wasInitial) {
			// autoStart=false and no start()/resume() ever called -- by
			// design, no file is written. Nothing to finalise either.
			this.warn("stop() called without start()/resume(); no file written");
			const empty: StopResult = { path: this.config.opts.path, frameCount: 0, written: false };
			this._finalized = Promise.resolve(empty);
			return empty;
		}

		// Drain pending writes, then close ffmpeg stdin and wait for the
		// child to exit. After this point the intermediate file is on
		// disk and ready for the second pass.
		await this._writeChain;
		if(this._ff?.stdin && !this._ff.stdin.destroyed) this._ff.stdin.end();
		if(this._ff) {
			const proc = this._ff;
			await new Promise<void>(resolve => { proc.on("close", () => resolve()); });
		}

		const firstPassResult: StopResult = {
			path: this.config.opts.path,
			frameCount: this._frameCount,
			written: true,
		};

		// Kick off the second pass in the background. Errors are swallowed
		// here -- they'll surface to anyone who awaits `finalized`. The
		// intermediate file is intentionally NOT deleted on failure so the
		// recording isn't lost.
		this._finalized = this.runSecondPass(firstPassResult);
		this._finalized.catch(() => { /* errors surface via finalized */ });

		return firstPassResult;
	}

	audio(path: string, options?: { offset?: number, absolute?: boolean }): void {
		if(this._state === "closed") {
			this.warn("audio() called after stop() -- no-op");
			return;
		}
		if(this._state === "paused" && options?.offset === undefined) {
			this.warn("audio() called while paused -- offset reflects the pause point, which is rarely intended");
		}
		// "Now" relative to recorded video t=0. We use wall-clock from
		// `_startWallMs` (set by start()/autoStart) rather than
		// `frameCount / fps`: frameCount only advances when CDP delivers a
		// frame, so between two CDP frames it lags behind real time by up
		// to ~1/fps. That lag would make click-sound offsets fire slightly
		// early and sound out of sync.
		const now = this._startWallMs === null ?
			0 :
			(performance.now() - this._startWallMs - this._pausedAccumMs) / MS_PER_SECOND;
		let offset: number;
		if(options?.offset === undefined) {
			offset = now;
		} else if(options.absolute) {
			offset = options.offset;
		} else {
			offset = now + options.offset;
		}
		this._audioTracks.push({ path, offset: Math.max(0, offset) });
	}

	/**
	 * Run the second-pass ffmpeg invocation: transcode the intermediate to
	 * the user's target codec/container, and mux any scheduled audio
	 * tracks in the same pass. Resolves with the final StopResult; rejects
	 * with the underlying ffmpeg error on failure (intermediate kept).
	 */
	private async runSecondPass(firstPass: StopResult): Promise<StopResult> {
		const args = buildSecondPassFfmpegArgs(
			this.config.intermediatePath,
			this.config.opts.path,
			this.config.secondPassArgs,
			this._audioTracks
		);
		await runFfmpeg(this.config.ffmpegPath, args);
		// Second pass succeeded: the intermediate is no longer needed.
		// Best-effort delete; a stranded intermediate is annoying but not
		// a correctness bug.
		await fs.unlink(this.config.intermediatePath).catch(() => { /* ignore */ });
		return firstPass;
	}

	private warn(msg: string): void {
		if(!this.config.opts.silenceWarnings) console.warn(`[playwright-recorder-plus] ${msg}`);
	}

	private onFrame(data: Buffer | ArrayBuffer): void {
		const nowMs = performance.now();
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

		if(!this._sizeChecked) {
			this._sizeChecked = true;
			const actual = parseJpegSize(buf);
			if(actual && (actual.width !== this.config.size.width || actual.height !== this.config.size.height)) {
				// Stop screencast and report. This is almost always a
				// "tracing started before recorder" mistake.
				this.page.screencast.stop().catch(() => { /* ignore */ });
				throw new Error(
					`playwright-recorder-plus: server delivered ${actual.width}x${actual.height}, ` +
					`expected ${this.config.size.width}x${this.config.size.height}. Cause: another screencast client ` +
					`(typically context.tracing.start with screenshots: true) started before ` +
					`attachRecorder. Move attachRecorder before any tracing.start call.`
				);
			}
		}

		// `nowMs` is when Node received the frame from CDP -- a few ms behind
		// the actual browser-side frame swap, but stable enough to lock the
		// encoded video's duration to wall-clock.
		this.ingestFrame(buf, nowMs);
	}

	/** Write one JPEG frame into ffmpeg stdin with backpressure. */
	private writeFrame(data: Buffer): void {
		if(!this._ff?.stdin || this._ff.stdin.destroyed) return;
		this._writeChain = this._writeChain.then(() => new Promise<void>(resolve => {
			const stdin = this._ff?.stdin;
			if(!stdin || stdin.destroyed) {
				resolve();
				return;
			}
			const ok = stdin.write(data);
			if(ok) resolve();
			else stdin.once("drain", resolve);
		}));
		this._frameCount++;
	}

	private ensureFfmpeg(): void {
		if(this._ff) return;
		// First pass writes to the intermediate file, NOT opts.path.
		this._ff = spawn(this.config.ffmpegPath, [...this.config.firstPassArgs, this.config.intermediatePath], {
			stdio: ["pipe", "ignore", "inherit"],
		});
		this._ff.on("error", err => {
			this.warn(`ffmpeg process error: ${err.message}`);
		});
	}

	/**
	 * Move into the "recording" state from "initial". Spawns the first-pass
	 * encoder, anchors the wall clock at this moment, and kicks off a
	 * baseline JPEG capture so static-page recordings can back-fill the
	 * pre-first-CDP-frame window with the correct page content rather than
	 * with whatever appears later (issue #1).
	 */
	private transitionToRecording(): void {
		this.ensureFfmpeg();
		if(this._startWallMs === null) this._startWallMs = performance.now();
		this._state = "recording";
		// Re-arm the baseline so it can refresh `_lastJpeg` for this leg
		// of the recording. resume() relies on this: at resume time the
		// page may look completely different than when we paused, but
		// `_lastJpeg` still holds the pre-pause frame -- the baseline
		// screenshot replaces it with what the page actually looks like
		// now.
		this._baselineConsumed = false;
		this.captureBaselineJpeg();
	}

	/**
	 * Take a JPEG screenshot of the page right now and use it as the
	 * back-fill image for slots that need padding before the next CDP
	 * frame arrives. Used by both:
	 *
	 *   - `start()` / `autoStart`: there is no `_lastJpeg` yet, and on a
	 *     static page CDP may not deliver a frame until something
	 *     changes -- without this baseline, back-fill would use the
	 *     first post-change frame (issue #1).
	 *   - `resume()`: `_lastJpeg` still holds the pre-pause frame, but
	 *     the page may look very different now. Without this baseline,
	 *     back-fill of the post-resume static window would show the
	 *     stale pre-pause content (issue #2).
	 *
	 * Runs in the background. The result is dropped if a real CDP frame
	 * has been ingested in the meantime (`_baselineConsumed`), so we
	 * never overwrite a fresher frame with this older screenshot.
	 *
	 * Failures are non-fatal: we just fall back to the previous
	 * `_lastJpeg` (null on start, pre-pause frame on resume).
	 */
	private captureBaselineJpeg(): void {
		const expectedWidth = this.config.size.width;
		const expectedHeight = this.config.size.height;
		this.page.screenshot({
			type: "jpeg",
			quality: this.config.opts.jpegQuality,
			clip: { x: 0, y: 0, width: expectedWidth, height: expectedHeight },
			// Force output dimensions to match CSS pixels regardless of
			// deviceScaleFactor. WebKit otherwise returns a 2x-scaled
			// image when DPR > 1, which would not match the screencast
			// frame size and get rejected below.
			scale: "css",
		}).then(buf => {
			// A real CDP frame has already arrived for this transition;
			// using the older screenshot would regress accuracy.
			if(this._baselineConsumed) return;
			// If the screenshot dimensions don't match our screencast
			// size, don't use it -- mixed-size frames would confuse the
			// encoder. Falling back to the previous _lastJpeg is fine,
			// just less accurate.
			const actual = parseJpegSize(buf);
			if(!actual || actual.width !== expectedWidth || actual.height !== expectedHeight) return;
			this._lastJpeg = buf;
			this._baselineConsumed = true;
		}).catch(() => { /* page may be closing; fall back silently */ });
	}

	/**
	 * Schedule a frame for the encoder.
	 * - `_startWallMs` (set by start()/autoStart) anchors t=0.
	 * - Each frame is given `frameNumber = floor(elapsed * fps)` where
	 *   `elapsed = nowMs - startWallMs - pausedAccumMs`.
	 * - Gaps since the last write are filled with copies of the previous
	 *   frame.
	 * - The very first frame may arrive several seconds after start() (CDP
	 *   only sends frames when the page changes). For back-filling slots
	 *   0..N-1 we prefer the baseline JPEG captured at start time (see
	 *   `captureBaselineJpeg`); if it isn't ready yet we fall back to the
	 *   current frame, which still preserves wall-clock duration even if
	 *   it can be visually wrong when the page changed mid-stream.
	 *
	 * Frames received during `paused` state are dropped; pausedAccumMs
	 * excludes paused intervals from the elapsed computation.
	 */
	private ingestFrame(buf: Buffer, nowMs: number): void {
		if(this._state !== "recording" || this._startWallMs === null) return;

		// Mark the baseline as consumed even when we drop this frame as
		// a same-slot duplicate -- we still saw a fresher CDP frame for
		// this leg, so the in-flight `captureBaselineJpeg` should not
		// later overwrite `_lastJpeg` with its older snapshot.
		this._baselineConsumed = true;

		const elapsedMs = nowMs - this._startWallMs - this._pausedAccumMs;
		const frameNumber = Math.floor(elapsedMs * this.config.fps / MS_PER_SECOND);

		// Drop frames that fall in the same slot as the previous one (CDP
		// can deliver faster than `fps` on lively pages -- a 60Hz animation
		// at fps=25 yields ~2.4 CDP frames per slot, all but one of which
		// must be discarded or the encoded video runs slow-motion).
		if(frameNumber <= this._lastFrameNumber) {
			this._lastJpeg = buf;
			return;
		}

		// Pad the gap since the last write. `_lastJpeg` is the baseline
		// screenshot when set by `captureBaselineJpeg`, the previous CDP
		// frame on subsequent calls, or null if neither has happened (in
		// which case we use the current frame -- not ideal but it
		// preserves duration).
		const padJpeg = this._lastJpeg ?? buf;
		const padFrom = this._lastFrameNumber + 1;
		for(let i = padFrom; i < frameNumber; i++) this.writeFrame(padJpeg);
		this.writeFrame(buf);
		this._lastFrameNumber = frameNumber;
		this._lastJpeg = buf;
	}

	/**
	 * Pad frames up to "now" using the most recent frame. Called from
	 * `stop()` so the encoded video covers the full wall-clock duration up
	 * to the moment recording ended -- otherwise the file would end at the
	 * last actual CDP frame, which can be seconds earlier on idle pages.
	 *
	 * If no CDP frames ever arrived, there's nothing to repeat and nothing
	 * is written. (A page that produces zero frames yields an empty file.)
	 */
	private padToNow(): void {
		if(this._startWallMs === null || !this._lastJpeg) return;
		const elapsedMs = performance.now() - this._startWallMs - this._pausedAccumMs;
		const targetFrame = Math.floor(elapsedMs * this.config.fps / MS_PER_SECOND);
		const repeatCount = targetFrame - this._lastFrameNumber;
		for(let i = 0; i < repeatCount; i++) this.writeFrame(this._lastJpeg);
		this._lastFrameNumber = targetFrame;
	}

	/** Bookkeeping for paused intervals so they don't bake into the file. */
	private notePauseEnter(): void {
		this._pauseStartedAtMs = performance.now();
	}

	private notePauseExit(): void {
		if(this._pauseStartedAtMs !== null) {
			this._pausedAccumMs += performance.now() - this._pauseStartedAtMs;
			this._pauseStartedAtMs = null;
		}
	}
}

