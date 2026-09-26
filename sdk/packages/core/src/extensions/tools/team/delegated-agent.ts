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
import type { WorkerStruggleSupervisor } from "../../../runtime/safety/worker-struggle";
import type { DelegatedAgentCheck } from "./agent-check";
import type { AgentNodePlacement } from "./agent-node-placement";
import type { AgentSlotGate, AgentSlotGateRegistry } from "./agent-slot-gate";
import {
	applySpawnSampling,
	modelTemperatureOf,
	type RealizedSpawnSampling,
	realizeSpawnSampling,
	type SpawnSamplingDraw,
} from "./spawn-sampling";
import { pinConversationHead } from "./subagent-layout";
import {
	buildSubAgentSystemPrompt,
	buildTeammateSystemPrompt,
} from "./subagent-prompts";
import { createTurnFaultRecovery } from "./turn-fault-recovery";

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
	| "staleReadRewrites"
	| "temperature"
>;

export interface DelegatedAgentRuntimeConfig
	extends DelegatedAgentConnectionConfig {
	cwd?: string;
	providerId: string;
	clinePlatform?: string;
	clineIdeName?: string;
	maxIterations?: number;
	/**
	 * Loop-detection and mistake-budget tuning for this agent's own runtime.
	 *
	 * Until now a delegated agent ran on whatever `execution` the lead's runtime
	 * config carried, which for a headless swarm worker is nothing worker-shaped:
	 * the exact-repeat loop tracker and the default mistake budget never catch a
	 * worker grinding on slightly-varying probes to the token cap. Carrying it
	 * here lets a spawn path hand a worker a tighter, worker-calibrated budget --
	 * see `worker-struggle.ts` -- without touching the shared runtime config.
	 */
	execution?: AgentConfig["execution"];
	/**
	 * What the server appends to reasoning it cut at the thinking budget, when
	 * the session knows it: how an agent's struggle supervisor tells a turn
	 * that ran out its budget. Without it the supervisor reads the generic
	 * admission in the reasoning's tail (`worker-struggle.ts`).
	 */
	thinkingBudgetMessage?: string;
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
	 * Priority 0 (PLANS §9g): this configuration is the lead's own opencoti
	 * connection, and a pooled agent built from it attaches as a sub-pool of
	 * the lead's session -- this id -- rather than of an owner opened for the
	 * swarm. Set only on the priority-0 node's provider; see
	 * `agent-node-placement.ts`. Absent everywhere else, which is every agent
	 * before this setting.
	 */
	polykvLeadOwner?: string;
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
	createPrepareTurn?: (
		agent?: DelegatedPrepareTurnTarget,
	) => AgentConfig["prepareTurn"];
	/** The pipeline's other half; stateless, so shared rather than built. */
	condenseDiscardedReasoning?: AgentConfig["condenseDiscardedReasoning"];
}

/**
 * Whose compaction a delegated agent's pipeline is.
 *
 * The agent's own: its connection and its engine session. Built from the
 * lead's instead -- as it was -- a sub-agent on an opencoti node summarised
 * itself with the lead's model, measured its trigger against the lead's
 * request counts, and read pool pressure in the lead's name.
 */
export interface DelegatedPrepareTurnTarget {
	providerId: string;
	modelId: string;
	providerConfig: NonNullable<AgentConfig["providerConfig"]>;
	engineSessionId?: string;
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
	/**
	 * The part of a session connection push the agents take: the fields
	 * their own connection names are left out. For an agent built earlier
	 * that the push reaches directly -- a live teammate -- so it keeps its own
	 * server as a new spawn would.
	 */
	acceptedConnectionUpdates?(
		overrides: Partial<DelegatedAgentConnectionConfig>,
	): Partial<DelegatedAgentConnectionConfig>;
}

export type DelegatedAgentKind = "subagent" | "teammate";

