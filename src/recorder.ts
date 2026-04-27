import { spawn } from "node:child_process";
import fs from "node:fs/promises";

import { pickAudioCodec } from "./defaults";
import { parseJpegSize } from "./jpeg";

import type { ChildProcess } from "node:child_process";
import type { Page } from "playwright-core";
import type { AudioTrack, Recorder, RecorderOptions, RecorderState, StopResult } from "./types";

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

	// Final-result promise: resolves when both first pass (capture) and
	// second pass (transcode + audio mux) have completed. Stored so a
	// repeated stop() returns the same result.
	private _finalized: Promise<StopResult> | null = null;

	constructor(
		private readonly page: Page,
		private readonly opts: RecorderOptions,
		private readonly ffmpegPath: string,
		private readonly firstPassArgs: string[],
		private readonly secondPassArgs: string[],
		private readonly intermediatePath: string,
		private readonly fps: number,
		private readonly size: { width: number, height: number }
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
			size: this.size,
			quality: this.opts.jpegQuality,
			onFrame: ({ data }) => this.onFrame(data),
		});
		if(autoStart) {
			this.ensureFfmpeg();
			this._startWallMs = performance.now();
			this._state = "recording";
		}
	}

	start(): Promise<void> {
		const warn = this.warn.bind(this);
		if(this._state === "initial") {
			this.ensureFfmpeg();
			this._startWallMs = performance.now();
			this._state = "recording";
		} else if(this._state === "recording") {
			warn("start() called but already recording -- no-op");
		} else if(this._state === "paused") {
			warn("start() called while paused -- use resume() instead. Resuming anyway.");
			this.notePauseExit();
			this._state = "recording";
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
			this.ensureFfmpeg();
			this._startWallMs = performance.now();
			this._state = "recording";
		} else if(this._state === "recording") {
			warn("resume() called but already recording -- no-op");
		} else if(this._state === "paused") {
			this.notePauseExit();
			this._state = "recording";
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
			return { path: this.opts.path, frameCount: this._frameCount, written: this._ff !== null };
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
			const empty: StopResult = { path: this.opts.path, frameCount: 0, written: false };
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
			path: this.opts.path,
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
			this.intermediatePath,
			this.opts.path,
			this.secondPassArgs,
			this._audioTracks
		);
		await runFfmpeg(this.ffmpegPath, args);
		// Second pass succeeded: the intermediate is no longer needed.
		// Best-effort delete; a stranded intermediate is annoying but not
		// a correctness bug.
		await fs.unlink(this.intermediatePath).catch(() => { /* ignore */ });
		return firstPass;
	}

	private warn(msg: string): void {
		if(!this.opts.silenceWarnings) console.warn(`[playwright-recorder-plus] ${msg}`);
	}

	private onFrame(data: Buffer | ArrayBuffer): void {
		const nowMs = performance.now();
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

		if(!this._sizeChecked) {
			this._sizeChecked = true;
			const actual = parseJpegSize(buf);
			if(actual && (actual.width !== this.size.width || actual.height !== this.size.height)) {
				// Stop screencast and report. This is almost always a
				// "tracing started before recorder" mistake.
				this.page.screencast.stop().catch(() => { /* ignore */ });
				throw new Error(
					`playwright-recorder-plus: server delivered ${actual.width}x${actual.height}, ` +
					`expected ${this.size.width}x${this.size.height}. Cause: another screencast client ` +
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
		this._ff = spawn(this.ffmpegPath, [...this.firstPassArgs, this.intermediatePath], {
			stdio: ["pipe", "ignore", "inherit"],
		});
		this._ff.on("error", err => {
			this.warn(`ffmpeg process error: ${err.message}`);
		});
	}

	/**
	 * Schedule a frame for the encoder.
	 * - `_startWallMs` (set by start()/autoStart) anchors t=0.
	 * - Each frame is given `frameNumber = floor(elapsed * fps)` where
	 *   `elapsed = nowMs - startWallMs - pausedAccumMs`.
	 * - Gaps since the last write are filled with copies of the previous
	 *   frame.
	 * - The very first frame may arrive several seconds after start() (CDP
	 *   only sends frames when the page changes); we back-fill those slots
	 *   with copies of *that* first frame, so the encoded video starts at
	 *   wall-clock t=0 with whatever the page looks like initially.
	 *
	 * Frames received during `paused` state are dropped; pausedAccumMs
	 * excludes paused intervals from the elapsed computation.
	 */
	private ingestFrame(buf: Buffer, nowMs: number): void {
		if(this._state !== "recording" || this._startWallMs === null) return;

		const elapsedMs = nowMs - this._startWallMs - this._pausedAccumMs;
		const frameNumber = Math.floor(elapsedMs * this.fps / MS_PER_SECOND);

		// Drop frames that fall in the same slot as the previous one (CDP
		// can deliver faster than `fps` on lively pages -- a 60Hz animation
		// at fps=25 yields ~2.4 CDP frames per slot, all but one of which
		// must be discarded or the encoded video runs slow-motion).
		if(frameNumber <= this._lastFrameNumber) {
			this._lastJpeg = buf;
			return;
		}

		// Pad the gap since the last write. Two cases:
		// - First frame ever (`_lastFrameNumber === -1`): back-fill slots
		//   0..frameNumber-1 with copies of the current frame. (We have no
		//   previous frame to use, so the first observed frame is our
		//   best representation of what the page looked like.)
		// - Subsequent frames: pad with the previous frame, since the gap
		//   represents a period where nothing changed.
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
		const targetFrame = Math.floor(elapsedMs * this.fps / MS_PER_SECOND);
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

const SECONDS_TO_MS = 1000;

/**
 * Build the second-pass argv. Layout is:
 *
 *   ffmpeg -loglevel error -y -i <intermediate>
 *          [-i <audio_i>]*
 *          [-filter_complex "<adelay/amix graph>"]
 *          -map 0:v
 *          [-map [aout]]
 *          <secondPassCodecArgs>          // user / preset codec choice
 *          [-c:a <audio codec for output>]
 *          <outPath>
 *
 * When there are no audio tracks the audio mapping and codec are omitted
 * entirely; the second pass is then just a video transcode.
 *
 * `secondPassCodecArgs` covers the video stream: `-c:v ... -preset ...`
 * etc. It must NOT include `-i` or the output path -- we add those.
 */
function buildSecondPassFfmpegArgs(
	intermediatePath: string,
	outPath: string,
	secondPassCodecArgs: string[],
	tracks: AudioTrack[]
): string[] {
	const args = ["-loglevel", "error", "-y", "-i", intermediatePath];
	for(const track of tracks) {
		args.push("-i", track.path);
	}

	if(tracks.length > 0) {
		// Build the filter graph. Track i corresponds to ffmpeg input
		// (i + 1) because input 0 is the video.
		//   [1:a]adelay=<ms>|<ms>[a0]; [2:a]adelay=...[a1]; ...
		//   [a0][a1]...amix=inputs=N[aout]
		const filterParts: string[] = [];
		const labels: string[] = [];
		for(let i = 0; i < tracks.length; i++) {
			const offsetMs = Math.max(0, Math.round(tracks[i].offset * SECONDS_TO_MS));
			const label = `a${i}`;
			// `adelay=<ms>|<ms>` applies the delay to all channels (stereo here).
			filterParts.push(`[${i + 1}:a]adelay=${offsetMs}|${offsetMs}[${label}]`);
			labels.push(`[${label}]`);
		}
		const mixLabel = "aout";
		filterParts.push(
			`${labels.join("")}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0[${mixLabel}]`
		);
		args.push("-filter_complex", filterParts.join(";"), "-map", "0:v", "-map", `[${mixLabel}]`);
	} else {
		args.push("-map", "0:v");
	}

	args.push(...secondPassCodecArgs);

	if(tracks.length > 0) {
		args.push("-c:a", pickAudioCodec(outPath));
	}

	// No `-shortest`: scheduled audio can extend past the video end
	// (delays + clip lengths). Trimming the muxed file to the shorter
	// stream caused a 7-second silent regression; do not re-add.
	args.push(outPath);
	return args;
}

/** Spawn ffmpeg, await its exit, reject on non-zero. */
function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "inherit"] });
		proc.on("error", reject);
		proc.on("close", code => {
			if(code === 0) resolve();
			else reject(new Error(`ffmpeg exited with code ${code}`));
		});
	});
}
