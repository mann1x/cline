import { clearPolykvSession, setPolykvSession } from "@cline/llms";
import type { AgentEvent, AgentTool } from "@cline/shared";
import {
	readPolykvCapacity,
	releasePolykvPool,
	snapshotPolykvSession,
} from "../../../extensions/context/polykv-session";
import {
	parseWorkDigest,
	renderWorkDigest,
} from "../../../extensions/context/work-digest";
import {
	createBuiltinTools,
	resolveToolPresetName,
	type ToolExecutors,
	ToolPresets,
} from "../../../extensions/tools";
import type {
	SubAgentEndContext,
	SubAgentStartContext,
} from "../../../extensions/tools/team";
import { createSpawnAgentTool } from "../../../extensions/tools/team";
import { admissionFromCapacity } from "../../../extensions/tools/team/agent-admission";
import type { DelegatedAgentConfigProvider } from "../../../extensions/tools/team/delegated-agent";
import { createDelegatedAgent } from "../../../extensions/tools/team/delegated-agent";
import {
	createSpawnSwarmTool,
	SWARM_REDUCER_PROMPT,
} from "../../../extensions/tools/team/spawn-swarm-tool";
import { buildTelemetryAgentIdentity } from "../../../services/agent-events";
import { filterDisabledTools } from "../../../services/global-settings";
import {
	captureAgentCreated,
	captureSubagentExecution,
} from "../../../services/telemetry/core-events";
import type { CoreSessionConfig } from "../../../types/config";
import type { ActiveSession } from "../../../types/session";

export type SubAgentStartTracker = Map<
	string,
	{ startedAt: number; rootSessionId: string }
>;

export interface SpawnToolDeps {
	getSession(sessionId: string): ActiveSession | undefined;
	subAgentStarts: SubAgentStartTracker;
	onAgentEvent(
		rootSessionId: string,
		config: CoreSessionConfig,
		event: AgentEvent,
	): void;
	invokeBackendOptional(method: string, ...args: unknown[]): Promise<void>;
}

export interface SessionSubAgentLifecycleCallbacks {
	onSubAgentEvent: (event: AgentEvent) => void;
	onSubAgentStart: (context: SubAgentStartContext) => void;
	onSubAgentEnd: (context: SubAgentEndContext) => void;
}

export function createSessionSubAgentLifecycleCallbacks(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
): SessionSubAgentLifecycleCallbacks {
	return {
		onSubAgentEvent: (event) => deps.onAgentEvent(rootSessionId, config, event),
		onSubAgentStart: (context) => {
			const teamRuntime = deps.getSession(rootSessionId)?.runtime.teamRuntime;
			deps.subAgentStarts.set(context.subAgentId, {
				startedAt: Date.now(),
				rootSessionId,
			});
			const agentIdentity = buildTelemetryAgentIdentity({
				agentId: context.subAgentId,
				conversationId: context.conversationId,
				parentAgentId: context.parentAgentId,
				teamId: teamRuntime?.getTeamId(),
				teamName: teamRuntime?.getTeamName(),
				createdByAgentId: context.parentAgentId,
			});
			if (agentIdentity) {
				captureAgentCreated(config.telemetry, {
					ulid: rootSessionId,
					modelId: config.modelId,
					provider: config.providerId,
					...agentIdentity,
				});
			}
			captureSubagentExecution(config.telemetry, {
				event: "started",
				ulid: rootSessionId,
				durationMs: 0,
				parentId: context.parentAgentId,
				agentId: context.subAgentId,
				...agentIdentity,
			});
			void deps.invokeBackendOptional(
				"handleSubAgentStart",
				rootSessionId,
				context,
			);
		},
		onSubAgentEnd: (context) => {
			const teamRuntime = deps.getSession(rootSessionId)?.runtime.teamRuntime;
			const started = deps.subAgentStarts.get(context.subAgentId);
			const durationMs = started ? Date.now() - started.startedAt : 0;
			const outputLines = context.result?.text
				? context.result.text.split("\n").length
				: 0;
			captureSubagentExecution(config.telemetry, {
				event: "ended",
				ulid: rootSessionId,
				durationMs,
				outputLines,
				errorMessage: context.error ? String(context.error) : undefined,
				agentId: context.subAgentId,
				parentId: context.parentAgentId,
				...buildTelemetryAgentIdentity({
					agentId: context.subAgentId,
					conversationId: context.conversationId,
					parentAgentId: context.parentAgentId,
					teamId: teamRuntime?.getTeamId(),
					teamName: teamRuntime?.getTeamName(),
					createdByAgentId: context.parentAgentId,
				}),
			});
			deps.subAgentStarts.delete(context.subAgentId);
			void deps.invokeBackendOptional(
				"handleSubAgentEnd",
				rootSessionId,
				context,
			);
		},
	};
}

