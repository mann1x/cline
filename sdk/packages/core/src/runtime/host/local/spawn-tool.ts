import {
	clearPolykvSession,
	releasePolykvAgent,
	setPolykvSession,
} from "@cline/llms";
import type { AgentEvent, AgentTool, TurnFaultRecovery } from "@cline/shared";
import {
	isPolykvProvider,
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
	SubAgentSettledContext,
	SubAgentStartContext,
} from "../../../extensions/tools/team";
import { createSpawnAgentTool } from "../../../extensions/tools/team";
import { admissionFromCapacity } from "../../../extensions/tools/team/agent-admission";
import {
	type AgentCheck,
	createDelegatedAgentCheck,
	describeAgentCheck,
} from "../../../extensions/tools/team/agent-check";
import {
	createDelegatedAgentLifetime,
	type DelegatedRunOutcome,
	runDelegatedWithCap,
} from "../../../extensions/tools/team/agent-iteration-cap";
import { reportWaits } from "../../../extensions/tools/team/agent-rounds";
import type { DelegatedSandboxProvider } from "../../../extensions/tools/team/agent-sandbox-executors";
import {
	createAgentTroubleWatch,
	roomWaitTrouble,
} from "../../../extensions/tools/team/agent-trouble";
import type { DelegatedAgentConfigProvider } from "../../../extensions/tools/team/delegated-agent";
import { createDelegatedAgent } from "../../../extensions/tools/team/delegated-agent";
import {
	commandLauncherOf,
	commandSandboxOf,
	type DelegatedSandboxes,
	type DelegatedWorkspace,
	type HandedRevision,
	handbackNote,
} from "../../../extensions/tools/team/delegated-sandboxes";
import { delegatedAgentTools } from "../../../extensions/tools/team/delegated-tools";
import {
	isAdmissionEvent,
	resumePlacement,
	runPlacedAgent,
} from "../../../extensions/tools/team/placed-run";
import { retryWhileSessionFull } from "../../../extensions/tools/team/session-window-retry";
import type { SpawnToolOptions } from "../../../extensions/tools/team/spawn-agent-tool";
import {
	requeueNote,
	withRevisedInstructions,
} from "../../../extensions/tools/team/spawn-agent-tool";
import {
	drawSpawnSampling,
	primeModelTemperature,
	type RealizedSpawnSampling,
	type SpawnSampling,
} from "../../../extensions/tools/team/spawn-sampling";
import type { SwarmWorkerResult } from "../../../extensions/tools/team/spawn-swarm-tool";
import {
	createSpawnSwarmTool,
	SWARM_REDUCER_PROMPT,
} from "../../../extensions/tools/team/spawn-swarm-tool";
import type {
	SubagentCancellationRegistration,
	SubagentRequeueCarry,
} from "../../../extensions/tools/team/subagent-cancellation";
import { buildSubagentLayout } from "../../../extensions/tools/team/subagent-layout";
import {
	compactionLogger,
	createSubagentProgress,
	reportSubagentModel,
	reportSubagentSampling,
	requeued,
	watchPolykvRoom,
} from "../../../extensions/tools/team/subagent-progress";
import { createTurnFaultRecovery } from "../../../extensions/tools/team/turn-fault-recovery";
import {
	createWorkerStruggleSupervisor,
	WORKER_STRUGGLE_MIN_ITERATION,
	type WorkerStruggleOptions,
} from "../../../runtime/safety/worker-struggle";
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

/**
 * Where a swarm worker's turn-count nudge sits, relative to its cap.
 *
 * Half the cap: late enough that a worker still reading the problem is left
 * alone, early enough that the nudge arrives with turns to spare. It is a
 * nudge only -- on the replayed swarms the longest workers all answered in the
 * end, so the turn count is not evidence enough to stop one. With no cap set
 * the supervisor's own default, calibrated to a ~40-iteration worker, stands.
 */
