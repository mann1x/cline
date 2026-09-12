/**
 * Put one file back to what it said when this transaction opened.
 *
 * The rollback the protocol already performs, made available before the
 * transaction ends and narrowed to a single file. The model that has just
 * broken something can undo exactly that, keep everything else it got right,
 * and carry on.
 *
 * Why it is worth a tool. Measured on the run that prompted it (pandorum,
 * 2026-09-05): three discarded transactions, 7328s, and 22 of 43 edits went to
 * a line the same transaction had already edited. The model announced it had
 * damaged the file nineteen times — "I accidentally deleted the entire `dDec`
 * method", "I accidentally merged dGrid and dDec into one line!" — and each
 * time set about rebuilding a 400-character minified line from memory. 91% of
 * that run's wall clock came after the first of those.
 *
 * What it takes with it. The base is the whole file as the transaction found
 * it, so a restore discards anything changed in that file since the
 * transaction opened — including an edit the user made in their own editor
 * while it was open. That is not new: the rollback at the transaction boundary
 * has always had exactly this reach, and this only brings it forward and
 * narrows it to one file. It is worth knowing rather than discovering.
 *
 * Why it is bounded. The same model class has been measured issuing twelve
 * `rm` of the file under test in one transaction, recreating it whole each
 * time, and losing the file when the twelfth outlived the transaction. A cheap
 * undo lowers the price of a reckless edit, so this one counts itself, says so
 * every time, and stops. A restore loop that announces itself is the point:
 * the failure it replaces was silent and cost two hours.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import {
	describeMissingBase,
	isTextBody,
	resolveBaseFile,
} from "./base-revision";
import type { Snapshot } from "./snapshot";

export const RESTORE_FILE_TOOL_NAME = "restore_file";

/**
 * Restores one transaction is allowed before it is told to stop.
 *
 * Nine. It was three, on the reasoning that a fourth restore in one
 * transaction is not a recovery but the loop -- and for a model that edits
 * accurately it still is. For one that does not, the cap turned out to be the
 * thing that ended the run rather than the thing that saved it.
 *
 * Measured on a JackDelta 9B session: 19 restore attempts, 8 of them refused
 * because the cap was already spent, and the model then named the cap as its
 * reason for giving up in three separate transactions -- "exhausted restore
 * slots (3/3)" in TX-02, and the same again in TX-03 and TX-05. Faced with a
 * mangled file it could neither restore nor repair, it submitted an apology
 * instead of a change. The cap was doing the opposite of its job: the
 * transaction still gets rolled back wholesale if the check fails, so a
 * restore costs nothing but the tokens, while refusing one costs the
 * transaction.
 *
 * It was then nine, for the same reason, and nine was still too few. Measured
 * on pandorum session 1789122866533_br1d0 (JackOD 9B, 4.100.94): the
 * transaction spent all nine and was refused twice more, and the model's own
 * account of why it stopped names the state it could not get out of -- "this
 * transaction has accumulated 14+ failed/rolled-back attempts with no clean fix
 * landing on disk", ending in a question to the user rather than a change.
 * Twenty-seven is three times the last figure and, unlike it, is not a number
 * the measured runs reach.
 *
 * The cap costs more than it saves at small sizes and the asymmetry is not
 * close. A restore cannot lose the file -- it writes the base revision back, so
 * the worst case is tokens -- while refusing one strands a model in a file it
 * mangled, and the transaction is rolled back wholesale anyway if the check
 * fails. The looping this was meant to catch is caught better elsewhere now:
 * `MAX_NOOP_RESTORES_PER_TRANSACTION` stops the degenerate case where nothing
 * is being undone at all, which is what the 102-restore run actually was, and
 * the repeated-call guard stops an identical call being retried. This number
 * only has to stop a model restoring real work in circles forever, and it is
 * the last line rather than the first.
 */
export const MAX_RESTORES_PER_TRANSACTION = 27;

/**
 * No-op restores answered before the tool stops answering them.
 *
 * A restore of a file that already matches the base changes nothing, so it
 * never touched the budget above and never refused. That made it free, and a
 * free call that returns a reassuring sentence is a loop waiting to happen.
 *
 * Measured on pandorum session 1789117848964_zhbk5 (JackOD 9B, 4.100.93):
 * 108 `restore_file` calls in a single transaction, of which **102 were
 * no-ops** and 6 were real -- against a cap of 9 that was therefore never
 * reached. The model was told "that is 102 times you have asked" and asked
 * again. 212 tool calls and 33 minutes went to a transaction that never
 * closed.
 *
 * Three, and they are counted across the transaction rather than
 * consecutively: while the file matches the base there is nothing to undo, and
 * that is equally true whatever the model did in between. Three leaves room
 * for the honest case -- an edit that did not apply, restored out of caution --
 * without leaving the door open on a hundred.
 */
