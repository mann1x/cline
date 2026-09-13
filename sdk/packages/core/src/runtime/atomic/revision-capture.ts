/**
 * Capture a revision of every file a tool writes.
 *
 * The choke point the change protocol never had. `withChangeSignal` next door
 * answers "did something change" for the stalled-check counter; this answers
 * "what did it say afterwards", which is what makes going back to a particular
 * point possible at all.
 *
 * Coverage is deliberately not "re-walk the tree after every call". A snapshot
 * reads every file under the root, and doing that per edit makes a real
 * repository unusable. Instead the tools that name what they write are asked
 * what they wrote, and `run_commands` -- which can write anything -- re-checks
 * the files the model has already touched. That is where the realistic desync
 * is: a `sed -i` or a shell redirect over the file being edited, which would
 * otherwise leave the log claiming a revision that is no longer on disk and
 * make a later restore resurrect stale content.
 *
 * What is NOT covered, stated so it is known rather than discovered: a
 * `run_commands` that writes a file the model has never touched with a tool.
 * That file has no revisions, `restore_file` says so, and the transaction
 * rollback still covers it because the base snapshot does.
 */

import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolDefinition,
} from "@cline/shared";
import { DefaultToolNames } from "../../extensions/tools/constants";
import { resolveBaseFile } from "./base-revision";
import { LAST_REVISION, type RevisionLog } from "./file-revisions";
import type { Snapshot } from "./snapshot";

export interface RevisionCaptureSource {
	/** The open transaction's base, or nothing when none is open. */
	readonly pending: Snapshot | undefined;
	/** Which transaction is open. */
	readonly transaction: number;
	/** Where the revisions go. */
	readonly log: RevisionLog;
}

export interface RevisionCaptureOptions {
	readonly source: RevisionCaptureSource;
	/** Read a file as it stands, or nothing when it does not exist. */
	readFile(absolutePath: string): Promise<Buffer | undefined>;
}

/** Tools that name the file they are about to write. */
const NAMED_WRITERS: readonly string[] = [
	DefaultToolNames.EDITOR,
	DefaultToolNames.APPLY_PATCH,
	DefaultToolNames.SED,
];

/** Tools that may write anything, and so only re-check what is tracked. */
const OPAQUE_WRITERS: readonly string[] = [DefaultToolNames.RUN_COMMANDS];

/**
 * Every path an `apply_patch` payload names.
 *
 * The paths are in the patch grammar rather than in a field, so they are read
 * out of the text. A payload whose header this does not match captures
 * nothing, which is the same position a `run_commands` write is in — covered
 * by the transaction rollback, not by a revision.
 */
export function patchTargets(payload: string): string[] {
	const found: string[] = [];
	const pattern = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$/gim;
	for (;;) {
		const match = pattern.exec(payload);
		if (!match) break;
		if (match[1]) found.push(match[1]);
	}
	return found;
}

/** The files a call is about to write, as the tool's own input names them. */
function targetsOf(name: string, input: unknown): string[] {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return typeof input === "string" && name === DefaultToolNames.APPLY_PATCH
			? patchTargets(input)
			: [];
	}
	const record = input as Record<string, unknown>;
	if (name === DefaultToolNames.EDITOR) {
		return typeof record.path === "string" ? [record.path] : [];
	}
	if (name === DefaultToolNames.APPLY_PATCH) {
		return typeof record.input === "string" ? patchTargets(record.input) : [];
	}
	if (name === DefaultToolNames.SED) {
		// Without `in_place` sed prints and writes nothing, so there is no
		// revision to take — and taking one would record the file's current
		// content under a tool that did not produce it.
		if (record.in_place !== true) return [];
		return Array.isArray(record.files)
			? record.files.filter((f): f is string => typeof f === "string")
			: [];
	}
	return [];
}

/**
 * What the model is told about the revision its edit just made.
 *
 * One line. The full history goes on reads, where there is room for it; here
 * the only things worth saying are the number this write got and the one call
 * that undoes exactly it.
 */
function describeNewRevision(
	display: string,
	index: number,
	lines: number,
): string {
	return `\`${display}\` is now revision #${index} (${lines} lines). To undo just this change, \`restore_file\` with \`revision: "${LAST_REVISION}"\`; #1 is the file as this transaction opened.`;
}

export function withRevisionCapture<T extends AgentToolDefinition>(
	tools: readonly T[],
	options: RevisionCaptureOptions,
): T[] {
	const { source } = options;

	/** Seed #1 from the base so a restore has somewhere to go back to. */
	const track = (snapshot: Snapshot, given: string): string | undefined => {
		const lookup = resolveBaseFile(snapshot, given);
		// Uncovered and outside are not tracked at all: the transaction cannot
		// put them back either, and a revision log over a file the rollback
		// does not reach would promise an undo that the boundary will not honour.
		if (lookup.kind === "uncovered" || lookup.kind === "outside") {
			return undefined;
		}
		source.log.seed(
			lookup.absolutePath,
			lookup.kind === "held" ? lookup.body : undefined,
		);
		return lookup.absolutePath;
	};

	const capture = async (
		snapshot: Snapshot,
		absolutePaths: readonly string[],
	): Promise<{ display: string; index: number; lines: number } | undefined> => {
		let newest: { display: string; index: number; lines: number } | undefined;
		for (const absolutePath of absolutePaths) {
			const body = await options.readFile(absolutePath);
			const revision = source.log.record(absolutePath, body, currentTool);
			if (!revision) continue;
			newest = {
				display: path.relative(snapshot.root, absolutePath) || absolutePath,
				index: revision.index,
				lines: revision.lines,
			};
		}
		return newest;
	};

	// Set per call so `record` can name the tool that produced the revision
	// without threading it through every helper.
	let currentTool = "";

	return tools.map((tool) => {
		const named = NAMED_WRITERS.includes(tool.name);
		const opaque = OPAQUE_WRITERS.includes(tool.name);
		if (!named && !opaque) {
			return tool;
		}
		const original = tool as unknown as AgentTool<unknown, unknown>;
		return {
			...original,
			execute: async (input: unknown, context: AgentToolContext) => {
				const snapshot = source.pending;
				if (!snapshot) {
					return original.execute(input, context);
				}
				// Seeded before the call, so #1 holds what the file said before
				// this write rather than after it.
				const targets = named
					? targetsOf(tool.name, input)
							.map((given) => track(snapshot, given))
							.filter((p): p is string => p !== undefined)
					: // Opaque writers re-check what is already tracked and nothing
						// else. A file nobody has touched with a tool has no history
						// to keep consistent.
						[...source.log.tracked()];
				currentTool = tool.name;
				const result = await original.execute(input, context);
				const newest = await capture(snapshot, targets);
				if (!newest || typeof result !== "string") {
					return result;
				}
				return `${result}\n\n${describeNewRevision(newest.display, newest.index, newest.lines)}`;
			},
		} as unknown as T;
	});
}
