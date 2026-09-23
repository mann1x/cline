/**
 * How a sub-agent's first request is laid out, and what it shares.
 *
 * Two layouts, chosen by where the agent runs.
 *
 * **On a PolyKV node** the request is built for deduplication, one shared layer
 * per turn, in the order the engine's pool tree nests them:
 *
 *   system  the sub-agent base prompt           -- identical for every agent
 *   user    the knowledge, with files inlined   -- identical for every agent given it
 *   user    the instructions of the agent's role -- identical for every agent of it
 *   user    the task                            -- the agent's own
 *
 * Each of the first three is a pool the engine holds once for the whole swarm
 * (`polykv-swarm.ts`). The file is read here, once, and inlined: an agent that
 * is only told the path reads it with its own tool, and every agent then holds
 * a private copy -- measured, 51 agents each carrying the same 15,191-byte read
 * result in their own suffix.
 *
 * **Everywhere else** there is nothing to dedupe against, so nothing changes
 * for the model: the instructions are the system prompt and the knowledge
 * rides at the top of the one task message -- with files named, not inlined,
 * because the agent has the tools to read what it needs and a copy it may not
 * need is context it pays for on every turn.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** What several agents are given in common. */
export interface SubagentKnowledge {
	/** Workspace files every agent given this knowledge works from. */
	files?: string[];
	/** Shared notes: findings, constraints, context. */
	text?: string;
}

/**
 * The system prompt of every pooled sub-agent.
 *
 * Fixed on purpose: it is the root of the pool tree, and a prompt that varied
 * per agent would share nothing below it. What makes agents different goes in
 * the instructions turn.
 */
export const SUBAGENT_BASE_PROMPT = [
	"You are a sub-agent working on one task for a lead agent.",
	"",
	"- Your role and your task follow in the conversation. Shared knowledge, when there is any, comes first and is the same for every agent working alongside you.",
	"- Files inlined in the shared knowledge are already in your context: do not read them again. Read other files with your tools when you need them.",
	"- Stay inside your task. Other agents are handling the rest.",
	"- Finish with a short report of what you found or did, with file paths and line numbers where they apply. The report is all the lead sees.",
].join("\n");

/** Files larger than this are named rather than inlined. */
export const SUBAGENT_INLINE_FILE_MAX_CHARS = 200_000;

/**
 * Reads, remembered by path and modification time.
 *
 * Every agent given the same file must receive the same bytes, or their
 * knowledge turns differ and the pool built for the first one shares nothing
 * with the rest. Reading once per version guarantees it, and costs one read
 * per swarm instead of one per agent.
 */
const FILE_CACHE = new Map<string, { key: string; text: string | undefined }>();

async function readShared(path: string): Promise<string | undefined> {
	try {
		const info = await stat(path);
		const key = `${info.mtimeMs}:${info.size}`;
		const cached = FILE_CACHE.get(path);
		if (cached?.key === key) {
			return cached.text;
		}
		const text =
			info.size > SUBAGENT_INLINE_FILE_MAX_CHARS * 4
				? undefined
				: await readFile(path, "utf8");
		const kept =
			text !== undefined && text.length <= SUBAGENT_INLINE_FILE_MAX_CHARS
				? text
				: undefined;
		FILE_CACHE.set(path, { key, text: kept });
		return kept;
	} catch {
		return undefined;
	}
}

function hasKnowledge(knowledge: SubagentKnowledge | undefined): boolean {
	return Boolean(
		knowledge?.text?.trim() ||
			(knowledge?.files ?? []).some((file) => file.trim()),
	);
}

/** The knowledge turn of a pooled agent: notes, then each file inlined. */
async function renderInlineKnowledge(
	knowledge: SubagentKnowledge,
	cwd: string | undefined,
): Promise<string> {
	const parts = ["# Shared knowledge", ""];
	const notes = knowledge.text?.trim();
	if (notes) {
		parts.push(notes, "");
	}
	const named: string[] = [];
	for (const raw of knowledge.files ?? []) {
		const file = raw.trim();
		if (!file) {
			continue;
		}
		const path = isAbsolute(file) || !cwd ? file : resolve(cwd, file);
		const text = await readShared(path);
		if (text === undefined) {
			named.push(file);
			continue;
		}
		parts.push(`<file path="${file}">`, text, "</file>", "");
	}
	if (named.length > 0) {
		parts.push(
			"Also relevant, not inlined (read them with your tools if you need them):",
			...named.map((file) => `- ${file}`),
			"",
		);
	}
	return parts.join("\n").trimEnd();
}

