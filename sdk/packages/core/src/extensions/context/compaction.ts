import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	charsPerToken,
	estimateRequestInputTokens,
	consumeContextOverflow,
	lastObservedRequestTokens,
} from "@cline/shared";
import {
	captureCompactionBudgetEmergency,
	captureCompactionExecuted,
	captureCompactionSkipped,
	type TelemetryCompactionStrategy,
} from "../../services/telemetry/core-events";
import {
	createSessionCompactionState,
	projectSessionCompactionState,
	type SessionCompactionState,
} from "../../session/models/session-compaction";
import type {
	CoreCompactionConfig,
	CoreCompactionContext,
	CoreCompactionMode,
	CoreCompactionResult,
	CoreCompactionStrategy,
	CoreSessionConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import { runAgenticCompaction } from "./agentic-compaction";
import { runBasicCompaction } from "./basic-compaction";
import { reasoningHistoryModeForProvider } from "@cline/llms";
import {
	COMPACTION_TRIGGER_RATIO,
	createTokenEstimator,
	DEFAULT_MAX_INPUT_TOKENS,
	DEFAULT_TARGET_RATIO,
	getCompactionSummaryMetadata,
	resolveCompactionTriggerTokens,
	resolveEffectiveMaxInputTokens,
	resolvePreserveRecentTokens,
	resolveRecencyBounds,
	seedCalibrationFromTranscript,
} from "./compaction-shared";

export interface ContextPipelinePrepareTurnInput {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
	iteration: number;
	messages: CoreCompactionContext["messages"];
	apiMessages: CoreCompactionContext["messages"];
	abortSignal: AbortSignal;
	systemPrompt: string;
	tools: unknown[];
	model: CoreCompactionContext["model"];
	/**
	 * Set by the runtime when the provider rejected the previous request as
	 * exceeding the model's context window. Forces a compaction regardless of
	 * the token-estimate trigger (the estimate just proved wrong) and uses the
	 * deterministic basic strategy — recovery must not depend on another
	 * successful LLM request.
	 */
	overflowRecovery?: boolean;
	emitStatusNotice?: (
		message: string,
		metadata?: Record<string, unknown>,
	) => void;
}

export interface ContextPipelinePrepareTurnResult {
	messages: CoreCompactionContext["messages"];
	systemPrompt?: string;
}

export type ContextPipelinePrepareTurn = (
	context: ContextPipelinePrepareTurnInput,
) => Promise<ContextPipelinePrepareTurnResult | undefined>;

type EstimateMessageTokens = ReturnType<typeof createTokenEstimator>;

type BuiltinCompactionStrategyOptions = {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	compaction: CoreCompactionConfig | undefined;
	estimateMessageTokens: EstimateMessageTokens;
	logger: Pick<CoreSessionConfig, "logger">["logger"];
};

type BuiltinCompactionStrategyRunner = (
	options: BuiltinCompactionStrategyOptions,
) =>
	| Promise<CoreCompactionResult | undefined>
	| CoreCompactionResult
	| undefined;

export interface ContextCompactionPrepareTurnOptions {
	mode?: CoreCompactionMode;
	manualTargetRatio?: number;
}

/**
 * Where a long conversation lands after an automatic compaction, as a share of
 * the usable input budget.
 *
 * Compaction is not free — it costs a summarizer call, and it costs whatever
 * the summary fails to carry — so the measure that matters is how many turns it
 * buys before the next one. At 0.5, a session that triggers at 0.9 recovers 40
 * points of window and, on a transcript that grows a couple of points a turn,
 * is back at the threshold within a handful of turns: observed sessions sat
 * near half full and compacted again and again. A third leaves nearly twice the
 * runway for one summary at the same price.
 *
 * Lower is not automatically better. The summarizer has to fit the discarded
 * turns into what is left, and below roughly a third the summary becomes the
 * thing that loses the detail, rather than the window.
 */
const LONG_CONVERSATION_TARGET_RATIO = 0.33;

/**
 * The share of the budget past which the last turn loses its exemption.
 *
 * The cut normally stops at the start of the latest typed turn so the model
 * keeps the request it is working on intact. A turn is a prompt and everything
 * the model did about it, so one prompt followed by a long tool loop is a
 * single turn that can be most of the transcript -- and then the exemption is
 * not protecting the model's train of thought, it is refusing to compact.
 *
 * Two thirds is chosen to sit above the 0.33 target with real room to spare, so
 * an ordinary compaction that simply lands wide of its target does not start
 * cutting into the live turn; only one that would leave the window still mostly
 * full does.
 */
const LAST_TURN_PRESERVE_CEILING_RATIO = 0.66;

function isCompactionCancellation(
	error: unknown,
	abortSignal: AbortSignal,
): boolean {
	if (abortSignal.aborted) {
		return true;
	}
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "AgentRuntimeAbortError")
	);
}

