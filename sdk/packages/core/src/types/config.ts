import type { ModelInfo } from "@cline/llms";
import type {
	AgentConfig,
	AgentHooks,
	AgentMode,
	AgentTool,
	BasicLogger,
	ConsecutiveMistakeLimitContext,
	ConsecutiveMistakeLimitDecision,
	ExtensionContext,
	HookErrorMode,
	ITelemetryService,
	MessageWithMetadata,
	SessionExecutionConfig,
	SessionPromptConfig,
	SessionWorkspaceConfig,
} from "@cline/shared";
import type { ToolRoutingRule } from "../extensions/tools/model-tool-routing";
import type { TaskProgressState } from "../extensions/tools/task-progress";
import type { TeamEvent } from "../extensions/tools/team";
import type { ProviderConfig } from "./provider-settings";

export type CoreAgentMode = AgentMode;

export interface CoreModelConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	providerConfig?: ProviderConfig;
	knownModels?: Record<string, ModelInfo>;
	/**
	 * Request model-side thinking/reasoning when supported.
	 */
	thinking?: boolean;
	/**
	 * Explicit reasoning effort override for capable models.
	 */
	reasoningEffort?: ProviderConfig["reasoningEffort"];
	/**
	 * Explicit thinking/reasoning token budget for capable models.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Maximum output tokens per API call.
	 */
	maxTokensPerTurn?: number;
	/**
	 * How much of one tool result reaches the provider before the message
	 * builder middle-truncates it. Omit for the built-in default.
	 */
	maxToolResultChars?: number;
	/**
	 * Sampling temperature per API call.
	 */
	temperature?: number;
}

export interface CoreRuntimeFeatures {
	enableTools: boolean;
	enableSpawnAgent: boolean;
	enableAgentTeams: boolean;
	disableMcpSettingsTools?: boolean;
	yolo?: boolean;
}

export type CoreCompactionMode = "auto" | "manual" | "overflow_recovery";

export interface CoreCompactionBudget {
	request: {
		/** Estimated tokens for the full provider request. */
		inputTokens: number;
		/** Effective provider input limit. */
		maxInputTokens: number;
		/** Full-request token count that triggers automatic compaction. */
		triggerTokens: number;
		/** Full-request token count the strategy output should fit within. */
		targetTokens: number;
		/** Fixed system-prompt, tool-definition, and request framing cost. */
		overheadTokens: number;
		thresholdRatio: number;
		utilizationRatio: number;
	};
	messages: {
		/** Estimated tokens in the compactable message transcript. */
		inputTokens: number;
		/** Message budget corresponding to the full-request trigger. */
		triggerTokens: number;
		/** Message budget the strategy should compact toward. */
		targetTokens: number;
	};
}

export interface CoreCompactionContext {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
	iteration: number;
	messages: MessageWithMetadata[];
	model: {
		id: string;
		provider: string;
		info?: ModelInfo;
	};
	mode: CoreCompactionMode;
	budget: CoreCompactionBudget;
	/**
	 * Aborted when the turn is cancelled. Custom `compact` implementations
	 * that call models or external services should observe it so a cancelled
	 * or recovering turn is not blocked on a stalled compaction.
	 */
	abortSignal?: AbortSignal;
}

// Mirrors BudgetPolicyIntent in extensions/context/budget-projection/types.ts.
// Keep this public API type decoupled from the internal projection module.
export type CoreCompactionBudgetPolicyIntent =
	| "agentic_summary"
	| "basic_compaction_projection"
	| "normal_provider_request";

// Mirrors LiveTailHandling in extensions/context/budget-projection/types.ts.
// Keep this public API type decoupled from the internal projection module.
export type CoreCompactionLiveTailHandling =
	| "included_verbatim"
	| "included_degraded"
	| "summarized_as_context"
	| "omitted_with_warning"
	| "preserved_out_of_band";

export interface CoreCompactionBudgetMetadata {
	policyIntent: CoreCompactionBudgetPolicyIntent;
	actionCount: number;
	warningCount: number;
	liveTailHandling: CoreCompactionLiveTailHandling;
}

export interface CoreCompactionResult {
	messages: MessageWithMetadata[];
	budget?: CoreCompactionBudgetMetadata;
}

export interface CoreCompactionSummarizerConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	/**
	 * Optional pre-resolved model metadata for the summarizer. Supplying either
	 * this or `knownModels` lets agentic compaction budget summary input against
	 * the summarizer model's actual context window instead of falling back to the
	 * active model's window.
	 */
	modelInfo?: ModelInfo;
	knownModels?: Record<string, ModelInfo>;
	providerConfig?: ProviderConfig;
	maxOutputTokens?: number;
}

/**
 * Session settings for the model's task checklist.
 *
 * Off unless a host asks for it: the checklist costs a parameter on every tool
 * description and re-sent text every few calls, which is a trade a host makes
 * knowingly rather than inherits.
 */
export interface CoreTaskProgressConfig {
	enabled: boolean;
	/** Tool calls between reminders. Non-positive disables reminding only. */
	reminderInterval?: number;
	/** Called whenever the model sends a new checklist. */
	onUpdate?: (state: TaskProgressState) => void;
}

export type CoreCompactionStrategy = "basic" | "agentic";

export interface CoreCompactionConfig {
	enabled?: boolean;
	strategy?: CoreCompactionStrategy;
	preserveRecentTokens?: number;
	/**
	 * Minimum share of the transcript's messages the preserved tail should reach
	 * before `preserveRecentTokens` alone is allowed to end it (0–1).
	 *
	 * A token budget is a poor proxy for how much conversation survives, and the
	 * two diverge exactly when messages are heavy: measured live, a 113-message
	 * transcript satisfied a 20,000-token budget after six messages and compacted
	 * to seven while the post-compaction budget allowed ~73,000. Defaults to
	 * {@link DEFAULT_PRESERVE_RECENT_MESSAGES_RATIO}; the token budget for the
	 * compacted request still caps it, so this can only ask, never overrun.
	 */
	preserveRecentMessagesRatio?: number;
	/**
	 * Replaces the built-in instruction the summarizer is given.
	 *
	 * The summary is all that survives the turns it stands for, and what a good
	 * one contains depends on the work and on the model writing it, so this is
	 * worth being able to change without a rebuild. `{{files_read}}` and
	 * `{{files_edited}}` are substituted; the transcript is appended by the
	 * caller either way. Blank or unset uses the default.
	 */
	summaryPrompt?: string;
	/**
	 * Whether compaction also writes a retrospective over the reasoning it is
	 * discarding, prepended to the summary as its own thinking block.
	 *
	 * The summary records what happened; the reasoning that produced it is
	 * thrown away with the turns, and with it every wrong approach the model
	 * already ruled out. A model that resumes from a summary alone has no memory
	 * of having been wrong, which is how a long task repeats its own mistakes.
	 *
	 * Costs one extra model call per compaction. Defaults to on.
	 */
	thinkingSummaryEnabled?: boolean;
	/**
	 * Replaces the built-in retrospective instruction.
	 *
	 * Worth changing per model for the same reason as `summaryPrompt`, and more
	 * so: a model that habitually reasons to its cap needs a firmer hand about
	 * terseness than one that thinks in three lines. Blank or unset uses the
	 * default.
	 */
	thinkingSummaryPrompt?: string;
	/**
	 * Whether a turn whose reasoning hit the thinking cap has that reasoning
	 * replaced, for the next request, with a note of what it settled.
	 *
	 * A capped turn is cut mid-sentence, and the next turn re-derives the same
	 * reasoning from the beginning rather than continuing from it. Defaults on
	 * where a thinking budget is known; without one there is nothing to detect.
	 */
	cappedThinkingEnabled?: boolean;
	/** Replaces the built-in continuation-note instruction. */
	cappedThinkingPrompt?: string;
	/** The per-turn thinking allowance this session sends, when one is known. */
	thinkingBudgetTokens?: number;
	summarizer?: CoreCompactionSummarizerConfig;
	compact?: (
		context: CoreCompactionContext,
	) =>
		| Promise<CoreCompactionResult | undefined>
		| CoreCompactionResult
		| undefined;
}

/**
 * Context passed to a custom `createCheckpoint` implementation.
 */
export interface CoreCheckpointContext {
	/** Absolute path to the working directory of the session. */
	cwd: string;
	/** The session identifier. */
	sessionId: string;
	/** Monotonically increasing run counter for this session (starts at 1). */
	runCount: number;
}

