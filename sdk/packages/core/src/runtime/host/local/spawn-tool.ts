import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
	SubAgentStartContext,
} from "../../../extensions/tools/team";
import { createSpawnAgentTool } from "../../../extensions/tools/team";
import { admissionFromCapacity } from "../../../extensions/tools/team/agent-admission";
import {
	type DelegatedSandboxProvider,
	setUpDelegatedSandbox,
} from "../../../extensions/tools/team/agent-sandbox-executors";
import {
	createAgentTroubleWatch,
	roomWaitTrouble,
} from "../../../extensions/tools/team/agent-trouble";
import type { DelegatedAgentConfigProvider } from "../../../extensions/tools/team/delegated-agent";
import { createDelegatedAgent } from "../../../extensions/tools/team/delegated-agent";
import { delegatedAgentTools } from "../../../extensions/tools/team/delegated-tools";
import {
	isAdmissionEvent,
	runPlacedAgent,
} from "../../../extensions/tools/team/placed-run";
import { retryWhileSessionFull } from "../../../extensions/tools/team/session-window-retry";
import type { SpawnToolOptions } from "../../../extensions/tools/team/spawn-agent-tool";
import type { SpawnSampling } from "../../../extensions/tools/team/spawn-sampling";
import type { SwarmWorkerResult } from "../../../extensions/tools/team/spawn-swarm-tool";
import {
	createSpawnSwarmTool,
	SWARM_REDUCER_PROMPT,
} from "../../../extensions/tools/team/spawn-swarm-tool";
import { buildSubagentLayout } from "../../../extensions/tools/team/subagent-layout";
import {
	createSubagentProgress,
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
import type { AgentSandbox } from "../../sandbox/agent-sandbox";

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
	 * When present, each delegated agent runs over a private overlay of the
	 * workspace instead of sharing the lead's executors. Absent — the default —
	 * keeps the prior behaviour exactly.
	 */
	sandboxProvider?: DelegatedSandboxProvider;
	/**
	 * The live sandboxes, keyed by the spawning tool call, shared between the
	 * tool builder that creates them and the lifecycle callback that hands their
	 * changes back and disposes them. Supplied alongside `sandboxProvider`.
	 */
	agentSandboxes?: Map<string, AgentSandbox>;
	/**
	 * Whether a delegated agent may run commands at all — the "Agents can run
	 * commands" toggle. Even when true, a command runs only if the sandbox has a
	 * native launcher for the platform; when false, the shell is withheld
	 * however capable the sandbox is.
	 */
	agentCommandsEnabled?: boolean;
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
			const sandbox = context.toolCallId
				? deps.agentSandboxes?.get(context.toolCallId)
				: undefined;
			if (sandbox && context.toolCallId) {
				deps.agentSandboxes?.delete(context.toolCallId);
				// Awaited, not fire-and-forget: the hand-back appends the revision
				// list to `context.result.text`, and the spawn tool returns that same
				// object to the lead right after this callback. Detached, the lead
				// would see the agent's answer without ever being told where its work
				// went — the failure that made this whole hand-back invisible.
				await handBackAndDispose(deps, rootSessionId, context, sandbox);
			}
			void deps.invokeBackendOptional(
				"handleSubAgentEnd",
				rootSessionId,
				context,
			);
		},
	};
}

/**
 * Fold a finished agent's changed files into the lead's revision log, then
 * dispose the overlay.
 *
 * Each change becomes the next revision in the lead's own list, marked as the
 * agent's (`by: "agent:<name>"`) and never written to disk — the lead adopts it
 * with `restore_file` or leaves it. The lead's current on-disk version is seeded
 * first so the agent's version lands as a revision the lead can go back from;
 * `seed()` is a no-op when the file is already tracked, so the numbering stays
 * continuous in the one list. Best-effort throughout: a hand-back that throws
 * must not fail the agent's teardown, and the overlay is disposed either way.
 */
async function handBackAndDispose(
	deps: SpawnToolDeps,
	rootSessionId: string,
	context: SubAgentEndContext,
	sandbox: AgentSandbox,
): Promise<void> {
	try {
		const log = deps.getSession(rootSessionId)?.revisionLog;
		const workspaceRoot = deps.sandboxProvider?.workspaceRoot;
		const agentName = context.input.name ?? "agent";
		const handed: { rel: string; index: number; kind: string }[] = [];
		if (log && workspaceRoot) {
			const by = `agent:${agentName}`;
			for (const change of await sandbox.changedFiles()) {
				const absolutePath = join(workspaceRoot, change.rel);
				log.seed(absolutePath, await readIfPresent(absolutePath), "session");
				const body =
					change.kind === "deleted" || !change.overlayPath
						? undefined
						: await readIfPresent(change.overlayPath);
				const revision = log.record(absolutePath, body, by, {
					intent: `${change.kind} by delegated agent — held as a revision, not written to disk`,
				});
				if (revision) {
					handed.push({
						rel: change.rel,
						index: revision.index,
						kind: change.kind,
					});
				}
			}
		}
		// Tell the lead where the agent's work went. Without this it reads or runs
		// its own on-disk copy -- unchanged, because the agent worked on a private
		// overlay -- sees no fix, and calls the agent a liar (pandorum 2026-09-24).
		appendHandbackNote(context, agentName, handed);
	} catch {
		// A failed hand-back must not fail teardown.
	} finally {
		await sandbox.dispose().catch(() => {});
	}
}

