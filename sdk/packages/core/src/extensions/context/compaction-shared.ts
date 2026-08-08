import type { ModelInfo, ReasoningHistoryMode, ToolResultContent } from "@cline/llms";
import {
	CHARS_PER_TOKEN,
	estimateTokens,
	type MessageWithMetadata,
	measureRequestInputChars,
	seedRequestTokenCalibration,
} from "@cline/shared";

export { CHARS_PER_TOKEN, estimateTokens };

import type { CoreCompactionSummarizerConfig } from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";

export const DEFAULT_MAX_INPUT_TOKENS = 128_000;
/** Estimate the usable input share when only a context window is reported. */
export const CONTEXT_WINDOW_INPUT_RATIO = 0.9;
/** Compact once the transcript consumes this share of the usable input budget. */
export const COMPACTION_TRIGGER_RATIO = 0.9;
export const DEFAULT_TARGET_RATIO = 0.7;
export const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000;

/** The window the flat 20,000 default was chosen against. */
const PRESERVE_RECENT_REFERENCE_WINDOW = 128_000;

/**
 * How the recency floor grows with the window.
 *
 * Sub-linear on purpose. A window ten times larger does not mean ten times as
 * much recent work is worth carrying — the useful tail is the current task, and
 * that is set by the task, not by the hardware. But it does not stay flat
 * either: 20,000 tokens is a third of a 64k window and 2% of a million.
 *
 * Two-thirds is the exponent that puts 20,000 at 128k and ~79,000 at 1M, which
 * are the two anchors this was specified against.
 */
const PRESERVE_RECENT_WINDOW_EXPONENT = 2 / 3;

/**
 * The largest share of a compaction's target the recent tail may claim.
 *
 * The summary and the thinking retrospective have to fit in the same target,
 * and they are what a long task runs on. Without this the ladder wins every
 * argument on a small window: at 32k it would ask for 7,900 tokens out of a
 * 9,700 target and leave the summary nothing to be written into.
 */
const PRESERVE_RECENT_TARGET_SHARE = 0.6;

/**
 * The recency floor for a given window.
 *
 * `DEFAULT_PRESERVE_RECENT_TOKENS` was a single number applied to every model,
 * which is right for exactly one window size. Measured against the two ends it
 * has to serve: on a 32k window it asks to preserve more than the compaction
 * target, so compaction can reclaim nothing; on a 1M window it throws away
 * everything but the last few turns of a task with room for forty times that.
 */
export function resolvePreserveRecentTokens(input: {
	contextWindow?: number;
	maxInputTokens?: number;
	messageTargetTokens?: number;
	override?: number;
}): number {
	if (isPositiveFiniteNumber(input.override)) {
		return input.override;
	}
	const window = isPositiveFiniteNumber(input.contextWindow)
		? input.contextWindow
		: isPositiveFiniteNumber(input.maxInputTokens)
			? input.maxInputTokens / CONTEXT_WINDOW_INPUT_RATIO
			: undefined;
	const ladder =
		window === undefined
			? DEFAULT_PRESERVE_RECENT_TOKENS
			: Math.round(
					DEFAULT_PRESERVE_RECENT_TOKENS *
						(window / PRESERVE_RECENT_REFERENCE_WINDOW) **
							PRESERVE_RECENT_WINDOW_EXPONENT,
				);
	if (!isPositiveFiniteNumber(input.messageTargetTokens)) {
		return Math.max(1, ladder);
	}
	return Math.max(
		1,
		Math.min(
			ladder,
			Math.floor(input.messageTargetTokens * PRESERVE_RECENT_TARGET_SHARE),
		),
	);
}
/** Floor for a compaction summary, and the cap when no window is known. */
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 1_024;
/**
 * Ceiling for a compaction summary, however much window is free.
 *
 * A summary is the whole of what survives the messages it replaces, so it is
 * worth spending real tokens on -- but it also becomes the context every later
 * turn carries, so it cannot be allowed to grow into the space compaction just
 * freed. This is the point past which a longer summary stops being a better one.
 */
export const MAX_SUMMARY_OUTPUT_TOKENS = 8_192;
/** Share of the usable input budget a summary may occupy. */
export const SUMMARY_OUTPUT_WINDOW_SHARE = 0.08;

export const TOOL_RESULT_CHAR_LIMIT = 2_000;
export const FILE_CONTENT_CHAR_LIMIT = 2_000;
export const MIN_TRUNCATED_MESSAGE_TOKENS = 8;

/**
 * How much a compaction summary is allowed to write.
 *
 * The flat default was applied whatever the window: one compaction sent a
 * 67,363-character transcript into a 110,000-token window and asked for 1,024
 * tokens back, leaving roughly 87,000 unused on the single generation every
 * turn after it depends on. Sizing from the window keeps a small model's
 * summary small and lets a large window buy a complete one.
 */
export function resolveSummaryMaxOutputTokens(
	maxInputTokens: number | undefined,
): number {
	if (!isPositiveFiniteNumber(maxInputTokens)) {
		return DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS;
	}
	return Math.min(
		MAX_SUMMARY_OUTPUT_TOKENS,
		Math.max(
			DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
			Math.floor(maxInputTokens * SUMMARY_OUTPUT_WINDOW_SHARE),
		),
	);
}

/**
 * What the summary and the retrospective may spend together, by generation.
 *
 * A first compaction is summarising one stretch of work. A fifth is carrying
 * everything the task has learned, and holding that to the same budget is how a
 * long session degrades: the standing context stops growing while the thing it
 * has to describe keeps going, so the model relearns what it already knew and
 * repeats mistakes it has already made.
 *
 * Shares of the compaction target rather than of the window, because the target
 * is what these compete for. The last rung is the ceiling — beyond it the
 * standing context crowds out the recent turns it is supposed to give
 * perspective on.
 */
const COMPACTION_BUDGET_LADDER = [0.33, 0.4, 0.45, 0.5, 0.55] as const;

/** The summary's share of the combined budget. It writes first. */
const SUMMARY_BUDGET_SHARE = 0.7;

/**
 * The retrospective's bounds, as shares of the combined budget.
 *
 * It is written second and takes what the summary left, so its cap is a range
 * rather than a number: a summary that used its whole 70% leaves the floor of
 * 30%, and one that came in at half leaves the ceiling of 50%. What it must not
 * do is expand to fill the room — the instruction to be terse is in the prompt,
 * and this is only the wall behind it.
 */
const THINKING_BUDGET_MAX_SHARE = 0.5;
const THINKING_BUDGET_MIN_SHARE = 0.2;

export interface CompactionOutputBudgets {
	/** Generation of the compaction being written, 1-based. */
	generation: number;
	/** Summary and retrospective together. */
	combinedTokens: number;
	summaryMaxTokens: number;
}

