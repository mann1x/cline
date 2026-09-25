import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reasoningHistoryModeForProvider } from "@cline/llms";
import {
	anchoredRequestTokens,
	charsPerToken,
	consumeContextOverflow,
	estimateRequestInputTokens,
	lastObservedRequestTokens,
	lastOutputCap,
	type MessageWithMetadata,
	measureRequestInputChars,
	measureRequestReasoningChars,
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
	type CompactionJournal,
	createCompactionJournal,
} from "./compaction-journal";
import { releaseUnreachableRevisions } from "./compaction-revisions";
import {
	COMPACTION_TRIGGER_RATIO,
	createTokenEstimator,
	DEFAULT_MAX_INPUT_TOKENS,
	dropsTailAtThisCompaction,
	getCompactionSummaryMetadata,
	type MeasureReportedTokens,
	resolveCompactionTriggerTokens,
	resolveEffectiveMaxInputTokens,
	resolveObservedOutputTokens,
	resolveOutputRoomTokens,
	resolvePreserveRecentTokens,
	resolveRecencyBounds,
	seedCalibrationFromTranscript,
} from "./compaction-shared";
import { warnIfWindowBelowMinimum } from "./context-minimum-warning";
import { withCouncilWriterPrompt } from "./council-compaction";
import { DEFAULT_FULL_COMPACTION_PROMPT } from "./full-compaction";
import {
	ensurePolykvPool,
	polykvSaysCompact,
	readPolykvAllocation,
	readPolykvCapacity,
	repointPolykvAfterCompaction,
	resolveGrantedContextWindow,
} from "./polykv-session";
import { DEFAULT_REPLAY_COMPACTION_PROMPT } from "./replay-compaction";

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
	/**
	 * Whether this compaction keeps a recency tail.
	 *
	 * Passed rather than read back off `compaction`, because it is not the
	 * setting: `forceFullFromCompaction` turns it off for this compaction
	 * alone, and a strategy re-deriving it from the config would quietly keep
	 * the tail the caller had already decided to drop.
	 */
	keepRecentMessages: boolean;
	estimateMessageTokens: EstimateMessageTokens;
	/**
	 * What a compaction *reports*, as opposed to what it decides with.
	 *
	 * Measures the request the transcript would produce, so `tokensAfter` is
	 * the size the next request will be and can be compared with the context
	 * meter directly.
	 */
	measureReportedTokens: MeasureReportedTokens;
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
	/**
	 * Where the pre-compaction transcript is kept, so a compaction can be undone.
	 *
	 * Supplied by a caller that wants to reach it — a host offering an "undo
	 * compaction" action, or a test. Omitted, one is created internally and the
	 * transcript is still kept; the journal is never optional, only its
	 * visibility is. See {@link createCompactionJournal}.
	 */
	journal?: CompactionJournal;
}

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

/**
 * Which instruction the summarizer gets, which follows from the cut, not the
 * other way round.
 *
 * The two prompts are not two styles of the same request. With a tail the
 * summary is prepended to messages still in the transcript and has to read as
 * the model's own memory of them; without one it is the entire context and has
 * to read as a state record. Handing either prompt to the other cut produces
 * the failure each was written to remove, so this pairing is not a default a
 * caller can half-override: a custom prompt replaces the one for its own cut
 * and nothing else.
 */
function resolveSummaryPrompt(
	compaction: CoreCompactionConfig | undefined,
	keepRecentMessages: boolean,
): string {
	const prompt = keepRecentMessages
		? compaction?.summaryPrompt?.trim() || DEFAULT_REPLAY_COMPACTION_PROMPT
		: compaction?.fullSummaryPrompt?.trim() || DEFAULT_FULL_COMPACTION_PROMPT;
	// The council splits what this writes at a marker only the writer can
	// place, so it is asked for exactly when a council will read it -- with
	// either prompt, and never otherwise.
	return compaction?.councilEnabled === false
		? prompt
		: withCouncilWriterPrompt(prompt, compaction?.councilWriterPrompt);
}

