/* eslint-disable @typescript-eslint/no-magic-numbers -- JPEG byte-level parsing follows the spec */

// JPEG SOF (Start Of Frame) marker bytes from ITU-T T.81 spec. Each one
// indicates a frame header that carries the image dimensions in the next
// few bytes after the marker.
const JPEG_SOF_MARKERS = new Set([
	0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
	0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
]);

/**
 * Parse a JPEG SOF marker to extract image dimensions. Used to verify the
 * screencast server delivered the requested frame size; a mismatch points
 * to another screencast client (most commonly tracing) having locked the
 * size first.
 */
export function parseJpegSize(buf: Buffer): { width: number, height: number } | null {
	// SOI marker (0xFFD8) must start every JPEG.
	if(buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
	let i = 2;
	while(i < buf.length - 1) {
		if(buf[i] !== 0xFF) return null;
		const marker = buf[i + 1];
		if(marker === undefined) return null;
		if(JPEG_SOF_MARKERS.has(marker)) {
			// SOF segment layout: 0xFF, marker, length(2), precision(1),
			// height(2), width(2). We need bytes [i+5..i+8].
			if(i + 9 >= buf.length) return null;
			const height = buf.readUInt16BE(i + 5);
			const width = buf.readUInt16BE(i + 7);
			return { width, height };
		}
		// Skip this segment: each non-SOF segment after the marker carries a
		// 2-byte length field that includes its own size.
		const segLen = buf.readUInt16BE(i + 2);
		i += 2 + segLen;
	}
	return null;
}