function swarmWorkerStruggleOptions(
	maxIterations?: number,
): Pick<WorkerStruggleOptions, "nudgeAfterIterations"> {
	if (typeof maxIterations !== "number" || maxIterations <= 0) {
		return {};
	}
	return {
		nudgeAfterIterations: Math.max(
			WORKER_STRUGGLE_MIN_ITERATION,
			Math.round(maxIterations * 0.5),
		),
	};
}

export interface SpawnToolDeps {
	getSession(sessionId: string): ActiveSession | undefined;
	subAgentStarts: SubAgentStartTracker;
	onAgentEvent(
		rootSessionId: string,
		config: CoreSessionConfig,
		event: AgentEvent,
	): void;
	invokeBackendOptional(method: string, ...args: unknown[]): Promise<void>;
	/**
	 * The session's delegated-agent workspaces. When present, every agent this
	 * builds -- a `spawn_agent` agent and each swarm worker -- runs over a
	 * private overlay of the workspace instead of the lead's executors, and gets
	 * a shell only where the sandbox can launch one and the user allowed agent
	 * commands. Absent, an agent keeps the lead's executors and gets no shell at
	 * all: an unsandboxed command would run against the real workspace.
	 */
	sandboxes?: DelegatedSandboxes;
}

/** Kept for hosts that name the provider type from here. */
export type { DelegatedSandboxProvider };

/**
 * The builtin-tool options that bind a delegated agent to its workspace: the
 * overlay-backed executors, and the shell only when the workspace allows it.
 * Without a workspace, the lead's executors and never a shell.
 */
export function delegatedToolOptions(
	workspace: DelegatedWorkspace | undefined,
	leadExecutors: Partial<ToolExecutors> | undefined,
): {
	executorOptions?: DelegatedWorkspace["executorOptions"];
	executors?: Partial<ToolExecutors>;
	enableBash?: false;
} {
	if (!workspace) {
		return { executors: leadExecutors, enableBash: false };
	}
	return {
		executorOptions: workspace.executorOptions,
		...(workspace.allowCommands ? {} : { enableBash: false }),
	};
}

export interface SessionSubAgentLifecycleCallbacks {
	onSubAgentEvent: (event: AgentEvent) => void;
	onSubAgentStart: (context: SubAgentStartContext) => void;
	onSubAgentEnd: (context: SubAgentEndContext) => void;
	onSubAgentSettled: (context: SubAgentSettledContext) => Promise<void>;
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
		onSubAgentEnd: async (context) => {
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
			// Tear down the agent's sandbox: fold its changed files into the lead's
			// revision log, then dispose the overlay.
			if (context.toolCallId && deps.sandboxes?.has(context.toolCallId)) {
				const agentName = context.input.name ?? "agent";
				// Awaited, not fire-and-forget: the hand-back appends the revision
				// list to `context.result.text`, and the spawn tool returns that same
				// object to the lead right after this callback. Detached, the lead
				// would see the agent's answer without ever being told where its work
				// went — the failure that made this whole hand-back invisible.
				const handed = await deps.sandboxes.close(
					context.toolCallId,
					agentName,
				);
				appendHandbackNote(context, agentName, handed);
			}
			void deps.invokeBackendOptional(
				"handleSubAgentEnd",
				rootSessionId,
				context,
			);
		},
		// The paths `onSubAgentEnd` never sees -- an agent that failed or was
		// stopped before it started -- still opened a workspace. Its changes
		// (none, usually) go back and the overlay is disposed; after a normal
		// end this finds nothing open and does nothing.
		onSubAgentSettled: async (context) => {
			if (context.toolCallId) {
				await deps.sandboxes?.close(context.toolCallId, context.name);
			}
		},
	};
}

/**
 * Append a note to the agent's answer naming the revisions its changes were
 * handed back as, so the lead adopts them with `restore_file` instead of judging
 * the agent by an on-disk copy the overlay never touched.
 */
