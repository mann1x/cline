/**
 * AgentRuntime contract types (ported from clinee `@cline/shared`).
 *
 * These are the canonical type definitions consumed by `AgentRuntime`.
 *
 */

import type { TurnFaultRecovery } from "./agents/turn-faults";
import type { GeneratedMedia } from "./llms/media";
import type { ModelInfo } from "./llms/model-info";
import type {
	ToolApprovalRequest,
	ToolApprovalResult,
	ToolPolicy,
} from "./llms/tools";
import type { BasicLogger } from "./logging/logger";
import type { ITelemetryService } from "./services/telemetry";

// =============================================================================
// Lightweight telemetry surface used by AgentRuntime
// =============================================================================

// =============================================================================
// Message parts
// =============================================================================

export interface AgentTextPart {
	type: "text";
	text: string;
}

export interface AgentReasoningPart {
	type: "reasoning";
	text: string;
	redacted?: boolean;
	metadata?: unknown;
}

export interface AgentImagePart {
	type: "image";
	image: string | Uint8Array | ArrayBuffer | URL;
	mediaType?: string;
}

export interface AgentFilePart {
	type: "file";
	path: string;
	content: string;
}

export interface AgentMediaPart {
	type: "media";
	media: GeneratedMedia;
}

export interface AgentToolCallPart {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	input: unknown;
	metadata?: unknown;
	/** Absent for ordinary AgentRuntime-executed tools. */
	execution?: ModelToolExecution;
}

export interface AgentToolResultPart {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	output: unknown;
	isError?: boolean;
	/** Absent for ordinary AgentRuntime-executed tools. */
	execution?: ModelToolExecution;
}

export type ModelToolExecution = "client" | "provider";

/** Observational record for a model tool executed outside AgentRuntime. */
export interface AgentModelToolActivity {
	toolCallId: string;
	toolName: string;
	execution: ModelToolExecution;
	input?: unknown;
	output?: unknown;
	isError?: boolean;
}

export type AgentMessagePart =
	| AgentTextPart
	| AgentReasoningPart
	| AgentImagePart
	| AgentFilePart
	| AgentMediaPart
	| AgentToolCallPart
	| AgentToolResultPart;

// =============================================================================
// Messages and token usage
// =============================================================================

export type AgentMessageRole = "user" | "assistant" | "tool";

export interface AgentTokenUsage {
	inputTokens: number;
	/**
	 * The prompt of the accepted request, when the turn made more than one.
	 *
	 * `inputTokens` is the billed sum across every attempt an empty response
	 * provoked, which is right for money and is not a measurement of the
	 * context. Anything deciding how full the window is -- the token
	 * calibration, the compaction trigger, the output cap, the context meter
	 * -- wants this one, and falls back to `inputTokens` when it is absent,
	 * which is every turn that did not retry.
	 */
	requestInputTokens?: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Provider-reported hidden reasoning tokens, when available. */
	reasoningTokenCount?: number;
}

/**
 * What one provider request cost in time, next to what it cost in tokens.
 *
 * Two independent sources, and the difference between them is the point.
 * `requestMs` and `firstTokenMs` are measured by Cline around its own stream,
 * so every provider has them. Everything below `engine` is the engine's own
 * accounting, reported by the two that publish it -- Ollama on its final
 * `done` chunk, llama.cpp in the `timings` object on its last SSE frame -- and
 * is absent everywhere else rather than guessed at.
 *
 * Keeping both is what makes either readable: a request whose `requestMs` far
 * exceeds `engineTotalMs` spent the difference queueing, and one whose
 * `promptMs` dwarfs `generateMs` is re-reading a prompt the cache should have
 * held. Neither question can be asked of a single number.
 *
 * Durations are milliseconds throughout. Ollama reports nanoseconds and
 * llama.cpp milliseconds; both are converted at the edge so nothing
 * downstream has to know which engine answered.
 */
export interface RequestTimings {
	/** Wall time Cline measured for the request, start of stream to end. */
	requestMs?: number;
	/** Time from the start of the request to its first content of any kind. */
	firstTokenMs?: number;
	/** Which engine reported the fields below; absent when only Cline timed it. */
	engine?: "ollama" | "llamacpp";
	/** Time spent loading the model before any work began (Ollama). */
	loadMs?: number;
	/** Prompt evaluation. */
	promptTokens?: number;
	promptMs?: number;
	promptPerSecond?: number;
	/** Generation. */
	generateTokens?: number;
	generateMs?: number;
	generatePerSecond?: number;
	/** The engine's own total, which includes admission Cline cannot see. */
	engineTotalMs?: number;
	/** Prompt tokens served from the engine's KV cache instead of recomputed. */
	cachedTokens?: number;
	/** Speculative decoding: tokens drafted, and how many survived (llama.cpp). */
	draftTokens?: number;
	draftAcceptedTokens?: number;
}

