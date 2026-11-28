/**
 * The pixel size of a screenshot, and the line that tells the model about it.
 *
 * Some models (and some providers in front of them) rescale an image before
 * the model sees it. GLM saw the browser tool's 900×600 screenshots about
 * 1000 px wide, so every click it read off the picture landed ~11% too far
 * right and down, and a click on a narrow input silently hit nothing
 * (session 1795889478074_yraiv). Stating the real size lets a model that
 * sees something else scale its coordinates.
 */

/** Width and height of a PNG or JPEG, from its bytes; undefined for anything else. */
export function imageSize(
	bytes: Uint8Array,
): { width: number; height: number } | undefined {
	// PNG: 8-byte signature, then the IHDR chunk with width and height.
	if (
		bytes.length >= 24 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	// JPEG: walk the segments to a start-of-frame marker.
	if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff) return undefined;
			const marker = bytes[at + 1];
			const length = (bytes[at + 2] << 8) | bytes[at + 3];
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return {
					height: (bytes[at + 5] << 8) | bytes[at + 6],
					width: (bytes[at + 7] << 8) | bytes[at + 8],
				};
			}
			at += 2 + length;
		}
	}
	return undefined;
}

export function imageSizeFromBase64(
	data: string,
): { width: number; height: number } | undefined {
	// The header is all that is needed; decoding a few KB is plenty for a JPEG's frame marker too.
	return imageSize(
		new Uint8Array(Buffer.from(data.slice(0, 65_536), "base64")),
	);
}

/** The line put beside a screenshot whose pixels are click coordinates. */
export function screenshotSizeNote(
	size: { width: number; height: number } | undefined,
): string {
	if (!size) return "";
	return `Screenshot: ${size.width}×${size.height} px. Coordinates are in these pixels; if the image you see has another size, scale your x and y to it.`;
}
