/**
 * Continuation notes for a turn whose thinking ran out of budget.
 *
 * A model that hits its thinking cap does not stop reasoning — it stops
 * mid-sentence, emits whatever tool call it can, and on the next turn starts the
 * same reasoning from the beginning. Observed on a live session: the same
 * ground covered a dozen times, each pass reaching "this is the final plan" and
 * then "wait, I just realised…", each one ending at the same cap, and each one
 * producing a differently-malformed call because the argument-writing was the
 * part that got cut.
 *
 * The reasoning is in the transcript, so in principle nothing is lost. In
 * practice seventeen thousand tokens of interrupted rambling is not something a
 * model reads and continues from; it is something it re-derives. So when the cap
 * fires, that turn's thinking is replaced — for the next request only — with a
 * short note of what it settled, what it ruled out, and what the tool call it
 * managed to make came back as. Short enough to be read, and framed as
 * conclusions rather than as a transcript to resume.
 */

import { createHandlerAsync } from "@cline/llms";
import type {
	BasicLogger,
	DiscardedTurnCondensation,
	DiscardedTurnInput,
	MessageWithMetadata,
} from "@cline/shared";
import type { CoreCompactionSummarizerConfig } from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
	buildThinkingSummaryRequest,
	estimateThinkingTokens,
	flattenToolResultContent,
	formatToolInput,
	resolveSummarizerConfig,
	truncateText,
} from "./compaction-shared";

/**
 * How close to the budget counts as having hit it.
 *
 * Not equality: a budget is enforced on whole tokens as they are produced, and
 * the turn stops on the first one that does not fit, so the last few are never
 * spent. A turn that spent nine tenths of its allowance was cut short in every
 * way that matters here.
 *
 * What this is compared against matters more than the ratio. The first version
 * of this compared an *estimate* — reasoning characters over the request-wide
 * chars-per-token ratio, 3.8 to 4.4 on a serialized request full of JSON and
 * code — against a budget denominated in the model's own tokens. A turn that
 * spent all 16,000 of its allowance, about 43,000 characters of prose,
 * therefore measured as ~10,300 and never crossed the line. The cap fired on
 * nearly 300 requests in one session and the detector saw none of them.
 */
const CAP_PROXIMITY = 0.9;

/**
 * How far back from the end of the reasoning the budget message can be.
 *
 * It is appended when the budget runs out, so it is at the end. Scanning only
 * the tail keeps a model that happens to *discuss* its thinking budget
 * mid-reasoning from being read as one that ran out of it.
 */
const BUDGET_MESSAGE_TAIL_MARGIN_CHARS = 400;

/**
 * Whether the server's own budget message is at the end of this reasoning.
 *
 * Only ever called with a message the session actually knows: either Cline set
 * it on the request, or Ollama reported the model's own via `/api/show`. There
 * is no guessing at the wording — a model with no message configured has no
 * marker to find, and this is not consulted for one.
 */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The line of the message to look for.
 *
 * The longest one, not the first. A message from a Modelfile arrives as the
 * author wrote it — `v7-coder_tb` opens its with two blank lines — and one a
 * user typed into the settings box can open with anything at all, including a
 * word short enough to appear in ordinary reasoning. The longest line is the
 * one least likely to be either.
 */
function budgetMessageMarker(message: string): string {
	let marker = "";
	for (const line of message.split("\n")) {
		const collapsed = collapseWhitespace(line);
		if (collapsed.length > marker.length) {
			marker = collapsed;
		}
	}
	return marker;
}

function endsWithBudgetMessage(thinking: string, message: string): boolean {
	const marker = budgetMessageMarker(message);
	if (!marker) {
		return false;
	}
	// Both sides collapsed: the same sentence is not always laid out the same
	// way twice. A Modelfile writes its line breaks as `\n` escapes, a user
	// types real ones, and the model's own copy of the message is whatever the
	// server streamed — which is not required to keep either.
	return collapseWhitespace(
		thinking.slice(-(marker.length + BUDGET_MESSAGE_TAIL_MARGIN_CHARS)),
	).includes(marker);
}

/** What the note is allowed to cost. It is a handful of lines by design. */
/**
 * Guard against a runaway note becoming the thing that fills the window.
 *
 * Generous, because the note is the only surviving record of a think that ran
 * to twenty or thirty thousand characters and it has to be detailed enough to
 * work from -- it is a summary, not a retrospective. A summary of that think
 * lands nowhere near this in practice, which is what makes it a guard rather
 * than a target.
 */
