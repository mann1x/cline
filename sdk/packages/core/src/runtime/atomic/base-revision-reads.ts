/**
 * `read_files` with a `revision`, offered wherever a file history is being kept.
 *
 * Built for the change protocol and worded for it; the escalation keeps a
 * history of its own -- the expert's writes, so the base model can check a note
 * against the bytes it was about -- and needs the same reads under different
 * words. `RevisionWording` below is that seam, and the change protocol's words
 * remain the default, so nothing that called this before sees any change.
 *
 * A decoration rather than a parameter on the built-in tool, and deliberately:
 * without an open transaction there is no base revision, and a schema that
 * advertises one anyway teaches the model a call that can only ever be
 * refused. Every host that runs without the protocol sees exactly the tool it
 * saw before this existed — same description, same schema, same behaviour.
 *
 * The read is the safe half of this pair. `restore_file` next door hands the
 * model a lever it can pull too often; this one only ever adds information, so
 * a model that leans on it cannot thrash with it.
 */

import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolDefinition,
} from "@cline/shared";
import { DefaultToolNames } from "../../extensions/tools/constants";
import { readFileRequestsFrom } from "../../extensions/tools/definitions";
import { readTextWindowFromText } from "../../extensions/tools/executors/file-read";
import {
	formatReadFileQuery,
	getReadFileRangeError,
} from "../../extensions/tools/helpers";
import type { ToolOperationResult } from "../../extensions/tools/types";
import {
	type BaseFileLookup,
	describeMissingBase,
	isTextBody,
	resolveBaseFile,
	resolveSessionFile,
} from "./base-revision";
import {
	describeRevisions,
	LAST_REVISION,
	ORIGINAL_REVISION,
	type RevisionLog,
} from "./file-revisions";
import type { Snapshot } from "./snapshot";

/** The value that asks for the transaction's copy instead of the file on disk. */
export const BASE_REVISION = "base";

/** What the decoration needs from the controller, and nothing more. */
export interface BaseRevisionSource {
	/** The open transaction's base, or nothing when none is open. */
	readonly pending: Snapshot | undefined;
	/** Which transaction is open, for messages that need to name it. */
	readonly transaction: number;
	/** Every version of every file a tool has written. */
	readonly revisions: RevisionLog;
	/**
	 * Where paths resolve when no transaction is open.
	 *
	 * Supplying it lets a session read its own history with the change protocol
	 * off. There is no base snapshot then, so `#1` comes from the log, seeded
	 * from the file itself at first touch — which is what the compaction
	 * ledger's addresses point at either way.
	 */
	readonly root?: string;
}

/**
 * The words that differ between the two histories this decoration can serve.
 *
 * One machinery, two arrangements. The change protocol's log holds the base
 * model's own edits inside its open transaction; the escalation's holds the
 * expert's edits while the base model stands down and watches. The numbering,
 * the de-duplication and the reads are identical. What is not identical is who
 * wrote the versions and what the reader means to do with them -- and a reader
 * told "your own edits are not in it" about somebody else's edits has been
 * told something false.
 */
export interface RevisionWording {
	/** Appended to `read_files`' description. */
	readonly description: string;
	/** The `revision` parameter's own description. */
	readonly parameter: string;
	/** What a refusal calls the span: "this transaction", "this escalation". */
	readonly span: string;
	/** What a served revision #1 is called. */
	readonly baseLabel: string;
	/** The refusal when nothing is open at all. */
	readonly closed: string;
}

const TRANSACTION_DESCRIPTION = `

**Reading an earlier version of a file.** Set \`revision\` to be shown the file as it was at some earlier point, instead of as it is now:

- \`"base"\` (or \`"${ORIGINAL_REVISION}"\`) — as this transaction opened. Your own edits are not in it.
- \`"${LAST_REVISION}"\` — as it was before your most recent change to it.
- \`"#3"\` — that numbered version. Every version a tool writes is numbered, and the numbers are listed at the end of every read of that file, so you never have to remember them.

Use it the moment you have damaged a file and are about to rebuild part of it from memory — a method you deleted, a line you rewrote and lost, a block whose brackets you have been moving around. Reading the original is exact and reconstructing it is not, and a long minified line is where the difference shows.

It is a read and nothing else: the file on disk is untouched, and what you are shown does not count as having read the file as it stands. To edit it, read it again without \`revision\` — the line numbers in the base version are the ones from before your changes and will not address today's file.`;

const TRANSACTION_PARAMETER = `Read an earlier version instead of the file as it is now: "${BASE_REVISION}" or "${ORIGINAL_REVISION}" for the file as this transaction opened, "${LAST_REVISION}" for the version before your most recent change to it, or a number such as "#3". Applies to every path in the call.`;

