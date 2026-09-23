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
	isAdmissionEvent,
	runPlacedAgent,
} from "../../../extensions/tools/team/placed-run";
import { retryWhileSessionFull } from "../../../extensions/tools/team/session-window-retry";
import type { SpawnToolOptions } from "../../../extensions/tools/team/spawn-agent-tool";
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
	options?: SpawnToolOptions,
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
		...(options?.swarm ? { swarm: options.swarm } : {}),
		...(options?.configuredAgents
			? { configuredAgents: options.configuredAgents }
			: {}),
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

	/**
	 * Whether two connections point at the same server.
	 *
	 * The provider and the base URL together, because a pool id is meaningful
	 * only on the engine that issued it: same provider on two hosts is two pool
	 * trees, and the same host under two providers is not a case that arises.
	 */
	const sameEndpoint = (
		a: { providerId?: string; baseUrl?: string },
		b: { providerId?: string; baseUrl?: string },
	): boolean => a.providerId === b.providerId && a.baseUrl === b.baseUrl;

	/** Run one agent attached to a pool, under its own session id. */
	const runOnPool = async (request: {
		name: string;
		task: string;
		systemPrompt: string;
		poolId?: string;
	}) => {
		const base = configProvider();
		const workerSessionId = `${rootSessionId}:swarm:${request.name}:${Date.now().toString(36)}`;
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
		// Built on the connection it runs on: a node decides the worker's
		// connection, so with nodes this runs once per placement.
		const attempt = async (
			workerConfig: DelegatedAgentConfigProvider,
			admitted: () => void,
		) => {
			// The lead's pool lives on the lead's engine. A worker placed on
			// another endpoint cannot attach to it, and sending the id there
			// would name a pool that server has never heard of -- so the pool
			// travels only with a worker that stayed home. It still shares the
			// round; it just prefills its own prefix.
			const onLeadEndpoint = sameEndpoint(
				base.getRuntimeConfig(),
				workerConfig.getRuntimeConfig(),
			);
			clearPolykvSession(workerSessionId);
			if (request.poolId && onLeadEndpoint) {
				// The vendor looks the live pool up under this key, so this is
				// what makes the agent attach to the lead's snapshot rather than
				// prefill the whole prompt for itself.
				setPolykvSession(workerSessionId, {
					poolId: request.poolId,
					prefixTokens: 0,
				});
			}
			const worker = createDelegatedAgent({
				kind: "subagent",
				prompt: request.systemPrompt,
				configProvider: forWorker(workerConfig, workerSessionId),
				tools,
				maxIterations: config.maxIterations,
				parentAgentId: rootSessionId,
				onEvent: (event) => {
					if (isAdmissionEvent(event)) {
						admitted();
					}
					lifecycle.onSubAgentEvent?.(event);
				},
			});
			return await worker.run(request.task);
		};
		try {
			const placement = base.getRuntimeConfig().nodePlacement;
			if (placement) {
				// Through the spawn queue like every other agent: a refusal --
				// the lead's window full, or the admission gate's 429 -- puts the
				// worker back at the front rather than failing it.
				return (
					await runPlacedAgent({
						placement,
						...(config.logger ? { logger: config.logger } : {}),
						label: `swarm worker ${request.name}`,
						run: (node, admitted) => attempt(node.configProvider, admitted),
					})
				).result;
			}
			// The same gate the lead's sub-agents queue on, so a swarm and a
			// `spawn_agent` beside it share one bound rather than each getting
			// the endpoint to itself. It also carries the engine's admission
			// answer, which is what paces the round.
			const slotGate = base.getRuntimeConfig().slotGate;
			// Refused because the LEAD's window is full, not the server's: a
			// pooled worker is charged to the session that owns the pool, so
			// the room comes back when a running worker finishes. Waiting is
			// the answer; failing the worker throws away a task the round was
			// asked to do.
			const runWorker = () =>
				retryWhileSessionFull(() => attempt(base, () => {}), {
					onRetry: (retry, waitMs) =>
						config.logger?.log?.(
							`[PolyKV] ${request.name} refused: the session's window is full; waiting ${
								waitMs / 1000
							}s for a worker to finish (attempt ${retry})`,
						),
				});
			return slotGate ? await slotGate.run(runWorker) : await runWorker();
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
					// A borrowed pool is the lead's root, pinned and serving the
					// conversation. Releasing it here would unpin the prefix the
					// lead is still using and cost it a full prefill on its next
					// turn -- worse than the unpooled round the borrow avoided.
					release: snapshot.borrowed
						? async () => undefined
						: () =>
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
			// What lets the round grow. It asks the same gate the workers
			// queue on, and asks WITHOUT taking: the worker this admits
			// acquires through that gate itself, so a consuming probe here
			// would book every worker twice and halve the swarm.
			//
			// It also inherits the gate's read discipline, which is the part
			// that matters on c7: a fresh `GET /capacity` folds the engine's
			// admission learner, so the answer is re-read when an agent
			// finishes and never merely because a tick came round.
			admit: async () => {
				const runtime = configProvider().getRuntimeConfig();
				// With nodes, the spawn queue is the pacing, and the question is
				// whether it has room now: nobody waiting means the last worker
				// found a node. A worker placed synchronously registers as a
				// waiter before this is asked again, so a round never launches
				// ahead of what the nodes take. An uncapped node opens for the
				// next worker once the engine admits the last one, which is what
				// lets `count: "max"` grow with the servers instead of stopping
				// at one. Asking the lead endpoint's gate as well would bound the
				// round by ONE node's capacity.
				if (runtime.nodePlacement) {
					return runtime.nodePlacement.waiting === 0;
				}
				const slotGate = runtime.slotGate;
				return slotGate ? await slotGate.canAdmitMore() : true;
			},
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