/**
 * Canonical `AgentUsage` shape for the new runtime.
 *
 * This supersedes the legacy `AgentUsage` (now `LegacyAgentUsage` in
 * `./agents/types`). The old, host-facing shape is
 * retained for `AgentResult`/`AgentUsageEvent` consumers via the facade.
 */
export interface AgentUsage extends AgentTokenUsage {
	totalCost?: number;
}

export interface AgentMessage {
	id: string;
	role: AgentMessageRole;
	content: AgentMessagePart[];
	createdAt: number;
	metadata?: Record<string, unknown>;
	modelInfo?: {
		id: string;
		provider: string;
		family?: string;
	};
	metrics?: AgentTokenUsage & {
		cost?: number;
		/**
		 * What the request that produced this message cost in time. Carried on
		 * the message rather than only on the live event so a task reopened
		 * from history shows the same numbers it showed while it ran.
		 */
		timings?: RequestTimings;
	};
}

// =============================================================================
// Runtime state
// =============================================================================

export type AgentRole = string;

export type AgentRunStatus =
	| "idle"
	| "running"
	| "completed"
	| "aborted"
	| "failed";

export interface AgentRuntimeStateSnapshot {
	agentId: string;
	agentRole?: AgentRole;
	parentAgentId?: string | null;
	conversationId?: string;
	runId?: string;
	status: AgentRunStatus;
	iteration: number;
	messages: readonly AgentMessage[];
	pendingToolCalls: readonly string[];
	usage: AgentUsage;
	lastError?: string;
	/** Classification of `lastError` when it came from a provider stream. */
	lastErrorClass?: ProviderErrorClass;
}

// =============================================================================
// Tools
// =============================================================================

export interface AgentToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/**
	 * Where the tool came from, when it is not one the agent builds itself.
	 *
	 * Read for the fixed-price breakdown the context bar shows. Tool schemas
	 * are most of what a request costs before a single message -- 21,000 to
	 * 24,000 tokens of a 65,536-token window, measured on pandorum -- and on a
	 * host that bridges an editor's MCP servers most of that is MCP rather than
	 * anything the agent chose. Told only a total, nobody can see that turning
	 * off a server is what buys the room back, so the two are counted apart.
	 *
	 * The name cannot answer this: `createMcpTools` sanitizes and hashes long
	 * names, so `serverName__toolName` is not recoverable from the wire.
	 */
	source?: "mcp";
	/**
	 * The tool only reads: it changes no file and no state outside the
	 * session. Unset means it may write.
	 *
	 * Read by xOllama's council (mail #372, D2): researchers and critics are
	 * offered only the tools marked read-only, and only the synthesizer
	 * writes. An MCP tool takes it from the server's `readOnlyHint`.
	 */
	readOnly?: boolean;
	lifecycle?: {
		/**
		 * Whether a successful call to this tool completes the current run.
		 */
		completesRun?: boolean;
		/**
		 * This tool bounds its own concurrency, so the runtime's parallel
		 * tool-call pool must not bound it a second time.
		 *
		 * The pool is a cap on what the disk, the terminal and the endpoint are
		 * asked to do at once, and for a batch of reads it is the right one. A
		 * delegation tool is different: how many of its calls may run together
		 * is decided by the agent-node placement queue -- which holds a node
		 * with a capacity of 1 to 1 -- and, past that, by the engine's own
		 * admission gate. The pool of eight on top made both decorative.
		 * Measured on pandorum 2026-09-23: the lead asked for forty agents in
		 * one message across two uncapped PolyKV nodes, and they ran eight
		 * wide, each starting at the millisecond another one finished.
		 *
		 * Only for a tool that genuinely gates itself. Set on one that does not
		 * and a model that emits forty calls opens forty at once.
		 */
		boundsOwnConcurrency?: boolean;
	};
}

export interface AgentToolResult<TOutput = unknown> {
	output: TOutput;
	isError?: boolean;
	metadata?: Record<string, unknown>;
}