export function resolveCompactionOutputBudgets(input: {
	messageTargetTokens?: number;
	maxInputTokens?: number;
	generation?: number;
}): CompactionOutputBudgets {
	const generation = Math.max(
		1,
		Math.floor(
			isPositiveFiniteNumber(input.generation) ? input.generation : 1,
		),
	);
	const share =
		COMPACTION_BUDGET_LADDER[
			Math.min(generation, COMPACTION_BUDGET_LADDER.length) - 1
		];
	// Falls back to the window-derived cap when there is no target to take a
	// share of, which is the first request of a session and every manual
	// compaction that names its own budget.
	const combinedTokens = isPositiveFiniteNumber(input.messageTargetTokens)
		? Math.max(
				DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
				Math.floor(input.messageTargetTokens * share),
			)
		: resolveSummaryMaxOutputTokens(input.maxInputTokens);
	return {
		generation,
		combinedTokens,
		summaryMaxTokens: Math.max(
			DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
			Math.floor(combinedTokens * SUMMARY_BUDGET_SHARE),
		),
	};
}

/**
 * What is left for the retrospective once the summary has been written.
 *
 * Measured against what the summary actually cost, not what it was allowed:
 * the point of writing them in this order is that an economical summary buys
 * the retrospective room rather than wasting it.
 */
export function resolveThinkingSummaryMaxTokens(input: {
	budgets: CompactionOutputBudgets;
	summaryTokens: number;
}): number {
	const { combinedTokens } = input.budgets;
	const remaining = combinedTokens - Math.max(0, input.summaryTokens);
	return Math.max(
		Math.floor(combinedTokens * THINKING_BUDGET_MIN_SHARE),
		Math.min(Math.floor(combinedTokens * THINKING_BUDGET_MAX_SHARE), remaining),
	);
}

/**
 * Output room to keep free when the model reports no per-turn cap of its own.
 *
 * Matches the gateway's `DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS`, which is the cap it
 * synthesizes in exactly the same situation. Two different numbers here would
 * put the two back into the disagreement this whole path exists to end.
 */
export const DEFAULT_OUTPUT_ROOM_TOKENS = 32_000;

/**
 * Floor on the trigger, as a share of the window.
 *
 * Output room is subtracted from the window, and on a small window a large cap
 * can eat most of it -- a 32,000 cap against a 40,000 window would put the
 * trigger at 8,000 and compact almost every turn. Below this share the cap is
 * the unreasonable figure, not the transcript.
 */
const MIN_TRIGGER_WINDOW_SHARE = 0.5;

/**
 * The largest prompt that still leaves the model room to answer.
 *
 * The trigger used to ask only whether the prompt fit. It does not follow that
 * a reply fits: a turn needs the prompt *and* its output inside one window, and
 * the output cap is up to `maxTokens`. Measured live on a 110,000-token window
 * with a 32,000 cap -- the transcript was allowed to 99,000, the request path
 * then found 11,000 short of what it needed and sent no cap at all, and the turn
 * died on the output limit with compaction still reporting there was room.
 *
 * Taking the smaller of the two keeps the old ratio as an upper bound while
 * making room for a full turn the binding constraint, which is what it is.
 */
export function resolveCompactionTriggerTokens(input: {
	maxInputTokens: number;
	contextWindow?: number;
	modelMaxTokens?: number;
}): number {
	const ratioTrigger = input.maxInputTokens * COMPACTION_TRIGGER_RATIO;
	if (!isPositiveFiniteNumber(input.contextWindow)) {
		return ratioTrigger;
	}
	const outputRoom = isPositiveFiniteNumber(input.modelMaxTokens)
		? input.modelMaxTokens
		: DEFAULT_OUTPUT_ROOM_TOKENS;
	const roomTrigger = Math.max(
		input.contextWindow - outputRoom,
		input.contextWindow * MIN_TRIGGER_WINDOW_SHARE,
	);
	return Math.min(ratioTrigger, roomTrigger);
}

export interface FileOperationSummary {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionSummaryMetadata {
	kind: "compaction_summary";
	displayRole: "system";
	userRunSpan: number;
	summary: string;
	details: FileOperationSummary;
	tokensBefore: number;
	generatedAt: number;
	/**
	 * How many compactions this summary is the product of, 1-based.
	 *
	 * Carried on the message because it is the only durable record of it: the
	 * summary chains through its own metadata, and the output budget ladder is
	 * indexed by this number.
	 */
	generation: number;
	/** The retrospective written alongside this summary, if there was one. */
	thinkingSummary?: string;
}

export type EstimateMessageTokens = (message: MessageWithMetadata) => number;

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the model's usable prompt budget. A reported input limit is
 * authoritative but cannot exceed the context window. When the model only
 * reports a context window, retain a conservative margin for request overhead.
 */
export function resolveEffectiveMaxInputTokens(
	input: Pick<ModelInfo, "maxInputTokens" | "contextWindow">,
): number | undefined {
	const contextWindow = isPositiveFiniteNumber(input.contextWindow)
		? input.contextWindow
		: undefined;
	const maxInputTokens = isPositiveFiniteNumber(input.maxInputTokens)
		? input.maxInputTokens
		: undefined;

	if (maxInputTokens !== undefined) {
		return contextWindow === undefined
			? maxInputTokens
			: Math.min(maxInputTokens, contextWindow);
	}

	return contextWindow === undefined
		? undefined
		: contextWindow * CONTEXT_WINDOW_INPUT_RATIO;
}

export function truncateText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export function flattenToolResultContent(
	content: ToolResultContent["content"],
): string {
	const truncated = truncateToolResultContentForCompaction(content);
	if (typeof truncated === "string") {
		return truncated;
	}
	return truncated
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "file":
					return `<file path="${block.path}">\n${block.content}\n</file>`;
				case "image":
					return `[image:${block.mediaType}]`;
				default:
					return "";
			}
		})
		.join("\n");
}

export function truncateToolResultContentForCompaction(
	content: ToolResultContent["content"],
): ToolResultContent["content"] {
	if (typeof content === "string") {
		return truncateText(content, TOOL_RESULT_CHAR_LIMIT);
	}
	return content.map((block) => {
		switch (block.type) {
			case "text":
				return {
					...block,
					text: truncateText(block.text, TOOL_RESULT_CHAR_LIMIT),
				};
			case "file":
				return {
					...block,
					content: truncateText(block.content, FILE_CONTENT_CHAR_LIMIT),
				};
			case "image":
				return block;
			default:
				return block;
		}
	});
}

export function formatToolInput(input: Record<string, unknown>): string {
	return Object.entries(input)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(", ");
}