export function createSessionSpawnTool(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
	toolExecutors?: Partial<ToolExecutors>,
): AgentTool {
	const lifecycle = createSessionSubAgentLifecycleCallbacks(
		deps,
		config,
		rootSessionId,
	);
	const createSubAgentTools = () => {
		const tools: AgentTool[] = config.enableTools
			? createBuiltinTools({
					cwd: config.cwd,
					telemetry: config.telemetry,
					...ToolPresets[resolveToolPresetName({ mode: config.mode })],
					executors: toolExecutors,
				})
			: [];
		if (config.enableSpawnAgent) {
			tools.push(
				createSessionSpawnTool(deps, config, rootSessionId, toolExecutors),
			);
		}
		return filterDisabledTools(tools);
	};

	return createSpawnAgentTool({
		configProvider: {
			getRuntimeConfig: () =>
				deps
					.getSession(rootSessionId)
					?.runtime.delegatedAgentConfigProvider?.getRuntimeConfig() ?? {
					providerId: config.providerId,
					modelId: config.modelId,
					cwd: config.cwd,
					apiKey: config.apiKey,
					baseUrl: config.baseUrl,
					headers: config.headers,
					providerConfig: config.providerConfig,
					knownModels: config.knownModels,
					thinking: config.thinking,
					maxIterations: config.maxIterations,
					hooks: config.hooks,
					extensions: config.extensions,
					logger: config.logger,
					telemetry: config.telemetry,
				},
			getConnectionConfig: () =>
				deps
					.getSession(rootSessionId)
					?.runtime.delegatedAgentConfigProvider?.getConnectionConfig() ?? {
					providerId: config.providerId,
					modelId: config.modelId,
					apiKey: config.apiKey,
					baseUrl: config.baseUrl,
					headers: config.headers,
					providerConfig: config.providerConfig,
					knownModels: config.knownModels,
					thinking: config.thinking,
				},
			updateConnectionDefaults: () => {},
		},
		createSubAgentTools,
		...lifecycle,
	}) as AgentTool;
}

/**
 * `spawn_swarm`, wired to this session's engine.
 *
 * Built beside `spawn_agent` because it needs the same three things a spawn
 * needs -- the delegated-agent config, the sub-agent toolset, and the slot gate
 * -- plus two the tool itself cannot reach: this session's PolyKV pool, and a
 * session id per worker.
 *
 * **Why a session id per worker.** The engine treats a request whose
 * `session_id` it already knows as a CONTINUATION rather than an admission, and
 * gates it differently -- its own comment says gating a continuation livelocks a
 * pool under floor. Delegated agents otherwise inherit the lead's session id, so
 * a swarm would arrive as one session's turns rather than as N sessions, and
 * neither the admission gate nor `/polykv/tps` could tell them apart. Each
 * worker therefore gets an id of its own, registered against the shared pool so
 * the vendor sends `pool_id` with it, and cleared when the worker finishes.
 */
