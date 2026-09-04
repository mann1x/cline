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
import { SessionRuntime } from "../../../runtime/orchestration/session-runtime-orchestrator";
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
	 * Stable end-user identity inherited from the parent session so
	 * delegated-agent telemetry (Langfuse `userId`) groups with the user.
	 */
	distinctId?: string;
	/**
	 * Root core session id inherited from the parent session so
	 * delegated-agent telemetry (Langfuse `sessionId`) groups with it.
	 */
	sessionId?: string;
}

export interface DelegatedAgentConfigProvider {
	getRuntimeConfig(): DelegatedAgentRuntimeConfig;
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
		parentAgentId: options.parentAgentId,
		abortSignal: options.abortSignal,
		onEvent: options.onEvent,
		hooks: runtimeConfig.hooks,
		extensions: runtimeConfig.extensions,
		hookErrorMode: options.hookErrorMode,
		toolPolicies: options.toolPolicies,
		requestToolApproval: options.requestToolApproval,
		logger: runtimeConfig.logger,
		role: options.role,
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