export const MAX_NOOP_RESTORES_PER_TRANSACTION = 3;

export const RESTORE_FILE_TOOL_DESCRIPTION = `Put one file back exactly as it was when this transaction opened, discarding every change you have made to it since.

Use it the moment an edit goes wrong in a way you would otherwise have to undo by hand — you deleted more than you meant to, you merged two lines together, you have rewritten the same line four times and it is further from working than when you started. Restoring is exact. Retyping the original from memory is not, and on a long or minified line it is where runs go to die.

It affects one file. Anything you changed in other files this transaction stays. If the file did not exist when the transaction opened, restoring it deletes it.

This is not the end of the transaction and it does not spend one — you carry on, from the file as it was. Read the file again afterwards: its line numbers are back to what they were before your changes, and any range you read earlier no longer addresses the same code.

If you only want to *see* what the file said before your changes, do not restore it — call \`read_files\` with \`revision: "base"\` and it is shown to you with the file left alone.`;

export const RESTORE_FILE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description:
				"The file to put back, absolute or relative to the workspace root.",
		},
		reason: {
			type: "string",
			description:
				"One sentence: what went wrong with this file that restoring it undoes.",
		},
	},
	required: ["path"],
} as const;

/** The part of the controller this tool drives. */
export interface RestoreFileSource {
	/** The open transaction's base, or nothing when none is open. */
	readonly pending: Snapshot | undefined;
	/** Which transaction is open. A new one gets a fresh budget. */
	readonly transaction: number;
}

export interface RestoreFileToolOptions {
	controller: RestoreFileSource;
	/**
	 * Retires what the model had read about this file.
	 *
	 * A restore moves every line in the file, so the reads that justify an edit
	 * by line number no longer describe it. Without this the editor's
	 * read-before-edit guard — the one thing standing between a stale line
	 * number and the file on disk — waves through an edit aimed at code that
	 * has since moved. Hosts that own the receipts supply it; one that does not
	 * gets a restore whose warning is only words.
	 */
	forgetReads?: (absolutePath: string) => void;
	/** For the host to say, in its own voice, that a file was put back. */
	onRestored?: (event: {
		path: string;
		transaction: number;
		deleted: boolean;
	}) => void;
	onError?: (message: string, error: unknown) => void;
}

/**
 * Lines, counted as the reader counts them.
 *
 * A trailing newline ends the last line rather than starting an empty one, so
 * `"a\nb\n"` is two lines and not three. Worth being exact about: the model
 * sees this number next to the one `read_files` prints for the same file, and
 * two tools disagreeing about how long a file is sends it looking for the
 * line that is not there.
 */
function countLines(body: Buffer | string): number {
	const text = typeof body === "string" ? body : body.toString("utf8");
	if (text === "") return 0;
	const lines = text.split(/\r\n|\r|\n/);
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.length;
}

/** The first line at which two texts stop agreeing, one-based, or 0. */
function firstDivergentLine(before: string, after: string): number {
	const a = before.split(/\r\n|\r|\n/);
	const b = after.split(/\r\n|\r|\n/);
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i += 1) {
		if (a[i] !== b[i]) return i + 1;
	}
	return a.length === b.length ? 0 : shared + 1;
}