/**
 * Configuration for the built-in git-based checkpoint feature.
 *
 * Checkpoints capture a restorable snapshot of the workspace at the start of
 * each root-agent run so that changes made during a session can be rolled back.
 *
 * @example Disable checkpoints entirely:
 * ```ts
 * checkpoint: { enabled: false }
 * ```
 *
 * @example Bring your own checkpoint implementation:
 * ```ts
 * checkpoint: {
 *   createCheckpoint: async ({ cwd, sessionId, runCount }) => {
 *     const ref = await mySnapshotFn(cwd);
 *     return { ref, createdAt: Date.now(), runCount };
 *   },
 * }
 * ```
 */
export interface CoreCheckpointConfig {
	/**
	 * Whether to create checkpoints on each root-agent run start.
	 * Defaults to `false` — checkpoints are **opt-in**. Set to `true` to
	 * enable the built-in git stash/ref checkpoint behaviour for this session.
	 */
	enabled?: boolean;
	/**
	 * Replace the built-in git stash/ref checkpoint logic with a custom
	 * implementation. Called once at the start of each root-agent run (before
	 * the first agent iteration).
	 *
	 * Return an object with at least `ref`, `createdAt`, and `runCount` to have
	 * the entry recorded in session metadata, or return `undefined` to skip
	 * writing a checkpoint for that run.
	 */
	createCheckpoint?: (context: CoreCheckpointContext) =>
		| Promise<
				| {
						ref: string;
						createdAt: number;
						runCount: number;
						kind?: "stash" | "commit";
				  }
				| undefined
		  >
		| {
				ref: string;
				createdAt: number;
				runCount: number;
				kind?: "stash" | "commit";
		  }
		| undefined;
}

export interface CoreSessionConfig
	extends CoreModelConfig,
		CoreRuntimeFeatures,
		Omit<SessionWorkspaceConfig, "workspaceRoot">,
		Omit<SessionPromptConfig, "systemPrompt">,
		Omit<
			SessionExecutionConfig,
			| "enableTools"
			| "teamName"
			| "missionLogIntervalSteps"
			| "missionLogIntervalMs"
			| "maxConsecutiveMistakes"
		> {
	/**
	 * Core/hub runtime session identifier.
	 *
	 * When provided, this becomes the host-owned id for persistence, hub
	 * subscriptions, send/abort/stop commands, and approval routing. When
	 * omitted, the runtime host creates one. This is distinct from the agent
	 * conversation id, which is generated by the conversation store for
	 * transcript/tool/hook context.
	 */
	sessionId?: string;
	workspaceRoot?: string;
	systemPrompt: string;
	teamName?: string;
	missionLogIntervalSteps?: number;
	missionLogIntervalMs?: number;
	hooks?: AgentHooks;
	hookErrorMode?: HookErrorMode;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	extensionContext?: ExtensionContext;
	extraTools?: AgentTool[];
	/**
	 * The checklist the model keeps while it works.
	 *
	 * Applied to the whole session toolset — builtins and `extraTools` alike.
	 * A host that replaces a builtin (VS Code swaps `run_commands` for its own
	 * terminal-aware version) would otherwise leave the most-used tool in a
	 * coding run as the one tool carrying no checklist.
	 */
	taskProgress?: CoreTaskProgressConfig;
	pluginPaths?: string[];
	extensions?: AgentConfig["extensions"];
	execution?: AgentConfig["execution"];
	compaction?: CoreCompactionConfig;
	checkpoint?: CoreCheckpointConfig;
	onTeamEvent?: (event: TeamEvent) => void;
	onConsecutiveMistakeLimitReached?: (
		context: ConsecutiveMistakeLimitContext,
	) =>
		| Promise<ConsecutiveMistakeLimitDecision>
		| ConsecutiveMistakeLimitDecision;
	toolRoutingRules?: ToolRoutingRule[];
	/**
	 * Optional skill allowlist for the `skills` tool. When provided, only these
	 * skills are surfaced in tool metadata and invocable by name.
	 */
	skills?: string[];
	workspaceMetadata?: string;
}

/**
 * Public ClineCore start configuration. The execution host resolves `cwd`
 * before constructing a runtime, assigning the shared chat workspace when both
 * workspace paths are omitted.
 */
export type ClineCoreStartConfig = Omit<CoreSessionConfig, "cwd"> & {
	cwd?: string;
};