export function serializeMessage(message: MessageWithMetadata): string {
	if (typeof message.content === "string") {
		return `[${message.role === "user" ? "User" : "Bot"}]: ${message.content}`;
	}
	const lines: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"}]: ${block.text}`,
				);
				break;
			case "thinking":
				lines.push(`[Bot thinking]: ${truncateText(block.thinking, 2_000)}`);
				break;
			case "redacted_thinking":
				lines.push("[Bot thinking]: [redacted]");
				break;
			case "tool_use":
				lines.push(
					`[Bot tool calls]: ${block.name}(${formatToolInput(block.input)})`,
				);
				break;
			case "tool_result":
				lines.push(`[Tool result]: ${flattenToolResultContent(block.content)}`);
				break;
			case "file":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"} file ${block.path}]: ${truncateText(block.content, FILE_CONTENT_CHAR_LIMIT)}`,
				);
				break;
			case "image":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"} image]: ${block.mediaType}`,
				);
				break;
		}
	}
	return lines.join("\n");
}

/**
 * Render the discarded reasoning against what it produced.
 *
 * The retrospective's whole value is the pairing. Reasoning on its own reads as
 * a plan and every plan reads as sound; it is the outcome next to it that shows
 * which ones were. So each turn is one block: what the model thought, what it
 * then called, and how that call came back -- applied, refused as a no-op,
 * failed, or refused by the loop guard.
 *
 * Tool results are reduced to their verdict rather than included. A retrospective
 * about method has no use for the contents of a file, and on the transcripts this
 * was built against the results are most of the bytes.
 */
export function serializeReasoningWithOutcomes(
	messages: MessageWithMetadata[],
): string {
	const outcomeByToolUseId = new Map<string, string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_result") {
				outcomeByToolUseId.set(
					block.tool_use_id,
					describeToolOutcome(block),
				);
			}
		}
	}

	const turns: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		const thinking = message.content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking.trim())
			.filter(Boolean)
			.join("\n");
		const calls = message.content
			.filter((block) => block.type === "tool_use")
			.map(
				(block) =>
					`  ${block.name} -> ${outcomeByToolUseId.get(block.id) ?? "no result recorded"}`,
			);
		if (!thinking && calls.length === 0) {
			continue;
		}
		const lines: string[] = [];
		if (thinking) {
			// The reasoning is the subject here, so it keeps a far longer leash
			// than `serializeMessage` gives it -- but not an unbounded one: a
			// single runaway think should not be able to crowd out the twenty
			// turns around it.
			const cost = reasoningCostLabel(message, thinking.length);
			lines.push(`Reasoning${cost}: ${truncateText(thinking, 6_000)}`);
		}
		if (calls.length > 0) {
			lines.push(`Then called:\n${calls.join("\n")}`);
		}
		turns.push(lines.join("\n"));
	}
	return turns.join("\n\n").trim();
}

/** What a tool call came back as, in the fewest words that distinguish them. */
function describeToolOutcome(block: ToolResultContent): string {
	const text = flattenToolResultContent(block.content);
	if (text.includes("strikes left") || text.includes("LAST strike")) {
		return "refused by the loop guard as an unchanged repeat";
	}
	if (text.includes(NO_CHANGE_MARKER)) {
		return "refused: the change was already in the file";
	}
	if (block.is_error === true) {
		return `failed: ${truncateText(firstLine(text), 200)}`;
	}
	if (/"success"\s*:\s*false/.test(text)) {
		return `reported failure: ${truncateText(firstLine(text), 200)}`;
	}
	return "applied";
}

/** The marker the editor builds its no-op refusal from. */
const NO_CHANGE_MARKER = "No change:";

function firstLine(text: string): string {
	const line = text.split("\n").find((value) => value.trim());
	return (line ?? text).trim();
}

/**
 * How much this turn's reasoning cost, when the transcript recorded it.
 *
 * Handed to the model because it is the one thing it cannot infer from reading
 * its own thinking back: whether a stretch that felt thorough was in fact the
 * turn that spent eighteen thousand tokens and produced one refused edit.
 */
function reasoningCostLabel(
	message: MessageWithMetadata,
	thinkingChars: number,
): string {
	const metrics = (message as { metrics?: { outputTokens?: number } }).metrics;
	const outputTokens = metrics?.outputTokens;
	if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens)) {
		return "";
	}
	return ` (${outputTokens} output tokens, ${thinkingChars} chars of it thinking)`;
}

export function serializeConversation(messages: MessageWithMetadata[]): string {
	return messages.map(serializeMessage).join("\n\n").trim();
}

export function createTokenEstimator(): EstimateMessageTokens {
	const cache = new WeakMap<object, number>();
	return (message) => {
		const ref = message as unknown as object;
		const cached = cache.get(ref);
		if (typeof cached === "number") {
			return cached;
		}
		let serialized: string;
		try {
			serialized = JSON.stringify(message);
		} catch {
			serialized = serializeMessage(message);
		}
		const value = estimateTokens(serialized.length);
		cache.set(ref, value);
		return value;
	};
}

export function isCompactionSummaryMessage(
	message: MessageWithMetadata,
): boolean {
	return (
		(message.metadata as { kind?: string } | undefined)?.kind ===
		"compaction_summary"
	);
}

export function getCompactionSummaryMetadata(
	message: MessageWithMetadata,
): CompactionSummaryMetadata | undefined {
	if (!isCompactionSummaryMessage(message)) {
		return undefined;
	}
	const metadata = message.metadata as Record<string, unknown> | undefined;
	if (!metadata) {
		return undefined;
	}
	const details = metadata.details as Record<string, unknown> | undefined;
	return {
		kind: "compaction_summary",
		displayRole: "system",
		userRunSpan:
			typeof metadata.userRunSpan === "number" &&
			Number.isInteger(metadata.userRunSpan) &&
			metadata.userRunSpan >= 0
				? metadata.userRunSpan
				: 1,
		summary: String(metadata.summary ?? ""),
		details: {
			readFiles: Array.isArray(details?.readFiles)
				? details.readFiles
						.filter((value): value is string => typeof value === "string")
						.map((value) => value.trim())
						.filter((value) => value.length > 0)
				: [],
			modifiedFiles: Array.isArray(details?.modifiedFiles)
				? details.modifiedFiles
						.filter((value): value is string => typeof value === "string")
						.map((value) => value.trim())
						.filter((value) => value.length > 0)
				: [],
		},
		tokensBefore: Number(metadata.tokensBefore ?? 0),
		generatedAt: Number(metadata.generatedAt ?? 0),
		// A summary written before the ladder existed carries no generation.
		// Reading it as the first is right for the only case that matters: a
		// session resumed across the upgrade starts its ladder over rather than
		// jumping to a rung it never earned.
		generation:
			typeof metadata.generation === "number" &&
			Number.isFinite(metadata.generation) &&
			metadata.generation >= 1
				? Math.floor(metadata.generation)
				: 1,
		...(typeof metadata.thinkingSummary === "string" &&
		metadata.thinkingSummary.trim()
			? { thinkingSummary: metadata.thinkingSummary }
			: {}),
	};
}