export function createRestoreFileTool(
	options: RestoreFileToolOptions,
): AgentTool {
	// Per transaction, reset when a new one opens: a model that recovered in
	// TX-01 should not begin TX-02 already one strike down, exactly as the
	// empty-attempt budget is reset by a transaction that contained work.
	let spentIn = 0;
	let lastTransaction = 0;
	// Counted apart and reported, the way `editor` reports a refused no-op.
	// Restoring a file that already matches the base is not thrash, it is a
	// model that has lost track of what it changed — and being told the file is
	// already the original is the answer it was looking for.
	let noOps = 0;

	return createTool({
		name: RESTORE_FILE_TOOL_NAME,
		description: RESTORE_FILE_TOOL_DESCRIPTION,
		inputSchema: RESTORE_FILE_TOOL_INPUT_SCHEMA as unknown as Record<
			string,
			unknown
		>,
		execute: async (input: unknown): Promise<string> => {
			const snapshot = options.controller.pending;
			const transaction = options.controller.transaction;
			if (transaction !== lastTransaction) {
				lastTransaction = transaction;
				spentIn = 0;
				noOps = 0;
			}
			if (!snapshot) {
				return "No transaction is open, so there is nothing to put the file back to.";
			}

			const requested =
				input && typeof input === "object" && !Array.isArray(input)
					? (input as { path?: unknown }).path
					: undefined;
			if (typeof requested !== "string" || requested.trim() === "") {
				return "Name the file to restore, as `path`.";
			}

			if (spentIn >= MAX_RESTORES_PER_TRANSACTION) {
				return `That is ${MAX_RESTORES_PER_TRANSACTION} restores already in this transaction, so no more will be made. Undoing the same work repeatedly is not converging on it. Read the file as it stands, decide on one change, and make that change — or say plainly that you cannot, and let the transaction be judged.`;
			}

			const lookup = resolveBaseFile(snapshot, requested.trim());
			if (lookup.kind === "uncovered" || lookup.kind === "outside") {
				return describeMissingBase(lookup);
			}

			const display =
				path.relative(snapshot.root, lookup.absolutePath) ||
				lookup.absolutePath;

			// Created by this transaction: its base revision is not existing, so
			// putting it back means removing it. The same thing the rollback does
			// at the boundary, and said plainly rather than dressed up as an edit.
			if (lookup.kind === "created") {
				// A path that is not in the snapshot and is not on disk either was
				// never created by anything. Deleting nothing and reporting a
				// restore would spend the budget on a typo.
				try {
					await fs.stat(lookup.absolutePath);
				} catch {
					return `\`${display}\` does not exist and did not exist when this transaction opened, so there is nothing to put back. Check the path.`;
				}
				let existed = true;
				try {
					await fs.rm(lookup.absolutePath, { force: true });
				} catch (error) {
					options.onError?.(`[Atomic] ${display} could not be removed`, error);
					return `\`${display}\` could not be removed: ${String(error)}`;
				}
				try {
					await fs.stat(lookup.absolutePath);
				} catch {
					existed = false;
				}
				if (existed) {
					return `\`${display}\` is still there — the delete reported success and the file remains. Do not rely on it having been undone.`;
				}
				spentIn += 1;
				options.forgetReads?.(lookup.absolutePath);
				options.onRestored?.({
					path: lookup.absolutePath,
					transaction,
					deleted: true,
				});
				return `\`${display}\` did not exist when this transaction opened, so it has been deleted — that is what putting it back means. ${describeBudget(spentIn)}`;
			}

			let current: Buffer | undefined;
			try {
				current = await fs.readFile(lookup.absolutePath);
			} catch {
				current = undefined;
			}

			if (current?.equals(lookup.body)) {
				noOps += 1;
				// Past the budget the tool stops answering. Not to punish the
				// call -- it costs nothing on disk -- but because answering it
				// is what kept the loop fed: the reply was reassuring, the next
				// call was identical, and the transaction never moved. The
				// refusal names the one thing that is true (the file is the
				// original) and the two calls that can follow it, and it does
				// not offer stopping as one of them.
				if (noOps > MAX_NOOP_RESTORES_PER_TRANSACTION) {
					return [
						`\`${display}\` is the original. You have now asked to restore it ${noOps} times without it having been changed, and this tool will not answer again for this file in this transaction — there is nothing here to undo.`,
						"",
						"That is the answer to the question you keep asking: your edits are not landing. The file on disk is exactly what it was when the transaction opened, so nothing you have done to it has taken effect.",
						"",
						`Read \`${display}\` now — the whole region you mean to change, with \`start_line\` and \`end_line\` — and send one \`editor\` call using the line numbers that read reports. If that call is refused, the refusal says why; fix what it names and send it again.`,
					].join("\n");
				}
				return `\`${display}\` is already exactly as it was when this transaction opened, so nothing was changed${noOps > 1 ? ` (that is ${noOps} times you have asked)` : ""}. Whatever is still wrong with it was wrong before you touched it — look at the file itself rather than at your own edits.`;
			}

			try {
				await fs.mkdir(path.dirname(lookup.absolutePath), { recursive: true });
				await fs.writeFile(lookup.absolutePath, lookup.body);
			} catch (error) {
				options.onError?.(`[Atomic] ${display} could not be restored`, error);
				return `\`${display}\` could not be restored: ${String(error)}`;
			}

			spentIn += 1;
			options.forgetReads?.(lookup.absolutePath);
			options.onRestored?.({
				path: lookup.absolutePath,
				transaction,
				deleted: false,
			});

			const restoredLines = countLines(lookup.body);
			const discarded =
				current === undefined
					? "it had been deleted"
					: describeDiscarded(current, lookup.body);

			return [
				`\`${display}\` is back as it was when this transaction opened: ${restoredLines} lines, ${discarded}.`,
				"Every line number you read before this now points somewhere else, so read the file again before you edit it.",
				describeBudget(spentIn),
			].join(" ");
		},
	});
}

