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
import {
	LAST_REVISION,
	type RevisionLog,
	type RevisionNote,
} from "./file-revisions";
import type { Snapshot } from "./snapshot";

export interface RevisionCaptureSource {
	/** The open transaction's base, or nothing when none is open. */
	readonly pending: Snapshot | undefined;
	/**
	 * Where paths resolve and what counts as inside, when there is no
	 * transaction.
	 *
	 * Supplying it is what makes capture session-scoped: `#1` is seeded from the
	 * file's own content at first touch instead of from a base snapshot, and the
	 * log outlives every transaction because it never belonged to one. Left out,
	 * a session with no open transaction captures nothing, which is what every
	 * caller did before this existed.
	 *
	 * The promise changes with it and the label says so. Inside a transaction
	 * `#1` is what a rollback returns the whole tree to; outside one it is what
	 * this one file said before this session touched it. "Can the rollback reach
	 * this path" stops being a precondition of recording history and becomes a
	 * question the rollback asks -- which is the point, since the history is
	 * worth having in a session that has no rollback at all.
	 */
	readonly root?: string;
	/** Which transaction is open. */
	readonly transaction: number;
	/** Where the revisions go. */
	readonly log: RevisionLog;
}

export interface RevisionCaptureOptions {
	readonly source: RevisionCaptureSource;
	/** Read a file as it stands, or nothing when it does not exist. */
	readFile(absolutePath: string): Promise<Buffer | undefined>;
	/**
	 * What the checker last said, when it has run and said anything.
	 *
	 * Appended to the label rather than used as it: it answers "was this
	 * working here", which is a different question from "what changed here",
	 * and for plenty of files -- a README, anything the checker does not look
	 * at -- it has nothing to say at all.
	 */
	lastCheck?(): string | undefined;
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
	note: string,
	fromModel: boolean,
): string {
	const head = `\`${display}\` is now revision #${index} (${lines} lines) — ${note}.`;
	const undo = `To undo just this change, \`restore_file\` with \`revision: "${LAST_REVISION}"\`; #1 is the file as this transaction opened.`;
	if (fromModel) {
		return `${head} ${undo}`;
	}
	// Asked for, not required. The label above is already usable -- the point
	// of asking is that one sentence of intent beats any amount of derived
	// description when the model later has to choose which revision to go back
	// to, and only the model knows what the edit was for.
	return `${head} ${undo}\n\nThat note was worked out from the change itself. Send \`intent\` with your next edit — one short sentence on what it is meant to do — and it will be the label for that revision.`;
}

