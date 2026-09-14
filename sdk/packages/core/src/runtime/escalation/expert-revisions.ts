/**
 * Every version of every file the expert writes, for as long as the escalation
 * lasts.
 *
 * WHY THE BASE MODEL NEEDS THIS. It is live while the expert works and it is
 * told what the expert did in batches, which means every note describes a
 * moment that has already passed. By the time the base reads "the expert edited
 * manic_miner.html" the expert has edited it twice more, so a base that opens
 * the file on disk is checking a claim against evidence that has moved under
 * it. The revision number is the fixed point: it names the exact bytes the note
 * was about, and `read_files` with `revision` serves them. That is what turns
 * "I fixed function A and the linter is quiet" from an assertion into something
 * testable (user, 2026-09-14: "this is a testable statement if run on the right
 * snapshot").
 *
 * WHY IT IS NOT THE CHANGE PROTOCOL'S LOG. The protocol's revisions belong to
 * the base model's open transaction -- its budget, its plan, its rollback --
 * and the expert is not in that arrangement at all; as of this build it is not
 * even given the protocol's tools. Sharing one log would mean the expert's
 * writes renumbering the base model's history, and `restore_file` offering to
 * put back a version the base never made.
 *
 * WHY IT IS PURGED AT THE END. A revision is worth holding while there is still
 * a claim to check. When the escalation closes, the delivery has been made, the
 * base has accepted or pushed back, and what is left is copies of files held in
 * memory for a conversation that is over (user, 2026-09-14: "once the expert
 * escalation is done, we purge the snapshots").
 *
 * The log, the de-duplication, the memory cap and the read decoration are all
 * `runtime/atomic`'s, unchanged. This is the escalation's own instance of them.
 */

import {
	createRevisionLog,
	type FileRevision,
	type RevisionLog,
} from "../atomic/file-revisions";
import type { RevisionCaptureSource } from "../atomic/revision-capture";
import type { Snapshot } from "../atomic/snapshot";

export interface ExpertRevisions {
	/**
	 * What `withRevisionCapture` needs to decorate the expert's tools.
	 *
	 * Read through rather than copied: the base snapshot arrives when the
	 * escalation opens, which is after the expert's tools have been built.
	 */
	readonly source: RevisionCaptureSource;
	/** Begin an escalation's history at the workspace as it stands now. */
	open(base: Snapshot, index: number): void;
	/** Every version of one file, oldest first. #1 is as the escalation opened. */
	revisions(absolutePath: string): readonly FileRevision[];
	/** Files anything has been recorded for. */
	tracked(): readonly string[];
	/**
	 * The highest revision held for each file.
	 *
	 * What the note-taker diffs across a tool call to work out what that call
	 * wrote, without having to know what any particular tool's input means. A
	 * tool that writes two files in one call shows up as two entries moving,
	 * and a tool that writes nothing shows up as nothing moving -- which is
	 * also the right answer for a read.
	 */
	heads(): ReadonlyMap<string, number>;
	/** The escalation is over. Drop the history and the claim on the workspace. */
	purge(): void;
}

export function createExpertRevisions(): ExpertRevisions {
	let log: RevisionLog = createRevisionLog();
	let pending: Snapshot | undefined;
	let index = 0;

	const source: RevisionCaptureSource = {
		get pending() {
			return pending;
		},
		get transaction() {
			return index;
		},
		get log() {
			return log;
		},
	};

	return {
		source,
		open(base, escalation) {
			// A fresh log rather than a reset one, so #1 cannot mean "as some
			// earlier escalation opened" -- a second escalation is a second
			// question asked against a workspace the first one changed.
			log = createRevisionLog();
			pending = base;
			index = escalation;
		},
		revisions(absolutePath) {
			return log.revisions(absolutePath);
		},
		tracked() {
			return log.tracked();
		},
		heads() {
			const heads = new Map<string, number>();
			for (const path of log.tracked()) {
				const held = log.revisions(path);
				const last = held[held.length - 1];
				if (last) {
					heads.set(path, last.index);
				}
			}
			return heads;
		},
		purge() {
			log.reset();
			log = createRevisionLog();
			pending = undefined;
			index = 0;
		},
	};
}
