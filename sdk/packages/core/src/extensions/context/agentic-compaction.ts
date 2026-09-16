import { createHandlerAsync } from "@cline/llms";
import type { BasicLogger, MessageWithMetadata } from "@cline/shared";
import { countUserRunMessages } from "../../session/user-run-messages";
import type {
	CoreCompactionContext,
	CoreCompactionResult,
	CoreCompactionSummarizerConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
	type BudgetProjectionResult,
	buildBudgetProjection,
} from "./budget-projection";
import {
	buildSummaryMessage,
	buildSummaryRequest,
	buildThinkingSummaryRequest,
	type EstimateMessageTokens,
	ensureFilesSection,
	estimateTokens,
	extractFileOps,
	findCutPlan,
	findLatestSummaryIndex,
	getCompactionSummaryMetadata,
	planFullCut,
	type RecencyBounds,
	resolveCompactionOutputBudgets,
	resolveEffectiveMaxInputTokens,
	resolveSummarizerConfig,
	resolveThinkingSummaryMaxTokens,
	serializeConversation,
	serializeReasoningWithOutcomes,
} from "./compaction-shared";
import {
	buildToolLedger,
	renderToolLedger,
	type ToolLedgerOptions,
} from "./tool-ledger";

const MIN_AGENTIC_SUMMARY_INPUT_TOKENS = 1_024;

function resolveProviderMaxInputTokens(
	providerConfig: ProviderConfig,
): number | undefined {
	const modelInfoLimit = resolveEffectiveMaxInputTokens({
		maxInputTokens:
			providerConfig.maxInputTokens ?? providerConfig.modelInfo?.maxInputTokens,
		contextWindow: providerConfig.modelInfo?.contextWindow,
	});
	if (modelInfoLimit !== undefined) {
		return modelInfoLimit;
	}
	const knownModelInfo = providerConfig.knownModels?.[providerConfig.modelId];
	return resolveEffectiveMaxInputTokens({
		maxInputTokens: knownModelInfo?.maxInputTokens,
		contextWindow: knownModelInfo?.contextWindow,
	});
}

export function buildAgenticSummaryInputBudget(options: {
	messages: CoreCompactionContext["messages"];
	targetTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
}): BudgetProjectionResult {
	return buildBudgetProjection({
		messages: options.messages,
		targetTokens: Math.max(1, options.targetTokens),
		policyIntent: "agentic_summary",
		estimateMessageTokens: options.estimateMessageTokens,
	});
}

interface SummaryGenerationResult {
	text: string;
	/** Reasoning/thinking output length; discarded from the summary itself. */
	reasoningChars: number;
	/** Provider-reported reason the response is incomplete (e.g. "max_output_tokens"). */
	incompleteReason?: string;
}

/**
 * What the summarizer is told it is, which is not the same job in both modes.
 *
 * The system half used to say "concise" while the user half asked for the
 * detail that has to survive, and the model was pulled both ways on the one
 * message that has to carry everything. Both of these agree with their prompt
 * instead — and they have to be separate texts, because the two prompts ask
 * for different artifacts. A replay is written in the first person and is read
 * as the model's own memory; a full summary is a state record read as the only
 * surviving fact. Telling a model to write a hand-over note and then handing it
 * the replay prompt reproduces the seam the replay prompt exists to remove.
 */
const SUMMARIZER_SYSTEM_PROMPTS = {
	tail: "You are re-telling your own recent work in your own voice, because the earlier part of your transcript is about to be discarded and what you write takes its place directly in front of the turns that remain. Match the prose of those turns. Keep every specific — names, paths, quoted wording, errors, numbers — that you would otherwise have to rediscover.",
	full: "You write the state record for a working session of any kind. The transcript you are given is about to be discarded, so what you write is the only record that remains. Follow the requested structure exactly, section for section, and keep every specific — names, paths, quoted wording, errors, numbers — that whoever continues would otherwise have to rediscover.",
	// The retrospective ran under the hand-over wording too, and it is the one
	// pass that must not carry specifics: they are in the summary already, and
	// repeating them spends the budget twice for one fact.
	retrospective:
		"You are assessing your own reasoning on work that is about to be discarded. This is judgement, not a record — what happened is written up separately. Be terse, and say only what you would want to know before starting the next hour of this task.",
} as const;

