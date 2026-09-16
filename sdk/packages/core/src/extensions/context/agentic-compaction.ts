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
	const summaryResult = await generateSummary({
		providerConfig: summarizerProviderConfig,
		request: summaryRequest,
		systemPrompt: keepRecentMessages
			? SUMMARIZER_SYSTEM_PROMPTS.tail
			: SUMMARIZER_SYSTEM_PROMPTS.full,
		logger: options.logger,
	});
	const rawSummary = summaryResult.text;
	if (!rawSummary) {
		options.logger?.log(
			"Skipped agentic compaction: summarizer returned no summary text",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerMaxOutputTokens: summarizerProviderConfig.maxOutputTokens,
				reasoningChars: summaryResult.reasoningChars,
				incompleteReason: summaryResult.incompleteReason,
				likelyCause:
					summaryResult.reasoningChars > 0
						? "output_budget_consumed_by_reasoning"
						: "empty_response",
			},
		);
		return undefined;
	}

	const summary = ensureFilesSection(rawSummary, fileOps);
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
		}),
		...(pinnedMessage ? [pinnedMessage] : []),
		...messages.slice(cutIndex),
	];
	const tokensAfter = resultMessages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	options.logger?.debug("Performed agentic compaction", {
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