export interface BuildDelegatedAgentConfigOptions {
	kind: DelegatedAgentKind;
	prompt: string;
	tools: AgentTool[];
	configProvider: DelegatedAgentConfigProvider;
	parentAgentId?: string;
	maxIterations?: number;
	/**
	 * Per-build override of the runtime's loop-detection and mistake budget.
	 * Falls back to {@link DelegatedAgentRuntimeConfig.execution}. The swarm path
	 * uses it to hand each worker a tighter budget than the shared runtime.
	 */
	execution?: AgentConfig["execution"];
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
	/**
	 * The engine session this agent runs in -- its own, never the lead's.
	 * See `AgentConfig.engineSessionId`.
	 */
	engineSessionId?: string;
	/** Attach to a shared PolyKV pool tree; see `AgentConfig.polykvWorker`. */
	polykvWorker?: AgentConfig["polykvWorker"];
	/**
	 * Shared turns at the head of the conversation that compaction must keep
	 * verbatim. See `subagent-layout.ts`.
	 */
	pinnedHead?: readonly string[];
	/**
	 * Watches a headless worker for a grind and stops it, per worker.
	 *
	 * The lead has a struggle layer; a delegated worker had none, and on the
	 * 75-agent swarm a third of them ground to the token cap without ever
	 * reporting. Passed here rather than composed in each spawn path because this
	 * builder is the one funnel both `spawn_agent` and the swarm pass through:
	 * wiring it once reaches both. When present it wraps this agent's tools so the
	 * one nudge lands on a result, folds every event into the supervisor, and ORs
	 * its stop into the agent's abort signal. See `worker-struggle.ts`. The
	 * supervisor is stateful and per-agent -- a caller that builds two agents
	 * gives each its own.
	 */
	struggle?: WorkerStruggleSupervisor;
	/**
	 * How this agent waits out a turn the server dropped or refused. Defaults
	 * to waiting on its own connection's server with no limit (see
	 * `turn-fault-recovery.ts`); a spawn path that placed the agent passes one
	 * that knows the node and whether the engine has admitted it.
	 */
	recoverTurnFault?: AgentConfig["recoverTurnFault"];
	/**
	 * The sampler the spawning call asked for: `temperature` and `seed`.
	 *
	 * A build option rather than a connection field, and applied after the
	 * connection is read, so that nothing which moves a connection -- the
	 * session's `updateConnectionDefaults`, a profile, a node's placement --
	 * can move it. Absent leaves the connection's sampler exactly as it was.
	 * See `spawn-sampling.ts`.
	 *
	 * Already drawn (`drawSpawnSampling`): a random seed is a number here, and
	 * a random temperature is a position in its range, made concrete against
	 * this build's connection -- the model's own temperature is only known
	 * once the node, and so the model, is.
	 */
	sampling?: SpawnSamplingDraw;
	/**
	 * Told what this build's sampler came to: the values applied, what a
	 * random one was drawn around, or why one was not applied. Called on every
	 * build with a sampler, so a re-placement reports its own.
	 */
	onSampling?: (realized: RealizedSpawnSampling) => void;
	/**
	 * The lead's check on this agent (`agent-check.ts`), judged at each of its
	 * completion attempts. Wired into the runtime's completion boundary -- the
	 * hook the change protocol's approved check uses -- so a failing check
	 * keeps the agent in the same run, within its iteration budget.
	 */
	check?: DelegatedAgentCheck;
}

/** OR two optional abort signals, without an `AbortSignal.any` of one. */
function composeAbortSignals(
	...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
	const present = signals.filter((s): s is AbortSignal => s !== undefined);
	if (present.length === 0) {
		return undefined;
	}
	return present.length === 1 ? present[0] : AbortSignal.any(present);
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
	const accepted = (overrides: Partial<DelegatedAgentConnectionConfig>) =>
		held.size === 0
			? overrides
			: Object.fromEntries(
					Object.entries(overrides).filter(([key]) => !held.has(key)),
				);

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
			staleReadRewrites: runtimeConfig.staleReadRewrites,
			temperature: runtimeConfig.temperature,
		}),
		updateConnectionDefaults: (overrides) => {
			runtimeConfig = {
				...runtimeConfig,
				...accepted(overrides),
			};
		},
		acceptedConnectionUpdates: accepted,
	};
}

/**
 * The worker spec with its owner, when the agent was placed on priority 0.
 *
 * Decided here, the one funnel every spawn path builds through, rather than at
 * each of the three spawn sites: which node took the agent is a property of
 * the configuration it was built from, and a site that forgot to ask would put
 * a priority-0 agent in an owner the swarm opened -- quietly correct, and not
 * what the setting says.
 */
export function withPolykvLeadOwner(
	worker: AgentConfig["polykvWorker"],
	owner: string | undefined,
): AgentConfig["polykvWorker"] {
	return worker && owner ? { ...worker, owner } : worker;
}