const CONDENSED_THINKING_MAX_CHARS = 12_000;

/**
 * The output cap for the condensation call itself.
 *
 * A fixed cap was removed once, for a good reason: at 700 tokens against a
 * summariser that reasons, the whole budget went into thinking and the call
 * returned no text at all. The condensation call now asks for no reasoning, so
 * the budget is the note -- and something has to bound it, because a small
 * model asked for prose in its own voice can fall into repeating itself.
 * Measured live: a note that opened "Summary-of-thought process:" and then said
 * a variant of that line thirty times.
 *
 * Set well above what the note needs, so it is a stop rather than a limit the
 * note is written to.
 */
const CONDENSED_THINKING_MAX_OUTPUT_TOKENS = 2_000;

/**
 * Whether a note is the model repeating itself rather than writing.
 *
 * Degeneration is not a graceful failure here: the note goes into the thinking
 * channel as the model's own reasoning, so thirty near-identical lines are read
 * as thirty things it thought. No note at all is strictly better -- the turn
 * then re-derives, which is the behaviour this feature improves on rather than
 * one it breaks.
 *
 * Two cheap tests, because the shape is unmistakable: mostly-repeated lines, or
 * one line that repeats a phrase over and over.
 */
export function isDegenerateNote(note: string): boolean {
	const lines = note
		.split("\n")
		.map((line) => line.trim().toLowerCase())
		.filter((line) => line.length > 0);
	if (lines.length >= 6) {
		// Thresholds set against the observed sample rather than by taste: ten
		// lines, five of them exact repeats and four sharing an opening. Prose
		// that is actually written repeats neither way, so the gap between a real
		// note and this one is wide.
		const distinct = new Set(lines).size;
		if (distinct / lines.length <= 0.6) {
			return true;
		}
		// Near-identical rather than identical: "Summary-of-thought process:" and
		// "Summary of the task at hand is at the thought process:" are different
		// strings and the same failure. Compare on the first few words.
		const stems = lines.map((line) => line.split(/\s+/).slice(0, 4).join(" "));
		if (new Set(stems).size / stems.length <= 0.5) {
			return true;
		}
	}
	const words = note.trim().toLowerCase().split(/\s+/);
	if (words.length >= 40) {
		const distinct = new Set(words).size;
		if (distinct / words.length < 0.35) {
			return true;
		}
	}
	return false;
}

/**
 * The instruction half of the retrospective call.
 *
 * The user half is the compaction's own retrospective prompt; this only says
 * who is writing and for whom.
 */
const CAPPED_THINKING_RETROSPECTIVE_SYSTEM_PROMPT =
	"You are recording what a train of reasoning established about the problem it was working on, for the agent that is about to reason about the same problem again. Not what it decided -- that is written down elsewhere -- but what it found out: the constraints, the dead ends and why they were dead, the facts about the code that took work to establish. Plain prose, no headings, no preamble.";

/**
 * The line the condensed reasoning arrives under, inside the thinking channel.
 *
 * First person, because of where it lands. The note replaces a thinking block
 * and is read as thinking; a line announcing "this is the note you left
 * yourself" turns the model's own reasoning into a document handed to it, and a
 * document gets checked rather than continued. Measured on a live run: the
 * model opened its next turn quoting the note back and arguing with a tool
 * result about it, then re-read the same file and reasoned to the budget again.
 */
const CONDENSED_THINKING_LEAD_IN =
	"I have already reasoned this far on this problem, up to the point where I ran out of thinking budget. Picking up from here rather than starting again:";

/**
 * The instruction half of the condensation request.
 *
 * Short on purpose, and separate from the task itself, which travels as the
 * user message: the same split the compaction summariser uses. It says what the
 * note is for; `DEFAULT_CAPPED_THINKING_PROMPT` says what it must contain.
 */
export const CAPPED_THINKING_SYSTEM_PROMPT =
	"You are compressing a train of thought, in the voice of the person who was thinking it. What you write goes back into that same reasoning as its own continuation -- not as a report about it -- so write it the way thinking is written: first person, present tense, plain sentences, no headings and no lists. Keep every specific: paths, symbols, line numbers, error text, and above all what was already ruled out and why.";