/** The knowledge preamble of an unpooled agent: notes, and files by name. */
function renderReferenceKnowledge(knowledge: SubagentKnowledge): string {
	const parts = ["# Shared knowledge", ""];
	const notes = knowledge.text?.trim();
	if (notes) {
		parts.push(notes, "");
	}
	const files = (knowledge.files ?? [])
		.map((file) => file.trim())
		.filter(Boolean);
	if (files.length > 0) {
		parts.push(
			"Files to work from (read them with your tools as you need them):",
			...files.map((file) => `- ${file}`),
		);
	}
	return parts.join("\n").trimEnd();
}

export interface SubagentLayout {
	/** The agent's system prompt. */
	systemPrompt: string;
	/** The agent's own task turn. */
	task: string;
	/**
	 * The shared turns at the head of the conversation, verbatim, before the
	 * task.
	 *
	 * Compaction must leave them exactly where they are: they are the pool the
	 * agent's every request attaches to, and a head rewritten by a summary
	 * matches nothing and shares nothing for the rest of the run.
	 */
	pinnedHead: string[];
	/** How many turns after the system turn are shared layers. */
	layers: number;
}

export async function buildSubagentLayout(options: {
	/** The agent's role, as the lead wrote it. */
	instructions: string;
	task: string;
	knowledge?: SubagentKnowledge;
	/** Whether the agent runs on a PolyKV node. */
	pooled: boolean;
	cwd?: string;
}): Promise<SubagentLayout> {
	const instructions = options.instructions.trim();
	const knowledge = hasKnowledge(options.knowledge)
		? options.knowledge
		: undefined;
	if (!options.pooled) {
		return {
			systemPrompt: instructions,
			task: knowledge
				? `${renderReferenceKnowledge(knowledge)}\n\n# Task\n\n${options.task}`
				: options.task,
			pinnedHead: [],
			layers: 0,
		};
	}
	const head: string[] = [];
	if (knowledge) {
		head.push(await renderInlineKnowledge(knowledge, options.cwd));
	}
	if (instructions) {
		head.push(`# Your role\n\n${instructions}`);
	}
	return {
		systemPrompt: SUBAGENT_BASE_PROMPT,
		task: `# Your task\n\n${options.task}`,
		pinnedHead: head,
		layers: head.length,
	};
}

/** The text of a message, for comparing a head turn against what was pinned. */
function textOf(message: unknown): string | undefined {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const texts = content
		.filter(
			(part): part is { type: "text"; text: string } =>
				(part as { type?: string })?.type === "text",
		)
		.map((part) => part.text);
	return texts.length > 0 ? texts.join("") : undefined;
}

type PrepareTurn<I, R> = (input: I) => Promise<R | undefined>;

/**
 * Keep the shared head out of compaction's reach.
 *
 * The turns are taken off the front before the pipeline sees the conversation
 * and put back in front of whatever it returns, unchanged. Compaction then
 * summarises only the agent's own work -- which is also the only part of the
 * conversation that grows -- and every request after it still opens with the
 * exact tokens of the pool.
 *
 * A conversation that does not start with the pinned turns is passed through
 * untouched: something upstream already changed the head, and guessing where
 * it went would be worse than leaving the pipeline to see the whole thing.
 */
export function pinConversationHead<
	I extends { messages: readonly unknown[]; apiMessages?: readonly unknown[] },
	R extends { messages: readonly unknown[] },
>(
	prepare: PrepareTurn<I, R> | undefined,
	pinned: readonly string[],
): PrepareTurn<I, R> | undefined {
	if (!prepare || pinned.length === 0) {
		return prepare;
	}
	const startsWithHead = (messages: readonly unknown[] | undefined): boolean =>
		Array.isArray(messages) &&
		messages.length > pinned.length &&
		pinned.every((text, index) => textOf(messages[index]) === text);
	return async (input) => {
		if (!startsWithHead(input.messages)) {
			return prepare(input);
		}
		const head = input.messages.slice(0, pinned.length);
		const result = await prepare({
			...input,
			messages: input.messages.slice(pinned.length),
			...(input.apiMessages && startsWithHead(input.apiMessages)
				? { apiMessages: input.apiMessages.slice(pinned.length) }
				: {}),
		});
		if (!result) {
			return result;
		}
		return { ...result, messages: [...head, ...result.messages] };
	};
}
