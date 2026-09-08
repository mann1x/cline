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
import type { Snapshot } from "./snapshot";

/** The value that asks for the transaction's copy instead of the file on disk. */
export const BASE_REVISION = "base";

/** What the decoration needs from the controller, and nothing more. */
export interface BaseRevisionSource {
	/** The open transaction's base, or nothing when none is open. */
	readonly pending: Snapshot | undefined;
	/** Which transaction is open, for messages that need to name it. */
	readonly transaction: number;
}

const REVISION_DESCRIPTION = `

**Reading the version this transaction started from.** Set \`revision: "base"\` to be shown the file as it was when this transaction opened, instead of as it is now. Your own edits are not in it.

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
				enum: [BASE_REVISION],
				description:
					'Set to "base" to read the files as they were when this transaction opened, rather than as they are now. Applies to every path in the call.',
			},
		},
	};
}

async function readFromBase(
	snapshot: Snapshot,
	input: unknown,
	context: AgentToolContext,
): Promise<ToolOperationResult[]> {
	const requests = readFileRequestsFrom(input);
	return Promise.all(
		requests.map(async (request): Promise<ToolOperationResult> => {
			const query = `${formatReadFileQuery(request)}@base`;
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
			if (lookup.kind !== "held") {
				return {
					query,
					result: "",
					error: describeMissingBase(lookup),
					success: false,
				};
			}
			if (!isTextBody(lookup.body)) {
				return {
					query,
					result: "",
					error:
						"That file is not text, so there is nothing to show. A rollback would still put it back.",
					success: false,
				};
			}
			const window = await readTextWindowFromText({
				text: lookup.body.toString("utf8"),
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
				result: `${window.text}\n\n[This is the version from before this transaction's changes, not the file as it stands.]`,
				success: true,
			};
		}),
	);
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
				if (typeof revision !== "string") {
					return original.execute(rest, context);
				}
				const wanted = revision.trim().toLowerCase();
				// Anything but "base" is the working tree, which is what the
				// unadorned call already does. A model that writes
				// `revision: "current"` gets the file rather than a refusal.
				if (wanted !== BASE_REVISION) {
					return original.execute(rest, context);
				}
				const snapshot = source.pending;
				if (!snapshot) {
					return [
						{
							query: BASE_REVISION,
							result: "",
							error:
								"No transaction is open, so there is no earlier version to read. Read the file as it stands.",
							success: false,
						} satisfies ToolOperationResult,
					];
				}
				return readFromBase(snapshot, rest, context);
			},
		} as unknown as T;
	});
}