/**
 * Append a note to the agent's answer naming the revisions its changes were
 * handed back as, so the lead adopts them with `restore_file` instead of judging
 * the agent by an on-disk copy the overlay never touched.
 */
export function appendHandbackNote(
	context: SubAgentEndContext,
	agentName: string,
	handed: { rel: string; index: number; kind: string }[],
): void {
	if (!context.result || typeof context.result.text !== "string") {
		return;
	}
	// Whether the agent gave an answer of its own -- read before we append to it.
	// An empty answer is the tell that the run ended without the agent saying
	// what it did, and the usual cause is a final turn that produced no text and
	// no *readable* tool call: a tool call emitted inside the reasoning channel
	// is swallowed, so the loop sees "no more tool calls" and finishes as
	// "completed". The lead must not read that silence as success, and if the
	// agent handed changes back it must be told they are unvetted (pandorum
	// 2026-09-24, agent "fix-manic-miner": empty summary, a revision that had
	// not converged, because the fix it worked out was lost inside its thinking).
	const answered = context.result.text.trim().length > 0;
	const finishReason = context.result.finishReason;
	const noAnswerNote =
		finishReason === "completed"
			? `\n\n---\nThis agent ended without an answer of its own: its final turn produced no text and no readable tool call. That usually means an action it attempted could not be read — for example a tool call emitted inside its reasoning — so it may not have finished. Do not treat its run as successful.`
			: `\n\n---\nThis agent ended early (${finishReason}) without an answer of its own, so it may not have finished. Do not treat its run as successful.`;
	if (handed.length === 0) {
		context.result.text += answered
			? `\n\n---\nThis agent worked on a private copy of the workspace and left your files unchanged; it recorded no file changes to hand back.`
			: noAnswerNote;
		return;
	}
	const verb = (kind: string): string =>
		kind === "deleted" ? "deleted" : kind === "created" ? "created" : "changed";
	const lines = handed
		.map(
			(h) =>
				`  - ${h.rel} — revision #${h.index} (${verb(h.kind)} by "${agentName}")`,
		)
		.join("\n");
	const first = handed[0]?.index ?? 1;
	if (!answered) {
		// Changes handed back by an agent that never said whether they work: make
		// the lead inspect them rather than adopt them on faith.
		context.result.text +=
			noAnswerNote +
			`\n\nIt did leave changes on its private copy, held for you as revisions (NOT written to disk). Because it gave no summary, these are UNVETTED and may be an unfinished or non-working edit:\n${lines}\n` +
			`Inspect one before trusting it: \`read_files\` with \`revision: "#${first}"\`, then run your own check. To apply it: \`restore_file\` with the same \`revision\`. Do not verify by reading your current copy — it does not contain these changes yet.`;
		return;
	}
	context.result.text +=
		`\n\n---\nThe agent worked on a private copy of the workspace, so your own files are UNCHANGED. Its changes are held for you as revisions, not written to disk:\n${lines}\n` +
		`To see a version: \`read_files\` with \`revision: "#${first}"\`. To apply it to your workspace: \`restore_file\` with the same \`revision\`. ` +
		`Do not verify the agent's work by reading or running your current copy of these files — it does not contain these changes yet.`;
}