export function isToolResultOnlyUserMessage(
	message: MessageWithMetadata,
): boolean {
	if (message.role !== "user" || !Array.isArray(message.content)) {
		return false;
	}
	return (
		message.content.length > 0 &&
		message.content.every((block) => block.type === "tool_result")
	);
}

export function isTurnStartMessage(message: MessageWithMetadata): boolean {
	return (
		message.role === "user" &&
		!isToolResultOnlyUserMessage(message) &&
		!isCompactionSummaryMessage(message)
	);
}

export function findFirstUserMessageIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = 0; index < messages.length; index += 1) {
		if (isTurnStartMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

export function findLastTurnStartIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isTurnStartMessage(messages[index])) {
			return index;
		}
	}
	return 0;
}

export function findLastAssistantIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "assistant") {
			return index;
		}
	}
	return -1;
}

export function findLatestSummaryIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isCompactionSummaryMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

/**
 * A cut boundary is safe when starting the preserved tail there cannot
 * orphan half of a tool_use/tool_result pair. Typed user turns qualify,
 * and so do assistant messages: an assistant's tool_use keeps its results
 * in the user message that follows it, so both halves stay on the same
 * side of the cut. A tool_result-only user message is never safe — its
 * matching tool_use sits in the preceding assistant message and would be
 * folded into the summary, leaving an orphaned tool_result the provider
 * rejects.
 */
function isSafeCutBoundary(message: MessageWithMetadata): boolean {
	return message.role === "assistant" || isTurnStartMessage(message);
}

/**
 * The share of the material after a pinned prompt that a compaction folds when
 * the prompt-preservation cap would otherwise leave it nothing to do.
 *
 * A fraction rather than a token count, deliberately. Every absolute threshold
 * in this pipeline is only as trustworthy as the token estimator feeding it,
 * and that estimator drifts by multiples. "Half of what follows the prompt" is
 * half of what follows the prompt no matter how the counting drifts, because
 * the bias appears in both sides of the ratio and cancels.
 */
export const PINNED_PROMPT_FOLD_RATIO = 0.5;

/**
 * The share of a transcript's messages the preserved tail should reach before
 * the token floor alone is allowed to end the walk.
 *
 * A token floor on its own says nothing about how much *conversation* survives,
 * and the two come apart when messages are heavy. Measured live: a 113-message
 * transcript whose recent turns carried ~3.3k tokens each satisfied a 20,000
 * token floor after six messages, so a compaction with a ~73,000 token budget
 * kept seven. Twenty thousand tokens of two file dumps is not a thread anyone
 * can pick up.
 *
 * A quarter is chosen to be legible on a short transcript and irrelevant on a
 * long one: 25% of 500 messages will always reach the ceiling first, so the
 * ratio stops applying exactly where honouring it would be reckless.
 */
export const DEFAULT_PRESERVE_RECENT_MESSAGES_RATIO = 0.25;

/**
 * The three bounds on how much of the tail survives a compaction.
 *
 * Two lower bounds and one upper, because "how much is enough" and "how much is
 * too much" are different questions and only the second has a budget behind it.
 */
export interface RecencyBounds {
	/**
	 * Minimum tokens to preserve; the conversation is unusable below this, and
	 * never more than the budget the compacted request has to fit in — a floor
	 * above the ceiling is not a floor, it is a refusal to compact.
	 */
	tokenFloor: number;
	/** Minimum share of the transcript's messages to preserve. */
	messagesRatio: number;
	/**
	 * The most the preserved tail may cost before the last turn stops being
	 * exempt from the cut.
	 *
	 * The last typed turn survives verbatim so the model keeps the request it is
	 * working on. That exemption is unbounded, and a long tool loop under one
	 * prompt is all one turn: measured live, a 250,621-byte request compacted to
	 * 226,763 -- ten small messages folded, 9.5 percent reclaimed -- because the
	 * cut was clamped to the start of a turn that was nearly the whole
	 * transcript, and the trigger fired again on the very next turn. Past this
	 * ceiling, keeping the turn whole costs more than it is worth and the cut is
	 * allowed into it.
	 */
	lastTurnCeiling?: number;
	/**
	 * Maximum tokens to preserve. Compaction computes a target for the
	 * post-compaction request and this is what that target buys: without it the
	 * floor is also the ceiling, and every compaction folds to the minimum no
	 * matter how much room the model actually had.
	 */
	tokenCeiling: number;
}

export function resolveRecencyBounds(input: {
	preserveRecentTokens: number;
	preserveRecentMessagesRatio?: number;
	messageTargetTokens?: number;
	lastTurnCeiling?: number;
}): RecencyBounds {
	const preserve = Math.max(1, input.preserveRecentTokens);
	// Without a usable target there is nothing to spend, so the floor is also
	// the ceiling and the walk behaves as it did before there were two bounds.
	const tokenCeiling = isPositiveFiniteNumber(input.messageTargetTokens)
		? input.messageTargetTokens
		: preserve;
	const ratio = input.preserveRecentMessagesRatio;
	return {
		// A model too small to hold the default floor still has to compact:
		// asking to preserve 20,000 tokens inside a 1,200-token budget is a
		// request to keep everything, which is how a small context ends up
		// never compacting at all.
		tokenFloor: Math.min(preserve, tokenCeiling),
		lastTurnCeiling: isPositiveFiniteNumber(input.lastTurnCeiling)
			? input.lastTurnCeiling
			: undefined,
		messagesRatio:
			typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0
				? Math.min(1, ratio)
				: DEFAULT_PRESERVE_RECENT_MESSAGES_RATIO,
		tokenCeiling,
	};
}

/**
 * Walk back from the newest message until the preserved tail is big enough,
 * and stop early if it would grow past what the compaction is aiming for.
 *
 * The count floor proposes and the token ceiling disposes: asking for a share
 * of the messages is what keeps a thread legible when turns are heavy, and
 * capping it in tokens is what stops that request being honoured into a
 * transcript that no longer fits. Neither bound alone survives both shapes,
 * because how many tokens a message costs is not something either can know in
 * advance.
 */
