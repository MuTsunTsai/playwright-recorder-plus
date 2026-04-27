import type { RecorderOptions } from "./types";

export const DEFAULT_FPS = 25;
export const DEFAULT_JPEG_QUALITY = 100;
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/**
 * First-pass ffmpeg arguments. Always H.264 with `-preset ultrafast` so the
 * encoder cannot fall behind realtime: stdin backpressure stalls Node-side
 * `onFrame` ingestion, which makes the ingestion clock drift behind wall-
 * clock and produces a video shorter than the recording session. Trying to
 * shave bytes here is what wrecks the timeline; do compression in the
 * second pass instead.
 *
 * `-pix_fmt yuv420p` keeps intermediate playable in any tool. `+faststart`
 * is harmless on the intermediate (it gets re-muxed in pass 2 anyway).
 *
 * NOT user-configurable. The whole architecture rests on this being fast.
 */
const FIRST_PASS_ARGS = [
	"-loglevel", "error",
	"-f", "image2pipe",
	"-c:v", "mjpeg",
	"-i", "pipe:0",
	"-y",
	"-an",
	// fps_mode passthrough: emit one output frame per input frame, no
	// dropping, no duplication. Frame timing is computed Node-side in
	// `ingestFrame`; ffmpeg must not second-guess us. (Equivalent to the
	// deprecated `-vsync 0`, modern syntax.)
	"-fps_mode", "passthrough",
	"-c:v", "libx264",
	"-preset", "ultrafast",
	"-crf", "18",
	"-pix_fmt", "yuv420p",
	"-movflags", "+faststart",
];

/**
 * Compose the first-pass ffmpeg argv. `-r <fps>` is inserted before `-i`
 * so it applies to the input stream; an optional `-vf crop=...` filter
 * is appended.
 */
export function buildFirstPassArgs(opts: RecorderOptions, fps: number): string[] {
	const args = [...FIRST_PASS_ARGS];
	const iIndex = args.indexOf("-i");
	args.splice(iIndex, 0, "-r", String(fps));
	if(opts.crop) {
		const { x, y, width, height } = opts.crop;
		args.push("-vf", `crop=${width}:${height}:${x}:${y}`);
	}
	return args;
}

/**
 * Built-in second-pass presets. Each value returns the argv tail that
 * goes between `-i <intermediate>` and the output path.
 *
 * - `youtube`: H.264 / mp4 with sane upload defaults. Container-friendly
 *   defaults (yuv420p, +faststart) so the file streams without scanning.
 * - `web`: VP9 / webm. Smaller than H.264 at similar quality and natively
 *   decoded by browsers.
 *
 * Filter graph for muxing audio is applied uniformly by the caller; the
 * preset only contributes codec choices and container-level flags.
 */
export type SecondPassPreset = "youtube" | "web";

export function buildSecondPassArgs(preset: SecondPassPreset): string[] {
	if(preset === "web") {
		return [
			"-c:v", "libvpx-vp9",
			"-crf", "30",
			"-b:v", "0",
			"-deadline", "good",
			"-speed", "2",
			"-row-mt", "1",
			"-tile-columns", "2",
			"-pix_fmt", "yuv420p",
		];
	}
	// youtube
	return [
		"-c:v", "libx264",
		"-preset", "medium",
		"-crf", "20",
		"-profile:v", "main",
		"-pix_fmt", "yuv420p",
		"-movflags", "+faststart",
	];
}

/**
 * Pick a default preset based on the output extension. `.webm` / `.ogg` /
 * `.ogv` -> `web`, anything else -> `youtube`.
 */
export function defaultPresetForPath(path: string): SecondPassPreset {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if(ext === "webm" || ext === "ogg" || ext === "ogv") return "web";
	return "youtube";
}

/**
 * Audio codec compatible with the output container. WebM-family only
 * accepts Vorbis/Opus; mp4/mov accept AAC. Default to AAC for unknown
 * extensions.
 */
export function pickAudioCodec(outPath: string): string {
	const ext = outPath.slice(outPath.lastIndexOf(".") + 1).toLowerCase();
	if(ext === "webm" || ext === "ogg" || ext === "ogv") return "libopus";
	return "aac";
}

/**
 * Default intermediate-file path: `<dirname>/<basename>.intermediate.mp4`.
 * Always mp4 since the first pass is fixed at H.264.
 */
export function defaultIntermediatePath(finalPath: string): string {
	const dot = finalPath.lastIndexOf(".");
	const base = dot >= 0 ? finalPath.slice(0, dot) : finalPath;
	return `${base}.intermediate.mp4`;
}