/** How the change protocol talks about its own revisions. The default. */
export const TRANSACTION_REVISION_WORDING: RevisionWording = {
	description: TRANSACTION_DESCRIPTION,
	parameter: TRANSACTION_PARAMETER,
	span: "this transaction",
	baseLabel: "the version from before this transaction's changes",
	closed:
		"No transaction is open, so there is no earlier version to read. Read the file as it stands.",
};

const ESCALATION_DESCRIPTION = `

**Reading a version of a file the expert wrote.** Set \`revision\` to be shown a file as it was at some point during this escalation, instead of as it is now:

- \`"${BASE_REVISION}"\` (or \`"${ORIGINAL_REVISION}"\`) — the workspace as it stood when you handed the work over. None of the expert's changes are in it.
- \`"${LAST_REVISION}"\` — as it was before the expert's most recent change to it.
- \`"#3"\` — that numbered version. Every version the expert writes is numbered, and the note reporting the change names its number, so you can read the exact bytes a note was about.

This is what makes the notes checkable. A note reaches you describing a moment that has already passed: by the time you read that the expert edited a file, the file on disk may have moved on twice, so checking the claim against disk is checking it against evidence that moved under you. The numbered version does not move. Read the revision a note names when you want to judge what the expert said it did, and read the file on disk when you want to know where the work stands now.

It is a read and nothing else. The file is untouched, and you are standing down from changes while the expert works.`;

const ESCALATION_PARAMETER = `Read a version from during this escalation instead of the file as it is now: "${BASE_REVISION}" or "${ORIGINAL_REVISION}" for the workspace as you handed it over, "${LAST_REVISION}" for the version before the expert's most recent change to it, or a number such as "#3" taken from a note. Applies to every path in the call.`;

/** How the escalation talks about the expert's revisions. */
/**
 * The words for a session that has no transactions.
 *
 * Same machinery, third arrangement. `#1` here is the file as this session
 * first found it rather than a base a rollback returns the tree to, and the
 * "closed" line has to say something the model can act on: with the protocol
 * off there is no transaction to open, so "no transaction is open" would be
 * true forever and mean nothing.
 */
export const SESSION_REVISION_WORDING: RevisionWording = {
	description: `

**Reading an earlier version of a file.** Set \`revision\` to be shown a file as it was earlier in this session, instead of as it is now:

- \`"${ORIGINAL_REVISION}"\` — the file as it stood before this session first wrote to it.
- \`"${LAST_REVISION}"\` — as it was before your most recent change to it.
- \`"#3"\` — that numbered version. Every version a tool writes is numbered, and the result reporting the change names its number.

The file on disk is left exactly as it is. Use this to see what you had before, and \`restore_file\` when you want it back.`,
	parameter: `Which earlier version of the file to show, instead of the file as it stands: "${ORIGINAL_REVISION}" for the file before this session first wrote to it, "${LAST_REVISION}" for the version before your most recent change, or a number such as "#3".`,
	span: "this session",
	baseLabel: "the version from before this session's changes",
	closed:
		"Nothing has written that file in this session, so there is no earlier version of it held. Read the file as it stands.",
};

export const ESCALATION_REVISION_WORDING: RevisionWording = {
	description: ESCALATION_DESCRIPTION,
	parameter: ESCALATION_PARAMETER,
	span: "this escalation",
	baseLabel: "the version from before the expert's changes",
	closed:
		"No escalation is open, so there is no earlier version to read. Read the file as it stands.",
};

/**
 * A second history that takes over while it is live.
 *
 * The escalation's, in practice. Two logs exist at once during a hand-over --
 * the base model's open transaction and the expert's writes -- and they cannot
 * both answer `revision: "#3"`. They do not have to: while the expert has the
 * pen the base model is standing down and its own transaction is not moving,
 * so the only numbers that mean anything are the expert's, and those are the
 * ones the notes are quoting. When the escalation closes and the log is
 * purged, this stops being live and the transaction answers again.
 *
 * Stacking two decorations instead would not work: the outer one would take
 * `revision` off the input and the inner would never see it.
 */
export interface RevisionOverlay {
	readonly source: BaseRevisionSource;
	readonly wording: RevisionWording;
	/** Whether this is the history a `revision` means right now. */
	live(): boolean;
}

function revisionOf(input: unknown): {
	revision: unknown;
	rest: unknown;
} {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { revision: undefined, rest: input };
	}
	const { revision, ...rest } = input as Record<string, unknown>;
	return { revision, rest };
}