function findRecencyCandidate(
	messages: MessageWithMetadata[],
	bounds: RecencyBounds,
	estimateMessageTokens: EstimateMessageTokens,
): number {
	const countFloor = Math.min(
		messages.length,
		Math.ceil(messages.length * bounds.messagesRatio),
	);
	let total = 0;
	let kept = 0;
	let candidate = messages.length;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		total += estimateMessageTokens(messages[index]);
		kept += 1;
		candidate = index;
		if (total >= bounds.tokenCeiling) {
			break;
		}
		if (total >= bounds.tokenFloor && kept >= countFloor) {
			break;
		}
	}
	return candidate;
}

function walkBackToSafeBoundary(
	messages: MessageWithMetadata[],
	cut: number,
	floor: number,
): number {
	let index = cut;
	while (index > floor && !isSafeCutBoundary(messages[index])) {
		index -= 1;
	}
	return index;
}

/**
 * How many messages a cut would actually fold into a summary: those before the
 * cut that no existing summary already stands for, minus any pinned message
 * that survives verbatim. Zero means the compaction cannot make progress —
 * it would replace a summary with a summary of that same summary.
 */
function countFoldableMessages(
	messages: MessageWithMetadata[],
	cutIndex: number,
	pinnedIndex: number,
): number {
	const latestSummaryIndex = findLatestSummaryIndex(
		messages.slice(0, cutIndex),
	);
	let count = 0;
	for (let index = latestSummaryIndex + 1; index < cutIndex; index += 1) {
		if (index !== pinnedIndex) {
			count += 1;
		}
	}
	return count;
}

export interface CompactionCutPlan {
	/**
	 * Everything before this index is folded into the summary; the messages
	 * from here on survive verbatim. Zero means no cut makes progress.
	 */
	cutIndex: number;
	/**
	 * A typed prompt that lies *before* the cut but must still survive
	 * verbatim, or -1 when the cut already preserves every typed prompt.
	 */
	pinnedIndex: number;
}

const NO_CUT: CompactionCutPlan = { cutIndex: 0, pinnedIndex: -1 };

/**
 * Decide where to cut a transcript, and whether the latest typed prompt has to
 * be lifted out of the folded region to survive.
 *
 * The ordinary rule is the recency budget capped at the latest typed prompt,
 * so that whole turn stays verbatim. That cap has one failure shape: after a
 * compaction the transcript reads `[summary, prompt, ...tool loop]`, so the
 * prompt sits at index 1 and the cap pins the cut there — folding only the
 * summary, which is no progress at all. An agentic run driven by a single
 * typed prompt could therefore be compacted exactly once, and every later
 * attempt returned "nothing to do" while the context kept growing.
 *
 * When that happens the cut moves past the prompt and the prompt is pinned
 * instead: it survives verbatim without holding the cut hostage. The pinned
 * cut folds at least {@link PINNED_PROMPT_FOLD_RATIO} of the material after
 * the prompt, so a compaction that runs always shrinks the transcript by a
 * measurable share of it, while still honouring the recency budget when that
 * budget asks to keep less than half.
 */
/**
 * Would preserving the whole last turn leave more than the ceiling allows?
 *
 * Measured against what the tail would actually cost, not against the message
 * count: a turn is expensive because of what is in it, and a tool loop's
 * arguments and results are most of that.
 */
function exceedsLastTurnCeiling(
	messages: MessageWithMetadata[],
	lastTurnStartIndex: number,
	bounds: RecencyBounds,
	estimateMessageTokens: EstimateMessageTokens,
): boolean {
	if (!isPositiveFiniteNumber(bounds.lastTurnCeiling)) {
		return false;
	}
	let tail = 0;
	for (let index = lastTurnStartIndex; index < messages.length; index += 1) {
		tail += estimateMessageTokens(messages[index]);
		if (tail > bounds.lastTurnCeiling) {
			return true;
		}
	}
	return false;
}

export function findCutPlan(
	messages: MessageWithMetadata[],
	bounds: RecencyBounds,
	estimateMessageTokens: EstimateMessageTokens,
): CompactionCutPlan {
	const candidate = findRecencyCandidate(
		messages,
		bounds,
		estimateMessageTokens,
	);
	if (candidate <= 0) {
		return NO_CUT;
	}

	// Never summarize away the latest typed user prompt: when one exists
	// past index 0, the cut stays at or before it so that whole turn
	// survives verbatim. Transcripts without a later typed turn (a single
	// task followed by one long tool loop) still cut at the token-budget
	// candidate.
	const lastTurnStartIndex = findLastTurnStartIndex(messages);
	// Unless keeping the whole turn is what defeats the compaction. One prompt
	// followed by a long tool loop is a single turn, so this clamp could drag the
	// cut back to near the start of the transcript and fold almost nothing:
	// measured live, a 250,621-byte request compacted to 226,763 and the trigger
	// fired again on the very next turn.
	//
	// The prompt still survives. What costs the window is the tool traffic under
	// it, not the sentence that asked for it, so an over-budget turn is cut with
	// the prompt pinned rather than summarized away -- the model keeps the
	// request it is working on and loses only the loop it can re-derive.
	if (
		lastTurnStartIndex > 0 &&
		exceedsLastTurnCeiling(
			messages,
			lastTurnStartIndex,
			bounds,
			estimateMessageTokens,
		)
	) {
		const pinned = planPinnedCut(
			messages,
			lastTurnStartIndex,
			bounds,
			estimateMessageTokens,
		);
		if (pinned.cutIndex > 0) {
			return pinned;
		}
	}
	const cappedCut =
		lastTurnStartIndex > 0
			? Math.min(candidate, lastTurnStartIndex)
			: candidate;
	const cutIndex = walkBackToSafeBoundary(messages, cappedCut, 0);
	if (countFoldableMessages(messages, cutIndex, -1) > 0) {
		return { cutIndex, pinnedIndex: -1 };
	}

	return planPinnedCut(
		messages,
		lastTurnStartIndex,
		bounds,
		estimateMessageTokens,
	);
}

function planPinnedCut(
	messages: MessageWithMetadata[],
	pinnedIndex: number,
	bounds: RecencyBounds,
	estimateMessageTokens: EstimateMessageTokens,
): CompactionCutPlan {
	const tailStart = pinnedIndex + 1;
	if (pinnedIndex <= 0 || tailStart >= messages.length) {
		return NO_CUT;
	}

	let tailTokens = 0;
	for (let index = tailStart; index < messages.length; index += 1) {
		tailTokens += estimateMessageTokens(messages[index]);
	}
	// The ratio governs a large tail and the recency budget governs a small
	// one, and neither may be violated: fold at least half, but never keep
	// less than the budget asks for.
	//
	// The ceiling only ever lowers this, so the fold guarantee survives it: a
	// tail too big for the post-compaction budget gets cut to the budget, which
	// folds strictly more than half, not less.
	const keepTokens = Math.min(
		Math.max(
			tailTokens * PINNED_PROMPT_FOLD_RATIO,
			Math.min(bounds.tokenFloor, tailTokens),
		),
		bounds.tokenCeiling,
	);

	let total = 0;
	let cut = messages.length;
	for (let index = messages.length - 1; index >= tailStart; index -= 1) {
		total += estimateMessageTokens(messages[index]);
		cut = index;
		if (total >= keepTokens) {
			break;
		}
	}
	cut = walkBackToSafeBoundary(messages, cut, tailStart);
	if (countFoldableMessages(messages, cut, pinnedIndex) === 0) {
		return NO_CUT;
	}
	return { cutIndex: cut, pinnedIndex };
}