const BUILTIN_COMPACTION_STRATEGIES = {
	basic: ({ context, estimateMessageTokens, measureReportedTokens, logger }) =>
		runBasicCompaction({
			context,
			estimateMessageTokens,
			measureReportedTokens,
			logger,
		}),
	agentic: ({
		context,
		providerConfig,
		compaction,
		keepRecentMessages,
		estimateMessageTokens,
		measureReportedTokens,
		logger,
	}) =>
		runAgenticCompaction({
			context,
			providerConfig,
			summarizer: compaction?.summarizer,
			keepRecentMessages,
			// Bound, because the port is an object and the ledger wants a plain
			// function. Absent when the host keeps no log, and the ledger then
			// says nothing about files rather than guessing a revision number.
			...(compaction?.revisions
				? {
						spanFor: (filePath: string) =>
							compaction.revisions?.spanFor(filePath),
					}
				: {}),
			// The ledger travels with the revision log: both are what the
			// Checkpoints switch turns off, and the host drops `revisions` when
			// it is off.
			toolLedgerEnabled: compaction?.toolLedgerEnabled,
			summaryPrompt: resolveSummaryPrompt(compaction, keepRecentMessages),
			thinkingSummaryEnabled: compaction?.thinkingSummaryEnabled,
			thinkingSummaryPrompt: compaction?.thinkingSummaryPrompt,
			councilEnabled: compaction?.councilEnabled,
			councilCriticPrompt: compaction?.councilCriticPrompt,
			councilSynthesizerPrompt: compaction?.councilSynthesizerPrompt,
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
			measureReportedTokens,
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

/**
 * Sessions whose tool array has already been written out, keyed by session and
 * tool count. A session that gains or loses a tool -- an MCP server coming up
 * late, a mode switch -- writes a second file rather than going unrecorded.
 */
const dumpedToolManifests = new Set<string>();

/**
 * Write the tool array, as it goes on the wire, to `<tmpdir>/cline-tools.json`,
 * and a per-tool size line to `<tmpdir>/cline-tools.jsonl`.
 *
 * `toolSchemaTokens` says the schemas cost 20,000 tokens of a 65,536-token
 * window; it cannot say *which* tool costs what, and that is the only form of
 * the number anyone can act on. A per-tool breakdown is the difference between
 * "the tools are expensive" and "these four MCP tools are two thirds of it".
 *
 * Reconstructing this from the repo does not work: the built-ins are a third
 * of it, and the rest is whatever MCP servers the host happened to bridge,
 * which exists only in the running session. So it is written from the session,
 * once, and left on disk next to `cline-compaction.jsonl`.
 *
 * The full schemas are the file worth reading, so that one is overwritten
 * rather than accumulated -- a session's worth of MCP schemas is hundreds of
 * kilobytes, and keeping one per session fills a temp directory to no purpose.
 * The sizes, which are what a second session is compared against, append.
 *
 * Best-effort and never throws, for the same reason the diagnostics sink is.
 */
function writeToolManifest(input: {
	sessionId: string | undefined;
	providerId: string;
	modelId: string;
	tools: ContextPipelinePrepareTurnInput["tools"];
	systemPromptTokens: number;
	toolSchemaTokens: number;
}): void {
	const tools = input.tools ?? [];
	const key = `${input.sessionId ?? "no-session"}-${tools.length}`;
	if (dumpedToolManifests.has(key)) {
		return;
	}
	dumpedToolManifests.add(key);
	try {
		const ratio = charsPerToken();
		const rows = tools
			.map((entry) => {
				// `tools` is `unknown[]` on this input -- the pipeline never
				// needs their shape -- so read the three fields that go on the
				// wire and nothing else. The executor, the lifecycle and the
				// timeouts stay on this side of it and are not part of the
				// price.
				const tool = (entry ?? {}) as {
					name?: string;
					description?: string;
					inputSchema?: unknown;
				};
				const wire = {
					name: tool.name ?? "(unnamed)",
					description: tool.description,
					inputSchema: tool.inputSchema,
				};
				const chars = JSON.stringify(wire).length;
				return {
					chars,
					tokens: Math.ceil(chars / ratio),
					descriptionChars: (tool.description ?? "").length,
					schemaChars: JSON.stringify(tool.inputSchema ?? {}).length,
					...wire,
				};
			})
			.sort((left, right) => right.chars - left.chars);
		const header = {
			at: new Date().toISOString(),
			sessionId: input.sessionId,
			providerId: input.providerId,
			modelId: input.modelId,
			toolCount: tools.length,
			charsPerToken: Math.round(ratio * 100) / 100,
			systemPromptTokens: input.systemPromptTokens,
			toolSchemaTokens: input.toolSchemaTokens,
			toolChars: rows.reduce((total, row) => total + row.chars, 0),
		};
		writeFileSync(
			join(tmpdir(), "cline-tools.json"),
			`${JSON.stringify({ ...header, tools: rows }, null, 2)}\n`,
		);
		appendFileSync(
			join(tmpdir(), "cline-tools.jsonl"),
			`${JSON.stringify({
				...header,
				tools: rows.map((row) => ({
					name: row.name,
					tokens: row.tokens,
					chars: row.chars,
					descriptionChars: row.descriptionChars,
					schemaChars: row.schemaChars,
				})),
			})}\n`,
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

/**
 * The share of the *content* a compaction aims to leave behind.
 *
 * Of the content, not of the window. The system prompt, the tool schemas and
 * any MCP tools are paid before a single message exists, and compaction cannot
 * touch one token of them -- measured on pandorum 2026-09-19, 21,000-24,000
 * tokens of a 65,536-token window, about a third of it gone before the
 * conversation starts. (The system prompt is 1,607 of that; the rest is
 * schemas.)
 *
 * Taking the share from the window made the target incoherent once the fixed
 * price grew: a quarter of 65,536 is 16,384, below the price itself, so the
 * transcript budget floored at nothing and every compaction became a full one
 * whatever the tail setting said. Taking it from what is left asks the
 * question that was always meant -- how much conversation may survive -- and
 * has an answer for any window.
 */
export const COMPACTION_TARGET_CONTENT_SHARE = 0.25;

/**
 * How many tokens of transcript a compaction should leave.
 *
 * `maxInputTokens` is the whole window and `requestOverheadTokens` is what is
 * spent before any message; the difference is the only part a compaction can
 * spend, and the share is taken from that.
 */
export function resolveMessageTargetTokens(input: {
	maxInputTokens: number;
	requestOverheadTokens: number;
	share?: number;
}): number {
	const free = input.maxInputTokens - Math.max(0, input.requestOverheadTokens);
	const share = input.share ?? COMPACTION_TARGET_CONTENT_SHARE;
	return Math.max(1, Math.floor(Math.max(0, free) * share));
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
/**
 * The transcript budget, expressed in the units the planner measures in.
 *
 * Two scales meet here and used not to. `shouldCompact` compares
 * `triggerInputTokens` -- the provider's own count of the last request, when
 * there is one -- against the threshold. Everything after it is an estimate:
 * `requestOverheadTokens` and the `estimateMessageTokens` sum the cut is
 * planned with. Subtracting an estimated overhead from a target derived from
 * the real window mixes the two, and the error goes entirely one way when the
 * estimator under-reads.
 *
 * Measured on pandorum 2026-09-19, iteration 10: ollama counted the request at
 * 58,328 and the estimator read it as 36,826. The trigger fired correctly on
 * 58,328 against 57,536. The target was then 57,536 x 0.7 = 40,275, less an
 * estimated overhead of 23,796, giving 16,479 -- against a transcript the
 * planner measured at 13,045. The compaction was asked to shrink something to
 * a size it was already 3,434 tokens under, cut two messages, and the next
 * turn overflowed and forced a real one. Two compactions, one file read
 * between them.
 *
 * Scaling the request target by `estimate / observed` before the subtraction
 * is what makes the two halves comparable. It is a no-op when the estimator
 * agrees with the provider, and a no-op when there is no observation to
 * calibrate against.
 *
 * **One-directional: it may tighten the target and never loosen it.** The
 * correction exists because an under-reading estimator leaves a target the
 * transcript is already past. An over-reading one is the opposite case, and
 * there the plain subtraction is already tight -- inflating it would hand back
 * a budget bigger than the trigger that just fired was asking for, and the
 * compaction would find nothing to do. That is not hypothetical: it is the
 * starved-output-cap path, where a thin cap forces a compaction on a
 * transcript the estimator reads at 2.7x the provider's count, and a
 * two-directional scale suppresses it entirely.
 */
export function resolveMessageTargetOnTriggerScale(input: {
	requestTargetTokens: number;
	requestOverheadTokens: number;
	requestInputTokens: number;
	triggerInputTokens: number | undefined;
}): number {
	const { requestInputTokens: estimate, triggerInputTokens: observed } = input;
	const scaled =
		observed !== undefined &&
		Number.isFinite(observed) &&
		observed > 0 &&
		Number.isFinite(estimate) &&
		estimate > 0
			? Math.min(
					input.requestTargetTokens,
					(input.requestTargetTokens * estimate) / observed,
				)
			: input.requestTargetTokens;
	return Math.max(
		1,
		Math.round(scaled) - Math.max(0, input.requestOverheadTokens),
	);
}

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
/**
 * Sessions currently compacting because their output cap went thin.
 *
 * A latch, not a counter: it arms when the cap recovers above the room a reply
 * needs and fires once on the way back down. Without it a session that can no
 * longer reclaim anything would compact on every turn for the rest of its life
 * -- the failure the overflow report is *consumed* to avoid, arrived at from
 * the other direction.
 *
 * Keyed by session rather than held in the pipeline closure because the closure
 * is rebuilt more often than a session lives.
 */
/**
 * How far the cap's estimate may run past the provider's count before the cap
 * stops being evidence.
 *
 * A quarter, because the estimate is allowed to be a little high by design --
 * it projects the characters added since the last measurement, and erring
 * upward is what keeps a request from overflowing. What it may not do is
 * describe a different request: the faults this catches ran at 1.9x and 2.4x,
 * far outside anything projection accounts for.
 */
const OUTPUT_CAP_ESTIMATE_TOLERANCE = 1.25;

const starvedOutputCapSessions = new Set<string>();

/** Test seam: the latch is process-wide, so a suite has to be able to clear it. */
export function resetStarvedOutputCapLatch(): void {
	starvedOutputCapSessions.clear();
}

/**
 * The turn's model with its window replaced by the granted one, or the turn
 * unchanged when there is no smaller grant to size against.
 *
 * `maxInputTokens` is clamped with it: an input ceiling above the window is a
 * number no request can reach.
 */
function withGrantedWindow(
	turn: ContextPipelinePrepareTurnInput,
	granted: number | undefined,
): ContextPipelinePrepareTurnInput {
	const info = turn.model.info;
	if (granted === undefined || !info) {
		return turn;
	}
	return {
		...turn,
		model: {
			...turn.model,
			info: {
				...info,
				contextWindow: granted,
				...(typeof info.maxInputTokens === "number"
					? { maxInputTokens: Math.min(info.maxInputTokens, granted) }
					: {}),
			},
		},
	};
}

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
	// Always present. Compaction is the one operation here that destroys its own
	// input, and every other thing the model does to state is recoverable: an
	// edit has a revision, a transaction has a base snapshot, a file has the
	// disk. The transcript had nothing.
	const journal = options.journal ?? createCompactionJournal();
	const keepRecentMessagesConfigured =
		userCompaction?.keepRecentMessages !== false;
	const telemetryStrategy: TelemetryCompactionStrategy = userCompaction?.compact
		? "custom"
		: strategy;

	return async (turn) => {
		// Sized against the window the server GRANTED, where one is known and
		// smaller than the configured one. A conversation negotiated down to
		// 160k of 256k holds 160k for its life, and every threshold below --
		// the trigger, the target, the output room -- computed against 256k
		// fires after the real window has already run out.
		const context = withGrantedWindow(
			turn,
			resolveGrantedContextWindow(
				config.sessionId,
				config.providerId,
				turn.model.info?.contextWindow,
			),
		);
		// The tail is a per-compaction decision, not a per-session one: a run
		// that has compacted before is measurably different from one that has
		// not, and the summary is what the next attempt gets to read either way.
		const keepRecentMessages =
			keepRecentMessagesConfigured &&
			!dropsTailAtThisCompaction(
				context.messages,
				userCompaction?.forceFullFromCompaction,
			);
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
		// Asked about this request, not just this provider: the mode is resolved
		// per model from a measured capability, so the provider id alone answers
		// for a different request than the one the gateway is about to send.
		const reasoningHistory = reasoningHistoryModeForProvider(
			config.providerId,
			{
				modelId: providerConfig.modelId ?? config.modelId,
				baseUrl: providerConfig.baseUrl,
				reasoningHistory: providerConfig.reasoningHistory,
				// The gate belongs here too: with the fallback on, a template that
				// drops the field still gets the block -- inlined into content --
				// so those characters do reach the server and have to be counted.
				// Reading the setting in one path and not the other is the
				// estimator/request-path disagreement this whole resolver exists
				// to end.
				reasoningInline: providerConfig.reasoningInline,
			},
		);
		// Anchored, because the request path is. `estimateRequestInputTokens`
		// is characters over one smoothed ratio with nothing holding it to the
		// provider's own count, so its error compounds with the transcript:
		// over the 192-turn pandorum run of 2026-09-19 the ratio of ollama's
		// count to this estimate reset to ~0.95 after every compaction and
		// decayed to 0.58 as tool results accumulated -- the estimate reading
		// 1.7x the truth by the time the trigger fired. `anchoredRequestTokens`
		// prices only the characters added since the last measurement and
		// leaves everything before them as measurement, which is what the
		// gateway has always done. Two paths reading the same evidence.
		const requestChars = measureRequestInputChars(
			{
				systemPrompt: context.systemPrompt,
				messages: context.apiMessages,
				tools: context.tools,
			},
			{ reasoningHistory },
		);
		const requestReasoningChars = Math.min(
			requestChars,
			measureRequestReasoningChars(
				{
					systemPrompt: context.systemPrompt,
					messages: context.apiMessages,
					tools: context.tools,
				},
				{ reasoningHistory },
			),
		);
		const requestInputTokens = anchoredRequestTokens(
			requestChars,
			requestReasoningChars,
			config.sessionId,
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
		// Split, because "overhead" is three different things with three
		// different remedies and only one number was ever reported. Measured on
		// pandorum 2026-09-19 against a 65,536-token window: 21,000-24,000
		// tokens before a single message, of which the system prompt -- prompt
		// template included, it is rendered into it -- is 1,607. The rest is
		// tool schemas, and on a host that bridges VS Code's MCP servers most
		// of that is MCP. A user told only the total has no way to know that
		// turning off a handful of tools is what buys the room back.
		const systemPromptTokens = estimateRequestInputTokens(
			{ systemPrompt: context.systemPrompt, messages: [], tools: [] },
			{ reasoningHistory },
		);
		const requestOverheadTokens = estimateRequestInputTokens(
			{
				systemPrompt: context.systemPrompt,
				messages: [],
				tools: context.tools,
			},
			{ reasoningHistory },
		);
		const toolSchemaTokens = Math.max(
			0,
			requestOverheadTokens - systemPromptTokens,
		);
		// And the half of *that* a user can act on without giving up a tool.
		// MCP schemas arrive from servers the session did not choose -- on a
		// host that bridges VS Code's they are most of the fixed price -- and
		// turning a server off is a different decision from turning a built-in
		// tool off. One number cannot ask for either.
		const mcpTools = (context.tools ?? []).filter(
			(tool) => (tool as { source?: string }).source === "mcp",
		);
		const mcpToolSchemaTokens = mcpTools.length
			? Math.max(
					0,
					estimateRequestInputTokens(
						{
							systemPrompt: context.systemPrompt,
							messages: [],
							tools: mcpTools,
						},
						{ reasoningHistory },
					) - systemPromptTokens,
				)
			: 0;
		const builtinToolSchemaTokens = Math.max(
			0,
			toolSchemaTokens - mcpToolSchemaTokens,
		);
		writeToolManifest({
			sessionId: config.sessionId,
			providerId: config.providerId,
			modelId: config.modelId,
			tools: context.tools,
			systemPromptTokens,
			toolSchemaTokens,
		});
		const maxInputTokens =
			resolveEffectiveMaxInputTokens({
				maxInputTokens: context.model.info?.maxInputTokens,
				contextWindow: context.model.info?.contextWindow,
			}) ?? DEFAULT_MAX_INPUT_TOKENS;
		// Once per session: a window below the fixed price plus the output cap
		// cannot hold one turn. The panel warns where a window is typed; this
		// is the same arithmetic for a host that has no panel.
		warnIfWindowBelowMinimum({
			sessionId: config.sessionId,
			logger: config.logger,
			contextWindow:
				context.model.info?.contextWindow ?? context.model.info?.maxInputTokens,
			systemPromptTokens,
			toolSchemaTokens: builtinToolSchemaTokens,
			mcpToolSchemaTokens,
			...(typeof providerConfig.defaultMaxOutputTokens === "number"
				? { outputCapTokens: providerConfig.defaultMaxOutputTokens }
				: {}),
			...(typeof context.model.info?.maxTokens === "number"
				? { modelMaxOutputTokens: context.model.info.maxTokens }
				: {}),
		});
		// What this session's own turns have cost, so the room held back for the
		// next one is sized to the model actually running rather than to its
		// declared ceiling. A model that answers in two thousand tokens and one
		// that opens seventeen thousand tokens of thinking want opposite
		// reservations, and the transcript already says which is which.
		//
		// Measured from the transcript, not from `metrics.outputTokens`. The bill
		// counts reasoning the condenser may already have replaced, and on
		// pandorum 2026-09-19 one capped think -- billed 30,786, condensed to a
		// 624-character note the same second -- held half a 65,536-token window
		// in reserve for the twelve turns after it, pinning the trigger to its
		// 50% floor while those turns produced 130 and 144 tokens. This is the
		// same estimator the trigger measures the request with, so both halves of
		// the comparison agree about what a message costs.
		const lastAssistantIndex = context.messages.reduce(
			(last: number, message, index) =>
				message.role === "assistant" ? index : last,
			-1,
		);
		const measureContextTokens = (
			message: MessageWithMetadata,
			index: number,
		): number =>
			estimateRequestInputTokens(
				{ systemPrompt: "", messages: [message] },
				{
					// Only the last assistant turn still carries its reasoning
					// under `last`, and a single-message request would otherwise
					// look like the last one every time.
					reasoningHistory:
						reasoningHistory === "all" || index === lastAssistantIndex
							? reasoningHistory
							: "none",
				},
			);
		const observedOutputTokens = resolveObservedOutputTokens(
			context.messages,
			measureContextTokens,
		);
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
		// The session's own row of `GET /kv`: its raw `pressure` is the
		// preferred signal, and it needs no pool to be read.
		const polykvAllocation = await readPolykvAllocation({
			sessionId: config.sessionId,
			providerConfig,
			logger: config.logger,
		});
		const polykvPressure = polykvSaysCompact(
			polykvCapacity,
			providerConfig.polykv?.compactionPressureThreshold,
			polykvAllocation,
		);
		// What the request path actually resolved for the last turn, against what
		// a reply from this session actually costs.
		//
		// The ratio trigger above is a turn behind by construction -- it prefers
		// the provider's counted tokens, which describe the request that already
		// went out. `resolveGatewayOutputCap` takes the smallest of {configured,
		// model max, window - input - reserve}, so inside that gap the cap can
		// fall below what a reply needs while the ratio still reports room.
		// Measured on pandorum 2026-09-18: a session walked 96,000 -> 12,286
		// across 54 messages, and the malformed tool calls sit exactly at the
		// thin end -- a whole-file rewrite cut mid-JSON arrives as a pathless
		// `editor` call, the turn is wasted, and the model tries again. Reported
		// as "this is what trigger v9-agentic to start looping".
		//
		// Only a window-bound cap counts. A cap the user configured, or the
		// model's own ceiling, is a setting rather than a symptom, and compacting
		// the transcript cannot raise either of them.
		const outputRoomTokens = resolveOutputRoomTokens({
			contextWindow: context.model.info?.contextWindow,
			modelMaxTokens: context.model.info?.maxTokens,
			observedOutputTokens,
		});
		const lastCap = lastOutputCap(config.sessionId);
		// A cap is a conclusion drawn from an estimate, and this is the one
		// trigger that acts on a conclusion rather than on a measurement. When
		// the estimate behind it disagrees with what the provider counted for
		// the same request, the cap describes the error and not the context --
		// and compaction cannot fix an estimate. Measured on pandorum session
		// 1789852877349_7bbnd: a turn that retried an empty response reported
		// the sum of both attempts' prompts, that sum anchored the next
		// estimate, and the cap came out at 6,099 for a request the provider
		// counted at 27,029 of a 65,536-token window. The compaction that
		// followed threw away half a transcript at 41% of the window.
		//
		// Absence is not disagreement: a cap carrying no estimate is trusted,
		// which is every cap resolved before this field existed and every one
		// from a path that does not compute it.
		const capEstimate = lastCap?.estimatedInputTokens;
		const positiveNumber = (value: unknown): value is number =>
			typeof value === "number" && Number.isFinite(value) && value > 0;
		const capContradicted =
			positiveNumber(capEstimate) &&
			positiveNumber(triggerInputTokens) &&
			capEstimate > triggerInputTokens * OUTPUT_CAP_ESTIMATE_TOLERANCE;
		const outputCapStarved =
			lastCap?.windowBound === true &&
			typeof lastCap.maxTokens === "number" &&
			lastCap.maxTokens < outputRoomTokens &&
			!capContradicted;
		if (capContradicted) {
			config.logger?.log(
				"Ignored a starved output cap whose estimate the provider's count contradicts",
				{
					severity: "warn",
					capEstimatedInputTokens: capEstimate,
					observedRequestTokens: triggerInputTokens,
					lastOutputCapTokens: lastCap?.maxTokens,
					outputRoomTokens,
				},
			);
		}
		const latchKey = config.sessionId ?? "";
		const outputCapStarvedFires =
			outputCapStarved && !starvedOutputCapSessions.has(latchKey);
		if (outputCapStarved) {
			starvedOutputCapSessions.add(latchKey);
		} else {
			starvedOutputCapSessions.delete(latchKey);
		}
		const shouldCompact =
			contextOverflow !== undefined ||
			triggerInputTokens >= requestTriggerTokens ||
			polykvPressure ||
			outputCapStarvedFires;
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
			// The two halves of it, so a session that is a third spent before it
			// starts says which third.
			systemPromptTokens,
			toolSchemaTokens,
			builtinToolSchemaTokens,
			mcpToolSchemaTokens,
			toolCount: context.tools?.length ?? 0,
			mcpToolCount: mcpTools.length,
			maxInputTokens,
			requestTriggerTokens,
			messageTriggerTokens,
			messageTargetShare: COMPACTION_TARGET_CONTENT_SHARE,
			thresholdRatio: COMPACTION_TRIGGER_RATIO,
			contextWindow: context.model.info?.contextWindow,
			modelMaxTokens: context.model.info?.maxTokens,
			observedOutputTokens,
			contextOverflow,
			polykvCompactionPressure: polykvCapacity?.compaction_pressure,
			polykvRawPressure: polykvAllocation?.pressure ?? polykvCapacity?.pressure,
			grantedContextWindow:
				context.model.info?.contextWindow !== turn.model.info?.contextWindow
					? context.model.info?.contextWindow
					: undefined,
			polykvKvHeadroomPct: polykvCapacity?.kv_headroom_pct,
			polykvPressure,
			outputRoomTokens,
			lastOutputCapTokens: lastCap?.maxTokens,
			lastOutputCapSource: lastCap?.source,
			// The estimate the cap was drawn from, beside the count that either
			// corroborates it or does not. Without both numbers in the record
			// a compaction fired from a bad cap looks identical to one fired
			// from a good one.
			lastOutputCapEstimatedInputTokens: capEstimate,
			capContradicted,
			outputCapStarved,
			outputCapStarvedFires,
			shouldCompact,
			messageCount: context.messages.length,
			apiMessageCount: context.apiMessages.length,
			apiMessagesJsonChars: safeJsonSize(context.apiMessages),
			charsPerToken: Math.round(charsPerToken() * 100) / 100,
			...summarizeToolResults(context.apiMessages),
		};
		config.logger?.debug("Context compaction diagnostics", diagnostics);
		appendCompactionDiagnostics(diagnostics);
		// What the request costs before a message, to whoever is drawing the
		// context bar. Every turn, not only the ones that compact: the fixed
		// price is what the bar is mostly showing on an idle session, and a
		// breakdown that only appeared after the first compaction would be
		// missing exactly when someone is asking why the bar starts a third
		// full. Internal -- it is a measurement, not something to tell the user
		// about in the transcript.
		context.emitStatusNotice?.("context-breakdown", {
			kind: "context_breakdown",
			iteration: context.iteration,
			systemPromptTokens,
			builtinToolSchemaTokens,
			mcpToolSchemaTokens,
			toolCount: context.tools?.length ?? 0,
			mcpToolCount: mcpTools.length,
			requestOverheadTokens,
			maxInputTokens,
		});
		if (effectiveMode === "auto" && !shouldCompact) {
			return undefined;
		}
		let requestTargetTokens: number;
		let messageTargetTokens: number;
		if (effectiveMode === "auto") {
			// A share of the content, not of the window: the fixed price of the
			// system prompt and the tool schemas is not something a compaction
			// can spend, so it is removed before the share is taken rather than
			// subtracted from a target that was computed as though it could be.
			messageTargetTokens = resolveMessageTargetTokens({
				maxInputTokens,
				requestOverheadTokens,
			});
			// Kept under the threshold it just crossed: a target at or above the
			// trigger is a compaction that cannot finish.
			requestTargetTokens = Math.min(
				requestOverheadTokens + messageTargetTokens,
				Math.max(1, requestTriggerTokens - 1),
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
			// Named here or the strategy has no way to report progress: this
			// object is built field by field, and a field left off one of these
			// lists reaches its reader as `undefined` with nothing to say so.
			emitStatusNotice: context.emitStatusNotice,
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

		// What the row prints, measured the way the transcript is actually sent.
		// `estimateMessageTokens` is `JSON.stringify` of the whole message, so
		// summing it counts the reasoning the provider is not sent on an older
		// turn, the metadata that never leaves the host, and the JSON structure
		// itself -- none of which is context. The printed pair then describes a
		// transcript nobody transmits.
		//
		// The transcript only: no system prompt, no tool schemas. These two
		// numbers are consumed as a *ratio* (`getLastApiReqTotalTokens` rescales
		// the provider's own total by `tokensAfter / tokensBefore`, because the
		// two scales differ and substituting an estimate would make the bar
		// re-snap when real usage lands). Overhead is identical on both sides of
		// a compaction, so folding it in would drag that ratio toward 1 and make
		// the bar under-report the shrink. What compaction changes is the
		// transcript, and the ratio has to measure exactly that.
		//
		// Deliberately not used for any cut decision. The budgets, the recency
		// bounds and the no-tail comparison stay on `estimateMessageTokens`:
		// those decide what compaction *does*, and moving them would change the
		// cut, not the caption. This changes only what it *says*.
		const measureReportedTokens = (
			messages: readonly MessageWithMetadata[],
		): number =>
			estimateRequestInputTokens(
				{ systemPrompt: "", messages },
				{ reasoningHistory },
			);

		const builtinOptions = {
			context: compactionContext,
			providerConfig: {
				...providerConfig,
				abortSignal: context.abortSignal,
			},
			compaction: userCompaction,
			keepRecentMessages,
			estimateMessageTokens,
			measureReportedTokens,
			logger: config.logger,
		};
		const sizeOf = (messages: CoreCompactionResult["messages"]): number =>
			messages.reduce(
				(sum: number, message) => sum + estimateMessageTokens(message),
				0,
			);

		/**
		 * Drop the tail when keeping it did not get the transcript under the bar.
		 *
		 * A keep-tail compaction never declines, which made it look like the safe
		 * configuration. It is not: past roughly four times the trigger it stops
		 * producing a transcript that *fits*, and it reports success anyway.
		 * Measured on a 32k window at 4x overshoot, it returned 34,297 tokens —
		 * over the window it was compacting for — while the no-tail cut on the
		 * same transcript returned 17,217. At 128k and 4x the pair is 136,697
		 * against 68,417.
		 *
		 * The reason is structural rather than a tuning miss. The tail is whole
		 * messages, and its floor is one message; a transcript that overshot by
		 * that much did so because its messages are enormous, so the smallest
		 * legal tail is itself bigger than the window. No recency budget can fix
		 * that, because the budget cannot cut a message in half.
		 *
		 * So the escalation is to the cut that has no tail to be defeated by.
		 * It fires only when the result is still above the *trigger* — above the
		 * target merely means the compaction was disappointing, and re-running a
		 * summarizer call for that would spend a request on a transcript that is
		 * going to be fine. Above the trigger means the next turn compacts again
		 * immediately or overflows, which is the failure this exists to catch.
		 *
		 * How the transcript gets four times past a trigger that fires at 0.9 of
		 * the window is the other half of the story, and both known routes are
		 * recorded here: auto-compaction silently disabled by a catalog-derived
		 * window, and a provider reporting a window that is not the real one.
		 * Neither is the user's doing, and neither announces itself.
		 */
		const escalateToNoTailIfStillOversized = async (
			produced: CoreCompactionResult | undefined,
		): Promise<CoreCompactionResult | undefined> => {
			if (
				strategy !== "agentic" ||
				!keepRecentMessages ||
				!produced?.messages?.length ||
				!(Number.isFinite(messageTriggerTokens) && messageTriggerTokens > 0)
			) {
				return produced;
			}
			const producedTokens = sizeOf(produced.messages);
			if (producedTokens <= messageTriggerTokens) {
				return produced;
			}
			config.logger?.log(
				"Compaction kept the tail and stayed over the trigger; retrying without it",
				{
					severity: "warn",
					producedTokens,
					messageTriggerTokens,
					messageInputTokens,
				},
			);
			const noTail = await runAgenticCompaction({
				context: compactionContext,
				providerConfig: builtinOptions.providerConfig,
				summarizer: userCompaction?.summarizer,
				keepRecentMessages: false,
				summaryPrompt: resolveSummaryPrompt(userCompaction, false),
				thinkingSummaryEnabled: userCompaction?.thinkingSummaryEnabled,
				thinkingSummaryPrompt: userCompaction?.thinkingSummaryPrompt,
				// The rescue is reviewed too. Its summary is the one that
				// ships when it wins, and the keep-tail summary it replaces
				// is discarded whether or not a council read it.
				councilEnabled: userCompaction?.councilEnabled,
				councilCriticPrompt: userCompaction?.councilCriticPrompt,
				councilSynthesizerPrompt: userCompaction?.councilSynthesizerPrompt,
				bounds: resolveRecencyBounds({ preserveRecentTokens: 1 }),
				estimateMessageTokens,
				logger: config.logger,
			});
			// Only if it actually did better. A no-tail cut that declines, or
			// that somehow comes back larger, leaves the keep-tail result in
			// place: an oversized transcript beats no transcript.
			if (!noTail?.messages?.length) {
				return produced;
			}
			const noTailTokens = sizeOf(noTail.messages);
			if (noTailTokens >= producedTokens) {
				return produced;
			}
			executedStrategy = "agentic";
			config.logger?.log("Compaction dropped the tail to fit", {
				severity: "warn",
				keptTailTokens: producedTokens,
				noTailTokens,
				messageTriggerTokens,
			});
			context.emitStatusNotice?.("compaction-tail-dropped", {
				kind: "compaction",
				phase: "escalated",
				iteration: context.iteration,
				keptTailTokens: producedTokens,
				noTailTokens,
				messageTriggerTokens,
			});
			return noTail;
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
				result = await escalateToNoTailIfStillOversized(result);
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
			//
			// Not when the configuration says to keep nothing. Basic compaction
			// prunes tool results and keeps every message, so substituting it
			// for a no-tail compaction silently runs the opposite of what was
			// configured -- and a user who turned the tail off did so because
			// keeping it was the problem. Declining is the honest answer, and
			// with the summarizer's own retries in place an agentic decline now
			// means there was genuinely nothing to fold rather than that a model
			// call went wrong.
			if (strategy === "agentic" && !result?.messages) {
				if (!keepRecentMessages) {
					config.logger?.log(
						"Agentic compaction produced no result and the tail is disabled; not substituting basic compaction",
						{
							severity: "warn",
							messageInputTokens,
							messageTargetTokens,
							messageCount: context.messages.length,
						},
					);
				} else {
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
			// Before anything else touches it. The transcript that was just
			// replaced is unrecoverable from this point on unless it is held
			// here, and a bad no-tail compaction is terminal without it.
			journal.record({
				generation:
					result.messages
						.map((message) => getCompactionSummaryMetadata(message))
						.find((metadata) => metadata !== undefined)?.generation ?? 1,
				before: context.messages,
				afterMessageCount: result.messages.length,
				strategy: executedStrategy,
				keptRecentMessages: keepRecentMessages,
			});
			// After the journal, because eviction is the one step here that
			// destroys something, and the transcript it is reasoning about has
			// to be recoverable before anything is released.
			releaseUnreachableRevisions(
				userCompaction?.revisions,
				result.messages,
				config.logger,
			);
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
				// How long the whole thing took. A compaction is several
				// sequential model calls and on a local model it is minutes, not
				// seconds -- the number belongs on the row that says it happened,
				// not only in telemetry nobody reads during a run.
				durationMs,
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
