import type {
	AgentConfig,
	AgentEvent,
	AgentHooks,
	AgentTool,
	BasicLogger,
	HookErrorMode,
	ITelemetryService,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "@cline/shared";
import { mergeAgentHooks } from "../../../hooks/hook-file-hooks";
import { SessionRuntime } from "../../../runtime/orchestration/session-runtime-orchestrator";
import type { AgentNodePlacement } from "./agent-node-placement";
import type { AgentSlotGate, AgentSlotGateRegistry } from "./agent-slot-gate";
import {
	buildSubAgentSystemPrompt,
	buildTeammateSystemPrompt,
} from "./subagent-prompts";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

export type DelegatedAgentConnectionConfig = Pick<
	AgentConfig,
	| "providerId"
	| "modelId"
	| "apiKey"
	| "baseUrl"
	| "headers"
	| "onAuthError"
	| "providerConfig"
	| "knownModels"
	| "thinking"
	| "reasoningEffort"
	| "thinkingBudgetTokens"
	| "maxTokensPerTurn"
	| "maxToolResultChars"
	| "temperature"
>;

export interface DelegatedAgentRuntimeConfig
	extends DelegatedAgentConnectionConfig {
	cwd?: string;
	providerId: string;
	clinePlatform?: string;
	clineIdeName?: string;
	maxIterations?: number;
	hooks?: AgentHooks;
	extensions?: AgentExtension[];
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	workspaceMetadata?: string;
	/**
	 * Holds delegated agents to the number of requests their endpoint serves.
	 *
	 * Carried here because it is the one thing every spawn path already shares:
	 * the team runtime, the lead's `spawn_agent`, and a sub-agent spawning its
	 * own all read this provider, so one gate covers them without any of them
	 * knowing about the others. Omitted means no gate -- see
	 * `createAgentSlotGate` for when that is the right answer.
	 */
	slotGate?: AgentSlotGate;
	/**
	 * The same bound, held per endpoint, for the path that does not all run on
	 * this provider.
	 *
	 * `slotGate` above covers `spawn_agent`, whose sub-agents are free-form and
	 * always on this connection. A *configured* agent is not: its file may name
	 * a `providerId` or a `profile`, so several in one turn can be spread over a
	 * local server and a cloud one. Gating those together would queue an
	 * Anthropic agent behind a one-slot Ollama; not gating them at all -- which
	 * is what happened until now -- lets four agents pointed at that same Ollama
	 * be spawned four-wide, which is what the gate exists to prevent.
	 */
	slotGates?: AgentSlotGateRegistry;
	/**
	 * Where a delegated agent runs, when the profile configures agent nodes.
	 *
	 * A node is a whole agents configuration, so the node decides the agent's
	 * connection and has to be chosen BEFORE the agent is built. A spawn path
	 * that has this takes a node, builds the agent on that node's config
	 * provider, runs inside the node's own gate, and gives the node back --
	 * see `agent-node-placement.ts`. Absent is every session that names no
	 * node: the single delegated connection, and `slotGate` above.
	 */
	nodePlacement?: AgentNodePlacement;
	/**
	 * Stable end-user identity inherited from the parent session so
	 * delegated-agent telemetry (Langfuse `userId`) groups with the user.
	 */
	distinctId?: string;
	/**
	 * Root core session id inherited from the parent session so
	 * delegated-agent telemetry (Langfuse `sessionId`) groups with it.
	 */
	sessionId?: string;
	/**
	 * Builds this agent's context pipeline -- compaction and the thinking cap.
	 *
	 * A factory rather than the pipeline itself because compaction carries
	 * state: the lead's is bound to the session's sidecar, and every delegated
	 * agent needs one keyed to its own transcript. Called once per agent in
	 * {@link buildDelegatedAgentConfig}.
	 *
	 * Absent means this agent compacts never. That was the behaviour until now,
	 * and it is how a sub-agent reached 1.87x its model's context window across
	 * 34 consecutive requests with nothing in the transcript to say so.
	 */
	createPrepareTurn?: () => AgentConfig["prepareTurn"];
	/** The pipeline's other half; stateless, so shared rather than built. */
	condenseDiscardedReasoning?: AgentConfig["condenseDiscardedReasoning"];
}

export interface DelegatedAgentConfigProvider {
	getRuntimeConfig(): DelegatedAgentRuntimeConfig;
	/**
	 * Hand this provider the session's node placement.
	 *
	 * A setter because the placement needs this provider to build from -- each
	 * node's connection is the session's with the node's fields over it -- so
	 * the two cannot both be constructed first. Optional on the interface for
	 * the hand-built providers a couple of hosts fall back to.
	 */
	setNodePlacement?(placement: AgentNodePlacement): void;
	getConnectionConfig(): DelegatedAgentConnectionConfig;
	updateConnectionDefaults(
		overrides: Partial<DelegatedAgentConnectionConfig>,
	): void;
}

export type DelegatedAgentKind = "subagent" | "teammate";

export interface BuildDelegatedAgentConfigOptions {
	kind: DelegatedAgentKind;
	prompt: string;
	tools: AgentTool[];
	configProvider: DelegatedAgentConfigProvider;
	parentAgentId?: string;
	maxIterations?: number;
	abortSignal?: AbortSignal;
	onEvent?: (event: AgentEvent) => void;
	hookErrorMode?: HookErrorMode;
	toolPolicies?: AgentConfig["toolPolicies"];
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	role?: string;
	cwd?: string;
	/**
	 * Hooks for this run alone, on top of the session's.
	 *
	 * The session's hooks belong to the session and are shared by every
	 * delegated run it starts. A background delegation needs one of its own --
	 * the barrier that holds it while the user has it paused -- and that barrier
	 * belongs to that run and no other.
	 */
	hooks?: AgentHooks;
	/**
	 * Something to say to this agent at its next turn boundary, if anything.
	 *
	 * The runtime asks at the one point in the loop with no tool call open, so
	 * what is handed back arrives inside the turn rather than as an invitation
	 * to go and fetch it. The session's own model has had this since steering
	 * existed; a delegated agent could not be reached at all, which was fine
	 * while nothing else was running beside one and is not fine now that the
	 * escalation's base model watches the expert and may need to stop it.
	 */
	consumePendingUserMessage?: AgentConfig["consumePendingUserMessage"];
}

/**
 * @param pinned Connection fields the session must not push over.
 *
 * Delegated agents normally track the session: the host pushes a model switch
 * or a refreshed key through `updateConnectionDefaults` and the agents follow,
 * which is what makes them agents *of* this session. When the agents have been
 * given a connection of their own, that same push would silently move them back
 * onto the lead's model — so the fields the override supplied are held, and
 * everything else still gets through.
 */
export function createDelegatedAgentConfigProvider(
	initialConfig: DelegatedAgentRuntimeConfig,
	pinned: readonly (keyof DelegatedAgentConnectionConfig)[] = [],
): DelegatedAgentConfigProvider {
	let runtimeConfig: DelegatedAgentRuntimeConfig = { ...initialConfig };
	const held = new Set<string>(pinned as readonly string[]);

	return {
		getRuntimeConfig: () => runtimeConfig,
		setNodePlacement: (placement) => {
			runtimeConfig = { ...runtimeConfig, nodePlacement: placement };
		},
		getConnectionConfig: () => ({
			providerId: runtimeConfig.providerId,
			modelId: runtimeConfig.modelId,
			apiKey: runtimeConfig.apiKey,
			baseUrl: runtimeConfig.baseUrl,
			headers: runtimeConfig.headers,
			onAuthError: runtimeConfig.onAuthError,
			providerConfig: runtimeConfig.providerConfig,
			knownModels: runtimeConfig.knownModels,
			thinking: runtimeConfig.thinking,
			reasoningEffort: runtimeConfig.reasoningEffort,
			thinkingBudgetTokens: runtimeConfig.thinkingBudgetTokens,
			maxTokensPerTurn: runtimeConfig.maxTokensPerTurn,
			maxToolResultChars: runtimeConfig.maxToolResultChars,
			temperature: runtimeConfig.temperature,
		}),
		updateConnectionDefaults: (overrides) => {
			const accepted =
				held.size === 0
					? overrides
					: Object.fromEntries(
							Object.entries(overrides).filter(([key]) => !held.has(key)),
						);
			runtimeConfig = {
				...runtimeConfig,
				...accepted,
			};
		},
	};
}

export function buildDelegatedAgentConfig(
	options: BuildDelegatedAgentConfigOptions,
): AgentConfig & { role?: string } {
	const runtimeConfig = options.configProvider.getRuntimeConfig();
	const systemPrompt =
		options.kind === "teammate"
			? buildTeammateSystemPrompt(options.prompt, runtimeConfig)
			: buildSubAgentSystemPrompt(options.prompt, runtimeConfig);

	return {
		...options.configProvider.getConnectionConfig(),
		distinctId: runtimeConfig.distinctId,
		sessionId: runtimeConfig.sessionId,
		systemPrompt,
		tools: options.tools,
		maxIterations: options.maxIterations ?? runtimeConfig.maxIterations,
		// One pipeline per agent, built here rather than passed in: see
		// `createPrepareTurn`. A delegated agent that inherited the lead's
		// would compact against the lead's summary and overwrite its state.
		prepareTurn: runtimeConfig.createPrepareTurn?.(),
		condenseDiscardedReasoning: runtimeConfig.condenseDiscardedReasoning,
		parentAgentId: options.parentAgentId,
		abortSignal: options.abortSignal,
		onEvent: options.onEvent,
		hooks: mergeAgentHooks([runtimeConfig.hooks, options.hooks]),
		extensions: runtimeConfig.extensions,
		hookErrorMode: options.hookErrorMode,
		toolPolicies: options.toolPolicies,
		requestToolApproval: options.requestToolApproval,
		logger: runtimeConfig.logger,
		role: options.role,
		consumePendingUserMessage: options.consumePendingUserMessage,
	};
}

export function createDelegatedAgent(
	options: BuildDelegatedAgentConfigOptions,
): SessionRuntime {
	const config = buildDelegatedAgentConfig(options);
	const session = new SessionRuntime(config);
	if (config.onEvent) {
		session.subscribeEvents(config.onEvent);
	}
	return session;
}
