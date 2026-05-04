import { spawn } from "node:child_process";

import { pickAudioCodec } from "./defaults";

import type { AudioTrack } from "./types";

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
export function buildSecondPassFfmpegArgs(
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
export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "inherit"] });
		proc.on("error", reject);
		proc.on("close", code => {
			if(code === 0) resolve();
			else reject(new Error(`ffmpeg exited with code ${code}`));
		});
	});
}