function withRevisionProperty(
	schema: Record<string, unknown>,
	wording: RevisionWording,
	overlay?: RevisionOverlay,
): Record<string, unknown> {
	const properties =
		typeof schema.properties === "object" && schema.properties !== null
			? (schema.properties as Record<string, unknown>)
			: {};
	return {
		...schema,
		properties: {
			...properties,
			revision: {
				type: "string",
				description: overlay
					? `${wording.parameter} While an expert is working this workspace, the versions are the expert's: ${overlay.wording.parameter}`
					: wording.parameter,
			},
		},
	};
}

/** Where a requested revision's bytes come from, and what to call it. */
type RevisionSource =
	| { kind: "body"; body: Buffer; label: string }
	| { kind: "error"; message: string };

function bodyForRevision(
	source: BaseRevisionSource,
	absolutePath: string,
	requested: string,
	base: Buffer | undefined,
	wording: RevisionWording,
): RevisionSource {
	const history = source.revisions.revisions(absolutePath);
	if (history.length === 0) {
		// Nothing has written it, so the only earlier version that exists is the
		// one the transaction opened with.
		if (!isOriginal(requested)) {
			return {
				kind: "error",
				message: `Nothing has written to that file in ${wording.span}, so the only earlier version of it is the one ${wording.span} opened with — there is no \`${requested}\` to read. Ask for \`"${BASE_REVISION}"\`, or read the file as it stands.`,
			};
		}
		return base
			? {
					kind: "body",
					body: base,
					label: wording.baseLabel,
				}
			: {
					kind: "error",
					message: describeMissingBase({ kind: "created", absolutePath }),
				};
	}
	const found = source.revisions.resolve(absolutePath, requested);
	if (found.kind === "dropped") {
		return {
			kind: "error",
			message: `Revision #${found.index} is no longer held: its content was released to stay inside the memory ${wording.span} may spend on file history.\n\n${describeRevisions(path.basename(absolutePath), history)}`,
		};
	}
	if (found.kind !== "found") {
		return {
			kind: "error",
			message: `\`${requested}\` does not name a version of that file that exists.\n\n${describeRevisions(path.basename(absolutePath), history)}`,
		};
	}
	if (!found.revision.body) {
		return {
			kind: "error",
			message: `The file did not exist at revision #${found.revision.index}, so there is nothing to show.`,
		};
	}
	return {
		kind: "body",
		body: found.revision.body,
		label:
			found.revision.index === 1
				? wording.baseLabel
				: `revision #${found.revision.index}`,
	};
}

function isOriginal(requested: string): boolean {
	const text = requested.trim().toLowerCase();
	return (
		text === BASE_REVISION ||
		text === ORIGINAL_REVISION ||
		text === "first" ||
		text === "1" ||
		text === "#1"
	);
}

/**
 * How a call resolves a path, and where it displays it from.
 *
 * One object rather than a `Snapshot`, because the only two things these
 * helpers ever took from the snapshot were the resolver and the root — and a
 * session with no transaction has both without having a snapshot.
 */
interface RevisionPlace {
	readonly root: string;
	resolve(requestedPath: string): BaseFileLookup;
}

function placeOf(source: BaseRevisionSource): RevisionPlace | undefined {
	const snapshot = source.pending;
	if (snapshot) {
		return {
			root: snapshot.root,
			resolve: (requestedPath) => resolveBaseFile(snapshot, requestedPath),
		};
	}
	if (source.root === undefined) {
		return undefined;
	}
	const root = source.root;
	return {
		root,
		resolve: (requestedPath) => resolveSessionFile(root, requestedPath),
	};
}

async function readFromRevision(
	source: BaseRevisionSource,
	place: RevisionPlace,
	input: unknown,
	context: AgentToolContext,
	requested: string,
	wording: RevisionWording,
): Promise<ToolOperationResult[]> {
	const requests = readFileRequestsFrom(input);
	return Promise.all(
		requests.map(async (request): Promise<ToolOperationResult> => {
			const query = `${formatReadFileQuery(request)}@${requested}`;
			const rangeError = getReadFileRangeError(request);
			if (rangeError) {
				return {
					query,
					result: "",
					error: `Invalid file range: ${rangeError}`,
					success: false,
				};
			}
			const lookup = place.resolve(request.path);
			if (lookup.kind === "uncovered" || lookup.kind === "outside") {
				return {
					query,
					result: "",
					error: describeMissingBase(lookup),
					success: false,
				};
			}
			const chosen = bodyForRevision(
				source,
				lookup.absolutePath,
				requested,
				lookup.kind === "held" ? lookup.body : undefined,
				wording,
			);
			if (chosen.kind === "error") {
				return { query, result: "", error: chosen.message, success: false };
			}
			if (!isTextBody(chosen.body)) {
				return {
					query,
					result: "",
					error:
						"That file is not text, so there is nothing to show. A rollback would still put it back.",
					success: false,
				};
			}
			const window = await readTextWindowFromText({
				text: chosen.body.toString("utf8"),
				includeLineNumbers: request.line_numbers ?? true,
				startLine: request.start_line,
				endLine: request.end_line,
				signal: context.signal,
			});
			// No read receipt. What the model has just seen is not the file it
			// would be editing, and crediting this as a read would let it edit
			// lines of the working file it has never looked at — the one guard
			// standing between a rebuilt-from-memory line and the file on disk.
			return {
				query,
				result: `${window.text}\n\n[This is ${chosen.label}, not the file as it stands.]`,
				success: true,
			};
		}),
	);
}