export const DEFAULT_CAPPED_THINKING_PROMPT = `You were reasoning about a problem and ran out of thinking budget mid-thought. Below is how far you got, and what the tool call you managed to make returned.

Rewrite that reasoning, compressed, as the thinking it is. It is going back into your own reasoning channel as the part you have already done, so that your next pass starts from here instead of starting over and arriving at this same point again.

Write it as thought, not as a report about thought:
- First person, present tense, the way you were already thinking. No headings, no bullet lists, no preamble, no sign-off. Do not label it or announce what it is; just think.
- A paragraph or two. Long enough to carry the specifics, short enough that none of it is padding. If you find yourself restating a line you have already written, you are finished: stop.
- State what you have settled as settled. Do not re-derive it and do not hedge it.
- Say what you ruled out and why, in a clause each. This is the part that stops the next pass repeating this one, and it is the part that gets dropped first if you are careless.
- End on the one question still open and the single next action, stated concretely.

Two things to keep out of it:
- Do not copy file contents. Name the file and the line and say what you concluded about it. Quoted code goes stale the moment the file is edited, and reasoning that argues with the next tool result costs more than it saved.
- Do not narrate the interruption. It is not part of the problem.`;

interface ToolOutcome {
	name: string;
	input: string;
	result: string;
}

/** What the capped turn actually called, and what came back. */
function collectToolOutcomes(
	messages: readonly MessageWithMetadata[],
	index: number,
): ToolOutcome[] {
	const message = messages[index];
	if (!Array.isArray(message?.content)) {
		return [];
	}
	const results = new Map<string, string>();
	for (const later of messages.slice(index + 1)) {
		if (!Array.isArray(later.content)) {
			continue;
		}
		for (const block of later.content) {
			if (block.type === "tool_result") {
				results.set(block.tool_use_id, flattenToolResultContent(block.content));
			}
		}
	}
	const outcomes: ToolOutcome[] = [];
	for (const block of message.content) {
		if (block.type !== "tool_use") {
			continue;
		}
		outcomes.push({
			name: block.name,
			input: truncateText(formatToolInput(block.input), 1_000),
			result: truncateText(results.get(block.id) ?? "(no result yet)", 2_000),
		});
	}
	return outcomes;
}

function thinkingText(message: MessageWithMetadata): string {
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking)
		.join("\n")
		.trim();
}

/**
 * What this turn's reasoning cost, in the model's own tokens.
 *
 * Measured rather than estimated wherever the turn reported its output: the
 * ratio between the characters a turn produced and the tokens the provider
 * counted for them is that turn's own, and needs no assumption about how prose
 * tokenizes. The estimate is the fallback, and uses the reasoning-specific
 * ratio rather than the request-wide one, which is what made the first version
 * of this never fire.
 */
function measuredThinkingTokens(
	message: MessageWithMetadata,
	thinking: string,
): number {
	const outputTokens = (message as { metrics?: { outputTokens?: number } })
		.metrics?.outputTokens;
	if (
		typeof outputTokens === "number" &&
		Number.isFinite(outputTokens) &&
		outputTokens > 0
	) {
		const producedChars = producedCharacters(message);
		if (producedChars > 0) {
			return Math.round((thinking.length / producedChars) * outputTokens);
		}
	}
	return estimateThinkingTokens(thinking.length);
}

/** Everything the turn wrote, which is what its output tokens were spent on. */
function producedCharacters(message: MessageWithMetadata): number {
	if (!Array.isArray(message.content)) {
		return 0;
	}
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "tool_use") {
			chars += formatToolInput(block.input).length + block.name.length;
		}
	}
	return chars;
}

/**
 * Why a look for a capped turn came back with nothing.
 *
 * Every one of these has been mistaken for "the feature is broken" at least
 * once, and from the outside they are indistinguishable: no note, no error, no
 * line. They are distinguishable from in here, so they are reported.
 */
export type CappedThinkingStandDown =
	| "no-budget"
	| "no-assistant-turn"
	| "turn-did-not-reason"
	| "budget-message-absent"
	| "under-budget";

export interface CappedThinkingLookup {
	index: number;
	reason?: CappedThinkingStandDown;
	/** Characters of reasoning on the turn that was examined. */
	thinkingChars?: number;
	/** Its last few hundred characters, which is where the message would be. */
	thinkingTail?: string;
	/** What the estimate made of it, when the estimate is what decided. */
	measuredTokens?: number;
	/** Call-only assistant messages stepped over on the way back. */
	skippedFragments?: number;
}