/**
 * How many times the summarizer is asked before compaction gives up.
 *
 * Three, because the three failures it recovers from are different and a
 * single retry only covers one of them: a transport error is usually gone on
 * the next call, an empty response from a model that spent its budget
 * reasoning may need two, and a summary that overran its budget needs one
 * attempt to measure it and another to act on the measurement.
 */
const SUMMARY_ATTEMPTS = 3;

/**
 * Tell the summarizer, in numbers, that its last attempt did not fit.
 *
 * This is the one place length is worth talking about, and it is the exception
 * that proves the rule the prompts follow. `DEFAULT_FULL_COMPACTION_PROMPT`
 * carries no length adjective because adjectives are a measured non-lever
 * (arXiv 2605.23296): "be concise" and "be very detailed" produce nearly the
 * same output, since the model anchors length to its training distribution and
 * has no way to know what the budget is.
 *
 * A measurement is not an adjective. "You wrote 4,100 tokens and the limit is
 * 2,800" is a fact about this attempt against a number the model could not
 * otherwise see, and the second attempt has something to aim at. What it must
 * not turn into is an instruction to drop sections — a shorter summary that
 * has lost the standing instructions or the identifiers is worse than one that
 * overran, so the guidance is to compress within the structure and the two
 * things that are never compressed are named.
 */
function describeOverrun(measuredTokens: number, limitTokens: number): string {
	return [
		"",
		"",
		`Your previous attempt was about ${measuredTokens} tokens. It has to fit in ${limitTokens} and it did not, so it was rejected and nothing was kept from it.`,
		"",
		`Write it again under ${limitTokens} tokens. Keep every section — a missing section reads as an omission by accident. Shorten within them instead: fewer words per item, no restating the same fact in two sections, no preamble. Two things are never shortened: quoted standing instructions, and identifiers, lists and checklists, which have to stay verbatim and complete however little room is left.`,
	].join("\n");
}

async function generateSummary(options: {
	providerConfig: ProviderConfig;
	request: string;
	systemPrompt: string;
	logger?: BasicLogger;
}): Promise<SummaryGenerationResult> {
	const handler = await createHandlerAsync(options.providerConfig);
	let text = "";
	let reasoningChars = 0;
	let incompleteReason: string | undefined;
	for await (const chunk of handler.createMessage(options.systemPrompt, [
		{ role: "user", content: options.request },
	])) {
		if (chunk.type === "text") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "reasoning") {
			reasoningChars += chunk.reasoning?.length ?? 0;
			continue;
		}
		if (chunk.type === "done") {
			if (!chunk.success && chunk.error) {
				throw new Error(chunk.error);
			}
			incompleteReason = chunk.incompleteReason ?? incompleteReason;
		}
	}
	options.logger?.debug("Generated compaction summary", {
		outputChars: text.length,
		reasoningChars,
		incompleteReason,
		modelId: options.providerConfig.modelId,
		providerId: options.providerConfig.providerId,
	});
	return { text: text.trim(), reasoningChars, incompleteReason };
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

/**
 * The second phase, in full.
 *
 * Self-contained and unable to fail the compaction: a retrospective is worth
 * having and worth nothing at the price of losing the summary that was already
 * paid for. Every exit here returns `undefined` and the compaction proceeds
 * without it.
 */