/**
 * Put the file's revision list on the end of an ordinary read.
 *
 * The compaction answer. The numbers are only useful if the model can find
 * them, and a long thrashing run auto-compacts away the receipts that first
 * announced them — while being exactly the run that needs to go back three
 * versions. Every read of a file that has any restates the whole list, so one
 * call recovers it.
 *
 * Only for files that have a history: a read of anything else is untouched, so
 * a session that never edits sees precisely the tool it saw before.
 */
function annotateWithRevisions(
	source: BaseRevisionSource,
	place: RevisionPlace,
	input: unknown,
	results: ToolOperationResult[],
): ToolOperationResult[] {
	const byQuery = new Map<string, string>();
	for (const request of readFileRequestsFrom(input)) {
		const lookup = place.resolve(request.path);
		if (lookup.kind === "uncovered" || lookup.kind === "outside") continue;
		byQuery.set(formatReadFileQuery(request), lookup.absolutePath);
	}
	if (byQuery.size === 0) return results;
	return results.map((result) => {
		if (!result.success) return result;
		const absolutePath = byQuery.get(result.query);
		if (!absolutePath) return result;
		const history = source.revisions.revisions(absolutePath);
		if (history.length < 2) return result;
		return {
			...result,
			result: `${result.result}\n\n${describeRevisions(path.basename(absolutePath), history)}`,
		};
	});
}

/**
 * Return the tool list with `read_files` able to serve the transaction's base.
 *
 * Wraps rather than rebuilds, so every wrapper already applied to the tool —
 * task-progress capture, edit verification — still sees an ordinary read.
 */
export function withBaseRevisionReads<T extends AgentToolDefinition>(
	tools: readonly T[],
	source: BaseRevisionSource,
	wording: RevisionWording = TRANSACTION_REVISION_WORDING,
	overlay?: RevisionOverlay,
): T[] {
	/** Whichever history a call means, decided when the call is made. */
	const live = (): { source: BaseRevisionSource; wording: RevisionWording } =>
		overlay?.live() ? overlay : { source, wording };
	return tools.map((tool) => {
		if (tool.name !== DefaultToolNames.READ_FILES) {
			return tool;
		}
		// The list this runs over is heterogeneous — every tool has its own
		// input type — and the decoration widens exactly one of them to accept
		// `revision` alongside whatever it took before. The cast says that and
		// nothing more: same tool, same result type, one more accepted shape.
		const original = tool as unknown as AgentTool<unknown, unknown>;
		return {
			...original,
			description:
				original.description +
				wording.description +
				(overlay ? overlay.wording.description : ""),
			inputSchema: withRevisionProperty(original.inputSchema, wording, overlay),
			execute: async (input: unknown, context: AgentToolContext) => {
				const active = live();
				const { revision, rest } = revisionOf(input);
				const place = placeOf(active.source);
				const wanted =
					typeof revision === "string" ? revision.trim() : undefined;
				// Names for the working tree are what the unadorned call already
				// does. A model that writes `revision: "current"` gets the file
				// rather than a refusal.
				const isWorkingTree =
					wanted === undefined ||
					wanted === "" ||
					["current", "now", "disk", "head", "working"].includes(
						wanted.toLowerCase(),
					);
				if (isWorkingTree) {
					const plain = (await original.execute(
						rest,
						context,
					)) as ToolOperationResult[];
					return place && Array.isArray(plain)
						? annotateWithRevisions(active.source, place, rest, plain)
						: plain;
				}
				if (!place) {
					return [
						{
							query: wanted,
							result: "",
							error: active.wording.closed,
							success: false,
						} satisfies ToolOperationResult,
					];
				}
				return readFromRevision(
					active.source,
					place,
					rest,
					context,
					wanted,
					active.wording,
				);
			},
		} as unknown as T;
	});
}