export function appendHandbackNote(
	context: SubAgentEndContext,
	agentName: string,
	handed: readonly HandedRevision[],
): void {
	if (!context.result || typeof context.result.text !== "string") {
		return;
	}
	context.result.text += handbackNote(
		context.result.text,
		context.result.finishReason,
		agentName,
		handed,
	);
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
	const createSubAgentTools = async (
		_input: unknown,
		context?: { toolCallId?: string },
	): Promise<AgentTool[]> => {
		// A delegated agent works over a private overlay when the host provides a
		// sandbox. Its file tools resolve through the overlay and its shell is
		// rooted at the launcher, so none of the lead's disk-backed executors are
		// passed through — that isolation is the whole point. Without a provider,
		// or without a tool-call id to key the overlay on, it behaves as before.
		// Registered under the tool-call id so the lifecycle callback can hand
		// its changes back and dispose it when the agent ends. Without a
		// tool-call id to key it on there is no hand-back, so no workspace
		// either -- and then no shell.
		const toolCallId = context?.toolCallId;
		const workspace =
			deps.sandboxes && toolCallId && config.enableTools
				? await deps.sandboxes.open(toolCallId)
				: undefined;
		const tools: AgentTool[] = config.enableTools
			? delegatedAgentTools(
					createBuiltinTools({
						cwd: config.cwd,
						telemetry: config.telemetry,
						...ToolPresets[resolveToolPresetName({ mode: config.mode })],
						// Sandboxed agents build overlay-backed executors from options
						// and take no lead overrides; the shell is last, so it beats
						// the mode preset.
						...delegatedToolOptions(workspace, toolExecutors),
					}),
					config.extraTools,
				)
			: [];
		if (config.enableSpawnAgent) {
			tools.push(
				createSessionSpawnTool(deps, config, rootSessionId, toolExecutors),
			);
		}
		return filterDisabledTools(tools);
	};

	return createSpawnAgentTool({
		// The lead's own spawn tool (built with options) is the one its rounds
		// run agents again through; a sub-agent's nested one is not.
		...(options ? { sessionId: rootSessionId } : {}),
		...(options?.swarm ? { swarm: options.swarm } : {}),
		...(options?.teammates ? { teammates: true } : {}),
		...(options?.configuredAgents
			? { configuredAgents: options.configuredAgents }
			: {}),
		...(options?.configuredAgentConfigs
			? { configuredAgentConfigs: options.configuredAgentConfigs }
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
		// An agent's check runs under its own launcher, in its own overlay;
		// with none -- no sandbox, or agent commands off -- it is not run.
		commandSandboxFor: (toolCallId) =>
			commandSandboxOf(deps.sandboxes, toolCallId),
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

/**
 * Carry a worker's handed-back revisions on its result, or on the error it
 * failed with, for the swarm's report (`spawn-swarm-tool.ts`, `handback`).
 */
function attachHandback(
	carrier: unknown,
	handed: readonly HandedRevision[],
): void {
	if (carrier && typeof carrier === "object") {
		(carrier as { handback?: readonly HandedRevision[] }).handback = handed;
	}
}

/** Pass the reducer's handed-back revisions, if any, to the swarm's report. */
function reportHandback(
	reducer:
		| { handedBack(name: string, handed: readonly HandedRevision[]): void }
		| undefined,
	carrier: unknown,
): void {
	const handed =
		carrier && typeof carrier === "object"
			? (carrier as { handback?: readonly HandedRevision[] }).handback
			: undefined;
	if (handed) {
		reducer?.handedBack("reducer", handed);
	}
}

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
		tools?: string[];
		emitUpdate?: (update: unknown) => void;
		signal?: AbortSignal;
		takeMessage?: () => string | undefined;
		sampling?: SpawnSampling;
		maxIterations?: number;
		check?: AgentCheck;
		control?: SubagentCancellationRegistration;
	}): Promise<SwarmWorkerResult> => {
		const control = request.control;
		// Per segment: a requeue ends one and starts the next on a new signal.
		const signalNow = () => control?.signal ?? request.signal;
		const base = configProvider();
		const workerSessionId = `${rootSessionId}:swarm:${request.name}:${Date.now().toString(36)}`;
		// Its own private workspace, exactly as a lone `spawn_agent` gets: file
		// tools over an overlay, the shell only where the sandbox can launch
		// one and the user allowed it. Keyed per worker, never per call -- two
		// workers of one round must not see each other's writes. The random
		// tail is what keeps two same-named workers of one millisecond apart.
		const sandboxKey = `${workerSessionId}:${Math.random().toString(36).slice(2, 8)}`;
		const workspace =
			deps.sandboxes && config.enableTools
				? await deps.sandboxes.open(sandboxKey)
				: undefined;
		// No questions to the user: a worker's transcript is discarded and
		// nobody is watching it, so a question from one blocked the round on a
		// prompt the user could not place -- measured on pandorum, a worker
		// asked, and the lead then sat "generating" for as long as it waited.
		// Its `ask_question` ends it and goes to the lead instead
		// (`delegated-tools.ts`), as every delegated agent's does.
		const tools: AgentTool[] = config.enableTools
			? filterDisabledTools(
					delegatedAgentTools(
						createBuiltinTools({
							cwd: config.cwd,
							telemetry: config.telemetry,
							...ToolPresets[resolveToolPresetName({ mode: config.mode })],
							// Over its overlay when it has one; otherwise the lead's
							// executors and no shell, since an unsandboxed
							// `run_commands` would write straight to the real
							// workspace (escape-critical).
							...delegatedToolOptions(workspace, toolExecutors),
						}),
						config.extraTools,
					),
				).filter(
					(tool) =>
						// A configured agent's own list, when the worker is one.
						request.tools === undefined || request.tools.includes(tool.name),
				)
			: [];
		// The worker's row: what it is running and writing, as a lone
		// `spawn_agent` reports it.
		const progress = createSubagentProgress(
			request.emitUpdate,
			(event) => lifecycle.onSubAgentEvent?.(event),
			Date.now,
			{
				onCompaction: compactionLogger(
					`swarm worker ${request.name}`,
					config.logger,
				),
			},
		);
		// How long it has been stuck, for the lead: after long enough without
		// progress the lead is told, once.
		const trouble = reportWaits(
			createAgentTroubleWatch({
				sessionId: rootSessionId,
				name: request.name,
				...(config.logger?.log
					? {
							logger: {
								log: (message: string) => config.logger?.log?.(message),
							},
						}
					: {}),
			}),
			request.emitUpdate,
			control,
		);
		// Queued again while its requests wait for room on the engine.
		const stopRoomWatch = watchPolykvRoom(
			workerSessionId,
			request.emitUpdate,
			config.logger,
			(reason) => trouble.waiting(roomWaitTrouble(reason)),
		);
		// Its cap, and its check under its own launcher when it has one: a
		// worker with no sandboxed shell has its check reported as not run.
		const maxIterations = request.maxIterations ?? config.maxIterations;
		const wrapSpawn = request.check ? commandLauncherOf(workspace) : undefined;
		const task = request.check
			? `${request.task}\n\n${describeAgentCheck(request.check, wrapSpawn !== undefined)}`
			: request.task;
		// Held past the round when the worker is detached at its cap.
		const lifetime = createDelegatedAgentLifetime();
		let capOutcome: DelegatedRunOutcome | undefined;
		let agentId: string | undefined;
		// The worker's random choices, made once: a re-placement runs the same
		// seed and the same position in the temperature range.
		const sampling = drawSpawnSampling(request.sampling);
		let realizedSampling: RealizedSpawnSampling | undefined;
		// Built on the connection it runs on: a node decides the worker's
		// connection, so with nodes this runs once per placement.
		const attempt = async (
			workerConfig: DelegatedAgentConfigProvider,
			admitted: () => void,
			recoverTurnFault: TurnFaultRecovery | undefined,
			carry: SubagentRequeueCarry | undefined,
			nodeId?: string,
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
			const attached = Boolean(request.poolId && onLeadEndpoint);
			// With no lead pool to attach to, a worker on a PolyKV node joins
			// that node's pool tree the way a `spawn_agent` worker does: the
			// vendor books one owner window for the group and charges every
			// worker to it. Without it each worker was admitted as a session of
			// its own at the full per-session window -- 262,144 cells apiece on
			// a 1M server, four at a time, and the fifth refused 120 times.
			const connection = workerConfig.getConnectionConfig();
			reportSubagentModel(request.emitUpdate, {
				providerId: connection.providerId,
				modelId: connection.modelId,
				knownModels: connection.knownModels,
				maxIterations: config.maxIterations,
			});
			const pooled =
				!attached &&
				isPolykvProvider({
					providerId: connection.providerId,
					baseUrl: connection.baseUrl,
					polykv: (connection.providerConfig as { polykv?: never } | undefined)
						?.polykv,
				});
			const layout = await buildSubagentLayout({
				instructions: request.systemPrompt,
				task: withRevisedInstructions(task, control?.instructions),
				pooled,
				cwd: workerConfig.getRuntimeConfig().cwd,
			});
			// A random temperature is drawn around the model's own.
			await primeModelTemperature(sampling, connection);
			if (attached && request.poolId) {
				// The vendor looks the live pool up under this key, so this is
				// what makes the agent attach to the lead's snapshot rather than
				// prefill the whole prompt for itself.
				setPolykvSession(workerSessionId, {
					poolId: request.poolId,
					prefixTokens: 0,
					// The lead's, not the worker's: a compaction inside the
					// worker must not fork it at 0 and release it from under
					// the lead and the rest of the round.
					layout: "borrowed",
				});
			}
			// A headless worker gets the struggle layer the lead has always had,
			// with a terminal action a worker can take: nudge once ("commit your
			// best finding now as a SUMMARY"), and stop it only if its thinking
			// keeps running out its budget after that. The stop is not data loss
			// -- `digestOf` recovers whatever the worker produced, its reasoning
			// tail included. Fresh per attempt so a re-placed worker starts
			// watching from zero. See `worker-struggle.ts` for the replay that
			// set what fires and what stops.
			const struggle = createWorkerStruggleSupervisor({
				...swarmWorkerStruggleOptions(maxIterations),
				// What the server appends to reasoning it cut at the budget, when
				// the session knows it; without it the supervisor reads the
				// generic admission in the reasoning's tail.
				...(config.compaction?.cappedThinkingBudgetMessage
					? {
							thinkingBudgetMessage:
								config.compaction.cappedThinkingBudgetMessage,
						}
					: {}),
				onTransition: (phase, reason) =>
					config.logger?.log?.(
						`[swarm] ${request.name}: worker ${phase} (${reason})`,
					),
			});
			const check = request.check
				? createDelegatedAgentCheck({
						check: request.check,
						cwd: deps.sandboxes?.workspaceRoot ?? config.cwd,
						...(wrapSpawn ? { wrapSpawn } : {}),
					})
				: undefined;
			const worker = createDelegatedAgent({
				kind: "subagent",
				struggle,
				...(check ? { check } : {}),
				...(request.takeMessage || control
					? {
							consumePendingUserMessage: async () =>
								(control?.takeMessage ?? request.takeMessage)?.(),
						}
					: {}),
				prompt: layout.systemPrompt,
				// The worker's engine session, for its compaction as well as its
				// requests. Without it the compaction pipeline ran in the LEAD's
				// name, and on a node the lead is not on it pinned a root pool
				// for a session holding no allocation there -- unowned, pinned,
				// and never released.
				engineSessionId: workerSessionId,
				...(pooled
					? { polykvWorker: { group: rootSessionId, layers: layout.layers } }
					: {}),
				pinnedHead: layout.pinnedHead,
				configProvider: forWorker(workerConfig, workerSessionId),
				// The lead's sampler for this worker, applied over whichever
				// node's connection it was placed on.
				...(sampling
					? {
							sampling,
							onSampling: (realized: RealizedSpawnSampling) => {
								realizedSampling = realized;
								reportSubagentSampling(request.emitUpdate, realized);
							},
						}
					: {}),
				tools,
				maxIterations,
				parentAgentId: rootSessionId,
				...(signalNow() ? { abortSignal: signalNow() } : {}),
				onEvent: (event) => {
					if (isAdmissionEvent(event)) {
						admitted();
						trouble.progressed();
					}
					progress.observe(event);
				},
				// A server restart or a refusal is waited out, never the answer.
				recoverTurnFault:
					recoverTurnFault ??
					createTurnFaultRecovery({
						label: `swarm worker ${request.name}`,
						onWaiting: trouble.waiting,
						baseUrl: () => connection.baseUrl,
						headers: () => connection.headers,
						...(signalNow() ? { signal: signalNow() } : {}),
						...(request.emitUpdate ? { emitUpdate: request.emitUpdate } : {}),
						...(config.logger?.log
							? {
									logger: {
										log: (message: string) => config.logger?.log?.(message),
									},
								}
							: {}),
					}),
			});
			agentId = worker.getAgentId?.();
			// Its transcript, should the lead requeue it.
			control?.track(worker);
			// At its cap it waits for the lead, work kept.
			const outcome = await runDelegatedWithCap({
				agent: worker,
				start: async () => {
					if (carry && carry.messages.length > 0) {
						// Requeued: it carries on from its own transcript.
						worker.restore(carry.messages as never);
						return await worker.continue(requeueNote(carry.reason));
					}
					return layout.pinnedHead.length > 0
						? await worker.runWithHead(layout.pinnedHead, layout.task)
						: await worker.run(layout.task);
				},
				name: request.name,
				...(maxIterations !== undefined ? { maxIterations } : {}),
				sessionId: rootSessionId,
				...(control?.id ? { cancelId: control.id } : {}),
				...(signalNow() ? { signal: signalNow() } : {}),
				...(request.emitUpdate ? { emitUpdate: request.emitUpdate } : {}),
				...(check ? { check } : {}),
				// While it waits, its engine session goes back, and so does its
				// attachment to the round's pool: the pool is released when the
				// round ends, and a worker resumed after that must not name it.
				releaseEngineSession: async () => {
					clearPolykvSession(workerSessionId);
					await releasePolykvAgent(workerSessionId);
				},
				lifetime,
				// Resumed after the round returned: back through its placement.
				resumeThrough: resumePlacement({
					...(nodeId && base.getRuntimeConfig().nodePlacement
						? {
								placement: base.getRuntimeConfig().nodePlacement,
								nodeId,
							}
						: {}),
					...(!nodeId && base.getRuntimeConfig().slotGate
						? { slotGate: base.getRuntimeConfig().slotGate }
						: {}),
					signal: signalNow,
				}),
			});
			capOutcome = outcome;
			return outcome.result;
		};
		/** What the cap and the check add to the worker's result. */
		const withCapOutcome = (value: SwarmWorkerResult): SwarmWorkerResult => ({
			...value,
			...(agentId ? { agentId } : {}),
			...(capOutcome?.maxIterations !== undefined
				? { maxIterations: capOutcome.maxIterations }
				: {}),
			...(capOutcome?.stopReason ? { stopReason: capOutcome.stopReason } : {}),
			...(capOutcome?.state ? { state: capOutcome.state } : {}),
			...(capOutcome?.oracle ? { oracle: capOutcome.oracle } : {}),
		});
		let result: SwarmWorkerResult | undefined;
		let failure: unknown;
		// A requeue ends a segment and the next carries its transcript; the
		// overlay above is the worker's for all of them.
		const continuable = <T>(
			run: (carry: SubagentRequeueCarry | undefined) => Promise<T>,
		): Promise<T> =>
			control
				? control.continuable(run, async (carry) => {
						clearPolykvSession(workerSessionId);
						await requeued(request.emitUpdate, workerSessionId, carry.reason);
					})
				: run(undefined);
		try {
			const placement = base.getRuntimeConfig().nodePlacement;
			if (placement) {
				// Through the spawn queue like every other agent: a refusal --
				// the lead's window full, or the admission gate's 429 -- puts the
				// worker back at the front rather than failing it.
				const outcome = await continuable((carry) =>
					runPlacedAgent({
						placement,
						...(signalNow() ? { signal: signalNow() } : {}),
						...(request.emitUpdate ? { emitUpdate: request.emitUpdate } : {}),
						...(config.logger ? { logger: config.logger } : {}),
						label: `swarm worker ${request.name}`,
						onWaiting: trouble.waiting,
						...(carry
							? {
									requeued: carry.avoidNodeId
										? { avoidNodeId: carry.avoidNodeId }
										: {},
								}
							: {}),
						run: (node, admitted, recoverTurnFault) =>
							attempt(
								node.configProvider,
								admitted,
								recoverTurnFault,
								carry,
								node.nodeId,
							),
						// A re-placed worker starts clean on its new node: its session
						// and, if it was the last, its owner go back first.
						beforeRetry: async () => {
							await releasePolykvAgent(workerSessionId);
						},
					}),
				);
				result = withCapOutcome({
					...outcome.result,
					placed: outcome.placed,
					...(realizedSampling ? { sampling: realizedSampling } : {}),
				});
				return result;
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
			const runWorker = (carry: SubagentRequeueCarry | undefined) =>
				retryWhileSessionFull(() => attempt(base, () => {}, undefined, carry), {
					onRetry: (retry, waitMs) =>
						config.logger?.log?.(
							`[PolyKV] ${request.name} refused: the session's window is full; waiting ${
								waitMs / 1000
							}s for a worker to finish (attempt ${retry})`,
						),
				});
			// Off the queue the moment it has a slot, not when it ends.
			result = withCapOutcome(
				await continuable((carry) => {
					const started = () => {
						request.emitUpdate?.({ queued: false });
						return runWorker(carry);
					};
					return slotGate ? slotGate.run(started) : started();
				}),
			);
			if (realizedSampling) {
				result = { ...result, sampling: realizedSampling };
			}
			return result;
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			// On every path -- or, for a worker detached at its cap, once it
			// is finally done: its workspace, pool session and engine session
			// are what it would go on with.
			await lifetime.end(async () => {
				// On every path -- finished, failed, stopped, cancelled -- the worker's
				// changes go back to the lead as revisions and its overlay goes. The
				// revisions travel with the result (or the error) so the swarm's
				// report can say where the work went.
				if (workspace) {
					const handed = await deps.sandboxes
						?.close(sandboxKey, request.name)
						.catch(() => [] as HandedRevision[]);
					attachHandback(result ?? failure, handed ?? []);
				}
				clearPolykvSession(workerSessionId);
				stopRoomWatch();
				trouble.dispose();
				// Its engine session goes back the moment it ends, and its owner
				// window with it if it was the last agent on it. The swarm path
				// never did this: `spawn_agent` and configured agents released,
				// swarm workers did not, so every owner a swarm opened stayed
				// booked until the engine's 300 s idle TTL -- on 2026-09-24 four
				// owners held all 1,048,576 cells of 8240.
				const released = await releasePolykvAgent(workerSessionId).catch(
					() => undefined,
				);
				for (const failure of released?.failed ?? []) {
					config.logger?.log?.(
						`[PolyKV] could not close engine session ${failure.sessionId}: ${failure.error}`,
					);
				}
			});
		}
	};

	return createSpawnSwarmTool({
		sessionId: rootSessionId,
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
		reduce: async (digests, reducer) => {
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
			// Sandboxed like a worker: whatever it changed goes back to the lead
			// as its revisions, and the report names them -- on failure too.
			let result: SwarmWorkerResult;
			try {
				result = await runOnPool({
					name: "reducer",
					systemPrompt: SWARM_REDUCER_PROMPT,
					task: digests.map(renderWorkDigest).join("\n\n---\n\n"),
					poolId: sharedPoolId,
				});
			} catch (error) {
				reportHandback(reducer, error);
				throw error;
			}
			reportHandback(reducer, result);
			return parseWorkDigest(result.text);
		},
		runWorker: async (request) => {
			sharedPoolId = request.poolId;
			return runOnPool(request);
		},
	}) as AgentTool;
}