/** How much of the reasoning tail a stand-down line carries. */
const STAND_DOWN_TAIL_CHARS = 240;

/**
 * The most recent turn whose reasoning hit the cap, and why not when not.
 *
 * Only the most recent: older capped turns have already had their consequences
 * play out in the transcript, and rewriting history the model has since acted on
 * is a different and more dangerous idea than helping it continue.
 */
export function locateCappedThinking(
	messages: readonly MessageWithMetadata[],
	budgetTokens: number | undefined,
	options?: { budgetMessage?: string },
): CappedThinkingLookup {
	if (
		typeof budgetTokens !== "number" ||
		!Number.isFinite(budgetTokens) ||
		budgetTokens <= 0
	) {
		return { index: -1, reason: "no-budget" };
	}
	let skippedFragments = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		const thinking = thinkingText(message);
		if (!thinking) {
			if (isToolCallOnly(message)) {
				// Not a turn — a fragment of one. A turn reaches the transcript
				// as its reasoning and its call, and depending on how it was
				// assembled those can arrive as one message or two. Stopping at
				// the half without the reasoning would mean never finding a
				// capped turn at all, so the search steps over it while its
				// sibling is still the most recent thing that reasoned.
				skippedFragments += 1;
				continue;
			}
			// An assistant turn that answered without reasoning ends the search:
			// the capped turn we care about is the latest one, and anything
			// before this has already been superseded.
			return {
				index: -1,
				reason: "turn-did-not-reason",
				thinkingChars: 0,
				skippedFragments,
			};
		}
		const found = {
			thinkingChars: thinking.length,
			thinkingTail: thinking.slice(-STAND_DOWN_TAIL_CHARS),
			skippedFragments,
		};
		// A known budget message settles it either way. The measurement above is
		// good but not certain — it cannot tell which cap stopped a turn, and it
		// falls back to a ratio for turns that reported no usage — whereas the
		// message is the server stating what it did. So where the session knows
		// the wording, presence confirms and absence denies, and the estimate is
		// what runs when nobody configured one.
		const budgetMessage = options?.budgetMessage?.trim();
		if (budgetMessage) {
			return endsWithBudgetMessage(thinking, budgetMessage)
				? { index, ...found }
				: { index: -1, reason: "budget-message-absent", ...found };
		}
		const measuredTokens = measuredThinkingTokens(message, thinking);
		return measuredTokens >= budgetTokens * CAP_PROXIMITY
			? { index, measuredTokens, ...found }
			: { index: -1, reason: "under-budget", measuredTokens, ...found };
	}
	return { index: -1, reason: "no-assistant-turn", skippedFragments };
}

/**
 * An assistant message carrying calls and nothing else.
 *
 * Text would make it a turn that answered; reasoning is handled by the caller.
 * Anything else — a bare call, or a call beside an image — is half of a turn
 * whose other half is the message before it.
 */
function isToolCallOnly(message: MessageWithMetadata): boolean {
	if (!Array.isArray(message.content) || message.content.length === 0) {
		return false;
	}
	return message.content.every((block) => block.type === "tool_use");
}

/** The index alone, for callers that have nothing to report it to. */
export function findCappedThinkingIndex(
	messages: readonly MessageWithMetadata[],
	budgetTokens: number | undefined,
	options?: { budgetMessage?: string },
): number {
	return locateCappedThinking(messages, budgetTokens, options).index;
}

/**
 * The last few messages, as roles and block types.
 *
 * The detector reads the transcript the runtime hands it, which is not
 * necessarily the one on disk — and the difference between those two is the
 * only thing a stand-down cannot be diagnosed without. Written as
 * `assistant:thinking(35438),tool_use` so one line says what was there.
 */
function describeTranscriptTail(
	messages: readonly MessageWithMetadata[],
	count = 3,
): string {
	return messages
		.slice(-count)
		.map((message) => {
			if (!Array.isArray(message.content)) {
				return `${message.role}:text`;
			}
			const blocks = message.content.map((block) =>
				block.type === "thinking"
					? `thinking(${block.thinking.length})`
					: block.type,
			);
			return `${message.role}:${blocks.join("+") || "empty"}`;
		})
		.join(" ");
}

