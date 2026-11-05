/**
 * The guard for the executors that read a whole file into one string: `sed`,
 * `awk`, `grep` and `search_codebase`.
 *
 * `read_files` streams and refuses past {@link MAX_TEXT_STREAM_BYTES}; these
 * did not look before reading. A 150,400,128-byte compiled test runner read by
 * `sed` with `1,10p` became a string the process could not hold, and Node died
 * out of heap (exit 134) a second later, taking the session with it. The size
 * is known from a stat and a binary from its first bytes, so both are refused
 * before anything is read.
 */

import { promises as fs } from "node:fs";

/** The largest text file a tool reads: `read_files`' own limit. */
export const MAX_TEXT_STREAM_BYTES = 100_000_000;

/** How far into a file a NUL makes it binary, which is how grep decides. */
export const BINARY_SNIFF_BYTES = 8_000;

/** Why a file is not read whole: too large, or not text. */
export interface WholeFileRefusal {
	kind: "size" | "binary";
	message: string;
}

/**
 * Why `filePath` must not be read whole, or nothing when it may. A path that
 * cannot be opened is left to the caller's own read, which says why.
 */
export async function wholeFileRefusal(
	filePath: string,
	tool: string,
): Promise<WholeFileRefusal | undefined> {
	let size: number;
	let head: Uint8Array;
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) return undefined;
		size = stat.size;
		head = await readHead(filePath, BINARY_SNIFF_BYTES);
	} catch {
		return undefined;
	}
	if (size > MAX_TEXT_STREAM_BYTES) {
		return {
			kind: "size",
			message: `not read: ${size} bytes is over the ${MAX_TEXT_STREAM_BYTES} bytes ${tool} reads (it holds the whole file in memory). Look at parts of it with run_commands (head, tail, grep -n).`,
		};
	}
	if (head.includes(0)) {
		return {
			kind: "binary",
			message: `not read: it is a binary file (a NUL byte in its first ${BINARY_SNIFF_BYTES} bytes), and ${tool} works on text. To learn what it is, run \`file\` on it with run_commands.`,
		};
	}
	return undefined;
}

async function readHead(filePath: string, bytes: number): Promise<Uint8Array> {
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = new Uint8Array(bytes);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}