function describeBudget(spent: number): string {
	const left = MAX_RESTORES_PER_TRANSACTION - spent;
	const budget =
		left > 0
			? `${left} more restore${left === 1 ? "" : "s"} available in this transaction.`
			: "That was the last restore available in this transaction.";
	const habit = describeRestoreHabit(spent);
	return habit ? `${budget} ${habit}` : budget;
}

/**
 * Real restores in one transaction before the tool says what that many means.
 *
 * Measured on the JackOD4-AC 9B arm: 13.6 `restore_file` calls per run against
 * 0.23 for qwen3.6 27B over 40 runs, a factor of 59. Within the arm the count
 * is near-monotonic with wall time -- the three runs that restored nothing were
 * the three fastest successes, and the three highest counts (28, 30, 36) were
 * the three timeouts. One of them deleted 4,939 bytes, 35% of the file, before
 * it reached the cap.
 *
 * Three is early on purpose, because this is a sentence and not a refusal. The
 * cap that refuses is `MAX_RESTORES_PER_TRANSACTION` and it is deliberately
 * generous: a restore is the right call for an edit that went wrong, and a
 * model told to stop restoring goes back to retyping the original from memory,
 * which is how the runs this came from actually lost files.
 */
export const RESTORE_HABIT_AFTER = 3;

/** Where the same sentence stops being a nudge and starts being the answer. */
export const RESTORE_HABIT_INSISTS_AFTER = 6;

/**
 * What three restores in one transaction are evidence of.
 *
 * Not that restoring is wrong. That the edits being undone are wrong in the
 * same way each time, which makes the reading behind them wrong rather than the
 * typing -- and no number of restores fixes a reading.
 *
 * The second half is the thing these runs behaved as though they did not know.
 * A model restoring file after file is trying to hand back a clean workspace,
 * and it does not have to: a transaction that ends on a failing check is put
 * back in full whatever state its files are in, and the account it writes is
 * kept and read by the next one. Restoring buys nothing that ending does not.
 */
function describeRestoreHabit(spent: number): string | undefined {
	if (spent < RESTORE_HABIT_AFTER) {
		return undefined;
	}
	if (spent < RESTORE_HABIT_INSISTS_AFTER) {
		return [
			`That is ${spent} changes undone in this transaction.`,
			"Undoing the same kind of edit that many times means the reading behind it is wrong, not the typing.",
			"Run the check and say what it actually reports, and what in the file produces it, before you edit again.",
			"You do not have to restore your way back to a clean file: if this transaction ends with the check still failing, every file in it is put back in full and what you wrote about it is kept.",
		].join(" ");
	}
	return [
		`That is ${spent} changes undone in this transaction, which is no longer recovery — it is one attempt being repeated.`,
		"Stop editing and end the transaction: say plainly what you tried and what the check still says.",
		"The files are put back either way, and saying it is the only part that reaches the next transaction.",
	].join(" ");
}

function describeDiscarded(current: Buffer, base: Buffer): string {
	if (!isTextBody(current) || !isTextBody(base)) {
		return "your changes to it are gone";
	}
	const before = current.toString("utf8");
	const after = base.toString("utf8");
	const line = firstDivergentLine(after, before);
	const delta = countLines(before) - countLines(after);
	const size =
		delta === 0
			? "the same number of lines"
			: `${Math.abs(delta)} line${Math.abs(delta) === 1 ? "" : "s"} ${delta > 0 ? "more" : "fewer"}`;
	return line > 0
		? `discarding what you had made of it, which had ${size} and first differed at line ${line}`
		: "discarding what you had made of it";
}