/** One readable line saying which stand-down this was, and on what evidence. */
function describeStandDown(
	lookup: CappedThinkingLookup,
	config: { budgetTokens?: number; budgetMessage?: string },
): string {
	const parts: string[] = [lookup.reason ?? "unknown"];
	if (lookup.thinkingChars !== undefined) {
		parts.push(`thinking=${lookup.thinkingChars} chars`);
	}
	if (lookup.measuredTokens !== undefined) {
		parts.push(
			`measured=${lookup.measuredTokens} of ${config.budgetTokens ?? "?"} tokens`,
		);
	}
	if (lookup.skippedFragments) {
		parts.push(`callOnlyTurnsSkipped=${lookup.skippedFragments}`);
	}
	if (lookup.reason === "budget-message-absent") {
		// The two strings that failed to match, both on one line, because the
		// difference between them is the whole answer.
		parts.push(`looked for=${JSON.stringify(config.budgetMessage ?? "")}`);
		parts.push(`tail=${JSON.stringify(lookup.thinkingTail ?? "")}`);
	}
	return parts.join(" ");
}

export function buildCappedThinkingRequest(options: {
	thinking: string;
	outcomes: readonly ToolOutcome[];
	promptTemplate?: string;
	/** The reply the turn had begun writing before it was cut off. */
	partialAnswer?: string;
}): string {
	const parts = [
		options.promptTemplate?.trim() || DEFAULT_CAPPED_THINKING_PROMPT,
		`Your reasoning, as far as it got:\n${options.thinking}`,
	];
	if (options.partialAnswer?.trim()) {
		// What it had actually started to say. More committal than the reasoning
		// around it, and discarded with everything else.
		parts.push(
			`The reply you had begun writing when you were cut off:\n${options.partialAnswer.trim()}`,
		);
	}
	if (options.outcomes.length > 0) {
		parts.push(
			`What you then called, and what it returned:\n${options.outcomes
				.map(
					(outcome) =>
						`- ${outcome.name}(${outcome.input})\n  → ${outcome.result}`,
				)
				.join("\n")}`,
		);
	} else {
		parts.push("You made no tool call before the budget ran out.");
	}
	return parts.join("\n\n");
}

export interface CappedThinkingCondenserConfig {
	enabled?: boolean;
	/** The per-turn thinking allowance this session sends. */
	budgetTokens?: number;
	/**
	 * What the server appends to the reasoning when that allowance runs out,
	 * when the session knows it — configured by Cline, or reported by Ollama as
	 * the model's own. Absent for a model that has none, which is the case the
	 * measurement exists for.
	 */
	budgetMessage?: string;
	promptTemplate?: string;
	/** Absent when no provider is resolved yet; the condenser then stands down. */
	providerConfig?: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	logger?: BasicLogger;
}

type PrepareTurnInput = {
	messages: MessageWithMetadata[];
	/**
	 * The channel the compaction pipeline reports through, and the only way
	 * anything that happens inside `prepareTurn` reaches the transcript on
	 * screen. Optional because a caller is free not to supply one.
	 */
	emitStatusNotice?: (
		message: string,
		metadata?: Record<string, unknown>,
	) => void;
};
type PrepareTurnResult =
	| { messages?: readonly MessageWithMetadata[] }
	| undefined;
type PrepareTurn = (
	context: never,
) => PrepareTurnResult | Promise<PrepareTurnResult>;

/**
 * Turn one capped think into the note that replaces it.
 *
 * Extracted from the prepare-turn pipeline because the pipeline is not the only
 * place a capped think appears -- and, as it turned out, not the place it
 * appears in the case this feature exists for. See
 * `createCappedThinkingNoteWriter`.
 */
