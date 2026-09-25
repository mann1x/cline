/**
 * Read receipts -- and what the agent is shown -- for a delegated agent
 * working over an overlay.
 *
 * The agent reads a file where it currently lives -- the lead's workspace until
 * the agent first writes it, its own overlay copy after -- and the editor
 * checks the path it is about to write, which is always the overlay copy. Keyed
 * by the raw path, the read and the edit are two different files: every first
 * edit of an existing file was refused as "not read", and the refusal sent the
 * agent to read the overlay path itself, a directory it was never meant to see.
 *
 * So every path is keyed by the workspace file it stands for, and the copy-up
 * carries the read's stamp across: the copy is a new file on disk, and without
 * this the stale-read guard reads its fresh mtime as someone else's write. The
 * stamp moves only when the workspace file is still what the agent read -- if
 * the lead changed it in between, the edit is refused as it should be.
 */

import type { AgentOverlay } from "../../../runtime/sandbox/overlay-fs";
import { type ReadReceipts, readFileStamp } from "./read-receipts";

export function overlayReadReceipts(
	receipts: ReadReceipts,
	overlay: AgentOverlay,
): ReadReceipts {
	const key = (filePath: string): string => overlay.logicalPath(filePath);
	overlay.onCopyUp(async (wsPath, ovPath) => {
		if (!receipts.hasEverRead(wsPath)) {
			return;
		}
		if (receipts.changedSince(wsPath, await readFileStamp(wsPath))) {
			return;
		}
		receipts.noteStamp(wsPath, await readFileStamp(ovPath));
	});
	return {
		noteRead: (filePath, first, last) =>
			receipts.noteRead(key(filePath), first, last),
		covers: (filePath, first, last) =>
			receipts.covers(key(filePath), first, last),
		hasAny: (filePath) => receipts.hasAny(key(filePath)),
		hasEverRead: (filePath) => receipts.hasEverRead(key(filePath)),
		wasRetired: (filePath) => receipts.wasRetired(key(filePath)),
		noteWrite: (filePath, linesBefore, linesAfter) =>
			receipts.noteWrite(key(filePath), linesBefore, linesAfter),
		noteStamp: (filePath, stamp) => receipts.noteStamp(key(filePath), stamp),
		changedSince: (filePath, stamp) =>
			receipts.changedSince(key(filePath), stamp),
		retire: (filePath) => receipts.retire(key(filePath)),
		forget: (filePath) => receipts.forget(key(filePath)),
		paths: () => receipts.paths(),
	};
}

/**
 * `executor`, with every path into the overlay in what it returns or throws
 * rewritten to the workspace path it stands for. See {@link AgentOverlay.redact}.
 */
export function withoutOverlayPaths<
	F extends (...args: never[]) => Promise<unknown>,
>(executor: F, overlay: AgentOverlay): F {
	return (async (...args: Parameters<F>) => {
		try {
			return redactDeep(await executor(...args), overlay);
		} catch (error) {
			if (error instanceof Error) {
				error.message = overlay.redact(error.message);
				if (typeof error.stack === "string") {
					error.stack = overlay.redact(error.stack);
				}
				throw error;
			}
			throw typeof error === "string" ? overlay.redact(error) : error;
		}
	}) as F;
}

function redactDeep(value: unknown, overlay: AgentOverlay): unknown {
	if (typeof value === "string") {
		return overlay.redact(value);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redactDeep(entry, overlay));
	}
	if (
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				redactDeep(entry, overlay),
			]),
		);
	}
	return value;
}
