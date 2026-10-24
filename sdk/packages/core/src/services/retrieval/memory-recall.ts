/**
 * Automatic recall: Memory searched for every message the user sends, and
 * what is found put beside the message.
 *
 * The model has `recall`, and is told to call it at the start of a task. A
 * model that does not ask does not get its notes, and small models mostly do
 * not ask. So the host asks for it.
 *
 * The order of work is the one claude-hooks settled on after measuring it
 * (https://github.com/mann1x/claude-hooks, docs/hyde.md):
 *
 * 1. Search with the user's own words. Always.
 * 2. HyDE (Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance
 *    Labels", 2022), when it is on and step 1 found something: a second model
 *    writes the note that would answer the message, given the notes just
 *    found, and Memory is searched again with that. Grounded, because a model
 *    asked to imagine a note about a project's own jargon invents one about
 *    something else. Skipped when Memory holds no note in reach, for the
 *    same reason: there is nothing to ground on, and nothing to find.
 * 3. The two results are fused, the first search weighing as much as the
 *    second.
 *
 * One thing is added to that. A search always returns its best matches,
 * however poor: by keyword, "the" and "project" match every note. Asked for
 * by the model that is fine, it asked. Attached unasked to every message it
 * is noise, so a note is attached only when something says it is about the
 * message: the reranker scored it high, or it is close by meaning, or it
 * shares two meaningful words with what was searched for.
 *
 * Nothing here can fail a turn. A search that throws, an expander that times
 * out, a server that is down: the message goes to the model without notes.
 * But the user is told, in other words than "nothing found": a recall that
 * cannot run and a Memory with nothing to say end the same way for the
 * model, and are two different things to put right.
 */

import { RECALLED_MEMORY_TAG } from "@cline/shared";
import {
	type MemoryToolsConfig,
	resolveMemoryAccess,
} from "../../extensions/tools/memory-tools";
import { queryTerms } from "./library-store";
import { type Memory, type RecalledMemory, sharedMemory } from "./memory";

/** A message shorter than this is "yes", "continue", "go on": nothing to search for. */
export const MEMORY_RECALL_MIN_PROMPT_CHARS = 12;
/** A pasted log is not a question. Both ends are kept: the ask is at one of them. */
export const MEMORY_RECALL_MAX_QUERY_CHARS = 2000;
/** Notes given to the expander to ground on, and how much of them. */
export const HYDE_GROUND_NOTES = 3;
export const HYDE_GROUND_MAX_CHARS = 1500;
/** The expander's time. Past it the first search stands alone. */
export const HYDE_TIMEOUT_MS = 20_000;
/**
 * How close by meaning a note has to be to be attached unasked. A starting
 * point: it depends on the embedding model and is to be tuned.
 */
export const AUTO_RECALL_MIN_SIMILARITY = 0.5;
/** Meaningful words a note has to share with the search to be attached unasked. */
export const AUTO_RECALL_MIN_SHARED_WORDS = 2;
/**
 * The reranker's score that passes a note on its own. Its own floor, apart
 * from the user's threshold, which defaults to 0 and would pass every note.
 * Below it the note still has the other two tests.
 */
export const AUTO_RECALL_MIN_RELEVANCE = 0.5;
/**
 * The share of the session's window the notes may take. A share and not a
 * count: five notes of 4000 characters are a fifth of a 32k window.
 */
export const MEMORY_RECALL_WINDOW_SHARE = 0.04;
/** The window assumed when the host does not say: the smallest in common use. */
export const MEMORY_RECALL_FALLBACK_WINDOW = 32_768;
/** Characters per token, low, so the bound errs short. */
const CHARS_PER_TOKEN = 3.5;
const HYDE_CACHE_ENTRIES = 200;
const SESSIONS_TRACKED = 200;
const RRF_K = 60;

export const HYDE_SYSTEM_PROMPT =
	"You are a memory recall assistant. You are given a user's message and a few related notes retrieved from a knowledge base. Using ONLY facts consistent with those notes, write the short note that would answer the message, as if it were itself a stored note. Prefer the terms and specifics of the notes given. Do not invent facts beyond them. Two or three sentences. State facts; do not explain, and do not address the user.";

export function buildHydeUserPrompt(question: string, notes: string[]): string {
	return [
		"Related notes:",
		...notes.map((note, index) => `${index + 1}. ${note}`),
		"",
		`Message: ${question}`,
		"",
		"The stored note that answers it:",
	].join("\n");
}

/** Writes the hypothetical note. Undefined or empty: search without it. */
export type MemoryQueryExpander = (input: {
	system: string;
	prompt: string;
	signal: AbortSignal;
}) => Promise<string | undefined>;