function describeCompactionError(error: unknown): Record<string, unknown> {
	return error instanceof Error
		? { errorName: error.name, errorMessage: error.message }
		: { errorMessage: String(error) };
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function summarizeToolResults(messages: CoreCompactionContext["messages"]): {
	toolResultCount: number;
	toolResultSerializedChars: number;
	maxToolResultSerializedChars: number;
} {
	let toolResultCount = 0;
	let toolResultSerializedChars = 0;
	let maxToolResultSerializedChars = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type !== "tool_result") {
				continue;
			}
			const size = safeJsonSize(block.content);
			toolResultCount += 1;
			toolResultSerializedChars += size;
			maxToolResultSerializedChars = Math.max(
				maxToolResultSerializedChars,
				size,
			);
		}
	}
	return {
		toolResultCount,
		toolResultSerializedChars,
		maxToolResultSerializedChars,
	};
}

const BUILTIN_COMPACTION_STRATEGIES = {
	basic: ({ context, estimateMessageTokens, logger }) =>
		runBasicCompaction({
			context,
			estimateMessageTokens,
			logger,
		}),
	agentic: ({
		context,
		providerConfig,
		compaction,
		estimateMessageTokens,
		logger,
	}) =>
		runAgenticCompaction({
			context,
			providerConfig,
			summarizer: compaction?.summarizer,
			summaryPrompt: compaction?.summaryPrompt,
			thinkingSummaryEnabled: compaction?.thinkingSummaryEnabled,
			thinkingSummaryPrompt: compaction?.thinkingSummaryPrompt,
			// The recency budget is a floor and the message budget a ceiling —
			// two different bounds, not one clamped by the other. Taking the
			// smaller of the pair (as this did) collapses them: the floor is
			// always the smaller number in practice, so the clamp was a no-op
			// and the room the target bought went unused, every compaction
			// folding to the 20,000-token minimum no matter how much fit.
			bounds: resolveRecencyBounds({
				preserveRecentTokens: resolvePreserveRecentTokens({
					contextWindow: context.model.info?.contextWindow,
					maxInputTokens: context.budget.request.maxInputTokens,
					messageTargetTokens: context.budget.messages.targetTokens,
					override: compaction?.preserveRecentTokens,
				}),
				preserveRecentMessagesRatio: compaction?.preserveRecentMessagesRatio,
				messageTargetTokens: context.budget.messages.targetTokens,
				lastTurnCeiling:
					translateRequestBudgetToMessages(
						context.budget.request.maxInputTokens,
						context.budget.request.overheadTokens,
					) * LAST_TURN_PRESERVE_CEILING_RATIO,
			}),
			estimateMessageTokens,
			logger,
		}),
} satisfies Record<CoreCompactionStrategy, BuiltinCompactionStrategyRunner>;

/**
 * Append a compaction decision to `<tmpdir>/cline-compaction.jsonl`.
 *
 * The decision is already handed to `logger?.debug`, but in the VS Code host
 * that ends up in an output channel that exists only in memory: by the time a
 * bad compaction is noticed the evidence for it is gone, and reproducing it
 * means reproducing the whole session. A decision that cannot be inspected
 * after the fact can only be reasoned about, and reasoning about this one has
 * been wrong more than once.
 *
 * Best-effort and never throws: diagnostics must not be able to break the
 * pipeline they describe.
 */