export function buildDelegatedAgentConfig(
	options: BuildDelegatedAgentConfigOptions,
): AgentConfig & { role?: string } {
	const runtimeConfig = options.configProvider.getRuntimeConfig();
	const connection = options.configProvider.getConnectionConfig();
	const polykvWorker = withPolykvLeadOwner(
		options.polykvWorker,
		runtimeConfig.polykvLeadOwner,
	);
	// What this agent's own requests are built from, summarizer included: the
	// node's connection, the agent's engine session and its pool tree.
	const ownProviderConfig = {
		...((connection.providerConfig ?? {}) as Record<string, unknown>),
		providerId: connection.providerId,
		modelId: connection.modelId,
		...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
		...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
		...(connection.headers ? { headers: connection.headers } : {}),
		...(options.engineSessionId
			? { engineSessionId: options.engineSessionId }
			: {}),
		...(polykvWorker
			? { polykvWorker: { ...polykvWorker, attachOnly: true } }
			: {}),
	} as NonNullable<AgentConfig["providerConfig"]>;
	const prepareTurn = runtimeConfig.createPrepareTurn?.({
		providerId: connection.providerId,
		modelId: connection.modelId,
		providerConfig: ownProviderConfig,
		...(options.engineSessionId
			? { engineSessionId: options.engineSessionId }
			: {}),
	});
	const systemPrompt =
		options.kind === "teammate"
			? buildTeammateSystemPrompt(options.prompt, runtimeConfig)
			: buildSubAgentSystemPrompt(options.prompt, runtimeConfig);

	// The supervisor, when present, wraps the tools (so its one nudge lands on a
	// result) and folds every event in (so it sees the grind). Its stop aborts
	// the run it ends -- see `createDelegatedAgent` -- and never this signal:
	// the stop suspends the worker for the lead, who may resume it, and an
	// agent built on an aborted signal aborts every run it is given. Absent,
	// everything is exactly what the caller passed.
	const supervisor = options.struggle;
	const tools = supervisor
		? supervisor.wrapTools(options.tools)
		: options.tools;
	const onEvent: BuildDelegatedAgentConfigOptions["onEvent"] = supervisor
		? (event) => {
				options.onEvent?.(event);
				supervisor.observe(event);
			}
		: options.onEvent;
	const abortSignal = composeAbortSignals(options.abortSignal);

	// Every delegated agent retries a server restart or a refusal rather than
	// ending on it: it is meant to finish its job, and Stop is the bound.
	const recoverTurnFault =
		options.recoverTurnFault ??
		createTurnFaultRecovery({
			label: options.role ?? options.kind,
			baseUrl: () => connection.baseUrl,
			headers: () => connection.headers,
			...(abortSignal ? { signal: abortSignal } : {}),
			...(runtimeConfig.logger
				? {
						logger: {
							log: (message: string) => runtimeConfig.logger?.log?.(message),
						},
					}
				: {}),
		});

	const realized = realizeSpawnSampling(
		options.sampling,
		options.sampling?.temperatureRandom
			? modelTemperatureOf(connection)
			: undefined,
	);
	if (realized) {
		options.onSampling?.(realized);
	}
	return applySpawnSampling(
		{
			...connection,
			distinctId: runtimeConfig.distinctId,
			sessionId: runtimeConfig.sessionId,
			...(options.engineSessionId
				? { engineSessionId: options.engineSessionId }
				: {}),
			...(polykvWorker ? { polykvWorker } : {}),
			systemPrompt,
			tools,
			maxIterations: options.maxIterations ?? runtimeConfig.maxIterations,
			execution: options.execution ?? runtimeConfig.execution,
			// One pipeline per agent, built here rather than passed in: see
			// `createPrepareTurn`. A delegated agent that inherited the lead's
			// would compact against the lead's summary and overwrite its state.
			prepareTurn: pinConversationHead(
				prepareTurn as never,
				options.pinnedHead ?? [],
			) as AgentConfig["prepareTurn"],
			condenseDiscardedReasoning: runtimeConfig.condenseDiscardedReasoning,
			parentAgentId: options.parentAgentId,
			abortSignal,
			onEvent,
			hooks: mergeAgentHooks([runtimeConfig.hooks, options.hooks]),
			extensions: runtimeConfig.extensions,
			hookErrorMode: options.hookErrorMode,
			toolPolicies: options.toolPolicies,
			requestToolApproval: options.requestToolApproval,
			logger: runtimeConfig.logger,
			role: options.role,
			consumePendingUserMessage: options.consumePendingUserMessage,
			recoverTurnFault,
			...(options.check
				? {
						completionPolicy: {
							onCompletionAttempt: (context: {
								text?: string;
								forced?: boolean;
							}) =>
								options.check?.onCompletionAttempt(context) ??
								Promise.resolve(undefined),
						},
					}
				: {}),
		},
		realized,
	);
}

export function createDelegatedAgent(
	options: BuildDelegatedAgentConfigOptions,
): SessionRuntime {
	const config = buildDelegatedAgentConfig(options);
	const session = new SessionRuntime(config);
	if (config.onEvent) {
		session.subscribeEvents(config.onEvent);
	}
	// A supervisor stop ends the run in flight with the supervisor's words as
	// its abort reason, which `runDelegatedWithCap` reads as a stop to put to
	// the lead (`awaiting_lead`, struggling) rather than an end.
	options.struggle?.onStop((reason) => session.abort(reason));
	return session;
}

// The controls a lead has over a delegated agent at this layer: the iteration
// cap's suspension (`awaiting_lead`) and its resume, and the lead's check.
// `resume_agent` and the status tool are built on these.
export {
	type AgentCheck,
	type AgentOracleResult,
	createDelegatedAgentCheck,
	type DelegatedAgentCheck,
	describeAgentCheck,
	readAgentCheck,
} from "./agent-check";
export {
	type AwaitingLeadEvent,
	type AwaitingLeadView,
	createDelegatedAgentLifetime,
	type DelegatedAgentLifetime,
	type DelegatedRunOutcome,
	type DelegatedStopReason,
	listAwaitingLead,
	onAwaitingLead,
	RESUME_AGENT_TOOL_NAME,
	type ResumeSuspendedResult,
	resumeSuspended,
	runDelegatedWithCap,
	stopSuspended,
} from "./agent-iteration-cap";
