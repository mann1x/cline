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

async function generateSummary(options: {
	providerConfig: ProviderConfig;
	request: string;
	logger?: BasicLogger;
}): Promise<string> {
	const handler = await createHandlerAsync(options.providerConfig);
	let text = "";
	for await (const chunk of handler.createMessage(
		// The system half said "concise" while the user half asks for the detail
		// that has to survive; the model was being pulled both ways on the one
		// message that has to carry everything.
		"You write hand-over notes for coding sessions. The transcript you are given is about to be discarded, so your note is the only record that remains. Follow the requested structure exactly, and keep every specific — paths, names, errors, numbers — that the next agent would otherwise have to rediscover.",
		[{ role: "user", content: options.request }],
	)) {
		if (chunk.type === "text") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "done" && !chunk.success && chunk.error) {
			throw new Error(chunk.error);
		}
	}
	options.logger?.debug("Generated compaction summary", {
		outputChars: text.length,
		modelId: options.providerConfig.modelId,
		providerId: options.providerConfig.providerId,
	});
	return text.trim();
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
		const text = await generateSummary({
			providerConfig,
			request,
			logger: options.logger,
		});
		const trimmed = text.trim();
		if (!trimmed) {
			return undefined;
		}
		options.logger?.debug("Generated thinking compaction", {
			reasoningInputChars: reasoningText.length,
			previousThinkingSummaryChars: options.previousThinkingSummary?.length ?? 0,
			maxOutputTokens: options.maxOutputTokens,
			outputChars: trimmed.length,
			providerId: providerConfig.providerId,
			modelId: providerConfig.modelId,
		});
		return trimmed;
	} catch (error) {
		options.logger?.log("Thinking compaction failed; keeping the summary alone", {
			severity: "warn",
			errorMessage: error instanceof Error ? error.message : String(error),
		});
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
	bounds: RecencyBounds;
	estimateMessageTokens: EstimateMessageTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const messages = options.context.messages;
	if (messages.length < 2) {
		return undefined;
	}

	const { cutIndex, pinnedIndex } = findCutPlan(
		messages,
		options.bounds,
		options.estimateMessageTokens,
	);
	if (cutIndex <= 0 || cutIndex >= messages.length) {
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
		options.logger?.debug(
			"Skipped agentic compaction: summarizer budget exhausted",
			{
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
	const rawSummary = await generateSummary({
		providerConfig: summarizerProviderConfig,
		request: summaryRequest,
		logger: options.logger,
	});
	if (!rawSummary.trim()) {
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
