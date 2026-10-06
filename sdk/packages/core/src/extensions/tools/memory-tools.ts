/**
 * Memory's tools: `remember`, `recall` and `forget`.
 *
 * What the model keeps from one task to the next. The store works on
 * keywords alone; the embedding and reranking models of the Embedding tab,
 * when set, make a recall find a note by what it means.
 */

import { type AgentTool, createTool, type MemorySettings } from "@cline/shared";
import {
	MEMORY_MAX_CHARS,
	type Memory,
	type MemoryEndpoints,
	type MemoryScope,
	sharedMemory,
} from "../../services/retrieval/memory";

export const MEMORY_TOOL_NAMES = ["remember", "recall", "forget"] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export interface MemoryToolsConfig extends MemoryEndpoints {
	settings: MemorySettings;
}

export interface CreateMemoryToolsOptions {
	/** The workspace: what "this project" means for a project memory. */
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

function scopeOf(value: unknown): MemoryScope | undefined {
	return value === "project" || value === "global" ? value : undefined;
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
		description: `Keep a note for later tasks. Use it for what would otherwise have to be found out again: a decision and its reason, how this project is built, run and tested, a convention, a preference the user stated, a trap that cost time and how it was got round. One fact per note, written so it makes sense on its own months from now, with the names and paths in it. Do not keep what the code or the git history already says, what only matters to this task, or secrets. Scope "project" is this workspace only; "global" is every project (the user's preferences). At most ${MEMORY_MAX_CHARS} characters.`,
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "The note." },
				scope: {
					type: "string",
					enum: ["project", "global"],
					description: "Leave out for the user's default.",
				},
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
			const scope = scopeOf(request.scope) ?? config.settings.defaultScope;
			try {
				const result = await (options.memory ?? sharedMemory()).remember({
					text: typeof request.text === "string" ? request.text : "",
					scope,
					project: options.cwd,
					tags: tagsOf(request.tags),
					endpoints: config,
					...(context?.signal ? { signal: context.signal } : {}),
				});
				return result.outcome === "unchanged"
					? `Already remembered as ${result.item.id} (${result.item.scope}); nothing was added.`
					: `Remembered as ${result.item.id} (${scope === "global" ? "global: every project" : "this project"}).${result.note ? ` It is found by keyword for now: ${result.note}` : ""}`;
			} catch (error) {
				return `Not remembered: ${message(error)}`;
			}
		},
	});
}

function createRecallTool(options: CreateMemoryToolsOptions): AgentTool {
	return createTool({
		name: "recall",
		description:
			"Look in Memory for notes kept in earlier tasks: decisions, how the project is built and tested, conventions, the user's preferences, known traps. Call it at the start of a task with what the task is about, and again before deciding something that may have been decided before. It searches this project's notes and the global ones. With no query it lists the newest notes. What comes back is what was noted then: check it still holds before relying on it.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "What to look for. Leave out to list the newest notes.",
				},
				scope: {
					type: "string",
					enum: ["project", "global", "all"],
					description: "Leave out for all.",
				},
				limit: { type: "integer" },
			},
		},
		execute: async (input: unknown, context): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return OFF;
			const request = (input ?? {}) as Record<string, unknown>;
			const memory = options.memory ?? sharedMemory();
			const scope =
				request.scope === "all" ? "all" : (scopeOf(request.scope) ?? "all");
			const limitInput = Number(request.limit);
			const limit =
				Number.isFinite(limitInput) && limitInput >= 1
					? Math.min(50, Math.round(limitInput))
					: config.settings.recallCount;
			const query =
				typeof request.query === "string" ? request.query.trim() : "";
			const describe = (item: {
				id: string;
				scope: string;
				tags: string[];
				createdAt: string;
				text: string;
				relevance?: number;
			}) =>
				`[${item.id}] ${item.createdAt.slice(0, 10)}, ${item.scope}${item.tags.length ? `, tags: ${item.tags.join(", ")}` : ""}${item.relevance !== undefined ? `, relevance ${item.relevance.toFixed(2)}` : ""}\n${item.text}`;
			try {
				if (!query) {
					const all = memory.list({ project: options.cwd, scope });
					if (all.length === 0) {
						return "Memory holds nothing for this project yet. remember keeps a note.";
					}
					return [
						`Memory: the ${Math.min(limit, all.length)} newest of ${all.length} note${all.length === 1 ? "" : "s"}.`,
						...all.slice(0, limit).map(describe),
					].join("\n\n");
				}
				const result = await memory.recall(query, {
					project: options.cwd,
					scope,
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
			"Remove a note from Memory, by the id recall showed (m12). Use it when a note turned out wrong or no longer holds, and when the user asks to forget something. To correct a note, forget it and remember the right one.",
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
				const removed = await (options.memory ?? sharedMemory()).forget(id, {
					project: options.cwd,
				});
				return removed
					? `Forgot ${id}.`
					: `There is no note ${id} for this project. recall shows the ids.`;
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