export interface AgentToolContext {
	sessionId?: string;
	agentId: string;
	conversationId?: string;
	runId?: string;
	iteration: number;
	toolCallId?: string;
	signal?: AbortSignal;
	metadata?: Record<string, unknown>;
	snapshot?: AgentRuntimeStateSnapshot;
	emitUpdate?: (update: unknown) => void;
}

export interface AgentTool<TInput = unknown, TOutput = unknown>
	extends AgentToolDefinition {
	timeoutMs?: number;
	retryable?: boolean;
	maxRetries?: number;
	execute: (
		input: TInput,
		context: AgentToolContext,
	) => Promise<TOutput> | TOutput;
}

// =============================================================================
// Model adapter contract
// =============================================================================

export interface AgentModelRequest {
	systemPrompt?: string;
	messages: readonly AgentMessage[];
	tools: readonly AgentToolDefinition[];
	/** Provider-executed tools enabled for this model request. */
	modelTools?: readonly import("./llms/model-tools").ModelTool[];
	signal?: AbortSignal;
	options?: Record<string, unknown>;
}

export interface AgentRuntimePrepareTurnContext {
	agentId: string;
	conversationId?: string;
	parentAgentId?: string | null;
	iteration: number;
	messages: readonly AgentMessage[];
	systemPrompt?: string;
	tools: readonly AgentToolDefinition[];
	model: {
		id?: string;
		provider?: string;
		info?: ModelInfo;
	};
	signal?: AbortSignal;
	/**
	 * Set when the previous model request was rejected as exceeding the
	 * model's context window; asks the prepare-turn pipeline to force a
	 * compaction rather than trust its token estimates.
	 */
	overflowRecovery?: boolean;
	emitStatusNotice?: (
		message: string,
		metadata?: Record<string, unknown>,
	) => void;
}

export interface AgentRuntimePrepareTurnResult {
	messages?: readonly AgentMessage[];
	systemPrompt?: string;
}

export type AgentModelFinishReason =
	| "stop"
	| "tool-calls"
	| "max-tokens"
	| "aborted"
	| "error";

/**
 * Coarse classification of a provider error, derived from the raw provider
 * error object before it is flattened into a display string. Shared by the
 * runtime's recovery policy and telemetry (`error_class`). Extend with new
 * classes (rate_limit, billing, ...) as consumers need them.
 *
 * `auth`: the provider rejected the request's credentials (HTTP 401/403) —
 * hosts should point the user at their API key configuration.
 */
export interface AgentImageToDescribe {
	/** Base64 image data, as carried on an `AgentMessagePart` of type `image`. */
	image: string;
	mediaType?: string;
	/** Text that accompanied the image, e.g. the tool's console output. */
	context?: string;
}

export type ProviderErrorClass =
	| "context_window_exceeded"
	/**
	 * The model refused an image in the request. Told apart from `unknown`
	 * because it is recoverable without the user: the images can be dropped and
	 * the turn resent, where an unknown failure has nowhere to go.
	 */
	| "image_input_unsupported"
	/**
	 * The provider could not parse a tool call the model emitted. Told apart
	 * from `unknown` for the same reason as the image case: the model can be
	 * asked to send the call again, where an unknown failure has nowhere to go.
	 *
	 * Note what this is not. The payload is malformed, and repairing it is the
	 * one response that must never be taken — a call truncated mid-value would
	 * be "repaired" into writing the fragment, silently, over the file it
	 * names. Asking for the whole call again is the only safe recovery.
	 */
	| "tool_call_unparsable"
	/** The provider rejected the credentials. */
	| "auth"
	/**
	 * The provider declined to start this request for throughput or capacity
	 * reasons, and said when to come back (`Retry-After`).
	 *
	 * Told apart from `unknown` because it is not a failure at all on a server
	 * that admits work deliberately: opencoti runs its KV admission gate
	 * `enforced` by default, so a busy pool answers `429` as a matter of course.
	 * Folded into `unknown` it was indistinguishable from a bug, and the caller
	 * that should have waited the stated interval gave up instead.
	 */
	| "rate_limited"
	/**
	 * A KV pool operation was refused because the prefix does not match what the
	 * pool holds.
	 *
	 * Not retryable, and not the turn's fault: the request is fine and the pool
	 * is wrong, so the recovery is to rebuild the pool and carry on unpooled
	 * meanwhile — never to fail the turn.
	 */
	| "pool_contract_violation"
	/**
	 * The engine evicted this request's sequence to keep the others in its
	 * batch alive: its KV could not fit another token (opencoti's partial
	 * eviction, `error_kind: "evicted_kv_full"`, `kv_observable_v1`).
	 *
	 * Not the request's fault and not an overflow of its own window -- the
	 * victims of swarm 0926 held 20-31k of 64k. The turn is sent again like a
	 * refusal, and the eviction is reported as the engine bug it is: no
	 * session is ever meant to be evicted.
	 */
	| "kv_evicted"
	| "unknown";