async function generateThinkingSummary(options: {
	enabled: boolean;
	messages: MessageWithMetadata[];
	previousThinkingSummary?: string;
	promptTemplate?: string;
	maxOutputTokens: number;
	summarizer?: CoreCompactionSummarizerConfig;
	activeProviderConfig: ProviderConfig;
	summarizerInputLimit: number;
	logger?: BasicLogger;
}): Promise<string | undefined> {
	if (!options.enabled) {
		return undefined;
	}
	const reasoningText = serializeReasoningWithOutcomes(options.messages);
	if (!reasoningText.trim() && !options.previousThinkingSummary?.trim()) {
		// Nothing was thought and nothing was carried, so there is nothing to be
		// retrospective about. Common on the first compaction of a session whose
		// model does not reason at all.
		return undefined;
	}
	const request = buildThinkingSummaryRequest({
		previousThinkingSummary: options.previousThinkingSummary,
		reasoningText,
		promptTemplate: options.promptTemplate,
	});
	if (estimateTokens(request.length) > options.summarizerInputLimit) {
		options.logger?.log(
			"Skipped thinking compaction: reasoning exceeds the summarizer input limit",
			{
				severity: "warn",
				requestEstimatedTokens: estimateTokens(request.length),
				summarizerInputLimit: options.summarizerInputLimit,
			},
		);
		return undefined;
	}
	const providerConfig = resolveSummarizerConfig({
		activeProviderConfig: options.activeProviderConfig,
		summarizer: options.summarizer,
		maxInputTokens: options.summarizerInputLimit,
		outputTokenCap: options.maxOutputTokens,
	});
	try {
		const result = await generateSummary({
			providerConfig,
			request,
			systemPrompt: SUMMARIZER_SYSTEM_PROMPTS.retrospective,
			logger: options.logger,
		});
		const trimmed = result.text.trim();
		if (!trimmed) {
			return undefined;
		}
		options.logger?.debug("Generated thinking compaction", {
			reasoningInputChars: reasoningText.length,
			previousThinkingSummaryChars:
				options.previousThinkingSummary?.length ?? 0,
			maxOutputTokens: options.maxOutputTokens,
			outputChars: trimmed.length,
			providerId: providerConfig.providerId,
			modelId: providerConfig.modelId,
		});
		return trimmed;
	} catch (error) {
		options.logger?.log(
			"Thinking compaction failed; keeping the summary alone",
			{
				severity: "warn",
				errorMessage: error instanceof Error ? error.message : String(error),
			},
		);
		return undefined;
	}
}

