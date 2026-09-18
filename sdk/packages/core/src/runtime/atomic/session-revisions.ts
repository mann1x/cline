/**
 * File history for a whole session, whether or not the change protocol is on.
 *
 * The log used to belong to the transaction: `createRevisionLog()` was a field
 * on `TransactionController`, `withRevisionCapture` had two call sites and both
 * were anchored to a base `Snapshot`, and `--atomic off` therefore recorded
 * nothing at all. Two things that do not depend on the protocol depended on it
 * anyway:
 *
 * - the compaction ledger's closing section, `src/parser.ts #1–#7`, which is
 *   how a summary says "the content is not here, it is at this address". It
 *   rendered empty in every one of the 36 compactions of the 12-run A/B,
 *   because that arm ran with the protocol off;
 * - and recovery, which is the reason the whole thing exists. A session that
 *   destroys a file wants its earlier content back; whether a transaction was
 *   open when it happened is not the model's question.
 *
 * So the log is the session's, and the transaction is one consumer of it. The
 * protocol is handed this object instead of making its own, which also keeps
 * the numbering continuous: a session that engages the protocol part-way
 * through does not restart `#1` underneath a model that has already been told
 * where `#4` is.
 */

import { readFile as readFileFromDisk } from "node:fs/promises";
import type { AgentTool, AgentToolDefinition } from "@cline/shared";
import type { CompactionRevisions } from "../../extensions/context/compaction-revisions";
import {
	SESSION_REVISION_WORDING,
	withBaseRevisionReads,
} from "./base-revision-reads";
import {
	createRevisionLog,
	type RevisionLog,
	revisionSpan,
} from "./file-revisions";
import { createRestoreFileTool } from "./restore-file-tool";
import { withRevisionCapture } from "./revision-capture";

export interface SessionRevisions {
	/** The log itself, to hand to the change protocol so both share one. */
	readonly log: RevisionLog;
	/** What compaction reads and writes. */
	readonly port: CompactionRevisions;
	/**
	 * Tools that exist because the history does.
	 *
	 * Just `restore_file` today, and it is the reason any of this is worth
	 * having: it was added by the change protocol's `decorateTools` and by
	 * nothing else, so a session with the protocol off could record nothing and
	 * undo nothing. Added by the host only when the protocol is absent — with
	 * it, the protocol adds its own, bound to the transaction.
	 */
	readonly tools: readonly AgentTool[];
	/**
	 * Wrap the session's tools so writes are recorded.
	 *
	 * Called by the host **only when the protocol is not installed**: the
	 * protocol's own `decorateTools` already wraps the same list against the
	 * same log, and wrapping twice would record every write as two revisions.
	 */
	decorate<T extends AgentToolDefinition>(tools: readonly T[]): T[];
}

export function createSessionRevisions(options: {
	/** Where relative paths resolve, and the edge of what is tracked. */
	root: string;
	/** Supplied by tests; the default reads the real file. */
	readFile?: (absolutePath: string) => Promise<Buffer | undefined>;
	/** What the checker last said, appended to a revision's label. */
	lastCheck?: () => string | undefined;
	/** Supplied by tests that want to inspect the log they passed in. */
	log?: RevisionLog;
	/** Retires what the model had read about a file a restore has moved. */
	forgetReads?: (absolutePath: string) => void;
	/** For the host to say, in its own voice, that a file was put back. */
	onRestored?: (event: { path: string; deleted: boolean }) => void;
	onError?: (message: string, error: unknown) => void;
}): SessionRevisions {
	const log = options.log ?? createRevisionLog();
	const readFile =
		options.readFile ??
		(async (absolutePath: string) => {
			try {
				return await readFileFromDisk(absolutePath);
			} catch {
				// Gone, unreadable, or never there. All three are "no content at
				// this revision", which is a real answer.
				return undefined;
			}
		});

	const source = {
		// No transaction of its own, ever: a host that has the protocol routes
		// through the protocol's decoration instead of this one.
		pending: undefined,
		root: options.root,
		transaction: 0,
		revisions: log,
	};

	return {
		log,
		tools: [
			createRestoreFileTool({
				controller: source,
				scope: "session",
				...(options.forgetReads ? { forgetReads: options.forgetReads } : {}),
				...(options.onRestored
					? {
							onRestored: ({ path: restored, deleted }) =>
								options.onRestored?.({ path: restored, deleted }),
						}
					: {}),
				...(options.onError ? { onError: options.onError } : {}),
			}),
		],
		port: {
			spanFor: (filePath) => revisionSpan(log.revisions(filePath)),
			tracked: () => log.tracked(),
			noteCompaction: (keep) => log.noteCompaction(keep),
		},
		decorate: (tools) =>
			withRevisionCapture(
				// Reads first, writes outside, matching the protocol's own order:
				// the read decoration widens `read_files` and the capture wraps
				// the writers, and neither touches the other's tool.
				withBaseRevisionReads(tools, source, SESSION_REVISION_WORDING),
				{
					source: { ...source, log },
					readFile,
					...(options.lastCheck ? { lastCheck: options.lastCheck } : {}),
				},
			),
	};
}