/**
 * Why an engine rejected a tool call the model emitted, when it says so.
 *
 * opencoti sends it with the rejection (`type: "tool_call_rejected"`), so a
 * retry can tell the model what it got wrong instead of just "it did not
 * parse". The measured case is `swallowed_key`: a long `editor` argument
 * closed with a backtick from the code inside it, so the parser read the next
 * argument (`key`) as part of the value.
 */
export interface ToolCallRejection {
	/** The engine's rule; `swallowed_key` today. Unknown reasons read as generic. */
	reason: string;
	/** The argument the malformed value ran into. */
	key?: string;
	/** The tool the rejected call was for. */
	tool?: string;
}

export type AgentModelEvent =
	| { type: "text-delta"; text: string }
	| { type: "media"; media: GeneratedMedia }
	| {
			type: "reasoning-delta";
			text: string;
			redacted?: boolean;
			metadata?: unknown;
	  }
	| {
			type: "tool-call-delta";
			index?: number;
			toolCallId?: string;
			toolName?: string;
			inputText?: string;
			input?: unknown;
			metadata?: unknown;
			/** Set when execution is owned by AI SDK or the model provider. */
			execution?: ModelToolExecution;
	  }
	| {
			type: "tool-result";
			toolCallId: string;
			/**
			 * Declared model tools carry a ModelToolName; provider-executed tools
			 * (e.g. the Claude Code CLI's own tools) carry arbitrary names.
			 */
			toolName: string;
			input?: unknown;
			output: unknown;
			isError?: boolean;
			execution: ModelToolExecution;
	  }
	| {
			type: "usage";
			usage: Partial<AgentUsage>;
			/** What this one request cost in time. See `RequestTimings`. */
			timings?: RequestTimings;
	  }
	| {
			type: "finish";
			reason: AgentModelFinishReason;
			error?: string;
			errorClass?: ProviderErrorClass;
			/** What the engine said was wrong with a rejected tool call. */
			toolCallRejection?: ToolCallRejection;
			/**
			 * The model layer already recorded `sdk.error` telemetry for this
			 * failure at its own error boundary. `error` is a flattened string,
			 * so this bit carries reporting ownership across the boundary: the
			 * agent loop skips re-reporting when it is set, and still reports
			 * failures from model implementations that do not record their own
			 * telemetry.
			 */
			errorReported?: boolean;
	  };

export interface AgentModel {
	stream: (
		request: AgentModelRequest,
	) => AsyncIterable<AgentModelEvent> | Promise<AsyncIterable<AgentModelEvent>>;
}

// =============================================================================
// Hook contexts
// =============================================================================

export interface AgentBeforeModelContext {
	snapshot: AgentRuntimeStateSnapshot;
	request: AgentModelRequest;
}

export interface AgentStopControl {
	stop?: boolean;
	reason?: string;
}

export interface AgentBeforeModelResult {
	stop?: boolean;
	reason?: string;
	messages?: readonly AgentMessage[];
	tools?: readonly AgentToolDefinition[];
	options?: Record<string, unknown>;
}

export interface AgentAfterModelContext {
	snapshot: AgentRuntimeStateSnapshot;
	assistantMessage: AgentMessage;
	finishReason: AgentModelFinishReason;
}

export interface AgentBeforeToolContext {
	snapshot: AgentRuntimeStateSnapshot;
	tool: AgentTool;
	toolCall: AgentToolCallPart;
	input: unknown;
}

export interface AgentBeforeToolResult {
	skip?: boolean;
	stop?: boolean;
	reason?: string;
	input?: unknown;
	policy?: ToolPolicy;
	/**
	 * Text to inject into the conversation as hook context (e.g. a hook's
	 * `contextModification`). Collected across hooks and appended after this
	 * iteration's tool results as a `<hook_context>` user message, so the
	 * model sees it on the next request.
	 */
	appendContext?: string;
}

export interface AgentAfterToolContext {
	snapshot: AgentRuntimeStateSnapshot;
	tool: AgentTool;
	toolCall: AgentToolCallPart;
	input: unknown;
	result: AgentToolResult;
	startedAt: Date;
	endedAt: Date;
	durationMs: number;
}

