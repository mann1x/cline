/**
 * Memory's tools: `remember`, `recall` and `forget`.
 *
 * What the model keeps from one task to the next. The store works on
 * keywords alone; the embedding and reranking models of the Embedding tab,
 * when set, make a recall find a note by what it means.
 *
 * Which memories a session uses is the user's choice per workspace, made in
 * the Memory panel: one memory new notes are kept in, and the memories that
 * are searched. The tools take no memory name: a model cannot store to, or
 * read from, a memory the user did not allow this workspace.
 */

import {
	type AgentTool,
	createTool,
	MAIN_MEMORY,
	type MemorySettings,
	memorySelectionFor,
} from "@cline/shared";
import {
	MEMORY_MAX_CHARS,
	type Memory,
	type MemoryEndpoints,
	sharedMemory,
} from "../../services/retrieval/memory";

export const MEMORY_TOOL_NAMES = ["remember", "recall", "forget"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export interface MemoryToolsConfig extends MemoryEndpoints {
	settings: MemorySettings;
}

export interface CreateMemoryToolsOptions {
	/** The workspace, which is what the user's choice of memories is filed under. */
	cwd: string;
	/** Read on every call. Undefined, or `enabled` off, means Memory is off. */
	getConfig: () => MemoryToolsConfig | undefined;
	/** @default the shared Memory of the data folder */
	memory?: Memory;
	onError?: (message: string, error: unknown) => void;
	log?: (message: string) => void;
}

const OFF =
	"Memory is turned off. The user turns it on under Settings > Memory; do not call this again in this task.";

function activeConfig(
	options: CreateMemoryToolsOptions,
): MemoryToolsConfig | undefined {
	const config = options.getConfig();
	return config?.settings.enabled ? config : undefined;
}

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * The memories this workspace uses, held to the ones that exist: a memory
 * deleted after it was picked is left out of the search, and notes go to
 * the main memory rather than nowhere.
 */
export function resolveMemoryAccess(
	memory: Memory,
	settings: MemorySettings,
	cwd: string,
): { store: string; recall: string[]; storeFellBack?: string } {
	const selection = memorySelectionFor(settings, cwd);
	const existing = new Set(memory.listMemories().map((entry) => entry.name));
	const recall = selection.recall.filter((name) => existing.has(name));
	return existing.has(selection.store)
		? { store: selection.store, recall }
		: { store: MAIN_MEMORY, recall, storeFellBack: selection.store };
}

function tagsOf(value: unknown): string[] {
	const list = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	return list.map((tag) => String(tag).trim()).filter(Boolean);
}

function createRememberTool(options: CreateMemoryToolsOptions): AgentTool {
	return createTool({
		name: "remember",
		description: `Keep a note for later tasks. Use it for what would otherwise have to be found out again: a decision and its reason, how this project is built, run and tested, a convention, a preference the user stated, a trap that cost time and how it was got round. One fact per note, written so it makes sense on its own months from now, with the names and paths in it. Do not keep what the code or the git history already says, what only matters to this task, or secrets. The note goes to the memory the user chose for this workspace. At most ${MEMORY_MAX_CHARS} characters.`,
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "The note." },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "A few words to find it by, e.g. build, testing.",
				},
			},
			required: ["text"],
		},
		execute: async (input: unknown, context): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return OFF;
			const request = (input ?? {}) as Record<string, unknown>;
			const memory = options.memory ?? sharedMemory();
			try {
				const access = resolveMemoryAccess(
					memory,
					config.settings,
					options.cwd,
				);
				const result = await memory.remember({
					text: typeof request.text === "string" ? request.text : "",
					memory: access.store,
					tags: tagsOf(request.tags),
					endpoints: config,
					...(context?.signal ? { signal: context.signal } : {}),
				});
				const where = `the "${access.store}" memory`;
				const fellBack = access.storeFellBack
					? ` The memory chosen for this workspace, "${access.storeFellBack}", no longer exists.`
					: "";
				return result.outcome === "unchanged"
					? `Already remembered as ${result.item.id} in ${where}; nothing was added.`
					: `Remembered as ${result.item.id} in ${where}.${fellBack}${result.note ? ` It is found by keyword for now: ${result.note}` : ""}`;
			} catch (error) {
				options.onError?.("[memory] remember failed", error);
				return `Not remembered: ${message(error)}`;
			}
		},
	});
}

