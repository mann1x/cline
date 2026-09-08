import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reasoningHistoryModeForProvider } from "@cline/llms";
import {
	charsPerToken,
	consumeContextOverflow,
	estimateRequestInputTokens,
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
import {
	COMPACTION_TRIGGER_RATIO,
	createTokenEstimator,
	DEFAULT_MAX_INPUT_TOKENS,
	DEFAULT_TARGET_RATIO,
	getCompactionSummaryMetadata,
	resolveCompactionTriggerTokens,
	resolveEffectiveMaxInputTokens,
	resolveObservedOutputTokens,
	resolvePreserveRecentTokens,
	resolveRecencyBounds,
	seedCalibrationFromTranscript,
} from "./compaction-shared";
import {
	ensurePolykvPool,
	polykvSaysCompact,
	readPolykvCapacity,
	repointPolykvAfterCompaction,
} from "./polykv-session";

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
 * Lower is not automatically better, and the measured floor is higher than this
 * reasoning assumed. Sessions retaining 69,300 and 54,600 tokens finished their
 * task in an hour to an hour and a half; the same task at 36,300 did not finish
 * once across a day of attempts, looping instead on files it had already read.
 * Below roughly half, the summary becomes the thing that loses the detail rather
 * than the window -- so this rung is for windows tight enough that there is no
 * alternative, which {@link LONG_CONVERSATION_MAX_OUTPUT_SHARE} is what decides.
 */
const LONG_CONVERSATION_TARGET_RATIO = 0.33;

/**
 * How small a model's per-turn output cap has to be for the aggressive target
 * to apply.
 *
 * The rule used to be `modelMaxTokens < maxInputTokens`, which was written when
 * `modelMaxTokens` was almost never populated and read as "this model has a
 * genuinely tight cap". Once the cap reached the session it became true of every
 * local model on every long session, so the aggressive target went from never
 * firing to always firing and the conservative branch became dead code. That
 * change is what took the retained context from 54,600 to 36,300, and the
 * completions stopped on the same day.
 *
 * An eighth is the line between a cap that constrains and a cap that is merely
 * smaller: a model that can only answer in 12,000 tokens against a 100,000
 * window really does need the runway more than the history, while one allowed
 * 32,000 of a 110,000 window does not.
 */
const LONG_CONVERSATION_MAX_OUTPUT_SHARE = 0.125;

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
		input.modelMaxTokens <=
			input.maxInputTokens * LONG_CONVERSATION_MAX_OUTPUT_SHARE
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
		// Measured directly, not left over from a subtraction. `requestInputTokens`
		// and `apiMessageTokens` do not share a ratio -- the first splits
		// reasoning out at its own rate, the second does not -- so their
		// difference absorbs the whole disagreement between two estimators and
		// calls it overhead. Measured live: system prompt and tool schemas
		// totalling 57,876 characters, about 12,700 tokens at the ratio the
		// session had calibrated, reported as 53,323 tokens of overhead. That
		// left 56,677 tokens for the transcript instead of ~97,000, dropped the
		// message target to 32,380, and a compaction that had to hit it cut 24
		// messages to 4 -- after which the model, having lost what it was working
		// from, looped. The term also wandered 19,793 -> 53,323 across a single
		// session while the payload it describes barely changed.
		const requestOverheadTokens = estimateRequestInputTokens(
			{
				systemPrompt: context.systemPrompt,
				messages: [],
				tools: context.tools,
			},
			{ reasoningHistory },
		);
		const maxInputTokens =
			resolveEffectiveMaxInputTokens({
				maxInputTokens: context.model.info?.maxInputTokens,
				contextWindow: context.model.info?.contextWindow,
			}) ?? DEFAULT_MAX_INPUT_TOKENS;
		// What this session's own turns have cost, so the room held back for the
		// next one is sized to the model actually running rather than to its
		// declared ceiling. A model that answers in two thousand tokens and one
		// that opens seventeen thousand tokens of thinking want opposite
		// reservations, and the transcript already says which is which.
		const observedOutputTokens = resolveObservedOutputTokens(context.messages);
		const requestTriggerTokens = resolveCompactionTriggerTokens({
			maxInputTokens,
			contextWindow: context.model.info?.contextWindow,
			modelMaxTokens: context.model.info?.maxTokens,
			observedOutputTokens,
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
			sessionId: config.sessionId,
		});
		// Asked in this session's name. The record is process-wide and a request
		// that is not this conversation's says nothing about how full it is:
		// measured on a reporter's own diagnostics, 302 decisions across twelve
		// days had the estimate over the trigger and a foreign count below it,
		// the worst vetoing a 436,717-token estimate with 18,875 observed tokens
		// against a 262,144 window (mann1x/cline#68).
		const observedRequestTokens = lastObservedRequestTokens(config.sessionId);
		const triggerInputTokens = observedRequestTokens ?? requestInputTokens;
		// The request path found no room for a reply on the last turn. That is
		// not a projection that could be miscalibrated -- it is the budget
		// arithmetic having already failed -- so it compacts whatever the ratio
		// above concludes, and covers the case where the two disagree.
		const contextOverflow = consumeContextOverflow(config.sessionId);
		// The one signal here that is not an estimate.
		//
		// On an engine with a KV pool tree, the pool knows what it holds and
		// says how close to full it is; everything else on this path is
		// inference from character counts. It is asked only when the session
		// actually has a pool, it cannot fail the turn, and it can only ever add
		// a reason to compact -- a pool that says there is room does not
		// overrule arithmetic that says there is not.
		await ensurePolykvPool({
			sessionId: config.sessionId,
			providerConfig,
			systemPrompt: context.systemPrompt,
			tools: context.tools,
			logger: config.logger,
		});
		const polykvCapacity = await readPolykvCapacity({
			sessionId: config.sessionId,
			providerConfig,
			expectedTokens: triggerInputTokens,
			logger: config.logger,
		});
		const polykvPressure = polykvSaysCompact(polykvCapacity);
		const shouldCompact =
			contextOverflow !== undefined ||
			triggerInputTokens >= requestTriggerTokens ||
			polykvPressure;
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
			observedOutputTokens,
			contextOverflow,
			polykvCompactionPressure: polykvCapacity?.compaction_pressure,
			polykvKvHeadroomPct: polykvCapacity?.kv_headroom_pct,
			polykvPressure,
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
			// Recovery has to end deterministically, because the provider has
			// already rejected this request: whatever else is attempted, basic
			// compaction is what guarantees an answer without another LLM call
			// succeeding. But it is the *last* resort rather than the first,
			// because of what it costs. Basic compaction drops turns whole, and
			// measured on live runs the model does not survive it — the
			// transcript it wakes up in has the work in it but not the reasons,
			// and every recovery in a session was followed by the run coming
			// apart. So the summarising strategy gets a bounded attempt first,
			// held to exactly the bar basic aims for, and basic runs the moment
			// that attempt throws, declines, or does not shrink the transcript
			// enough. The failure mode this guards against is one wasted
			// summariser call; the one it replaces was a dead run.
			//
			// A custom compactor still goes first — it sees mode
			// "overflow_recovery" and owns its transcript invariants — and is
			// held to the same bar: strictly smaller than the input (the runtime
			// refuses to retry with a request that is not smaller) AND within
			// the recovery token target. A marginal shrink would spend the run's
			// single retry on a request that still cannot fit.
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
				// Basic first, but as the floor rather than the answer: it is
				// local, deterministic and cheap, and having it in hand means the
				// summarising attempt can be judged against what it would
				// actually replace instead of against a target basic itself is
				// not held to.
				const basicResult =
					await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
				const basicTokens = (basicResult?.messages ?? []).reduce(
					(total: number, message) => total + estimateMessageTokens(message),
					0,
				);
				executedStrategy = "basic";
				result = basicResult;

				if (strategy !== "basic") {
					// The summarising attempt: one model call, and the difference
					// between resuming with a transcript that explains itself and
					// one that merely contains the work.
					try {
						const summarised = await runBuiltinStrategy(builtinOptions);
						const summarisedTokens = (summarised?.messages ?? []).reduce(
							(total: number, message) =>
								total + estimateMessageTokens(message),
							0,
						);
						// The bar is whether the retry fits, which is what the
						// recovery target expresses — not whether it beats basic
						// on size. It never will: a summary plus the recent turns
						// is by construction bigger than the recent turns alone,
						// and a rule that preferred the smaller transcript would
						// choose the one that loses the reasons every single
						// time. `basicTokens` is reported when this fails so the
						// two are comparable in the log.
						const acceptable =
							(summarised?.messages?.length ?? 0) > 0 &&
							summarisedTokens < messageInputTokens &&
							summarisedTokens <= messageTargetTokens;
						if (acceptable) {
							result = summarised;
							executedStrategy = strategy;
						} else {
							config.logger?.log(
								`${strategy} compaction did not produce an acceptable overflow-recovery transcript; keeping the basic one`,
								{
									severity: "warn",
									summarisedMessageCount: summarised?.messages?.length ?? 0,
									summarisedTokens,
									basicTokens,
									messageTargetTokens,
								},
							);
						}
					} catch (error) {
						if (isCompactionCancellation(error, context.abortSignal)) {
							throw error;
						}
						config.logger?.log(
							`${strategy} compaction failed during overflow recovery; keeping the basic one`,
							{
								severity: "warn",
								...describeCompactionError(error),
							},
						);
					}
				}
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
			// Compaction is a prompt rewrite, so the pool it was serving is now
			// serving text that no longer exists. Re-rooting forks the shared
			// prefix -- which did not change -- and releases the old subtree; the
			// alternative is a pinned pool nothing will ever match again, which
			// is the leak the engine's own design warns about.
			await repointPolykvAfterCompaction({
				sessionId: config.sessionId,
				providerConfig,
				compactedPrompt: JSON.stringify(result.messages),
				logger: config.logger,
			});
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