export interface AgentAfterToolResult {
	stop?: boolean;
	reason?: string;
	result?: AgentToolResult;
	/**
	 * Text to inject into the conversation as hook context (e.g. a hook's
	 * `contextModification`). Collected across hooks and appended after this
	 * iteration's tool results as a `<hook_context>` user message, so the
	 * model sees it on the next request.
	 */
	appendContext?: string;
}

export interface AgentRunLifecycleContext {
	snapshot: AgentRuntimeStateSnapshot;
}

// =============================================================================
// Runtime hook bag
// =============================================================================

/**
 * Everything a turn discarded at the output cap was carrying.
 *
 * Not just the reasoning. The answer it had begun writing and the call it had
 * begun making are the most concrete statements of what it decided, and both
 * went into the bin with the rest.
 */
export interface DiscardedTurnInput {
	reasoning: string;
	/** The reply as far as it got before the cap cut it off. */
	text?: string;
	/**
	 * Whether the cap that cut this turn off was the context window.
	 *
	 * The distinction decides how much may be spent salvaging it. A turn cut off
	 * by `num_predict` with two thirds of the window free can afford the same
	 * two passes a compaction makes; one cut off because there was no room left
	 * to answer in cannot, and gets the cheap single pass.
	 */
	windowBound?: boolean;
}

/** What a host makes of a discarded turn. Both halves are optional. */
export interface DiscardedTurnCondensation {
	/** Where the turn had got to, in its own voice. */
	note?: string;
	/** What the reasoning learned, which the note does not carry. */
	retrospective?: string;
}

/**
 * 7-callback hook bag consumed by `AgentRuntime`.
 */
