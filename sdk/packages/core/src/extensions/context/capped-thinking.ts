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
import type { BasicLogger, MessageWithMetadata } from "@cline/shared";
import type { CoreCompactionSummarizerConfig } from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
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
function endsWithBudgetMessage(thinking: string, message: string): boolean {
	const marker = message
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!marker) {
		return false;
	}
	return thinking
		.slice(-(marker.length + BUDGET_MESSAGE_TAIL_MARGIN_CHARS))
		.includes(marker);
}

/** What the note is allowed to cost. It is a handful of lines by design. */
const CONDENSED_THINKING_MAX_TOKENS = 700;

/** Guard against a runaway note becoming the thing that fills the window. */
const CONDENSED_THINKING_MAX_CHARS = 4_000;

export const DEFAULT_CAPPED_THINKING_PROMPT = `Your reasoning on the last turn ran out of budget and was cut off. You are about to think again about the same problem, and without this note you will start from the beginning and reach the same point.

Below is the reasoning you had produced when it was cut, and what the tool call you managed to make came back as.

Write the note your next turn needs. Conclusions, not narration:

## Settled
What you worked out and do not need to work out again.

## Ruled out
Approaches you already considered and rejected, with the reason in a few words each. This is the most important section — it is what stops the next pass repeating this one.

## Open
The one question you had not answered yet.

## Next
The single next action, stated concretely.

Rules:
- Be brief. This is a note to yourself, not a report.
- Do not re-argue anything. If you settled it, state it as settled.
- If the tool result contradicts what you expected, say so plainly and say what it means.
- Leave out any section with nothing in it.`;

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
 * The most recent turn whose reasoning hit the cap, or -1.
 *
 * Only the most recent: older capped turns have already had their consequences
 * play out in the transcript, and rewriting history the model has since acted on
 * is a different and more dangerous idea than helping it continue.
 */
export function findCappedThinkingIndex(
	messages: readonly MessageWithMetadata[],
	budgetTokens: number | undefined,
	options?: { budgetMessage?: string },
): number {
	if (
		typeof budgetTokens !== "number" ||
		!Number.isFinite(budgetTokens) ||
		budgetTokens <= 0
	) {
		return -1;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		const thinking = thinkingText(message);
		if (!thinking) {
			// An assistant turn that did not reason at all ends the search: the
			// capped turn we care about is the latest one, and anything before
			// this has already been superseded.
			return -1;
		}
		// A known budget message settles it either way. The measurement above is
		// good but not certain — it cannot tell which cap stopped a turn, and it
		// falls back to a ratio for turns that reported no usage — whereas the
		// message is the server stating what it did. So where the session knows
		// the wording, presence confirms and absence denies, and the estimate is
		// what runs when nobody configured one.
		const budgetMessage = options?.budgetMessage?.trim();
		if (budgetMessage) {
			return endsWithBudgetMessage(thinking, budgetMessage) ? index : -1;
		}
		return measuredThinkingTokens(message, thinking) >=
			budgetTokens * CAP_PROXIMITY
			? index
			: -1;
	}
	return -1;
}

export function buildCappedThinkingRequest(options: {
	thinking: string;
	outcomes: readonly ToolOutcome[];
	promptTemplate?: string;
}): string {
	const parts = [
		options.promptTemplate?.trim() || DEFAULT_CAPPED_THINKING_PROMPT,
		`Your reasoning, as far as it got:\n${options.thinking}`,
	];
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

type PrepareTurnInput = { messages: MessageWithMetadata[] };
type PrepareTurnResult =
	| { messages?: readonly MessageWithMetadata[] }
	| undefined;
type PrepareTurn = (
	context: never,
) => PrepareTurnResult | Promise<PrepareTurnResult>;

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
		return inner;
	}
	const providerConfig = config.providerConfig;
	// Keyed by the reasoning itself, so a turn is condensed once however many
	// times the pipeline sees it, and a re-run of the same turn after an abort
	// reuses the note rather than paying for it again.
	const condensed = new Map<string, string>();

	const condense = async (
		messages: MessageWithMetadata[],
	): Promise<MessageWithMetadata[]> => {
		const index = findCappedThinkingIndex(messages, config.budgetTokens, {
			budgetMessage: config.budgetMessage,
		});
		if (index < 0) {
			return messages;
		}
		const thinking = thinkingText(messages[index]);
		let note = condensed.get(thinking);
		if (note === undefined) {
			const request = buildCappedThinkingRequest({
				thinking,
				outcomes: collectToolOutcomes(messages, index),
				promptTemplate: config.promptTemplate,
			});
			try {
				const handler = await createHandlerAsync(
					resolveSummarizerConfig({
						activeProviderConfig: providerConfig,
						summarizer: config.summarizer,
						outputTokenCap: CONDENSED_THINKING_MAX_TOKENS,
					}),
				);
				let text = "";
				for await (const chunk of handler.createMessage(request, [])) {
					if (chunk.type === "text") {
						text += chunk.text;
					}
				}
				note = truncateText(text.trim(), CONDENSED_THINKING_MAX_CHARS);
			} catch (error) {
				// A note is worth having and worth nothing at the price of the
				// turn it was meant to help.
				config.logger?.log(
					"Capped-thinking condensation failed; keeping the reasoning as it stands",
					{
						severity: "warn",
						errorMessage:
							error instanceof Error ? error.message : String(error),
					},
				);
				note = "";
			}
			condensed.set(thinking, note);
		}
		if (!note) {
			return messages;
		}
		config.logger?.debug?.("Condensed capped thinking", {
			thinkingChars: thinking.length,
			noteChars: note.length,
			budgetTokens: config.budgetTokens,
		});
		const next = [...messages];
		const target = next[index];
		next[index] = {
			...target,
			content: [
				{
					type: "thinking",
					thinking: `[Your previous reasoning ran out of budget and was cut off. This is the note you left yourself.]\n\n${note}`,
				},
				...(Array.isArray(target.content)
					? target.content.filter((block) => block.type !== "thinking")
					: []),
			],
		} as MessageWithMetadata;
		return next;
	};

	return (async (context: PrepareTurnInput) => {
		const messages = await condense(context.messages);
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