async function writeCappedThinkingNote(options: {
	thinking: string;
	outcomes: readonly ToolOutcome[];
	config: CappedThinkingCondenserConfig;
	providerConfig: ProviderConfig;
	partialAnswer?: string;
}): Promise<string> {
	const request = buildCappedThinkingRequest({
		thinking: options.thinking,
		outcomes: options.outcomes,
		promptTemplate: options.config.promptTemplate,
		...(options.partialAnswer ? { partialAnswer: options.partialAnswer } : {}),
	});
	try {
		// No output cap of its own. A fixed one was the whole failure: at 700
		// tokens against a template that reasons whatever the request asks for,
		// the summariser spent the entire budget thinking and returned a single
		// usage chunk with no text -- measured three times running, on thinks of
		// 22,011, 19,007 and 39,544 characters. Left unset, the cap resolves from
		// the window like any other turn, which is both large enough to survive a
		// forced think and already scaled to what the session has room for.
		const summarizerConfig = {
			...resolveSummarizerConfig({
				activeProviderConfig: options.providerConfig,
				summarizer: options.config.summarizer,
			}),
			maxOutputTokens: CONDENSED_THINKING_MAX_OUTPUT_TOKENS,
		};
		const handler = await createHandlerAsync(summarizerConfig);
		let text = "";
		let chunks = 0;
		const seen: string[] = [];
		let streamError: string | undefined;
		// The prompt goes in the user half, with only the instruction above it.
		//
		// It used to be the whole system prompt against an empty message list,
		// and an empty message list is not a request: nothing reached the server
		// at all. Six condensations in one session returned a single chunk and no
		// text -- 35,872, 39,719, 36,311, 35,623, 35,588 and 13,492 characters of
		// reasoning, every one of them thrown away -- while the compaction
		// summariser, which splits the same way this now does, worked throughout.
		for await (const chunk of handler.createMessage(
			CAPPED_THINKING_SYSTEM_PROMPT,
			[{ role: "user", content: request }],
		)) {
			chunks += 1;
			if (seen.length < 8 && !seen.includes(chunk.type)) {
				seen.push(chunk.type);
			}
			if (chunk.type === "text") {
				text += chunk.text;
				continue;
			}
			if (chunk.type === "done" && !chunk.success && chunk.error) {
				streamError = chunk.error;
			}
		}
		const note = truncateText(text.trim(), CONDENSED_THINKING_MAX_CHARS);
		if (note && isDegenerateNote(note)) {
			options.config.logger?.log(
				`Capped-thinking condensation degenerated into repetition; discarding the note (${note.length} chars from ${options.thinking.length} chars of reasoning)`,
				{ severity: "warn", noteChars: note.length },
			);
			return "";
		}
		if (!note) {
			// An empty note used to return in silence, which reads exactly like a
			// condenser that was never called -- and for a whole session that is
			// how it was read. A summariser queued behind the conversation on a
			// single-slot server comes back like this: stream opened, no chunks,
			// no error. The chunk types are named because "1 chunk" said the
			// stream had answered something and not what: it took a server-side
			// request log to find out the request was never made.
			options.config.logger?.log(
				`Capped-thinking condensation produced nothing from ${options.thinking.length} chars of reasoning (${chunks} chunks received: ${
					seen.join(", ") || "none"
				})${streamError ? `; stream reported: ${streamError}` : ""}`,
				{ severity: "warn", chunks, thinkingChars: options.thinking.length },
			);
		}
		return note;
	} catch (error) {
		// A note is worth having and worth nothing at the price of the turn it
		// was meant to help.
		options.config.logger?.log(
			"Capped-thinking condensation failed; keeping the reasoning as it stands",
			{
				severity: "warn",
				errorMessage: error instanceof Error ? error.message : String(error),
			},
		);
		return "";
	}
}

/**
 * Condense reasoning that is about to be thrown away rather than sent again.
 *
 * The transcript is the wrong place to catch the turn this feature was built
 * for. A think only ends *at* the budget message when the model had no room to
 * continue -- which means the same turn also ends at the output cap with no
 * tool call, and the agent loop discards those before they reach the history.
 * Measured across a full session: every capped turn was discarded, the detector
 * re-examined the previous uncapped one, and the condenser stood down on each
 * of them, correctly and uselessly. The reasoning went in the bin with the
 * turn, and the retry started the same analysis from nothing.
 *
 * So the loop hands the reasoning here on its way to being dropped. The
 * truncated message still never re-enters the transcript; only the note does.
 *
 * Returns `undefined` when there is nothing to condense with, so a caller can
 * tell "off" from "produced nothing".
 */