export interface AgentRuntimeHooks {
	beforeRun?: (
		context: AgentRunLifecycleContext,
	) => AgentStopControl | undefined | Promise<AgentStopControl | undefined>;
	afterRun?: (
		context: AgentRunLifecycleContext & { result: AgentRunResult },
	) => void | Promise<void>;
	beforeModel?: (
		context: AgentBeforeModelContext,
	) =>
		| AgentBeforeModelResult
		| undefined
		| Promise<AgentBeforeModelResult | undefined>;
	afterModel?: (
		context: AgentAfterModelContext,
	) => AgentStopControl | undefined | Promise<AgentStopControl | undefined>;
	beforeTool?: (
		context: AgentBeforeToolContext,
	) =>
		| AgentBeforeToolResult
		| undefined
		| Promise<AgentBeforeToolResult | undefined>;
	afterTool?: (
		context: AgentAfterToolContext,
	) =>
		| AgentAfterToolResult
		| undefined
		| Promise<AgentAfterToolResult | undefined>;
	onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

// =============================================================================
// Plugins
// =============================================================================

export interface AgentRuntimePluginContext {
	agentId: string;
	agentRole?: AgentRole;
	systemPrompt?: string;
}

export interface AgentRuntimePluginSetup {
	// biome-ignore lint/suspicious/noExplicitAny: tool input/output types vary per tool
	tools?: readonly AgentTool<any, any>[];
	hooks?: Partial<AgentRuntimeHooks>;
}

export interface AgentRuntimePlugin {
	name: string;
	setup?: (
		context: AgentRuntimePluginContext,
	) =>
		| AgentRuntimePluginSetup
		| undefined
		| Promise<AgentRuntimePluginSetup | undefined>;
}

// =============================================================================
// Runtime config
// =============================================================================

export interface AgentRuntimeConfig {
	/**
	 * Stable end-user distinct ID used for provider and observability metadata.
	 * This is intentionally separate from the host-owned session id.
	 */
	distinctId?: string;
	/** Calling client surface, for example `cline-vscode` or `cline-sdk`. */
	clientName?: string;
	/** Calling client version, such as the VS Code extension version. */
	clientVersion?: string;
	/** Version of the Cline Core SDK executing the runtime. */
	clineCoreVersion?: string;
	/**
	 * Core/hub runtime session identifier.
	 *
	 * The host-owned lifecycle id for the task/session containing this runtime.
	 * It is stable for hub subscriptions, session persistence, abort/stop
	 * commands, and approval routing. It can differ from `conversationId`, which
	 * tracks the agent transcript.
	 */
	sessionId?: string;
	agentId?: string;
	/**
	 * Agent conversation/transcript identifier.
	 *
	 * Used by the stateless agent loop, tools, hooks, telemetry, and model
	 * history correlation. This id follows the current conversation store and
	 * should not be used as the hub/session routing key.
	 */
	conversationId?: string;
	parentAgentId?: string | null;
	agentRole?: AgentRole;
	systemPrompt?: string;
	messageModelInfo?: AgentMessage["modelInfo"];
	model: AgentModel;
	modelOptions?: Record<string, unknown>;
	/** Provider-executed tools, separate from locally executed AgentTools. */
	modelTools?: readonly import("./llms/model-tools").ModelTool[];
	// biome-ignore lint/suspicious/noExplicitAny: tool input/output types vary per tool
	tools?: readonly AgentTool<any, any>[];
	hooks?: Partial<AgentRuntimeHooks>;
	plugins?: readonly AgentRuntimePlugin[];
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	initialMessages?: readonly AgentMessage[];
	maxIterations?: number;
	completionPolicy?: {
		requireCompletionTool?: boolean;
		completionGuard?: () => string | undefined;
		/**
		 * The awaitable boundary hook. Fires on both ways a run can end, unlike
		 * `completionGuard`; see the full note on the runtime config type.
		 *
		 * `forced` says the run is ending because the no-tool-call nudges ran
		 * out, not because the model chose to stop. Silence from a model that
		 * was cut off mid-work is not an account of its work, and a guard that
		 * cannot tell the two apart reads it as one.
		 */
		onCompletionAttempt?: (context: {
			text?: string;
			forced?: boolean;
		}) => Promise<string | undefined>;
		/**
		 * A clause naming work the host knows has not started, appended to the
		 * no-tool-call nudge.
		 *
		 * The generic nudge says "you called nothing". That is true and not
		 * enough when a protocol is engaged: measured on pandorum session
		 * 1789230811792_qnyfa, the change protocol opened TX-01, the model spent
		 * three turns describing edits and calling nothing, and both nudges told
		 * it only that it had called nothing -- never that a transaction was
		 * open and empty. It invented a precedence rule, decided the protocol
		 * replaced its other instructions, and the run ended with the file
		 * untouched.
		 *
		 * Returns undefined when there is nothing to say, which is the usual
		 * case. The host owns the state this reads; the runtime only appends it.
		 */
		describeUnstartedWork?: () =>
			| Promise<string | undefined>
			| string
			| undefined;
		/**
		 * How many consecutive turns that produce no tool calls may be nudged to
		 * continue before the run is allowed to end. Zero (the default) keeps the
		 * standard contract: a turn with no tool calls completes the run.
		 *
		 * Set this for models that announce work instead of doing it — "I will use
		 * multiple editor calls to fix this", then stop — which ends a task with
		 * none of it done. The counter resets on any turn that does call tools, so
		 * the bound is on consecutive silence rather than on the run.
		 */
		maxNoToolCallNudges?: number;
		/**
		 * Whether a turn that called nothing is nudged even when nothing
		 * suggests unfinished work. Defaults to true.
		 *
		 * True is the coding reading, and the right default: in a task session a
		 * turn that called nothing is nearly always one that should have acted,
		 * a needless nudge costs a turn, and a missed one costs the task.
		 *
		 * False makes the nudge require evidence -- work the host knows is
		 * unstarted, a run that has already called something, or a turn ending
		 * on a promise rather than an answer. A session that is largely
		 * conversation wants this: asked which capital belongs to which country,
		 * a model answers and stops, and the nudge tells it the run "was about
		 * to end" and not to describe what it is going to do without doing it --
		 * which is the wrong description of what happened, and pushes toward
		 * calling something to avoid being asked again.
		 */
		strongNudges?: boolean;
		/**
		 * How many consecutive turns may produce no tool call before the run is
		 * nudged that thinking has stopped paying. Defaults to 3; zero disables
		 * the nudge entirely.
		 *
		 * Distinct from `maxNoToolCallNudges`, which counts nudges sent and so
		 * cannot see a run whose silent turns are answered by something else --
		 * a completion-boundary message, a transaction result, a reminder. This
		 * counts the turns themselves, resets only on a turn that calls a tool,
		 * and is spent at most once per run. It never ends the run: a false
		 * positive costs one message on a run that was working.
		 */
		noToolCallTurnStreakLimit?: number;
		/**
		 * How many consecutive turns cut off at the per-turn output cap are
		 * retried before the run ends. Defaults to 2; zero restores the older
		 * behaviour where a truncated turn ends the run.
		 *
		 * A turn that hits the cap with no tool calls in it produced nothing the
		 * run can use, and the model cannot see that it was cut off. Retrying
		 * discards the truncated reply — it never enters the history — and tells
		 * the model what happened, so the retry differs instead of reproducing
		 * the same overlong output. The counter resets on any turn that finishes.
		 */
		maxTruncatedTurnRetries?: number;
	};
	/**
	 * Repetition guard on the model's reasoning channel; see
	 * `ReasoningLoopDetectionConfig`. On by default, `false` disables it.
	 */
	reasoningLoopDetection?:
		| false
		| Partial<import("./agents/types").ReasoningLoopDetectionConfig>;
	/**
	 * Asked before the reasoning-loop streak ends the run.
	 *
	 * The mistake limit has had this seam since it was written; this guard has
	 * not, and it is the other terminal one a host might want to answer with
	 * something other than a stop. Absent, or answered with `stop`, the run ends
	 * exactly as it did before.
	 */
	onReasoningLoopLimitReached?: (
		context: import("./agents/types").ReasoningLoopLimitContext,
	) =>
		| Promise<import("./agents/types").TerminalGuardDecision>
		| import("./agents/types").TerminalGuardDecision;
	/**
	 * Verbatim self-repetition nudge on the model's reasoning channel; see
	 * `ReasoningRepetitionConfig`. On by default, `false` disables it.
	 */
	reasoningRepetition?:
		| false
		| Partial<import("./agents/types").ReasoningRepetitionConfig>;
	/**
	 * How a batch of tool calls from one assistant message is run.
	 *
	 * `"sequential"` is one at a time. Anything else is bounded by
	 * `maxParallelToolCalls`, which is the field that carries the number --
	 * this one only says whether there is a batch at all.
	 */
	toolExecution?: "sequential" | "parallel";
	/**
	 * How many of a batch may be in flight at once. Defaults to
	 * `DEFAULT_MAX_PARALLEL_TOOL_CALLS`; `1` is sequential, and an explicit
	 * `toolExecution: "sequential"` means the same thing and wins.
	 *
	 * Results are appended in the order the model asked for them however this
	 * resolves, so a bound changes when work happens and never what the
	 * transcript says happened.
	 */
	maxParallelToolCalls?: number;
	toolPolicies?: Record<string, ToolPolicy>;
	toolContextMetadata?: Record<string, unknown>;
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/**
	 * Optional host-owned request projection hook invoked before each model call.
	 *
	 * Returned messages affect only the provider request for the current call.
	 * They do not replace the canonical runtime transcript, are not persisted as
	 * session history, and are not reflected in AgentRunResult.messages.
	 */
	prepareTurn?: (
		context: AgentRuntimePrepareTurnContext,
	) =>
		| Promise<AgentRuntimePrepareTurnResult | undefined>
		| AgentRuntimePrepareTurnResult
		| undefined;
	/**
	 * Optional last look at reasoning that is about to be discarded.
	 *
	 * A turn cut off at the output cap with no tool call is thrown away whole --
	 * the reply was never finished, and resending it would spend the same budget
	 * on output already abandoned. But that turn's reasoning is the only one
	 * that reliably ends at the model's thinking budget, and it is exactly the
	 * work the retry is about to redo from nothing.
	 *
	 * Called with that reasoning before it is dropped. Whatever comes back is
	 * given to the model as a note it left itself; the discarded message still
	 * never re-enters the transcript. Returning nothing discards as before.
	 */
	condenseDiscardedReasoning?: (
		input: DiscardedTurnInput,
	) =>
		| Promise<DiscardedTurnCondensation | undefined>
		| DiscardedTurnCondensation
		| undefined;
	/**
	 * Wait out a turn that failed on a transport fault or an admission refusal,
	 * and say whether to send it again. See `TurnFaultRecovery`.
	 *
	 * Absent, such a turn fails the run as any other provider error does. A
	 * delegated agent is given one: it is meant to finish its job, and a server
	 * restart or a busy pool is not the job failing.
	 */
	recoverTurnFault?: TurnFaultRecovery;
	// Optional host callback used by interactive sessions to inject a queued
	// user steering message between agent loop iterations, before the next
	// model request.
	/**
	 * Called once when a model refuses a request for carrying an image, after
	 * the runtime has dropped the images and before it retries. Lets the host
	 * stop attaching them for the rest of the session, so the refusal costs one
	 * turn rather than one per tool call.
	 */
	onImageInputUnsupported?: () => void;
	/**
	 * Turns images into text using a second model, for a primary model that
	 * cannot read them (or reads them poorly).
	 *
	 * Returns one entry per image, in order; `undefined` for any the second
	 * model could not describe, so the caller can decide what to do with that
	 * one rather than losing the whole batch.
	 */
	describeImages?: (
		images: readonly AgentImageToDescribe[],
	) => Promise<readonly (string | undefined)[]>;
	/**
	 * Describe images on every turn rather than only after a refusal. Set when
	 * the user has configured a separate vision model: the point of doing so is
	 * that the primary model never sees the image.
	 */
	alwaysDescribeImages?: boolean;
	/**
	 * Whether the primary model can read an image itself.
	 *
	 * Only consulted when a description could not be produced: it decides
	 * between leaving the image and replacing it with a note.
	 */
	modelSupportsImages?: boolean;
	consumePendingUserMessage?: () =>
		| string
		| undefined
		| Promise<string | undefined>;
}

// =============================================================================
// Runtime event union
// =============================================================================

export type AgentRuntimeEvent =
	| {
			type: "run-started";
			snapshot: AgentRuntimeStateSnapshot;
	  }
	| {
			type: "message-added";
			snapshot: AgentRuntimeStateSnapshot;
			message: AgentMessage;
	  }
	| {
			type: "turn-started";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
	  }
	| {
			type: "assistant-text-delta";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			text: string;
			accumulatedText: string;
	  }
	| {
			type: "assistant-reasoning-delta";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			text: string;
			accumulatedText: string;
			redacted?: boolean;
			metadata?: unknown;
	  }
	| {
			type: "assistant-media";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			media: GeneratedMedia;
	  }
	| {
			type: "assistant-message";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			message: AgentMessage;
			finishReason: AgentModelFinishReason;
	  }
	| {
			type: "tool-started";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			toolCall: AgentToolCallPart;
	  }
	| {
			type: "tool-updated";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			toolCall: AgentToolCallPart;
			update: unknown;
	  }
	| {
			type: "tool-finished";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			toolCall: AgentToolCallPart;
			message: AgentMessage;
	  }
	| {
			type: "usage-updated";
			snapshot: AgentRuntimeStateSnapshot;
			usage: AgentUsage;
			/**
			 * The one request whose usage this update carries, timed.
			 *
			 * Separate from `usage` because `usage` is the running total and
			 * these are not addable: two requests do not have a duration
			 * between them, and a rate is not the sum of two rates. Each
			 * update describes exactly one request, so this replaces rather
			 * than accumulates.
			 */
			timings?: RequestTimings;
	  }
	| {
			type: "turn-finished";
			snapshot: AgentRuntimeStateSnapshot;
			iteration: number;
			toolCallCount: number;
	  }
	| {
			type: "status-notice";
			snapshot: AgentRuntimeStateSnapshot;
			message: string;
			metadata?: Record<string, unknown>;
	  }
	| {
			type: "run-finished";
			snapshot: AgentRuntimeStateSnapshot;
			result: AgentRunResult;
	  }
	| {
			type: "run-failed";
			snapshot: AgentRuntimeStateSnapshot;
			error: Error;
			/** Classification of the provider error that failed the run. */
			errorClass?: ProviderErrorClass;
	  };

// =============================================================================
// Run result
// =============================================================================

export interface AgentRunResult {
	agentId: string;
	agentRole?: AgentRole;
	runId: string;
	status: Exclude<AgentRunStatus, "idle" | "running">;
	iterations: number;
	outputText: string;
	messages: readonly AgentMessage[];
	usage: AgentUsage;
	error?: Error;
	/**
	 * Why an aborted run was aborted, when something said so.
	 *
	 * Kept apart from `error`, which means the run *failed*: an abort is a stop
	 * that was asked for, and a consumer treating the two alike would report a
	 * mistake limit as a crash. Carried because the reason was being thrown away
	 * exactly when it was the only thing that could explain the stop — the
	 * runtime aborts with a message, and every host downstream had to infer a
	 * cause from booleans it happened to hold.
	 */
	abortReason?: string;
	/**
	 * The limit that ended a failed run, when one did rather than an error.
	 *
	 * `max_iterations`: the run used every turn it was given. Its transcript is
	 * whole -- every turn it took and every tool result -- so a host can
	 * continue it with a higher cap instead of treating the work as lost. Kept
	 * apart from `error` because "out of turns" and "broken" call for opposite
	 * answers from whoever is watching the run.
	 */
	limit?: "max_iterations";
}