export function collectPaths(value: unknown): string[] {
	if (typeof value === "string" && value.trim().length > 0) {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectPaths(item));
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const paths: string[] = [];
		for (const key of [
			"path",
			"file_path",
			"target_file",
			"new_file_path",
			"old_file_path",
		]) {
			paths.push(...collectPaths(record[key]));
		}
		if (Array.isArray(record.files)) {
			for (const item of record.files) {
				if (item && typeof item === "object") {
					paths.push(...collectPaths((item as Record<string, unknown>).path));
				}
			}
		}
		if (Array.isArray(record.file_paths)) {
			paths.push(...collectPaths(record.file_paths));
		}
		return paths;
	}
	return [];
}

export function mergeUnique(base: string[], next: Iterable<string>): string[] {
	const seen = new Set(base);
	for (const value of next) {
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		seen.add(trimmed);
	}
	return [...seen].sort((a, b) => a.localeCompare(b));
}

export function extractFileOps(
	messages: MessageWithMetadata[],
): FileOperationSummary {
	let readFiles: string[] = [];
	let modifiedFiles: string[] = [];
	for (const message of messages) {
		const summaryMetadata = getCompactionSummaryMetadata(message);
		if (summaryMetadata) {
			readFiles = mergeUnique(readFiles, summaryMetadata.details.readFiles);
			modifiedFiles = mergeUnique(
				modifiedFiles,
				summaryMetadata.details.modifiedFiles,
			);
			continue;
		}
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "file") {
				readFiles = mergeUnique(readFiles, [block.path]);
				continue;
			}
			if (block.type !== "tool_use") {
				continue;
			}
			const paths = collectPaths(block.input);
			if (block.name === "read_files") {
				readFiles = mergeUnique(readFiles, paths);
				continue;
			}
			if (block.name === "editor" || block.name === "apply_patch") {
				modifiedFiles = mergeUnique(modifiedFiles, paths);
			}
		}
	}
	return { readFiles, modifiedFiles };
}

/** Commands longer than this are truncated in dropped-work summaries. */
export const COMMAND_SUMMARY_CHAR_LIMIT = 100;

/**
 * Compact record of the tool work performed inside a span of dropped
 * messages: which files were read and edited (with line ranges when
 * known) and which commands ran.
 */
export interface ToolActivitySummary {
	readFiles: string[];
	editedFiles: string[];
	commands: string[];
}

export function hasToolActivity(summary: ToolActivitySummary): boolean {
	return (
		summary.readFiles.length > 0 ||
		summary.editedFiles.length > 0 ||
		summary.commands.length > 0
	);
}

function pushUniqueEntry(list: string[], value: string): void {
	const trimmed = value.trim();
	if (trimmed && !list.includes(trimmed)) {
		list.push(trimmed);
	}
}

function truncateCommandForSummary(command: string): string {
	if (command.length <= COMMAND_SUMMARY_CHAR_LIMIT) {
		return command;
	}
	return `${command.slice(0, COMMAND_SUMMARY_CHAR_LIMIT)}...`;
}

function formatReadFileEntry(
	record: Record<string, unknown>,
): string | undefined {
	const path = typeof record.path === "string" ? record.path.trim() : "";
	if (!path) {
		return undefined;
	}
	const start = record.start_line;
	const end = record.end_line;
	if (typeof start === "number" && typeof end === "number") {
		return `${path}:${start}-${end}`;
	}
	return path;
}

/**
 * Pull the edited line range out of an editor tool result. Editor results
 * embed a numbered diff (`-467: ...` / `+467: ...`), usually inside a
 * JSON-encoded payload's `result` field; the range is the min/max line
 * number seen. Returns undefined when no diff line numbers are found.
 */
function extractDiffLineRange(
	content: ToolResultContent["content"],
): { start: number; end: number } | undefined {
	let text =
		typeof content === "string"
			? content
			: content
					.map((block) =>
						block.type === "text"
							? block.text
							: block.type === "file"
								? block.content
								: "",
					)
					.join("\n");
	try {
		const parsed = JSON.parse(text) as { result?: unknown };
		if (parsed && typeof parsed.result === "string") {
			text = parsed.result;
		}
	} catch {
		// Not JSON-encoded; scan the raw text.
	}
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const match of text.matchAll(/(?:^|\n|\\n)[-+](\d+): /g)) {
		const line = Number(match[1]);
		if (!Number.isFinite(line)) {
			continue;
		}
		start = Math.min(start, line);
		end = Math.max(end, line);
	}
	return start <= end ? { start, end } : undefined;
}

/**
 * Summarize the tool work inside a span of messages that compaction is
 * dropping. Read ranges come from read_files inputs; edited ranges come
 * from the numbered diff in the matching editor result when present.
 */
export function summarizeToolActivity(
	messages: MessageWithMetadata[],
): ToolActivitySummary {
	const readFiles: string[] = [];
	const editedFiles: string[] = [];
	const commands: string[] = [];
	const editorPathsByToolUseId = new Map<string, string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use") {
				const input = (block.input ?? {}) as Record<string, unknown>;
				if (block.name === "read_files") {
					if (Array.isArray(input.files)) {
						for (const file of input.files) {
							if (file && typeof file === "object") {
								const entry = formatReadFileEntry(
									file as Record<string, unknown>,
								);
								if (entry) {
									pushUniqueEntry(readFiles, entry);
								}
							}
						}
					} else {
						for (const path of collectPaths(input)) {
							pushUniqueEntry(readFiles, path);
						}
					}
					continue;
				}
				if (block.name === "editor" || block.name === "apply_patch") {
					const path = collectPaths(input)[0];
					if (path) {
						editorPathsByToolUseId.set(block.id, path);
					}
					continue;
				}
				if (block.name === "run_commands") {
					const commandList = Array.isArray(input.commands)
						? input.commands
						: [];
					for (const command of commandList) {
						if (typeof command === "string" && command.trim()) {
							pushUniqueEntry(
								commands,
								truncateCommandForSummary(command.trim()),
							);
						}
					}
				}
				continue;
			}
			if (block.type === "tool_result") {
				const path = editorPathsByToolUseId.get(block.tool_use_id);
				if (!path) {
					continue;
				}
				const range = extractDiffLineRange(block.content);
				pushUniqueEntry(
					editedFiles,
					range ? `${path}:${range.start}-${range.end}` : path,
				);
				editorPathsByToolUseId.delete(block.tool_use_id);
			}
		}
	}
	// Editor calls whose results fell outside the span still count as edits.
	for (const path of editorPathsByToolUseId.values()) {
		pushUniqueEntry(editedFiles, path);
	}
	return { readFiles, editedFiles, commands };
}