function appendCompactionDiagnostics(
	diagnostics: Record<string, unknown>,
): void {
	try {
		appendFileSync(
			join(tmpdir(), "cline-compaction.jsonl"),
			`${JSON.stringify({ at: new Date().toISOString(), ...diagnostics })}\n`,
		);
	} catch {
		// A diagnostics sink that can fail the run is worse than no sink.
	}
}

function resolveManualMessageTargetTokens(input: {
	messageInputTokens: number;
	messageTriggerTokens: number;
	manualTargetRatio: number | undefined;
}): number {
	const ratio =
		typeof input.manualTargetRatio === "number" &&
		Number.isFinite(input.manualTargetRatio)
			? input.manualTargetRatio
			: 0.5;
	const targetRatio = Math.min(0.95, Math.max(0.05, ratio));
	return Math.max(
		1,
		Math.floor(
			Math.min(
				input.messageTriggerTokens,
				input.messageInputTokens * targetRatio,
			),
		),
	);
}

function resolveAutoRequestTargetTokens(input: {
	maxInputTokens: number;
	modelMaxTokens?: number;
	triggerTokens: number;
	messagePairCount: number;
}): number {
	const targetTokens =
		input.messagePairCount >= 5 &&
		typeof input.modelMaxTokens === "number" &&
		Number.isFinite(input.modelMaxTokens) &&
		input.modelMaxTokens < input.maxInputTokens
			? Math.floor(input.maxInputTokens * LONG_CONVERSATION_TARGET_RATIO)
			: Math.floor(input.triggerTokens * DEFAULT_TARGET_RATIO);
	const triggerCeiling = Math.max(1, input.triggerTokens - 1);
	return Math.max(
		1,
		Math.min(targetTokens, input.maxInputTokens, triggerCeiling),
	);
}

/**
 * Put an estimate on the same scale as the provider's own count.
 *
 * `estimate` and `estimateOfObserved` measure the same transcript the same way;
 * `observed` is what the provider charged for it. The ratio between the last
 * two is this session's standing estimator error, and applying it to the first
 * is what makes a "before" and an "after" comparable. Falls back to the raw
 * estimate when there is nothing to calibrate against -- the first request of a
 * session, before any response has been counted.
 */
export function scaleEstimateToObserved(
	estimate: number,
	estimateOfObserved: number,
	observed: number | undefined,
): number {
	if (
		observed === undefined ||
		!Number.isFinite(observed) ||
		observed <= 0 ||
		!Number.isFinite(estimateOfObserved) ||
		estimateOfObserved <= 0
	) {
		return estimate;
	}
	return Math.max(1, Math.round(estimate * (observed / estimateOfObserved)));
}

function translateRequestBudgetToMessages(
	requestTokens: number,
	overheadTokens: number,
): number {
	return Math.max(1, Math.floor(requestTokens - overheadTokens));
}

function countUserAssistantPairs(
	messages: CoreCompactionContext["messages"],
): number {
	let pairs = 0;
	let hasPendingUser = false;
	for (const message of messages) {
		if (message.role === "user") {
			hasPendingUser = true;
		} else if (message.role === "assistant" && hasPendingUser) {
			pairs += 1;
			hasPendingUser = false;
		}
	}
	return pairs;
}

/**
 * Build the `prepareTurn` callback used by the agent runtime to compact the
 * transcript before each model request.
 *
 * Telemetry: emits `task.compaction_executed` on a successful compaction and
 * `task.compaction_skipped` when the configured strategy returns `undefined`.
 * Telemetry is keyed by `config.sessionId` (falling back to the per-turn
 * `conversationId`) and tagged with `provider` / `modelId`.
 *
 * Known gap: compactions performed via plugin `registerMessageBuilder()` or
 * via the `beforeModel` runtime hook bypass this wrapper entirely, so they
 * do not emit compaction telemetry. If we want coverage there too, the
 * plugin/hook pipelines must be instrumented separately.
 */