export async function runAgenticCompaction(options: {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	/** Overrides the built-in summary instruction; blank uses the default. */
	summaryPrompt?: string;
	/** Second phase: a retrospective over the reasoning being discarded. */
	thinkingSummaryEnabled?: boolean;
	/** Overrides the built-in retrospective instruction; blank uses the default. */
	thinkingSummaryPrompt?: string;
	/**
	 * Whether a recency tail survives the compaction. Defaults to true.
	 *
	 * False is a different operation, not a tighter budget: the summary becomes
	 * the whole context rather than its preface, `bounds` stops being consulted,
	 * and the prompt the caller passes has to be one written for a reader with
	 * nothing else. See {@link planFullCut}.
	 */
	keepRecentMessages?: boolean;
	/**
	 * Where the ledger gets the revisions holding each touched file's content.
	 *
	 * Absent means the ledger still runs and simply says nothing about files.
	 * That is the honest degradation: a wrong revision label is worse than
	 * none, because the model will try to restore it.
	 */
	revisionsFor?: ToolLedgerOptions["revisionsFor"];
	bounds: RecencyBounds;
	estimateMessageTokens: EstimateMessageTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const messages = options.context.messages;
	if (messages.length < 2) {
		return undefined;
	}

	const keepRecentMessages = options.keepRecentMessages !== false;
	const { cutIndex, pinnedIndex } = keepRecentMessages
		? findCutPlan(messages, options.bounds, options.estimateMessageTokens)
		: planFullCut(messages);
	// `cutIndex === messages.length` is the whole point of the no-tail plan and
	// is refused by the tail plan for the same reason: there, a cut at the end
	// means the recency walk found nothing to keep, which is a failure to
	// compact rather than a complete one.
	const maxCutIndex = keepRecentMessages
		? messages.length - 1
		: messages.length;
	if (cutIndex <= 0 || cutIndex > maxCutIndex) {
		return undefined;
	}

	// A pinned prompt lies before the cut but survives verbatim, so it is not
	// part of what gets summarized.
	const pinnedMessage = pinnedIndex >= 0 ? messages[pinnedIndex] : undefined;
	const messagesToSummarize = messages
		.slice(0, cutIndex)
		.filter((_, index) => index !== pinnedIndex);
	const latestSummaryIndex = findLatestSummaryIndex(messagesToSummarize);
	const previousSummaryMetadata =
		latestSummaryIndex >= 0
			? getCompactionSummaryMetadata(messagesToSummarize[latestSummaryIndex])
			: undefined;
	const previousSummary = previousSummaryMetadata?.summary;
	const previousThinkingSummary = previousSummaryMetadata?.thinkingSummary;
	const generation = (previousSummaryMetadata?.generation ?? 0) + 1;
	const newMessagesToFold =
		latestSummaryIndex >= 0
			? messagesToSummarize.slice(latestSummaryIndex + 1)
			: messagesToSummarize;
	if (newMessagesToFold.length === 0) {
		return undefined;
	}

	const preProjectionFileOps = extractFileOps(messagesToSummarize);
	// Resolved twice, because the two answers depend on each other: the input
	// limit comes from the merged model, and the output cap is sized from that
	// limit. The first pass exists only to identify the model; its output cap is
	// never used.
	const summarizerModelConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
	});
	const resolvedSummarizerInputLimit = resolveProviderMaxInputTokens(
		summarizerModelConfig,
	);
	const canUseActiveContextLimit = options.summarizer === undefined;
	const activeCompactionInputLimit = Math.max(
		options.context.budget.request.maxInputTokens,
		options.context.budget.request.triggerTokens,
		MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
	);
	if (resolvedSummarizerInputLimit === undefined && !canUseActiveContextLimit) {
		options.logger?.log(
			"Agentic compaction summarizer has no known input limit; using conservative summary budget",
			{
				severity: "warn",
				summarizerProviderId: summarizerModelConfig.providerId,
				summarizerModelId: summarizerModelConfig.modelId,
				fallbackInputLimit: MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
			},
		);
	}
	const summarizerInputLimit =
		resolvedSummarizerInputLimit ??
		(canUseActiveContextLimit
			? activeCompactionInputLimit
			: MIN_AGENTIC_SUMMARY_INPUT_TOKENS);
	// The ladder: what the summary and the retrospective may spend together at
	// this generation, and the summary's share of it. The summary writes first
	// and the retrospective takes what it leaves.
	const outputBudgets = resolveCompactionOutputBudgets({
		messageTargetTokens: options.context.budget.messages.targetTokens,
		maxInputTokens: summarizerInputLimit,
		generation,
	});
	const summarizerProviderConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
		maxInputTokens: summarizerInputLimit,
		outputTokenCap: outputBudgets.summaryMaxTokens,
	});
	const summaryRequestOverheadTokens = estimateTokens(
		buildSummaryRequest({
			previousSummary,
			conversationText: "",
			fileOps: preProjectionFileOps,
			promptTemplate: options.summaryPrompt,
		}).length,
	);
	const availableSummaryInputTokens =
		summarizerInputLimit - summaryRequestOverheadTokens;
	if (availableSummaryInputTokens <= 0) {
		// At warn, and naming the two numbers, because this is a configuration
		// fault rather than a transcript that happens not to need compacting.
		// The instruction alone does not fit the summarizer's window, so no
		// transcript will ever fit either and every compaction from here on is a
		// silent no-op while the context keeps growing. Both built-in prompts
		// are larger than the one they replaced — the no-tail prompt is a fixed
		// section list and cannot be short — so the summarizer window this needs
		// is a real floor, not a rounding error.
		options.logger?.log(
			"Skipped agentic compaction: the summary instruction alone exceeds the summarizer's input limit",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerInputLimit,
				summaryRequestOverheadTokens,
			},
		);
		return undefined;
	}
	const summaryInputBudget = buildAgenticSummaryInputBudget({
		messages: newMessagesToFold,
		targetTokens: availableSummaryInputTokens,
		estimateMessageTokens: options.estimateMessageTokens,
	});
	if (summaryInputBudget.status === "failed") {
		options.logger?.log(
			"Skipped agentic compaction: summary input budget failed",
			{
				severity: "warn",
				budgetWarnings: summaryInputBudget.warnings.map(
					(warning) => warning.code,
				),
				summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
				targetTokens: availableSummaryInputTokens,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}
	const fileOps = extractFileOps(summaryInputBudget.messages);
	const conversationText = serializeConversation(summaryInputBudget.messages);
	const summaryRequest = buildSummaryRequest({
		previousSummary,
		conversationText,
		fileOps,
		promptTemplate: options.summaryPrompt,
	});
	options.logger?.debug("Agentic compaction summarizer diagnostics", {
		keepRecentMessages,
		messagesToSummarize: messagesToSummarize.length,
		newMessagesToFold: newMessagesToFold.length,
		preservedMessages: messages.length - cutIndex + (pinnedMessage ? 1 : 0),
		pinnedPromptIndex: pinnedIndex,
		previousSummaryChars: previousSummary?.length ?? 0,
		conversationTextChars: conversationText.length,
		summaryRequestChars: summaryRequest.length,
		summaryRequestEstimatedTokens: estimateTokens(summaryRequest.length),
		newMessagesJsonChars: safeJsonSize(newMessagesToFold),
		summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
		summaryInputActions: summaryInputBudget.actions.length,
		summaryInputWarnings: summaryInputBudget.warnings.map(
			(warning) => warning.code,
		),
		summaryRequestOverheadTokens,
		summarizerProviderId: summarizerProviderConfig.providerId,
		summarizerModelId: summarizerProviderConfig.modelId,
		summarizerInputLimit,
		maxInputTokens: options.context.budget.request.maxInputTokens,
		triggerTokens: options.context.budget.request.triggerTokens,
	});
	// Three failures, all recoverable, none of which used to be recovered from:
	// the call threw, the call came back empty, or the summary overran the
	// budget it has to fit. Each one used to end the compaction — and ending it
	// means handing the same oversized transcript to the next turn, one turn
	// larger, having spent a model call to achieve nothing.
	const summaryLimitTokens = outputBudgets.summaryMaxTokens;
	let summaryResult: SummaryGenerationResult | undefined;
	let lastFailure = "none";
	for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt += 1) {
		// Only the overrun retry changes the request, because only the overrun
		// gives the model something it did not already know. A throw and an
		// empty response are told nothing new: the same request is simply sent
		// again.
		const request =
			lastFailure === "over_budget" && summaryResult
				? `${summaryRequest}${describeOverrun(
						estimateTokens(summaryResult.text.length),
						summaryLimitTokens,
					)}`
				: summaryRequest;
		let candidate: SummaryGenerationResult | undefined;
		try {
			candidate = await generateSummary({
				providerConfig: summarizerProviderConfig,
				request,
				systemPrompt: keepRecentMessages
					? SUMMARIZER_SYSTEM_PROMPTS.tail
					: SUMMARIZER_SYSTEM_PROMPTS.full,
				logger: options.logger,
			});
		} catch (error) {
			// A cancelled compaction is not a failed one, and retrying it would
			// ignore the abort that asked it to stop.
			if (options.context.abortSignal?.aborted) {
				throw error;
			}
			lastFailure = "threw";
			options.logger?.log("Compaction summarizer call failed; retrying", {
				severity: "warn",
				attempt,
				attempts: SUMMARY_ATTEMPTS,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (!candidate.text.trim()) {
			lastFailure = "empty";
			options.logger?.log(
				"Compaction summarizer returned no summary text; retrying",
				{
					severity: "warn",
					attempt,
					attempts: SUMMARY_ATTEMPTS,
					summarizerMaxOutputTokens: summarizerProviderConfig.maxOutputTokens,
					reasoningChars: candidate.reasoningChars,
					incompleteReason: candidate.incompleteReason,
					likelyCause:
						candidate.reasoningChars > 0
							? "output_budget_consumed_by_reasoning"
							: "empty_response",
				},
			);
			continue;
		}
		const candidateTokens = estimateTokens(candidate.text.length);
		if (candidateTokens > summaryLimitTokens) {
			lastFailure = "over_budget";
			summaryResult = candidate;
			options.logger?.log(
				"Compaction summary exceeded its output budget; retrying with the measurement",
				{
					severity: "warn",
					attempt,
					attempts: SUMMARY_ATTEMPTS,
					summaryTokens: candidateTokens,
					summaryLimitTokens,
				},
			);
			continue;
		}
		summaryResult = candidate;
		lastFailure = "none";
		break;
	}
	// An overrunning summary on the last attempt is kept, because it is a real
	// summary of the work and the alternative is no compaction at all. The
	// budget is a target the retry exists to hit, not a wall worth losing the
	// transcript over. An empty one is not kept: there is nothing in it.
	const rawSummary =
		lastFailure === "threw" || lastFailure === "empty"
			? ""
			: (summaryResult?.text ?? "");
	if (!rawSummary || !summaryResult) {
		options.logger?.log(
			"Skipped agentic compaction: the summarizer produced nothing usable",
			{
				severity: "warn",
				attempts: SUMMARY_ATTEMPTS,
				lastFailure,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}

	const summary = ensureFilesSection(rawSummary, fileOps);
	// Built from what is being folded now, not from everything the session has
	// ever done. Earlier generations' calls are already prose in the summary
	// this one folds, and a ledger that accumulated across generations would
	// grow while the transcript shrank.
	//
	// Built from the whole fold rather than from the projected budget slice,
	// too: the projection drops tool results to make the *summary request* fit,
	// and a call whose result was dropped is exactly the one most worth a line
	// here — it is the one the model was never shown and so cannot have
	// described.
	const toolLedger = renderToolLedger(
		buildToolLedger(newMessagesToFold, {
			...(options.revisionsFor ? { revisionsFor: options.revisionsFor } : {}),
		}),
	);
	const thinkingSummary = await generateThinkingSummary({
		enabled: options.thinkingSummaryEnabled !== false,
		messages: newMessagesToFold,
		previousThinkingSummary,
		promptTemplate: options.thinkingSummaryPrompt,
		maxOutputTokens: resolveThinkingSummaryMaxTokens({
			budgets: outputBudgets,
			summaryTokens: estimateTokens(summary.length),
		}),
		summarizer: options.summarizer,
		activeProviderConfig: options.providerConfig,
		summarizerInputLimit,
		logger: options.logger,
	});
	const tokensBefore = messages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	const resultMessages = [
		buildSummaryMessage({
			summary,
			fileOps,
			tokensBefore,
			userRunSpan: countUserRunMessages(messagesToSummarize),
			generation,
			thinkingSummary,
			toolLedger,
		}),
		...(pinnedMessage ? [pinnedMessage] : []),
		...messages.slice(cutIndex),
	];
	const tokensAfter = resultMessages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	options.logger?.debug("Performed agentic compaction", {
		toolLedgerChars: toolLedger.length,
		messagesBefore: messages.length,
		messagesAfter: resultMessages.length,
		messagesSummarized: messagesToSummarize.length,
		messagesPreserved: resultMessages.length - 1,
		tokensBefore,
		tokensAfter,
		maxInputTokens: options.context.budget.request.maxInputTokens,
	});
	const budgetActionCount = summaryInputBudget.actions.filter(
		(action) =>
			action.reason === "over_budget" || action.reason === "tool_pair_boundary",
	).length;
	return {
		messages: resultMessages,
		budget: {
			policyIntent: "agentic_summary",
			actionCount: budgetActionCount,
			warningCount: summaryInputBudget.warnings.length,
			liveTailHandling: summaryInputBudget.liveTailHandling,
		},
	};
}