export function formatToolActivitySummary(
	summary: ToolActivitySummary,
): string {
	return [
		`Files read:\n${summary.readFiles.join("\n")}`,
		`Files edited:\n${summary.editedFiles.join("\n")}`,
		`Commands ran:\n${summary.commands.join("\n")}`,
	].join("\n\n");
}

export function renderFilesSection(fileOps: FileOperationSummary): string {
	const readLines =
		fileOps.readFiles.length > 0
			? fileOps.readFiles.map((path) => `- ${path}`).join("\n")
			: "- none";
	const modifiedLines =
		fileOps.modifiedFiles.length > 0
			? fileOps.modifiedFiles.map((path) => `- ${path}`).join("\n")
			: "- none";
	return `## Files\nRead:\n${readLines}\nModified:\n${modifiedLines}`;
}

export function ensureFilesSection(
	summary: string,
	fileOps: FileOperationSummary,
): string {
	if (/^## Files$/im.test(summary)) {
		return summary.trim();
	}
	return `${summary.trim()}\n\n${renderFilesSection(fileOps)}`.trim();
}

/**
 * What the summarizer is asked for when nothing else is configured.
 *
 * The summary replaces the turns it stands for, permanently: every later turn
 * reads this and never the conversation again. So the instruction that matters
 * is not "be concise" -- brevity is what loses the work -- but which specific
 * things must survive the compression. The old default asked for a concise,
 * factual note under five headings and said nothing about identifiers, paths,
 * decisions already taken or approaches already ruled out, which is exactly
 * what a model needs in order not to redo them.
 *
 * `{{files_read}}` and `{{files_edited}}` are substituted before sending. A
 * template that omits them still gets a Files section appended, because losing
 * track of which files are in play is the one failure that makes a summary
 * actively misleading rather than merely thin.
 */
export const DEFAULT_COMPACTION_PROMPT = `You are writing the hand-over note for a coding session that is about to lose its transcript. Everything below will be discarded; only your note survives, and the agent continuing this work will have nothing else to go on.

Write for that reader. Prefer specifics over summary: exact file paths, function and symbol names, error text, commands, and numbers. Do not compress away detail that would have to be rediscovered — an over-long note costs a little context, a vague one costs the whole investigation.

## Goal
What is being built or fixed, in one or two sentences, including any constraint the user stated.

## Done
What is finished and verified, with the evidence — which files changed, what the test or command said. Be specific enough that none of it gets redone.

## In progress
What is underway right now, and exactly where it stopped.

## Ruled out
Approaches already tried that did not work, and why. Omit if none — but never drop one that was tried, or it will be tried again.

## Key facts
Decisions taken, values discovered, identifiers, signatures, and anything learned about the codebase that is not obvious from reading it. Omit if none.

## Next
The immediate next steps, in order.

## Files
Read: {{files_read}}
Edited: {{files_edited}}`;

function renderCompactionPrompt(
	template: string,
	fileOps: FileOperationSummary,
): string {
	const read = fileOps.readFiles.join(", ") || "none";
	const edited = fileOps.modifiedFiles.join(", ") || "none";
	const rendered = template
		.replaceAll("{{files_read}}", read)
		.replaceAll("{{files_edited}}", edited);
	if (rendered.includes(read) && rendered.includes(edited)) {
		return rendered;
	}
	// A custom template that names neither placeholder still gets the file list:
	// a summary that has lost track of which files are in play is worse than a
	// thin one, because it reads as authoritative.
	return `${rendered.trim()}\n\n## Files\nRead: ${read}\nEdited: ${edited}`;
}

export function buildSummaryRequest(options: {
	previousSummary?: string;
	conversationText: string;
	fileOps: FileOperationSummary;
	/** Overrides {@link DEFAULT_COMPACTION_PROMPT}; blank falls back to it. */
	promptTemplate?: string;
}): string {
	const template =
		options.promptTemplate?.trim() || DEFAULT_COMPACTION_PROMPT;
	const parts: string[] = [renderCompactionPrompt(template, options.fileOps)];

	if (options.previousSummary?.trim()) {
		parts.push(`Previous summary:\n${options.previousSummary.trim()}`);
	}

	parts.push(`Conversation:\n${options.conversationText || "(empty)"}`);

	return parts.join("\n\n");
}

/**
 * The second phase's prompt: a retrospective, not a second summary.
 *
 * The summary describes what happened. This describes how the work went, which
 * is the part that dies with the thinking blocks compaction discards -- every
 * wrong turn, every retry, every stretch spent on an approach that was never
 * going to work. A model that starts from a summary alone starts with no memory
 * of having been wrong, and makes the same mistakes in the same order.
 *
 * Written hard against verbosity, because the models this matters most for are
 * the ones that ruminate: on a coder model that hits its thinking cap most
 * turns, an unbounded "reflect on your reasoning" produces more of exactly the
 * behaviour it is meant to flag. Hence the ban on specifics -- those are in the
 * summary, and repeating them here spends the budget twice for one fact.
 */
export const DEFAULT_THINKING_COMPACTION_PROMPT = `You are writing the retrospective that goes at the top of your own context after compaction. It is not a summary — what happened is written up separately, and repeating it here wastes the space this needs.

You are reading your own reasoning from the work about to be discarded, together with what each stretch of it produced: which tool calls landed, which were refused, which were retried unchanged, and which turns ran long.

Write the honest assessment. Be terse. Every line must be something you would want to know before starting the next hour of this task.

## What worked
Approaches that produced progress, stated as approaches rather than as events.

## What did not
Approaches that cost time and produced nothing. Name the failure mode: repeating an unchanged call, editing from a stale read, rewriting where narrowing would do, chasing a symptom.

## Where the time went
The stretches that were expensive against what they achieved, including any turn where the reasoning ran long without converging.

## Do differently
What to do instead. Concrete enough to act on, short enough to remember.

Rules:
- No file names, line numbers, code, identifiers or values. Those are in the summary. This is about method.
- No narration of the sequence of events. Judgement only.
- Leave out any section with nothing worth saying.
- Terse throughout. A dozen short lines is a good retrospective; a page is a failed one.`;

