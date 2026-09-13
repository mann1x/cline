/**
 * `read_files` with a `revision`, offered only inside the change protocol.
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
	describeMissingBase,
	isTextBody,
	resolveBaseFile,
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
	/** Every version of every file a tool has written this transaction. */
	readonly revisions: RevisionLog;
}

const REVISION_DESCRIPTION = `

**Reading an earlier version of a file.** Set \`revision\` to be shown the file as it was at some earlier point, instead of as it is now:

- \`"base"\` (or \`"${ORIGINAL_REVISION}"\`) — as this transaction opened. Your own edits are not in it.
- \`"${LAST_REVISION}"\` — as it was before your most recent change to it.
- \`"#3"\` — that numbered version. Every version a tool writes is numbered, and the numbers are listed at the end of every read of that file, so you never have to remember them.

Use it the moment you have damaged a file and are about to rebuild part of it from memory — a method you deleted, a line you rewrote and lost, a block whose brackets you have been moving around. Reading the original is exact and reconstructing it is not, and a long minified line is where the difference shows.

It is a read and nothing else: the file on disk is untouched, and what you are shown does not count as having read the file as it stands. To edit it, read it again without \`revision\` — the line numbers in the base version are the ones from before your changes and will not address today's file.`;

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
				description: `Read an earlier version instead of the file as it is now: "${BASE_REVISION}" or "${ORIGINAL_REVISION}" for the file as this transaction opened, "${LAST_REVISION}" for the version before your most recent change to it, or a number such as "#3". Applies to every path in the call.`,
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
): RevisionSource {
	const history = source.revisions.revisions(absolutePath);
	if (history.length === 0) {
		// Nothing has written it, so the only earlier version that exists is the
		// one the transaction opened with.
		if (!isOriginal(requested)) {
			return {
				kind: "error",
				message: `Nothing has written to that file in this transaction, so the only earlier version of it is the one the transaction opened with — there is no \`${requested}\` to read. Ask for \`"${BASE_REVISION}"\`, or read the file as it stands.`,
			};
		}
		return base
			? {
					kind: "body",
					body: base,
					label: "the version from before this transaction's changes",
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
			message: `Revision #${found.index} is no longer held: its content was released to stay inside the memory this transaction may spend on file history.\n\n${describeRevisions(path.basename(absolutePath), history)}`,
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
				? "the version from before this transaction's changes"
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

async function readFromRevision(
	source: BaseRevisionSource,
	snapshot: Snapshot,
	input: unknown,
	context: AgentToolContext,
	requested: string,
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
			const lookup = resolveBaseFile(snapshot, request.path);
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
	snapshot: Snapshot,
	input: unknown,
	results: ToolOperationResult[],
): ToolOperationResult[] {
	const byQuery = new Map<string, string>();
	for (const request of readFileRequestsFrom(input)) {
		const lookup = resolveBaseFile(snapshot, request.path);
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
): T[] {
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
			description: original.description + REVISION_DESCRIPTION,
			inputSchema: withRevisionProperty(original.inputSchema),
			execute: async (input: unknown, context: AgentToolContext) => {
				const { revision, rest } = revisionOf(input);
				const snapshot = source.pending;
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
					return snapshot && Array.isArray(plain)
						? annotateWithRevisions(source, snapshot, rest, plain)
						: plain;
				}
				if (!snapshot) {
					return [
						{
							query: wanted,
							result: "",
							error:
								"No transaction is open, so there is no earlier version to read. Read the file as it stands.",
							success: false,
						} satisfies ToolOperationResult,
					];
				}
				return readFromRevision(source, snapshot, rest, context, wanted);
			},
		} as unknown as T;
	});
}