export interface MemoryRecallInput {
	/** The user's message, as typed. */
	prompt: string;
	/** The workspace, which decides the memories that are searched. */
	cwd: string;
	/** Notes already given to a session are not given to it again. */
	sessionId?: string;
	/**
	 * The notes still in the conversation, by id (`recalledMemoryIds` reads
	 * them from its messages). Given, they are what counts as given: a note
	 * a compaction folded away can be given again. Left out, a note is given
	 * once per session.
	 */
	inConversation?: readonly string[];
	/** The session's window, in tokens, which bounds how much is attached. */
	contextWindow?: number;
}

export interface MemoryRecallResult {
	/** The block to put after the user's message. Absent: nothing found. */
	context?: string;
	/** The notes in it. */
	ids: string[];
	/** Whether the expander's note was searched with. */
	expanded: boolean;
	/** One line for the user: what was recalled, or why nothing could be. */
	summary?: string;
	/** Why the recall did not run. Not the same as nothing being found. */
	failed?: string;
}

export type MemoryRecaller = (
	input: MemoryRecallInput,
) => Promise<MemoryRecallResult | undefined>;

export interface CreateMemoryRecallerOptions {
	/** Read on every message. Undefined, or Memory off: no recall. */
	getConfig: () => MemoryToolsConfig | undefined;
	/** Read on every message, so a profile chosen mid-session is used. */
	getExpander?: () => MemoryQueryExpander | undefined;
	/** @default the shared Memory of the data folder */
	memory?: Memory;
	log?: (message: string) => void;
	hydeTimeoutMs?: number;
}

/** Words that say nothing about what a message is about. */
const STOPWORDS = new Set(
	"a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours please thanks every always never use using used want wants need needs like get got make made new one two project projects code file files thing things".split(
		" ",
	),
);

/** A word cut to what it shares with its plural and its verb forms. */
function stem(word: string): string {
	if (word.length <= 4) return word;
	return word.replace(/(?:ing|ed|es|s)$/, "");
}

/** The meaningful words of a text, stemmed. */
export function contentWords(text: string): Set<string> {
	const words = new Set<string>();
	for (const term of queryTerms(text)) {
		if (term.length < 2 || STOPWORDS.has(term)) continue;
		words.add(stem(term));
	}
	return words;
}

/** Whether a note found for a search is about it, and not merely the best of a poor lot. */
export function isAboutTheSearch(
	search: string,
	item: RecalledMemory,
): boolean {
	// The reranker read the two together. Its score passes a note only above
	// a floor of its own; the user's threshold, at its default of 0, passes
	// every note, and the gate is the only floor there is.
	if (
		item.relevance !== undefined &&
		item.relevance >= AUTO_RECALL_MIN_RELEVANCE
	) {
		return true;
	}
	if (
		item.similarity !== undefined &&
		item.similarity >= AUTO_RECALL_MIN_SIMILARITY
	) {
		return true;
	}
	const wanted = contentWords(search);
	if (wanted.size === 0) return false;
	const held = contentWords(`${item.text} ${item.tags.join(" ")}`);
	let shared = 0;
	for (const word of wanted) if (held.has(word)) shared += 1;
	return shared >= Math.min(AUTO_RECALL_MIN_SHARED_WORDS, wanted.size);
}

/** Bound a query, keeping its head and its tail. */
export function clampRecallQuery(
	query: string,
	maxChars = MEMORY_RECALL_MAX_QUERY_CHARS,
): string {
	const text = query.trim();
	if (text.length <= maxChars) return text;
	const half = Math.floor((maxChars - 5) / 2);
	return `${text.slice(0, half)}\n...\n${text.slice(-half)}`;
}

/** Reciprocal-rank fusion of two orderings of notes, best first. */
export function fuseRecalls(
	first: RecalledMemory[],
	second: RecalledMemory[],
	limit: number,
): RecalledMemory[] {
	const scores = new Map<string, { item: RecalledMemory; score: number }>();
	for (const ranking of [first, second]) {
		ranking.forEach((item, index) => {
			const held = scores.get(item.id);
			const score = 1 / (RRF_K + index + 1);
			if (held) held.score += score;
			else scores.set(item.id, { item, score });
		});
	}
	return [...scores.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.item);
}

function formatNote(item: RecalledMemory, text = item.text): string {
	return `[${item.id}] ${item.createdAt.slice(0, 10)}, ${item.memory}${item.tags.length ? `, tags: ${item.tags.join(", ")}` : ""}\n${text}`;
}