export function createContextCompactionPrepareTurn(
	config: Pick<
		CoreSessionConfig,
		| "providerConfig"
		| "providerId"
		| "modelId"
		| "compaction"
		| "logger"
		| "telemetry"
		| "sessionId"
	>,
	options: ContextCompactionPrepareTurnOptions = {},
):
	| ((
			context: ContextPipelinePrepareTurnInput,
	  ) => Promise<ContextPipelinePrepareTurnResult | undefined>)
	| undefined {
	const userCompaction = config.compaction;
	if (userCompaction?.enabled !== true) {
		return undefined;
	}

	const providerConfig =
		config.providerConfig ??
		({
			providerId: config.providerId,
			modelId: config.modelId,
		} as ProviderConfig);
	const estimateMessageTokens = createTokenEstimator();
	const strategy = userCompaction?.strategy ?? "agentic";
	const runBuiltinStrategy = BUILTIN_COMPACTION_STRATEGIES[strategy];
	const mode = options.mode ?? "auto";
	const telemetryStrategy: TelemetryCompactionStrategy = userCompaction?.compact
		? "custom"
		: strategy;

	return async (context) => {
		const effectiveMode: CoreCompactionMode = context.overflowRecovery
			? "overflow_recovery"
			: mode;
		const apiMessageTokens = context.apiMessages.reduce(
			(total: number, message) => total + estimateMessageTokens(message),
			0,
		);
		// Measured the way the gateway measures it: reasoning the provider will
		// drop is not part of the request, and counting it here ran the estimate
		// at roughly twice the provider's own count (139,991 against 60,444,
		// measured live). The trigger prefers the observed count, so this is the
		// fallback path -- the first request of a session, and every resume --
		// which is exactly where an estimate that high compacts a transcript that
		// had ample room.
		const reasoningHistory = reasoningHistoryModeForProvider(config.providerId);
		const requestInputTokens = estimateRequestInputTokens(
			{
				systemPrompt: context.systemPrompt,
				messages: context.apiMessages,
				tools: context.tools,
			},
			{ reasoningHistory },
		);
		const messageInputTokens = context.messages.reduce(
			(total: number, message) => total + estimateMessageTokens(message),
			0,
		);
		const requestOverheadTokens = Math.max(
			0,
			requestInputTokens - apiMessageTokens,
		);
		const maxInputTokens =
			resolveEffectiveMaxInputTokens({
				maxInputTokens: context.model.info?.maxInputTokens,
				contextWindow: context.model.info?.contextWindow,
			}) ?? DEFAULT_MAX_INPUT_TOKENS;
		const requestTriggerTokens = resolveCompactionTriggerTokens({
			maxInputTokens,
			contextWindow: context.model.info?.contextWindow,
			modelMaxTokens: context.model.info?.maxTokens,
		});
		const messageTriggerTokens = translateRequestBudgetToMessages(
			requestTriggerTokens,
			requestOverheadTokens,
		);
		// `requestInputTokens` measures `apiMessages`, which is not the payload
		// the provider receives, and it is wrong in both directions. Measured
		// live against the request bodies a local provider logged: 803,588
		// characters of `apiMessages` against a 163,772-byte request body, so
		// the estimate read 151,556 tokens for a context that really cost about
		// 40,000 and it compacted a 17-message transcript that was nowhere near
		// full -- then again on every following turn, because compaction cannot
		// reclaim what was never really there. It goes the other way once a
		// compaction state exists, since `createCompactionStateAwarePrepareTurn`
		// replaces `apiMessages` with canonical projected messages: that
		// under-count let another session reach 126,000 tokens without
		// compacting at all, while the request path -- which measures the real
		// payload -- had already ratcheted the output cap from 32,000 to 976.
		//
		// The provider's own count for the last request is not an estimate, so
		// prefer it. The cost is that it describes the previous request, so the
		// trigger fires one turn after the threshold is crossed rather than
		// before; the ratio below `maxInputTokens` is the headroom that pays
		// for that. The estimate remains the fallback for the first request of
		// a session, when nothing has been counted yet.
		// A resumed session has counts on record from the process that ran it
		// before; without this the fallback below is reached with nothing
		// measured at all, and the estimate it falls back to is roughly double.
		seedCalibrationFromTranscript({
			systemPrompt: context.systemPrompt,
			messages: context.messages,
			tools: context.tools,
			reasoningHistory,
		});
		const observedRequestTokens = lastObservedRequestTokens();
		const triggerInputTokens = observedRequestTokens ?? requestInputTokens;
		// The request path found no room for a reply on the last turn. That is
		// not a projection that could be miscalibrated -- it is the budget
		// arithmetic having already failed -- so it compacts whatever the ratio
		// above concludes, and covers the case where the two disagree.
		const contextOverflow = consumeContextOverflow();
		const shouldCompact =
			contextOverflow !== undefined ||
			triggerInputTokens >= requestTriggerTokens;
		const diagnostics = {
			mode: effectiveMode,
			strategy,
			iteration: context.iteration,
			providerId: config.providerId,
			modelId: config.modelId,
			requestInputTokens,
			observedRequestTokens,
			triggerInputTokens,
			apiMessageTokens,
			messageInputTokens,
			requestOverheadTokens,
			maxInputTokens,
			requestTriggerTokens,
			messageTriggerTokens,
			thresholdRatio: COMPACTION_TRIGGER_RATIO,
			contextWindow: context.model.info?.contextWindow,
			modelMaxTokens: context.model.info?.maxTokens,
			contextOverflow,
			shouldCompact,
			messageCount: context.messages.length,
			apiMessageCount: context.apiMessages.length,
			apiMessagesJsonChars: safeJsonSize(context.apiMessages),
			charsPerToken: Math.round(charsPerToken() * 100) / 100,
			...summarizeToolResults(context.apiMessages),
		};
		config.logger?.debug("Context compaction diagnostics", diagnostics);
		appendCompactionDiagnostics(diagnostics);
		if (effectiveMode === "auto" && !shouldCompact) {
			return undefined;
		}
		let requestTargetTokens: number;
		let messageTargetTokens: number;
		if (effectiveMode === "auto") {
			requestTargetTokens = resolveAutoRequestTargetTokens({
				maxInputTokens,
				modelMaxTokens: context.model.info?.maxTokens,
				triggerTokens: requestTriggerTokens,
				messagePairCount: countUserAssistantPairs(context.messages),
			});
			messageTargetTokens = translateRequestBudgetToMessages(
				requestTargetTokens,
				requestOverheadTokens,
			);
		} else {
			messageTargetTokens = resolveManualMessageTargetTokens({
				messageInputTokens,
				messageTriggerTokens,
				manualTargetRatio: options.manualTargetRatio,
			});
			requestTargetTokens = requestOverheadTokens + messageTargetTokens;
		}

		const compactionContext = {
			agentId: context.agentId,
			conversationId: context.conversationId,
			parentAgentId: context.parentAgentId,
			iteration: context.iteration,
			messages: context.messages,
			model: context.model,
			mode: effectiveMode,
			abortSignal: context.abortSignal,
			budget: {
				request: {
					inputTokens: requestInputTokens,
					maxInputTokens,
					triggerTokens: requestTriggerTokens,
					targetTokens: requestTargetTokens,
					overheadTokens: requestOverheadTokens,
					thresholdRatio: COMPACTION_TRIGGER_RATIO,
					utilizationRatio:
						maxInputTokens > 0 ? requestInputTokens / maxInputTokens : 0,
				},
				messages: {
					inputTokens: messageInputTokens,
					triggerTokens: messageTriggerTokens,
					targetTokens: messageTargetTokens,
				},
			},
		};

		const statusReason =
			effectiveMode === "manual"
				? "manual_compaction"
				: effectiveMode === "overflow_recovery"
					? "overflow_recovery_compaction"
					: "auto_compaction";
		const noticePrefix =
			effectiveMode === "manual"
				? ""
				: effectiveMode === "overflow_recovery"
					? "overflow-recovery-"
					: "auto-";
		context.emitStatusNotice?.(`${noticePrefix}compacting`, {
			kind: statusReason,
			reason: statusReason,
			phase: "started",
			iteration: context.iteration,
			triggerTokens: requestTriggerTokens,
			targetTokens: requestTargetTokens,
			maxInputTokens,
			messageTargetTokens,
		});

		const beforeMessageCount = context.messages.length;
		const startedAt = Date.now();

		const builtinOptions = {
			context: compactionContext,
			providerConfig: {
				...providerConfig,
				abortSignal: context.abortSignal,
			},
			compaction: userCompaction,
			estimateMessageTokens,
			logger: config.logger,
		};
		let executedStrategy = telemetryStrategy;
		let result: CoreCompactionResult | undefined;
		if (effectiveMode === "overflow_recovery") {
			// The provider already rejected the request, so recovery must end
			// deterministically: the agentic strategy's own summarizer call could
			// overflow the same window (its input budgeting trusts the same
			// estimator that just undercounted). A custom compactor gets first
			// shot — it sees mode "overflow_recovery" and owns its transcript
			// invariants — but its result is held to the same bar basic
			// compaction aims for: strictly smaller than the input (the runtime
			// refuses to retry with a request that is not smaller) AND within
			// the recovery token target. A marginal shrink would spend the
			// run's single retry on a request that still cannot fit. On throw,
			// decline, or an insufficient result, basic compaction runs so
			// recovery never depends on another successful LLM request.
			if (userCompaction?.compact) {
				try {
					result = await userCompaction.compact(compactionContext);
				} catch (error) {
					if (isCompactionCancellation(error, context.abortSignal)) {
						throw error;
					}
					config.logger?.log(
						"Custom compaction failed during overflow recovery; falling back to basic compaction",
						{
							severity: "warn",
							...describeCompactionError(error),
						},
					);
					result = undefined;
				}
				if (result?.messages) {
					const customMessageTokens = result.messages.reduce(
						(total: number, message) => total + estimateMessageTokens(message),
						0,
					);
					// The full acceptance bar, covering every degenerate size: a
					// non-empty transcript (an empty one erases the request being
					// retried), strictly smaller than the input (the runtime
					// refuses a retry that is not smaller), and within the
					// recovery token target (a marginal shrink spends the run's
					// single retry on a request that still cannot fit). Both size
					// comparisons use the token estimator rather than serialized
					// length so they are expressed in the same unit as the target.
					const acceptable =
						result.messages.length > 0 &&
						customMessageTokens < messageInputTokens &&
						customMessageTokens <= messageTargetTokens;
					if (!acceptable) {
						config.logger?.log(
							"Custom compaction did not produce an acceptable overflow-recovery transcript; falling back to basic compaction",
							{
								severity: "warn",
								customMessageCount: result.messages.length,
								customMessageTokens,
								messageTargetTokens,
							},
						);
						result = undefined;
					}
				}
			}
			if (!result?.messages) {
				executedStrategy = "basic";
				result = await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
			}
		} else if (userCompaction?.compact) {
			result = await userCompaction.compact(compactionContext);
		} else {
			try {
				result = await runBuiltinStrategy(builtinOptions);
			} catch (error) {
				if (
					strategy !== "agentic" ||
					isCompactionCancellation(error, context.abortSignal)
				) {
					throw error;
				}
				config.logger?.log(
					"Agentic compaction failed; falling back to basic compaction",
					{
						severity: "warn",
						...describeCompactionError(error),
					},
				);
				executedStrategy = "basic";
				result = await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
			}
			// Reaching here means the trigger already decided this transcript has
			// to shrink, so "the strategy declined" is not an answer that leaves
			// the run in a good place: skipping just hands the same oversized
			// transcript to the next turn, one turn larger. Agentic compaction
			// can decline for reasons that have nothing to do with the transcript
			// being small enough -- an empty summary, a summarizer input budget
			// that does not fit, a cut with nothing left to fold -- and it needs a
			// working model request to succeed at exactly the moment the context
			// is fullest. Basic compaction needs no request and cannot decline for
			// any of those reasons, so it is what stands between a declined
			// compaction and a turn that runs out of room to answer in.
			if (strategy === "agentic" && !result?.messages) {
				config.logger?.log(
					"Agentic compaction produced no result; falling back to basic compaction",
					{
						severity: "warn",
						messageInputTokens,
						messageTargetTokens,
						messageCount: context.messages.length,
					},
				);
				executedStrategy = "basic";
				result = await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
			}
		}

		const durationMs = Date.now() - startedAt;
		// Telemetry identity: surface the agent/conversation passed into the
		// prepareTurn so multi-agent runs can attribute compactions correctly.
		// `sessionId` is the host-owned session id (ulid). We fall back to the
		// conversation id when no sessionId is supplied (e.g. ad-hoc callers).
		const telemetryUlid = config.sessionId ?? context.conversationId;
		const telemetryIdentity = {
			agentId: context.agentId,
			conversationId: context.conversationId,
			parentAgentId: context.parentAgentId ?? undefined,
		};

		if (result?.messages) {
			const compactedSummary = result.messages
				.map((message) => getCompactionSummaryMetadata(message))
				.find((metadata) => metadata !== undefined);
			const afterMessageTokens = result.messages.reduce(
				(total: number, message) => total + estimateMessageTokens(message),
				0,
			);
			const afterRequestTokens = requestOverheadTokens + afterMessageTokens;
			// On the provider's scale, so it can be compared with `tokensBefore`.
			const scaledAfterRequestTokens = scaleEstimateToObserved(
				afterRequestTokens,
				requestInputTokens,
				observedRequestTokens,
			);
			config.logger?.log("Context compaction completed", {
				severity: "info",
				strategy: executedStrategy,
				maxInputTokens,
				messageInputTokens,
				apiInputTokens: apiMessageTokens,
				requestInputTokens,
				requestOverheadTokens,
				afterMessageTokens,
				afterRequestTokens,
				tokensSaved: requestInputTokens - afterRequestTokens,
				utilizationBefore: `${((requestInputTokens / maxInputTokens) * 100).toFixed(1)}%`,
				utilizationAfter: `${((afterRequestTokens / maxInputTokens) * 100).toFixed(1)}%`,
				thresholdTrigger: `${(COMPACTION_TRIGGER_RATIO * 100).toFixed(1)}%`,
				messagesBefore: beforeMessageCount,
				messagesAfter: result.messages.length,
				messagesRemoved: beforeMessageCount - result.messages.length,
			} as Record<string, unknown>);
			context.emitStatusNotice?.(`${noticePrefix}compacted`, {
				kind: statusReason,
				reason: statusReason,
				phase: "completed",
				iteration: context.iteration,
				// Report what the decision was actually made on, which is the
				// provider's own count once one exists. `requestInputTokens`
				// estimates the same quantity and read 96% high before the
				// estimator was calibrated, which put this notice at odds with
				// the context bar it sits above. The "after" figure has no
				// counterpart to use -- it describes a request that has not
				// been sent.
				//
				// It can only be an estimate, but printing a measurement and an
				// estimate as the two ends of one arrow compares two different
				// rulers. Measured live: 89,881 observed before against 93,844
				// estimated after, shown as a compaction that made the context
				// *larger* -- and the next response counted 80,317. So the estimate
				// is scaled by how far this same transcript's estimate stood from
				// the count the provider gave it. That is the only calibration
				// available here and it is the right one: the same messages,
				// measured the same way, moments earlier.
				tokensBefore: triggerInputTokens,
				tokensAfter: scaledAfterRequestTokens,
				messagesBefore: beforeMessageCount,
				messagesAfter: result.messages.length,
				maxInputTokens,
				// The summary and the retrospective travel with the notice so
				// the row that announces a compaction can also show what it
				// produced. A compaction is the one operation whose output the
				// user never sees and cannot get back to afterwards -- it
				// replaces the messages it was written from.
				...(compactedSummary ? { summary: compactedSummary.summary } : {}),
				...(compactedSummary?.thinkingSummary
					? { thinkingSummary: compactedSummary.thinkingSummary }
					: {}),
			});
			captureCompactionExecuted(config.telemetry, {
				ulid: telemetryUlid,
				strategy: executedStrategy,
				mode: effectiveMode,
				messagesBefore: beforeMessageCount,
				messagesAfter: result.messages.length,
				messagesRemoved: beforeMessageCount - result.messages.length,
				tokensBefore: triggerInputTokens,
				tokensAfter: scaledAfterRequestTokens,
				tokensSaved: triggerInputTokens - scaledAfterRequestTokens,
				triggerTokens: requestTriggerTokens,
				maxInputTokens,
				thresholdRatio: COMPACTION_TRIGGER_RATIO,
				durationMs,
				// Matches the field name used by other TASK telemetry helpers
				// (e.g. captureTaskCompleted, captureToolUsage).
				provider: config.providerId,
				modelId: config.modelId,
				...telemetryIdentity,
			});
			if (
				result.budget &&
				(result.budget.actionCount > 0 || result.budget.warningCount > 0)
			) {
				captureCompactionBudgetEmergency(config.telemetry, {
					ulid: telemetryUlid,
					strategy: executedStrategy,
					mode: effectiveMode,
					policyIntent: result.budget.policyIntent,
					actionCount: result.budget.actionCount,
					warningCount: result.budget.warningCount,
					liveTailHandling: result.budget.liveTailHandling,
					provider: config.providerId,
					modelId: config.modelId,
					...telemetryIdentity,
				});
				context.emitStatusNotice?.("compaction-budget-adjusted", {
					kind: "compaction_budget_emergency",
					reason: "compaction_budget_emergency",
					iteration: context.iteration,
					policyIntent: result.budget.policyIntent,
					actionCount: result.budget.actionCount,
					warningCount: result.budget.warningCount,
				});
			}
		} else {
			context.emitStatusNotice?.(`${noticePrefix}compaction-skipped`, {
				kind: statusReason,
				reason: statusReason,
				phase: "skipped",
				iteration: context.iteration,
				maxInputTokens,
			});
			captureCompactionSkipped(config.telemetry, {
				ulid: telemetryUlid,
				strategy: executedStrategy,
				mode: effectiveMode,
				reason: "no_result",
				tokensBefore: requestInputTokens,
				triggerTokens: requestTriggerTokens,
				maxInputTokens,
				thresholdRatio: COMPACTION_TRIGGER_RATIO,
				durationMs,
				provider: config.providerId,
				modelId: config.modelId,
				...telemetryIdentity,
			});
		}

		return result;
	};
}

