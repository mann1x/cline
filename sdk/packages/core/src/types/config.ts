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
import type { QaCredential } from "../extensions/tools/qa-credentials";
import type { TaskProgressState } from "../extensions/tools/task-progress";
import type {
	AgentProfileConnection,
	AgentProviderConnection,
	TeamEvent,
} from "../extensions/tools/team";
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

/**
 * A connection for delegated agents that is not the session's own.
 *
 * Subagents and teammates inherit the lead's whole connection — provider,
 * model, sampler, and the context window with it. That is the right default and
 * the wrong only option: it leaves no way to run a team of small agents under a
 * strong lead, and no way to give them a window sized for the narrower job.
 *
 * Deliberately only the connection: which model to call, where, and with what
 * provider settings. Everything else about a delegated agent — its tools, its
 * prompt, its iteration cap — still comes from the session that spawned it. And
 * only the fields actually set are taken, so an override naming a model and
 * nothing else keeps the session's sampler and thinking budget.
 */
export type DelegatedAgentConnectionOverride = Pick<
	CoreModelConfig,
	| "providerId"
	| "modelId"
	| "apiKey"
	| "baseUrl"
	| "headers"
	| "providerConfig"
	| "knownModels"
>;

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

/**
 * How firmly the session insists an edited file be checked before it finishes.
 *
 * Three states rather than a boolean, because "ask the model once" and "do not
 * let it finish" are different products and the user owns the choice. It lives
 * in settings rather than in the conversation on purpose: a question asked
 * after every file change is a round trip per edit, and "always" is not an
 * answer a model should be giving on the user's behalf.
 */
export type CoreEditVerificationMode = "off" | "nudge" | "require";

export interface CoreEditVerificationConfig {
	mode?: CoreEditVerificationMode;
	/** Tools whose calls mark a file changed. Defaults to the built-in editors. */
	editTools?: string[];
	/**
	 * Tools whose calls mark a file verified. Named by the host rather than
	 * assumed: the checker on the VS Code path is `check_file`, which lives in
	 * the extension. A host that names none gets no guard at all.
	 */
	checkTools?: string[];
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
	/**
	 * What the server appends to reasoning it cut at the budget, when the
	 * session knows the wording. Confirms or denies a capped turn outright;
	 * without one the condenser measures instead.
	 */
	cappedThinkingBudgetMessage?: string;
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
	/**
	 * Turn images into text with a second model, so the session's model never
	 * sees one. See `AgentConfig.describeImages`.
	 *
	 * Declared here because it is a session-level setting that hosts already
	 * pass: the VS Code host has set both of these since the vision model
	 * shipped, and only got away with it because it adds them through a
	 * conditional spread, which excess-property checking does not inspect. A
	 * host assigning them directly — the CLI — was rejected for setting a field
	 * that has always been read.
	 */
	describeImages?: AgentConfig["describeImages"];
	/** See `AgentConfig.alwaysDescribeImages`. */
	alwaysDescribeImages?: boolean;
	/**
	 * Run subagents and teammates on this connection instead of the session's.
	 *
	 * Omitted means what it always meant: they inherit the lead's. See
	 * `DelegatedAgentConnectionOverride`.
	 */
	delegatedAgentConnection?: DelegatedAgentConnectionOverride;
	/**
	 * Most delegated agents that may run at once against their endpoint.
	 *
	 * Resolved by the host, because answering it can mean asking the server: a
	 * local one has a fixed number of slots (`OLLAMA_NUM_PARALLEL`,
	 * `--parallel N`) and *queues* the request that finds none free rather than
	 * refusing it, so over-spawning reads as a slow run rather than a blocked
	 * one. Hosted providers have the same shape with a plan's allowance in place
	 * of slots.
	 *
	 * `0` means no cap of ours -- not "unlimited", but "something else decides":
	 * opencoti with PolyKV on, where agents share a slot and admission control
	 * answers against measured KV headroom. `undefined` means no host resolved
	 * one at all, which leaves every previous behaviour exactly as it was.
	 */
	maxConcurrentAgents?: number;
	/**
	 * Resolves a provider other than the session's, for a configured subagent
	 * whose frontmatter names one.
	 *
	 * Host-supplied because only the host knows where its provider store lives:
	 * the CLI's follows `--config`, the extension's follows its own data
	 * directory. Core reaching for a default path would read the wrong file in
	 * one of them and call the wrong server with the wrong key. Absent means an
	 * agent on a second provider is refused rather than silently run on the
	 * session's connection.
	 */
	resolveProviderConnection?: (
		providerId: string,
	) => AgentProviderConnection | undefined;
	/**
	 * Resolves a saved API configuration profile by name, for an agent whose
	 * frontmatter names one.
	 *
	 * Host-supplied for the same reason as the provider resolver, and absent on
	 * a host that has no profiles at all — the CLI has providers and no named
	 * configurations over them. An agent naming a profile on such a host is
	 * refused rather than run on the session's, which is the same rule the
	 * provider case follows and for the same reason: a subagent silently running
	 * the wrong model is worse than one that does not run.
	 */
	resolveProfileConnection?: (
		name: string,
	) => AgentProfileConnection | undefined;
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
	/**
	 * Whether the run may end with a file the model changed and never checked.
	 *
	 * Measured on a live session: the linter ran once *before* anything was
	 * touched, then four consecutive edits landed unchecked, and the file was
	 * left with sixteen problems. The tool was present and already used — what
	 * was missing was anything that noticed.
	 */
	editVerification?: CoreEditVerificationConfig;
	/**
	 * The project's own checker, for the `check_file` this host supplies.
	 *
	 * Without one that tool answers a narrower question than the extension's
	 * does — syntax and brackets, where VS Code reads its language servers —
	 * and the two hosts ship measurably different tools under one name. Naming
	 * a command closes the distance and changes what the tool tells the model
	 * it is, which is the half that matters: a model that believes it has only
	 * a syntax check goes and runs the linter through `run_commands` anyway.
	 *
	 * `${file}` marks where the path goes; a command without it gets the path
	 * appended.
	 */
	checkFile?: { lintCommand?: string };
	/**
	 * Named secrets a QA command can ask for.
	 *
	 * Supplied by the host because only the host has a secret store; core never
	 * reads or writes them anywhere, it only routes a value into the environment
	 * of the one command that asked and masks it back out of what comes home.
	 * See `extensions/tools/qa-credentials.ts` for why that is the whole design.
	 */
	qaCredentials?: QaCredential[];
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