export function createCappedThinkingNoteWriter(
	config: CappedThinkingCondenserConfig,
):
	| ((input: DiscardedTurnInput) => Promise<DiscardedTurnCondensation>)
	| undefined {
	if (config.enabled === false || !config.providerConfig) {
		return undefined;
	}
	const providerConfig = config.providerConfig;
	// Keyed by the reasoning, like the pipeline's: a retry that reproduces the
	// same think pays for the note once.
	const condensed = new Map<string, DiscardedTurnCondensation>();
	return async (input: DiscardedTurnInput) => {
		const trimmed = input.reasoning.trim();
		const text = input.text?.trim();
		if (!trimmed && !text) {
			return {};
		}
		const key = `${trimmed}\u0000${text ?? ""}`;
		const cached = condensed.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const note = await writeCappedThinkingNote({
			thinking: trimmed,
			// The reply the turn had begun writing, offered as what it had already
			// committed to. There is never a tool call here -- a turn that made one
			// is not discarded -- so `outcomes` stays empty by definition rather
			// than by omission.
			...(text ? { partialAnswer: text } : {}),
			outcomes: [],
			config,
			providerConfig,
		});
		// The second pass, and the reason the caller says whether the window was
		// what capped the turn.
		//
		// A turn cut off by `num_predict` has, typically, most of its window
		// free: measured live, 48,508 tokens of request against 110,000, ended by
		// the caller's own 32,000-token cap. Salvaging that is worth two passes,
		// the same two a compaction makes -- a summary of where the turn had got
		// to, and a retrospective of what its reasoning established. A turn cut
		// off *by the window* has no such room, and gets the note alone.
		const retrospective =
			input.windowBound === true || !trimmed
				? undefined
				: await writeDiscardedRetrospective({
						reasoning: trimmed,
						config,
						providerConfig,
					});
		const result: DiscardedTurnCondensation = {
			...(note ? { note } : {}),
			...(retrospective ? { retrospective } : {}),
		};
		condensed.set(key, result);
		return result;
	};
}

/**
 * The retrospective half, over reasoning that is being discarded whole.
 *
 * Deliberately the compaction's own instruction rather than a second one
 * written for this: the question is identical -- what did this reasoning
 * establish that its conclusions do not carry -- and two prompts that drift
 * apart would give the same session two different kinds of retrospective
 * depending on which cap it hit.
 *
 * Cannot fail the retry: every exit is `undefined` and the note stands alone.
 */