export function createCompactionStateAwarePrepareTurn(input: {
	compact?: ContextPipelinePrepareTurn;
	getState?: () => SessionCompactionState | undefined;
	/**
	 * Persist a freshly-computed compaction state. `sourceMessages` are the
	 * exact canonical messages the state's source-prefix hash was computed
	 * over; hosts must validate projection against these rather than a
	 * separately derived transcript, which can legally differ mid-turn and
	 * spuriously reject the write.
	 */
	saveState?: (
		state: SessionCompactionState,
		sourceMessages: CoreCompactionContext["messages"],
	) => void | Promise<void>;
}): ContextPipelinePrepareTurn {
	return async (context) => {
		const existingState = input.getState?.();
		const projectedMessages = existingState
			? projectSessionCompactionState(existingState, context.messages)
			: undefined;
		if (existingState && projectedMessages) {
			// Re-compaction intentionally starts from the compacted projection plus
			// canonical tail. This keeps automatic turns bounded without rebuilding a
			// full-transcript summary every turn; manual `/compact` is the path for a
			// fresh summary from canonical history.
			const result = input.compact
				? await input.compact({
						...context,
						messages: projectedMessages,
						apiMessages: projectedMessages,
					})
				: undefined;
			if (result?.messages) {
				const systemPrompt = result.systemPrompt ?? existingState.system_prompt;
				const nextState = createSessionCompactionState({
					sourceMessages: context.messages,
					compactedMessages: result.messages,
					conversationId: context.conversationId,
					systemPrompt,
				});
				await input.saveState?.(nextState, context.messages);
				return {
					...result,
					...(systemPrompt !== undefined ? { systemPrompt } : {}),
				};
			}
			return {
				messages: projectedMessages,
				...(result?.systemPrompt !== undefined
					? { systemPrompt: result.systemPrompt }
					: existingState.system_prompt !== undefined
						? { systemPrompt: existingState.system_prompt }
						: {}),
			};
		}
		const result = input.compact ? await input.compact(context) : undefined;
		if (result?.messages) {
			const nextState = createSessionCompactionState({
				sourceMessages: context.messages,
				compactedMessages: result.messages,
				conversationId: context.conversationId,
				systemPrompt: result.systemPrompt,
			});
			await input.saveState?.(nextState, context.messages);
		}
		return result;
	};
}