/** How many characters of notes a window of this size takes. */
export function recallCharBudget(contextWindow: number | undefined): number {
	const window =
		contextWindow && contextWindow > 0
			? contextWindow
			: MEMORY_RECALL_FALLBACK_WINDOW;
	return Math.floor(window * MEMORY_RECALL_WINDOW_SHARE * CHARS_PER_TOKEN);
}

/**
 * The notes that fit in this many characters, best first. A note that does
 * not fit is left for the next, smaller ones; the best note is always given,
 * cut if it has to be, with the id to recall it whole.
 */
export function fitRecalledMemory(
	items: RecalledMemory[],
	maxChars: number,
): { items: RecalledMemory[]; cut?: string } {
	const kept: RecalledMemory[] = [];
	let used = 0;
	for (const item of items) {
		const size = formatNote(item).length + 2;
		if (used + size <= maxChars) {
			kept.push(item);
			used += size;
		}
	}
	if (kept.length > 0 || items.length === 0) return { items: kept };
	const first = items[0];
	const room = Math.max(200, maxChars - formatNote(first, "").length - 80);
	return {
		items: [
			{
				...first,
				text: `${first.text.slice(0, room)}\n... (cut to fit; recall ${first.id} for all of it)`,
			},
		],
		cut: first.id,
	};
}

export function formatRecalledMemory(items: RecalledMemory[]): string {
	return [
		`<${RECALLED_MEMORY_TAG}>`,
		`Notes from earlier tasks that may bear on this message, found automatically (${items.length}). They were true when noted: check they still hold before relying on them, and ignore any that do not apply. The recall tool searches for more.`,
		"",
		...items.map((item) => formatNote(item)),
		`</${RECALLED_MEMORY_TAG}>`,
	].join("\n");
}

/**
 * The ids of the notes recall attached that are still in these texts: the
 * head line of each, as `formatRecalledMemory` writes it. A compaction that
 * kept a note word for word kept that line with it.
 */
export function recalledMemoryIds(texts: Iterable<string>): string[] {
	const ids = new Set<string>();
	for (const text of texts) {
		if (!text.includes(`<${RECALLED_MEMORY_TAG}>`)) continue;
		for (const match of text.matchAll(/^\[(m\d+)\] \d{4}-\d{2}-\d{2}, /gm)) {
			ids.add(match[1]);
		}
	}
	return [...ids];
}