async function writeDiscardedRetrospective(options: {
	reasoning: string;
	config: CappedThinkingCondenserConfig;
	providerConfig: ProviderConfig;
}): Promise<string | undefined> {
	try {
		const request = buildThinkingSummaryRequest({
			reasoningText: options.reasoning,
		});
		const summarizerConfig = {
			...resolveSummarizerConfig({
				activeProviderConfig: options.providerConfig,
				summarizer: options.config.summarizer,
			}),
			maxOutputTokens: CONDENSED_THINKING_MAX_OUTPUT_TOKENS,
		};
		const handler = await createHandlerAsync(summarizerConfig);
		let text = "";
		for await (const chunk of handler.createMessage(
			CAPPED_THINKING_RETROSPECTIVE_SYSTEM_PROMPT,
			[{ role: "user", content: request }],
		)) {
			if (chunk.type === "text") {
				text += chunk.text;
			}
		}
		const retrospective = truncateText(
			text.trim(),
			CONDENSED_THINKING_MAX_CHARS,
		);
		if (!retrospective || isDegenerateNote(retrospective)) {
			return undefined;
		}
		options.config.logger?.debug?.(
			`Discarded-turn retrospective: ${options.reasoning.length} chars of reasoning to ${retrospective.length} chars`,
		);
		return retrospective;
	} catch (error) {
		options.config.logger?.debug?.(
			`Discarded-turn retrospective failed; keeping the note alone: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

/**
 * Rewrite the capped turn's reasoning, then hand off to the rest of the
 * pipeline.
 *
 * Ahead of compaction rather than behind it, because a condensed turn is a
 * smaller turn: whatever compaction then decides, it decides about a transcript
 * that is not carrying seventeen thousand tokens of abandoned reasoning.
 */
export function createCappedThinkingPrepareTurn<T extends PrepareTurn>(
	inner: T | undefined,
	config: CappedThinkingCondenserConfig,
): T | undefined {
	if (config.enabled === false || !config.providerConfig) {
		// Said out loud, because the first version of this was not: it stood down
		// for a missing provider config on every session, and a feature that
		// silently does nothing looks identical to one that is working and has
		// nothing to do. There is no other line to distinguish them by.
		config.logger?.debug?.(
			config.enabled === false
				? "Capped-thinking condensation is off"
				: "Capped-thinking condensation stood down: no provider config to summarise with",
		);
		return inner;
	}
	config.logger?.debug?.(
		`Capped-thinking condensation armed at ${config.budgetTokens ?? "no"} thinking tokens${
			config.budgetMessage ? ", confirmed by the server's budget message" : ""
		}`,
	);
	const providerConfig = config.providerConfig;
	// Keyed by the reasoning itself, so a turn is condensed once however many
	// times the pipeline sees it, and a re-run of the same turn after an abort
	// reuses the note rather than paying for it again.
	const condensed = new Map<string, string>();
	/** Stand-downs already reported, so the log carries each one once. */
	const reportedStandDowns = new Set<string>();

	const condense = async (
		messages: MessageWithMetadata[],
		emitStatusNotice?: PrepareTurnInput["emitStatusNotice"],
	): Promise<MessageWithMetadata[]> => {
		const lookup = locateCappedThinking(messages, config.budgetTokens, {
			budgetMessage: config.budgetMessage,
		});
		const index = lookup.index;
		if (index < 0) {
			// Once per distinct reasoning, not once per turn: a run asks this on
			// every request and the answer only changes when the turn does.
			// Without it a stand-down is invisible, and every one of these
			// reasons has already been read as "the condenser is broken" —
			// twice, at the cost of a morning each.
			const seen = `${lookup.reason}:${lookup.thinkingTail ?? ""}`;
			if (!reportedStandDowns.has(seen)) {
				reportedStandDowns.add(seen);
				// Written into the message rather than passed beside it: the
				// host logger appends structured arguments only when verbose
				// logging is on, and this line exists precisely for the case
				// where someone is reading an ordinary log asking why nothing
				// happened. The object still goes along for anyone running
				// verbose.
				config.logger?.debug?.(
					`Capped-thinking condensation stood down: ${describeStandDown(lookup, config)} transcriptTail=[${describeTranscriptTail(messages)}]`,
					{
						reason: lookup.reason,
						thinkingChars: lookup.thinkingChars,
						measuredTokens: lookup.measuredTokens,
						budgetTokens: config.budgetTokens,
						thinkingTail: lookup.thinkingTail,
						budgetMessage: config.budgetMessage,
					},
				);
			}
			return messages;
		}
		const thinking = thinkingText(messages[index]);
		let note = condensed.get(thinking);
		if (note === undefined) {
			note = await writeCappedThinkingNote({
				thinking,
				outcomes: collectToolOutcomes(messages, index),
				config,
				providerConfig,
			});
			condensed.set(thinking, note);
		}
		if (!note) {
			return messages;
		}
		config.logger?.debug?.(
			`Condensed capped thinking: ${thinking.length} chars of reasoning to a ${note.length}-char note`,
			{
				thinkingChars: thinking.length,
				noteChars: note.length,
				budgetTokens: config.budgetTokens,
			},
		);
		// On screen as well as in the log. This note is the only record of what a
		// capped turn concluded — the reasoning it replaces is not sent again —
		// and a summary nobody can read is a summary nobody can judge.
		emitStatusNotice?.("thinking-condensed", {
			kind: "capped_thinking",
			phase: "completed",
			thinkingChars: thinking.length,
			noteChars: note.length,
			budgetTokens: config.budgetTokens,
			note,
		});
		const next = [...messages];
		const target = next[index];
		next[index] = {
			...target,
			content: [
				{
					type: "thinking",
					thinking: `${CONDENSED_THINKING_LEAD_IN}\n\n${note}`,
				},
				...(Array.isArray(target.content)
					? target.content.filter((block) => block.type !== "thinking")
					: []),
			],
		} as MessageWithMetadata;
		return next;
	};

	return (async (context: PrepareTurnInput) => {
		const messages = await condense(context.messages, context.emitStatusNotice);
		const result = (await (
			inner as unknown as
				| ((input: PrepareTurnInput) => Promise<PrepareTurnResult>)
				| undefined
		)?.({ ...context, messages })) as PrepareTurnResult;
		if (result?.messages) {
			return result;
		}
		// The inner stage had nothing to say, but the condenser did, so the
		// rewritten transcript still has to reach the request.
		return messages === context.messages ? result : { ...result, messages };
	}) as unknown as T;
}