export function buildThinkingSummaryRequest(options: {
	previousThinkingSummary?: string;
	reasoningText: string;
	/** Overrides {@link DEFAULT_THINKING_COMPACTION_PROMPT}; blank falls back. */
	promptTemplate?: string;
}): string {
	const parts: string[] = [
		options.promptTemplate?.trim() || DEFAULT_THINKING_COMPACTION_PROMPT,
	];
	if (options.previousThinkingSummary?.trim()) {
		parts.push(
			`Your retrospective from the previous compaction. Carry forward what still holds, revise what does not, and do not simply restate it:\n${options.previousThinkingSummary.trim()}`,
		);
	}
	parts.push(
		`Your reasoning and what it produced:\n${options.reasoningText || "(none)"}`,
	);
	return parts.join("\n\n");
}


export function resolveSummarizerConfig(options: {
	activeProviderConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	/**
	 * The summarizer's usable input budget, once it is known. Left out on the
	 * first pass, which exists to resolve that budget from the merged model.
	 */
	maxInputTokens?: number;
	/**
	 * The output cap for this call, when the caller has one.
	 *
	 * The window-derived default is flat for the life of a session; the
	 * generation ladder is not, and the retrospective's cap is not even known
	 * until the summary has been written. Both are decided by the caller.
	 */
	outputTokenCap?: number;
}): ProviderConfig {
	const summarizer = options.summarizer;
	const summaryMaxOutputTokens = isPositiveFiniteNumber(options.outputTokenCap)
		? options.outputTokenCap
		: resolveSummaryMaxOutputTokens(options.maxInputTokens);
	const withSummarizerDefaults = (
		config: ProviderConfig,
		maxOutputTokens: number,
	): ProviderConfig => {
		if (config.providerId === "openai-codex") {
			const { maxOutputTokens: _maxOutputTokens, ...rest } = config;
			return {
				...rest,
				thinking: false,
			};
		}
		return { ...config, maxOutputTokens, thinking: false };
	};
	if (!summarizer) {
		// The caller's cap outranks the config's own. This branch runs on the
		// *active* provider config, whose `maxOutputTokens` is the user's
		// per-turn cap for doing the work -- 32,000 on the model this was
		// measured against -- and was never a statement about how long a summary
		// should be. Letting it stand would leave the ladder describing a budget
		// that nothing enforced.
		return withSummarizerDefaults(
			options.activeProviderConfig,
			isPositiveFiniteNumber(options.outputTokenCap)
				? options.outputTokenCap
				: (options.activeProviderConfig.maxOutputTokens ??
						summaryMaxOutputTokens),
		);
	}
	const baseProviderConfig =
		summarizer.providerConfig?.providerId === summarizer.providerId
			? summarizer.providerConfig
			: undefined;
	// A summarizer configured with its own cap keeps it: unlike the active
	// provider's, that number was chosen to size a summary, so it is a decision
	// the ladder has no business overruling.
	return withSummarizerDefaults(
		{
			...(baseProviderConfig ?? {}),
			providerId: summarizer.providerId,
			modelId: summarizer.modelId,
			apiKey: summarizer.apiKey ?? baseProviderConfig?.apiKey,
			baseUrl: summarizer.baseUrl ?? baseProviderConfig?.baseUrl,
			headers: summarizer.headers ?? baseProviderConfig?.headers,
			modelInfo: summarizer.modelInfo ?? baseProviderConfig?.modelInfo,
			knownModels: summarizer.knownModels ?? baseProviderConfig?.knownModels,
		},
		summarizer.maxOutputTokens ??
			(isPositiveFiniteNumber(options.outputTokenCap)
				? options.outputTokenCap
				: summaryMaxOutputTokens),
	);
}

export function buildSummaryMessage(options: {
	summary: string;
	fileOps: FileOperationSummary;
	tokensBefore: number;
	userRunSpan: number;
	generation?: number;
	/** The retrospective, prepended as this message's own reasoning. */
	thinkingSummary?: string;
}): MessageWithMetadata {
	const thinkingSummary = options.thinkingSummary?.trim();
	return {
		role: "user",
		content: [
			// Ahead of the text, and as reasoning rather than text, because that
			// is what it is: the model's own account of how the work went,
			// occupying the same position in the message that its thinking
			// occupied in the turns being replaced.
			...(thinkingSummary
				? ([
						{ type: "thinking", thinking: thinkingSummary },
					] as MessageWithMetadata["content"] & object[])
				: []),
			{
				type: "text",
				text: `Context summary:\n\n${options.summary}`,
			},
		],
		metadata: {
			kind: "compaction_summary",
			displayRole: "system",
			userRunSpan: options.userRunSpan,
			summary: options.summary,
			details: options.fileOps,
			tokensBefore: options.tokensBefore,
			generatedAt: Date.now(),
			generation: Math.max(1, Math.floor(options.generation ?? 1)),
			...(thinkingSummary ? { thinkingSummary } : {}),
		} satisfies CompactionSummaryMetadata,
	};
}

/**
 * Recover the token calibration from a transcript that was written by an
 * earlier process.
 *
 * Every assistant turn records what the provider counted for the request that
 * produced it, so a resumed session is not actually uncalibrated — it just
 * starts as if it were, because the calibration lives in process memory. That
 * gap is what makes a resume compact immediately: the character estimate reads
 * roughly twice the real size of a transcript (three assumed characters per
 * token against a measured 5.9), and twice a normal working context is over any
 * threshold.
 *
 * The newest turn with a recorded count is used, paired with the request that
 * produced it — the messages before it, plus the system prompt and tools, which
 * is the same payload {@link measureRequestInputChars} measures live. Both the
 * ratio and the count are adopted, so the first decision after a resume is made
 * on the same evidence the last decision before it was.
 *
 * Nothing happens once a live response has been observed, and nothing happens
 * for a transcript that carries no counts (a fresh session, or a provider that
 * reports no usage) — those keep the estimate they always had.
 */
export function seedCalibrationFromTranscript(request: {
	systemPrompt?: string;
	messages: MessageWithMetadata[];
	tools?: unknown[];
	reasoningHistory?: ReasoningHistoryMode;
}): void {
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index];
		if (message?.role !== "assistant") {
			continue;
		}
		const tokens = message.metrics?.inputTokens;
		if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
			continue;
		}
		seedRequestTokenCalibration(
			measureRequestInputChars(
				{
					systemPrompt: request.systemPrompt,
					messages: request.messages.slice(0, index),
					tools: request.tools,
				},
				{ reasoningHistory: request.reasoningHistory },
			),
			tokens,
		);
		return;
	}
}