export function createSessionSwarmTool(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
	toolExecutors?: Partial<ToolExecutors>,
): AgentTool {
	const lifecycle = createSessionSubAgentLifecycleCallbacks(
		deps,
		config,
		rootSessionId,
	);
	const providerConfig = {
		providerId: config.providerId,
		...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
		...(config.headers !== undefined ? { headers: config.headers } : {}),
		...(config.providerConfig?.polykv !== undefined
			? { polykv: config.providerConfig.polykv }
			: {}),
	};

	const configProvider = (): DelegatedAgentConfigProvider =>
		deps.getSession(rootSessionId)?.runtime.delegatedAgentConfigProvider ?? {
			getRuntimeConfig: () => ({
				providerId: config.providerId,
				modelId: config.modelId,
				cwd: config.cwd,
				apiKey: config.apiKey,
				baseUrl: config.baseUrl,
				headers: config.headers,
				providerConfig: config.providerConfig,
				knownModels: config.knownModels,
				thinking: config.thinking,
				maxIterations: config.maxIterations,
				hooks: config.hooks,
				extensions: config.extensions,
				logger: config.logger,
				telemetry: config.telemetry,
			}),
			getConnectionConfig: () => ({
				providerId: config.providerId,
				modelId: config.modelId,
				apiKey: config.apiKey,
				baseUrl: config.baseUrl,
				headers: config.headers,
				providerConfig: config.providerConfig,
				knownModels: config.knownModels,
				thinking: config.thinking,
			}),
			updateConnectionDefaults: () => {},
		};

	/** The shared provider, answering with one worker's session id. */
	const forWorker = (
		base: DelegatedAgentConfigProvider,
		sessionId: string,
	): DelegatedAgentConfigProvider => ({
		...base,
		getRuntimeConfig: () => ({ ...base.getRuntimeConfig(), sessionId }),
	});

	/**
	 * The pool this round's workers attached to, remembered for the reducer.
	 *
	 * Set by the first worker rather than passed in, because the snapshot is
	 * taken inside the tool -- it has to be, since its timing is the whole
	 * point.
	 */
	let sharedPoolId: string | undefined;

	/** Run one agent attached to a pool, under its own session id. */
	const runOnPool = async (request: {
		name: string;
		task: string;
		systemPrompt: string;
		poolId?: string;
	}) => {
		const base = configProvider();
		const workerSessionId = `${rootSessionId}:swarm:${request.name}:${Date.now().toString(36)}`;
		if (request.poolId) {
			// The vendor looks the live pool up under this key, so this is what
			// makes the agent attach to the lead's snapshot rather than prefill
			// the whole prompt for itself.
			setPolykvSession(workerSessionId, {
				poolId: request.poolId,
				prefixTokens: 0,
			});
		}
		const tools: AgentTool[] = config.enableTools
			? filterDisabledTools(
					createBuiltinTools({
						cwd: config.cwd,
						telemetry: config.telemetry,
						...ToolPresets[resolveToolPresetName({ mode: config.mode })],
						executors: toolExecutors,
					}),
				)
			: [];
		const worker = createDelegatedAgent({
			kind: "subagent",
			prompt: request.systemPrompt,
			configProvider: forWorker(base, workerSessionId),
			tools,
			maxIterations: config.maxIterations,
			parentAgentId: rootSessionId,
			onEvent: lifecycle.onSubAgentEvent,
		});
		try {
			// The same gate the lead's sub-agents queue on, so a swarm and a
			// `spawn_agent` beside it share one bound rather than each getting
			// the endpoint to itself. It also carries the engine's admission
			// answer, which is what paces the round.
			const slotGate = base.getRuntimeConfig().slotGate;
			return slotGate
				? await slotGate.run(() => worker.run(request.task))
				: await worker.run(request.task);
		} finally {
			clearPolykvSession(workerSessionId);
		}
	};

	return createSpawnSwarmTool({
		pools: {
			snapshot: async () => {
				const snapshot = await snapshotPolykvSession({
					sessionId: rootSessionId,
					providerConfig,
					logger: config.logger,
				});
				if (!snapshot) {
					return undefined;
				}
				return {
					poolId: snapshot.poolId,
					release: () =>
						releasePolykvPool({
							poolId: snapshot.poolId,
							providerConfig,
							logger: config.logger,
						}),
				};
			},
			headroom: async () =>
				admissionFromCapacity(
					await readPolykvCapacity({
						sessionId: rootSessionId,
						providerConfig,
						logger: config.logger,
					}),
				)?.headroomSessions,
		},
		reduce: async (digests) => {
			// The reducer runs on the SAME pool the workers did, so it writes
			// already holding what the lead holds -- which is what lets its
			// prompt ask for brevity instead of completeness. It is one more
			// agent through the same gate, not a special case.
			if (!sharedPoolId) {
				// Unpooled: the mechanical fold is lossless and free, and a
				// model that does not share the lead's context would have to be
				// told all of it first.
				return undefined;
			}
			const result = await runOnPool({
				name: "reducer",
				systemPrompt: SWARM_REDUCER_PROMPT,
				task: digests.map(renderWorkDigest).join("\n\n---\n\n"),
				poolId: sharedPoolId,
			});
			return parseWorkDigest(result.text);
		},
		runWorker: async (request) => {
			sharedPoolId = request.poolId;
			return runOnPool(request);
		},
	}) as AgentTool;
}