/** The model's one-line reason, when the call carried one. */
function intentOf(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	for (const key of ["intent", "why", "purpose"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/**
 * What the tool said it did, as the first line of its own report.
 *
 * `editor` opens with "Replaced line 90, columns 382-382 in <path>", which is
 * exactly the summary wanted -- minus the path, which is already the subject of
 * the entry and would take the whole line.
 */
function summaryOf(result: unknown): string | undefined {
	const text = firstText(result);
	if (!text) return undefined;
	const line = text.split("\n").find((candidate) => candidate.trim());
	if (!line) return undefined;
	return line.replace(/\s+in\s+\/\S+$/, "").trim() || undefined;
}

function firstText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (Array.isArray(result)) {
		for (let i = result.length - 1; i >= 0; i -= 1) {
			const text = firstText(result[i]);
			if (text) return text;
		}
		return undefined;
	}
	if (result && typeof result === "object") {
		const value = (result as Record<string, unknown>).result;
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** Advertise `intent` on the tools that write, only while the protocol is on. */
function withIntentProperty(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const properties =
		typeof schema.properties === "object" && schema.properties !== null
			? (schema.properties as Record<string, unknown>)
			: {};
	return {
		...schema,
		properties: {
			...properties,
			intent: {
				type: "string",
				description:
					"One short sentence on what this change is meant to achieve. It becomes the label for the revision this write creates, and it is what you will be choosing between if you later need to go back to a particular point. Omit it and the label is worked out from the change itself, which says what moved but not why.",
			},
		},
	};
}

/**
 * Put the note where the model will read it, whatever shape the tool returned.
 *
 * This used to be `typeof result === "string"` and nothing else, which is the
 * one shape the write tools never use: `editor` returns
 * `{query, result, success}`, and `run_commands` and `sed` return a list of
 * those. So the number an edit had just been given was appended to nothing,
 * every time -- 361 write results across three harness runs, none of them
 * carrying a revision. The model could only learn a number from a read or a
 * restore, which is why it only ever asked for `#1`.
 *
 * The last entry of a list, because that is the call the note is about: a
 * batch of reads followed by the write that triggered capture ends with the
 * write.
 */
function withNote(result: unknown, note: string): unknown {
	if (typeof result === "string") {
		return `${result}\n\n${note}`;
	}
	if (Array.isArray(result)) {
		if (result.length === 0) return result;
		const last = result[result.length - 1];
		const updated = withNote(last, note);
		return updated === last ? result : [...result.slice(0, -1), updated];
	}
	if (result && typeof result === "object") {
		const record = result as Record<string, unknown>;
		if (typeof record.result === "string") {
			return { ...record, result: `${record.result}\n\n${note}` };
		}
	}
	// A shape nothing here knows how to extend. Losing the note is better than
	// corrupting a result the model has to parse.
	return result;
}

export function withRevisionCapture<T extends AgentToolDefinition>(
	tools: readonly T[],
	options: RevisionCaptureOptions,
): T[] {
	const { source } = options;

	/** Seed #1 from the base so a restore has somewhere to go back to. */
	const trackAgainstBase = async (
		snapshot: Snapshot,
		given: string,
	): Promise<string | undefined> => {
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

	/** Seed #1 from the file itself, for a session with no transaction. */
	const trackAgainstDisk = async (
		root: string,
		given: string,
	): Promise<string | undefined> => {
		const absolutePath = path.normalize(
			path.isAbsolute(given) ? given : path.resolve(root, given),
		);
		// The one reachability question that survives the decoupling. There is
		// no rollback to bound this, but a workspace still has an edge, and a
		// history of files outside it is history nothing here will ever offer.
		const relative = path.relative(path.normalize(root), absolutePath);
		const inside =
			relative !== "" &&
			!relative.startsWith("..") &&
			!path.isAbsolute(relative);
		if (!inside) {
			return undefined;
		}
		// Read before the tool runs, so this is the content the write is about
		// to replace. `undefined` is a real answer -- the file does not exist
		// yet -- and `seed` records the absence as #1.
		source.log.seed(
			absolutePath,
			await options.readFile(absolutePath),
			"session",
		);
		return absolutePath;
	};

	type Captured = {
		display: string;
		index: number;
		lines: number;
		note: string;
		fromModel: boolean;
	};

	const capture = async (
		root: string,
		absolutePaths: readonly string[],
		note: RevisionNote,
	): Promise<Captured | undefined> => {
		let newest: Captured | undefined;
		for (const absolutePath of absolutePaths) {
			const body = await options.readFile(absolutePath);
			const revision = source.log.record(absolutePath, body, currentTool, note);
			if (!revision) continue;
			newest = {
				display: path.relative(root, absolutePath) || absolutePath,
				index: revision.index,
				lines: revision.lines,
				note: revision.note,
				fromModel: revision.noteSource === "model",
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
			// Only the named writers take `intent`: an opaque writer's call does
			// not say which file it is about, so a sentence attached to it could
			// end up labelling a revision of something else.
			...(named
				? { inputSchema: withIntentProperty(original.inputSchema ?? {}) }
				: {}),
			execute: async (input: unknown, context: AgentToolContext) => {
				const snapshot = source.pending;
				// The transaction's root when there is one, so protocol sessions
				// keep resolving exactly as they did; the session root otherwise.
				const root = snapshot?.root ?? source.root;
				if (root === undefined) {
					return original.execute(input, context);
				}
				// Seeded before the call, so #1 holds what the file said before
				// this write rather than after it.
				const targets = named
					? (
							await Promise.all(
								targetsOf(tool.name, input).map((given) =>
									snapshot
										? trackAgainstBase(snapshot, given)
										: trackAgainstDisk(root, given),
								),
							)
						).filter((p): p is string => p !== undefined)
					: // Opaque writers re-check what is already tracked and nothing
						// else. A file nobody has touched with a tool has no history
						// to keep consistent.
						[...source.log.tracked()];
				currentTool = tool.name;
				const result = await original.execute(input, context);
				const newest = await capture(root, targets, {
					intent: intentOf(input),
					summary: summaryOf(result),
					check: options.lastCheck?.(),
				});
				if (!newest) {
					return result;
				}
				return withNote(
					result,
					describeNewRevision(
						newest.display,
						newest.index,
						newest.lines,
						newest.note,
						newest.fromModel,
					),
				);
			},
		} as unknown as T;
	});
}