async function readIfPresent(
	absolutePath: string,
): Promise<Buffer | undefined> {
	try {
		return await readFile(absolutePath);
	} catch {
		// Absent or unreadable is "no content at this revision" — a real answer.
		return undefined;
	}
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
		const toolCallId = context?.toolCallId;
		let sandboxTools: {
			executorOptions?: Awaited<
				ReturnType<typeof setUpDelegatedSandbox>
			>["executorOptions"];
			enableBash?: boolean;
		} = {};
		if (deps.sandboxProvider && toolCallId) {
			const setup = await setUpDelegatedSandbox({
				workspaceRoot: deps.sandboxProvider.workspaceRoot,
				overlayRoot: deps.sandboxProvider.overlayRootFor(toolCallId),
				...(deps.sandboxProvider.binaries
					? { binaries: deps.sandboxProvider.binaries }
					: {}),
			});
			// Registered so the lifecycle callback can hand its changes back and
			// dispose it when the agent ends.
			deps.agentSandboxes?.set(toolCallId, setup.sandbox);
			// The shell is offered only when both hold: the user allowed agent
			// commands, and the sandbox has a launcher for this platform. Either
			// missing and it is withheld — an un-launched command escapes to the
			// real workspace, and a disallowed one must not run at all.
			const allowCommands =
				setup.commandsEnabled && deps.agentCommandsEnabled === true;
			sandboxTools = {
				executorOptions: setup.executorOptions,
				...(allowCommands ? {} : { enableBash: false }),
			};
		} else if (deps.agentCommandsEnabled === false) {
			// The feature is wired and the toggle is off: the agent keeps the lead's
			// executors (no overlay), but the shell is withheld. `undefined` instead
			// means an older host that never wired the toggle, and there the agent
			// behaves exactly as before — lead executors, shell included.
			sandboxTools = { enableBash: false };
		}
		const tools: AgentTool[] = config.enableTools
			? delegatedAgentTools(
					createBuiltinTools({
						cwd: config.cwd,
						telemetry: config.telemetry,
						...ToolPresets[resolveToolPresetName({ mode: config.mode })],
						// Sandboxed agents build overlay-backed executors from options
						// and take no lead overrides; unsandboxed agents reuse the
						// lead's executors as before.
						...(sandboxTools.executorOptions
							? { executorOptions: sandboxTools.executorOptions }
							: { executors: toolExecutors }),
						...(sandboxTools.enableBash === false ? { enableBash: false } : {}),
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
		...(options?.swarm ? { swarm: options.swarm } : {}),
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
		tools?: string[];
		emitUpdate?: (update: unknown) => void;
		signal?: AbortSignal;
		takeMessage?: () => string | undefined;
		sampling?: SpawnSampling;
	}): Promise<SwarmWorkerResult> => {
		const base = configProvider();
		const workerSessionId = `${rootSessionId}:swarm:${request.name}:${Date.now().toString(36)}`;
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
							// A swarm worker runs on the lead's own executors, with no
							// overlay and no command sandbox, so per escape-critical it
							// gets no shell: an unsandboxed `run_commands` would write
							// straight to the real workspace. Sandboxing this path is
							// what would let the worker have commands back.
							enableBash: false,
							executors: toolExecutors,
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
		const progress = createSubagentProgress(request.emitUpdate, (event) =>
			lifecycle.onSubAgentEvent?.(event),
		);
		// How long it has been stuck, for the lead: after long enough without
		// progress the lead is told, once.
		const trouble = createAgentTroubleWatch({
			sessionId: rootSessionId,
			name: request.name,
			...(config.logger?.log
				? {
						logger: {
							log: (message: string) => config.logger?.log?.(message),
						},
					}
				: {}),
		});
		// Queued again while its requests wait for room on the engine.
		const stopRoomWatch = watchPolykvRoom(
			workerSessionId,
			request.emitUpdate,
			config.logger,
			(reason) => trouble.waiting(roomWaitTrouble(reason)),
		);
		// Built on the connection it runs on: a node decides the worker's
		// connection, so with nodes this runs once per placement.
		const attempt = async (
			workerConfig: DelegatedAgentConfigProvider,
			admitted: () => void,
			recoverTurnFault?: TurnFaultRecovery,
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
				task: request.task,
				pooled,
				cwd: workerConfig.getRuntimeConfig().cwd,
			});
			if (attached && request.poolId) {
				// The vendor looks the live pool up under this key, so this is
				// what makes the agent attach to the lead's snapshot rather than
				// prefill the whole prompt for itself.
				setPolykvSession(workerSessionId, {
					poolId: request.poolId,
					prefixTokens: 0,
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
				...swarmWorkerStruggleOptions(config.maxIterations),
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
			const worker = createDelegatedAgent({
				kind: "subagent",
				struggle,
				...(request.takeMessage
					? {
							consumePendingUserMessage: async () => request.takeMessage?.(),
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
				...(request.sampling ? { sampling: request.sampling } : {}),
				tools,
				maxIterations: config.maxIterations,
				parentAgentId: rootSessionId,
				...(request.signal ? { abortSignal: request.signal } : {}),
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
						...(request.signal ? { signal: request.signal } : {}),
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
			return layout.pinnedHead.length > 0
				? await worker.runWithHead(layout.pinnedHead, layout.task)
				: await worker.run(layout.task);
		};
		try {
			const placement = base.getRuntimeConfig().nodePlacement;
			if (placement) {
				// Through the spawn queue like every other agent: a refusal --
				// the lead's window full, or the admission gate's 429 -- puts the
				// worker back at the front rather than failing it.
				const outcome = await runPlacedAgent({
					placement,
					...(request.signal ? { signal: request.signal } : {}),
					...(request.emitUpdate ? { emitUpdate: request.emitUpdate } : {}),
					...(config.logger ? { logger: config.logger } : {}),
					label: `swarm worker ${request.name}`,
					onWaiting: trouble.waiting,
					run: (node, admitted, recoverTurnFault) =>
						attempt(node.configProvider, admitted, recoverTurnFault),
					// A re-placed worker starts clean on its new node: its session
					// and, if it was the last, its owner go back first.
					beforeRetry: async () => {
						await releasePolykvAgent(workerSessionId);
					},
				});
				return { ...outcome.result, placed: outcome.placed };
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
			// Off the queue the moment it has a slot, not when it ends.
			const started = () => {
				request.emitUpdate?.({ queued: false });
				return runWorker();
			};
			return slotGate ? await slotGate.run(started) : await started();
		} finally {
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