function createRecallTool(options: CreateMemoryToolsOptions): AgentTool {
	return createTool({
		name: "recall",
		description:
			"Look in Memory for notes kept in earlier tasks: decisions, how the project is built and tested, conventions, the user's preferences, known traps. Call it at the start of a task with what the task is about, and again before deciding something that may have been decided before. It searches the memories the user allowed this workspace. With no query it lists the newest notes. What comes back is what was noted then: check it still holds before relying on it.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "What to look for. Leave out to list the newest notes.",
				},
				limit: { type: "integer" },
			},
		},
		execute: async (input: unknown, context): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return OFF;
			const request = (input ?? {}) as Record<string, unknown>;
			const memory = options.memory ?? sharedMemory();
			const limitInput = Number(request.limit);
			const limit =
				Number.isFinite(limitInput) && limitInput >= 1
					? Math.min(50, Math.round(limitInput))
					: config.settings.recallCount;
			const query =
				typeof request.query === "string" ? request.query.trim() : "";
			const describe = (item: {
				id: string;
				memory: string;
				tags: string[];
				createdAt: string;
				text: string;
				relevance?: number;
			}) =>
				`[${item.id}] ${item.createdAt.slice(0, 10)}, ${item.memory}${item.tags.length ? `, tags: ${item.tags.join(", ")}` : ""}${item.relevance !== undefined ? `, relevance ${item.relevance.toFixed(2)}` : ""}\n${item.text}`;
			try {
				const { recall } = resolveMemoryAccess(
					memory,
					config.settings,
					options.cwd,
				);
				if (recall.length === 0) {
					return "No memory is open for reading in this workspace. The user chooses which under Settings > Memory.";
				}
				if (!query) {
					const all = memory.list({ memories: recall });
					if (all.length === 0) {
						return "Memory holds nothing here yet. remember keeps a note.";
					}
					return [
						`Memory: the ${Math.min(limit, all.length)} newest of ${all.length} note${all.length === 1 ? "" : "s"}.`,
						...all.slice(0, limit).map(describe),
					].join("\n\n");
				}
				const result = await memory.recall(query, {
					memories: recall,
					settings: config.settings,
					endpoints: config,
					limit,
					...(context?.signal ? { signal: context.signal } : {}),
				});
				if (result.items.length === 0) {
					return [
						`Memory: nothing about "${query}". Try other words, or call recall with no query to list the newest notes.`,
						...result.notes,
					].join("\n");
				}
				return [
					[
						`Memory: ${result.items.length} note${result.items.length === 1 ? "" : "s"} about "${query}", best first. Noted in earlier tasks; check they still hold.`,
						...result.notes,
					].join("\n"),
					...result.items.map(describe),
				].join("\n\n");
			} catch (error) {
				options.onError?.("[memory] recall failed", error);
				return `Memory could not be searched: ${message(error)}`;
			}
		},
	});
}

function createForgetTool(options: CreateMemoryToolsOptions): AgentTool {
	return createTool({
		name: "forget",
		description:
			"Remove a note from Memory, by the id recall showed (m12). Use it when a note turned out wrong or no longer holds, and when the user asks to forget something. To correct a note, forget it and remember the right one. Only notes in the memory this workspace stores to can be removed.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "e.g. m12" } },
			required: ["id"],
		},
		execute: async (input: unknown): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return OFF;
			const id = String(
				(input as Record<string, unknown> | null)?.id ?? "",
			).trim();
			if (!id)
				return "`forget` needs the `id` of the note, as recall showed it.";
			try {
				const memory = options.memory ?? sharedMemory();
				// Removing is writing: only where this workspace may write.
				const { store } = resolveMemoryAccess(
					memory,
					config.settings,
					options.cwd,
				);
				const removed = await memory.forget(id, { memories: [store] });
				return removed
					? `Forgot ${id}.`
					: `There is no note ${id} in the "${store}" memory, the one this workspace stores to. A note in a memory that is only read here is the user's to remove.`;
			} catch (error) {
				options.onError?.("[memory] forget failed", error);
				return `Not forgotten: ${message(error)}`;
			}
		},
	});
}

/** Memory's tools, when Memory is on at session start. */
export function createMemoryTools(
	options: CreateMemoryToolsOptions,
): AgentTool[] {
	const config = activeConfig(options);
	if (!config) {
		options.log?.("memory tools omitted: Memory is off");
		return [];
	}
	options.log?.(
		`memory tools offered: ${config.embedding ? `embedding with ${config.embedding.model}` : "keyword search only"}`,
	);
	return [
		createRememberTool(options),
		createRecallTool(options),
		createForgetTool(options),
	];
}