export function createMemoryRecaller(
	options: CreateMemoryRecallerOptions,
): MemoryRecaller {
	const given = new Map<string, Set<string>>();
	// Search notes said to a session ("searched by keyword"), said once.
	const told = new Map<string, Set<string>>();
	const expansions = new Map<string, string>();
	const hydeTimeoutMs = options.hydeTimeoutMs ?? HYDE_TIMEOUT_MS;

	const tracked = (
		map: Map<string, Set<string>>,
		sessionId: string | undefined,
	): Set<string> => {
		if (!sessionId) return new Set();
		let set = map.get(sessionId);
		if (!set) {
			set = new Set();
			map.set(sessionId, set);
			if (map.size > SESSIONS_TRACKED) {
				const oldest = map.keys().next().value;
				if (oldest !== undefined) map.delete(oldest);
			}
		}
		return set;
	};
	const givenTo = (input: MemoryRecallInput): Set<string> => {
		if (!input.inConversation) return tracked(given, input.sessionId);
		// The conversation says what it holds; a note folded away is not in it.
		const set = new Set(input.inConversation);
		if (input.sessionId) given.set(input.sessionId, set);
		return set;
	};
	const newNotes = (sessionId: string | undefined, notes: string[]) => {
		const said = tracked(told, sessionId);
		const fresh = [...new Set(notes)].filter((note) => !said.has(note));
		for (const note of fresh) said.add(note);
		return fresh;
	};

	const expand = async (
		expander: MemoryQueryExpander,
		question: string,
		grounding: Array<{ text: string }>,
	): Promise<string | undefined> => {
		const budget = Math.max(
			200,
			Math.floor(HYDE_GROUND_MAX_CHARS / HYDE_GROUND_NOTES),
		);
		const notes = grounding
			.slice(0, HYDE_GROUND_NOTES)
			.map((item) => item.text.slice(0, budget));
		const prompt = buildHydeUserPrompt(question, notes);
		const cached = expansions.get(prompt);
		if (cached) return cached;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), hydeTimeoutMs);
		try {
			const text = (
				await expander({
					system: HYDE_SYSTEM_PROMPT,
					prompt,
					signal: abort.signal,
				})
			)?.trim();
			if (!text) return undefined;
			expansions.set(prompt, text);
			if (expansions.size > HYDE_CACHE_ENTRIES) {
				const oldest = expansions.keys().next().value;
				if (oldest !== undefined) expansions.delete(oldest);
			}
			return text;
		} finally {
			clearTimeout(timer);
		}
	};

	return async (input) => {
		const config = options.getConfig();
		if (!config?.settings.enabled || !config.settings.autoRecall) {
			return undefined;
		}
		const question = input.prompt.trim();
		if (question.length < MEMORY_RECALL_MIN_PROMPT_CHARS) return undefined;
		const memory = options.memory ?? sharedMemory();
		const query = clampRecallQuery(question);
		let memories: string[] = [];
		const searchNotes: string[] = [];
		const search = async (text: string) => {
			const result = await memory.recall(text, {
				memories,
				settings: config.settings,
				endpoints: config,
			});
			searchNotes.push(...result.notes);
			return {
				found: result.items,
				about: result.items.filter((item) => isAboutTheSearch(text, item)),
			};
		};
		try {
			memories = resolveMemoryAccess(memory, config.settings, input.cwd).recall;
			if (memories.length === 0) return undefined;
			const raw = await search(query);
			let items = raw.about;
			let expanded = false;
			const expander = config.settings.hyde
				? options.getExpander?.()
				: undefined;
			if (expander) {
				try {
					// Grounded on what the search returned, about the message or
					// not: the notes that miss a message by its words are the
					// ones the expansion is for, and what it writes is still
					// held to the same test before anything is attached. A
					// keyword search of a message sharing no word with any note
					// returns nothing; the newest notes then stand in, which at
					// least speak the project's language. No notes at all: no
					// expansion, there is nothing it could find.
					const grounding =
						raw.found.length > 0 ? raw.found : memory.list({ memories });
					const note =
						grounding.length > 0
							? await expand(expander, query, grounding)
							: undefined;
					// Said either way: "the expansion found nothing" and "the
					// expansion never ran" end the same for the user, and are
					// two different things to put right.
					options.log?.(
						note
							? `memory recall: expanded to "${note.slice(0, 160)}"`
							: grounding.length > 0
								? "memory recall: the expansion came back empty, searched with the message alone"
								: "memory recall: no notes to ground an expansion on",
					);
					if (note && note !== query) {
						const refined = await search(clampRecallQuery(note));
						items = fuseRecalls(
							raw.about,
							refined.about,
							config.settings.recallCount,
						);
						expanded = true;
					}
				} catch (error) {
					options.log?.(
						`memory recall: the expansion failed, searched with the message alone (${error instanceof Error ? error.message : String(error)})`,
					);
				}
			}
			const already = givenTo(input);
			const unseen = items.filter((item) => !already.has(item.id));
			// What the search could not do ("searched by keyword"), said once
			// a session: an empty recall from a degraded search is not the
			// same as Memory having nothing.
			const degraded = newNotes(input.sessionId, searchNotes);
			for (const note of degraded) options.log?.(`memory recall: ${note}`);
			const fitted = fitRecalledMemory(
				unseen,
				recallCharBudget(input.contextWindow),
			);
			const fresh = fitted.items;
			if (fresh.length === 0) {
				options.log?.(
					items.length > 0
						? "memory recall: nothing new, the notes found were already given to this task"
						: `memory recall: no note is about this message (${raw.found.length} looked at)`,
				);
				return degraded.length > 0
					? {
							ids: [],
							expanded,
							summary: `Memory found no note for this message. ${degraded.join(" ")}`,
						}
					: undefined;
			}
			const left = unseen.length - fresh.length;
			if (fitted.cut || left > 0) {
				options.log?.(
					`memory recall: ${fitted.cut ? `${fitted.cut} cut` : `${left} more left out`} to fit ${recallCharBudget(input.contextWindow)} characters`,
				);
			}
			for (const item of fresh) already.add(item.id);
			const ids = fresh.map((item) => item.id);
			options.log?.(
				`memory recall: ${ids.join(", ")}${expanded ? " (expanded)" : ""}`,
			);
			return {
				context: formatRecalledMemory(fresh),
				ids,
				expanded,
				summary: [
					`Recalled ${fresh.length} note${fresh.length === 1 ? "" : "s"} from Memory (${ids.join(", ")})${expanded ? ", searched with an expanded question" : ""}${left > 0 ? `; ${left} more did not fit the window` : ""}.`,
					...degraded,
				].join(" "),
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			options.log?.(
				`memory recall failed, the message goes without notes: ${reason}`,
			);
			// Told once a session for each reason, not on every message.
			const summary = `Memory unreachable, the message went without notes: ${reason}`;
			return {
				ids: [],
				expanded: false,
				failed: reason,
				...(newNotes(input.sessionId, [summary]).length > 0 ? { summary } : {}),
			};
		}
	};
}
