/**
 * The transaction's base revision, addressed by path.
 *
 * A transaction already holds what every file said when it opened — that copy
 * is the undo the whole protocol is built on. Until now only the rollback
 * could read it, and the model, having mangled a file, had to reconstruct the
 * original from memory.
 *
 * Measured on the run that prompted this (pandorum, 2026-09-05, 7328s, three
 * discarded transactions): 22 of 43 edits re-edited a line the same
 * transaction had already edited, and 91% of the run's wall clock fell after
 * the model first wrote "I accidentally deleted the entire `dDec` method. Let
 * me restore it correctly" — restoring, from memory, a 400-character minified
 * line. The snapshot next door had it exactly.
 *
 * So: one resolver, shared by the read side and the restore side, and it
 * distinguishes the cases rather than collapsing them into "not found". A file
 * the transaction created and a file the snapshot could not hold both have no
 * base revision, and they mean opposite things.
 */

import * as path from "node:path";
import type { Snapshot } from "./snapshot";

/** How a requested path relates to the transaction's base. */
export type BaseFileLookup =
	/** The snapshot holds it, with these bytes. */
	| {
			readonly kind: "held";
			readonly absolutePath: string;
			readonly body: Buffer;
	  }
	/**
	 * Inside the snapshot's root, and the snapshot does not hold it — so this
	 * transaction created it. Its base revision is the file not existing, which
	 * is a real answer and not a failure.
	 */
	| { readonly kind: "created"; readonly absolutePath: string }
	/** The snapshot skipped it: too large, a symlink, or past the limits. */
	| { readonly kind: "uncovered"; readonly absolutePath: string }
	/** Outside the root the transaction covers, so nothing was ever held. */
	| { readonly kind: "outside"; readonly absolutePath: string };

/**
 * Resolve a path the model gave against the transaction's base.
 *
 * Relative paths resolve against the snapshot's root rather than the process
 * working directory: the root is what the transaction covers, and resolving
 * elsewhere would report "outside the transaction" for a file sitting in it.
 */
export function resolveBaseFile(
	snapshot: Snapshot,
	requestedPath: string,
): BaseFileLookup {
	const absolutePath = path.normalize(
		path.isAbsolute(requestedPath)
			? requestedPath
			: path.resolve(snapshot.root, requestedPath),
	);

	const held = snapshot.files.get(absolutePath);
	if (held) {
		return { kind: "held", absolutePath, body: held.body };
	}
	if (snapshot.skipped.includes(absolutePath)) {
		return { kind: "uncovered", absolutePath };
	}
	const root = path.normalize(snapshot.root);
	const relative = path.relative(root, absolutePath);
	const inside =
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
	return inside
		? { kind: "created", absolutePath }
		: { kind: "outside", absolutePath };
}

/**
 * Why a path has no base text to show, in the words the model gets.
 *
 * Never "not found": each of these is a different fact about the transaction,
 * and a model told the wrong one goes looking for the wrong thing.
 */
export function describeMissingBase(
	lookup: Exclude<BaseFileLookup, { kind: "held" }>,
): string {
	switch (lookup.kind) {
		case "created":
			return "This transaction created that file — before it, the file did not exist, so there is no earlier version of it to show.";
		case "uncovered":
			return "That file is outside what this transaction can put back: it was too large to hold, or it is a symlink. Nothing was kept for it, so it has no base revision and a rollback would not restore it either.";
		case "outside":
			return "That path is outside the directory this transaction covers, so nothing was held for it.";
	}
}

/** Whether a snapshot's bytes can be shown as text at all. */
export function isTextBody(body: Buffer): boolean {
	// A NUL in the first block is the same test the rest of the tree uses to
	// refuse a binary read, and it is cheap enough to run on every call.
	return !body.subarray(0, 8000).includes(0);
}
