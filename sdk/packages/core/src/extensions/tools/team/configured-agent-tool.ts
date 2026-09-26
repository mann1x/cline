import { releasePolykvAgent } from "@cline/llms";
import {
	type AgentEvent,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	type BasicLogger,
	createTool,
	type HookErrorMode,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	type TurnFaultRecovery,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import type { OracleSpawnWrapper } from "../../../runtime/atomic/oracle";
import { isPolykvProvider } from "../../context/polykv-session";
import { createDelegatedAgentCheck, describeAgentCheck } from "./agent-check";
import { AGENT_CONTROLS_NOTE, AgentControlFields } from "./agent-controls";
import {
	createDelegatedAgentLifetime,
	type DelegatedRunOutcome,
	runDelegatedWithCap,
} from "./agent-iteration-cap";
import { summarizeForLead } from "./agent-reports";
import { agentEndpointKey } from "./agent-slot-gate";
import { createAgentTroubleWatch, roomWaitTrouble } from "./agent-trouble";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import {
	createDelegatedAgent,
	createDelegatedAgentConfigProvider,
	type DelegatedAgentConfigProvider,
	type DelegatedAgentRuntimeConfig,
} from "./delegated-agent";
import { readDelegationHooks } from "./delegation-call-hooks";
import { isAdmissionEvent, runPlacedAgent } from "./placed-run";
import {
	awaitingLeadNote,
	controlFields,
	controlReport,
	type SpawnAgentOutput,
	type SubAgentEndContext,
	type SubAgentSettledContext,
	type SubAgentStartContext,
} from "./spawn-agent-tool";
import {
	drawSpawnSampling,
	primeModelTemperature,
	type RealizedSpawnSampling,
	readSpawnSampling,
	SPAWN_SAMPLING_NOTE,
	SpawnSamplingFields,
} from "./spawn-sampling";
import {
	registerSubagentCancellation,
	subagentCancelId,
} from "./subagent-cancellation";
import {
	createSubagentProgress,
	DELEGATION_PACING_NOTE,
	reportSubagentModel,
	reportSubagentSampling,
	restarted,
	watchPolykvRoom,
} from "./subagent-progress";
import { createTurnFaultRecovery } from "./turn-fault-recovery";

const CONFIGURED_AGENT_TOOL_NAME_PREFIX = "subagent_";
const CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH = 64;

const ConfiguredAgentInputSchema = z.object({
	prompt: z.string().trim().min(1).describe("Task for the subagent to perform"),
	/** The lead's sampler for this one agent, over its model's own. */
	...SpawnSamplingFields,
	/** Its iteration cap (over its file's) and its check. */
	...AgentControlFields,
});

export type ConfiguredAgentInput = z.infer<typeof ConfiguredAgentInputSchema>;

export interface ConfiguredAgentToolDescriptor {
	toolName: string;
	config: ConfiguredAgentConfig;
}

/**
 * The connection a provider other than the session's runs on.
 *
 * Supplied by the host because only the host knows where its provider store
 * lives: the CLI's follows `--config`, and the extension's follows its own data
 * directory, so core reaching for a default path would read the wrong file in
 * one of them and silently call the wrong server with the wrong key.
 */
export interface AgentProviderConnection {
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	providerConfig?: unknown;
	knownModels?: DelegatedAgentRuntimeConfig["knownModels"];
}

/**
 * A saved API configuration profile, resolved.
 *
 * Carries the provider and the model as well as the connection, because that is
 * what a profile is: the user picked a provider, a model and the settings around
 * them and gave the three of them a name. An agent naming a profile is therefore
 * saying more than an agent naming a provider, and gets the model with it.
 */
export interface AgentProfileConnection extends AgentProviderConnection {
	providerId: string;
	modelId?: string;
}

export interface ConfiguredAgentToolConfig {
	/**
	 * Optional logger, for the things only the log can carry.
	 *
	 * Specifically a node that could not run an agent at all: the agent is
	 * re-queued elsewhere and succeeds, so the run looks clean, and without a
	 * line here the misconfigured node is invisible until someone counts the
	 * spawns.
	 */
	logger?: BasicLogger;
	configProvider: DelegatedAgentConfigProvider;
	agents: ConfiguredAgentConfig[];
	/**
	 * Resolves a second provider's own connection, for an agent whose
	 * frontmatter names one.
	 *
	 * Without it an agent on another provider is refused rather than run: it
	 * used to inherit the lead's base URL, key and context window along with the
	 * new provider id, which is a request to the wrong server that fails as an
	 * auth error or, worse, succeeds against a model nobody chose.
	 */
	resolveProviderConnection?: (
		providerId: string,
	) => AgentProviderConnection | undefined;
	/**
	 * Resolves a saved API configuration profile by name, for an agent whose
	 * frontmatter names one.
	 *
	 * Host-supplied for the same reason as the provider resolver: only the host
	 * knows where its profiles live. A host with no profiles at all supplies
	 * nothing, and an agent naming one is refused rather than run on the
	 * session's connection under a name the user chose for something else.
	 */
	resolveProfileConnection?: (
		name: string,
	) => AgentProfileConnection | undefined;
	/**
	 * The profile names this host currently has, for the refusal message.
	 *
	 * A profile can be deleted long after an agent was written to name it, and
	 * the agent file is not rewritten when that happens. Being told the name is
	 * unresolvable answers "what went wrong" and not "what do I put instead",
	 * which is the question the user is actually left holding.
	 */
	listProfileNames?: () => string[];
	createSubAgentTools?: (
		agent: ConfiguredAgentConfig,
		input: ConfiguredAgentInput,
		context: AgentToolContext,
	) => AgentTool[] | Promise<AgentTool[]>;
	onSubAgentEvent?: (event: AgentEvent) => void;
	hookErrorMode?: HookErrorMode;
	toolPolicies?: Record<string, ToolPolicy>;
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	/** See `SpawnAgentToolConfig.onSubAgentSettled`. */
	onSubAgentSettled?: (context: SubAgentSettledContext) => void | Promise<void>;
	/** See `SpawnAgentToolConfig.commandSandboxFor`: where its check runs. */
	commandSandboxFor?: (
		toolCallId: string | undefined,
	) => { wrapSpawn: OracleSpawnWrapper; cwd: string } | undefined;
}

function sanitizeAgentName(name: string): string {
	let result = "";
	let lastWasUnderscore = true;

	for (const char of name.trim().toLowerCase()) {
		const code = char.charCodeAt(0);
		const isAllowed =
			(code >= 97 && code <= 122) || (code >= 48 && code <= 57) || char === "_";

		if (!isAllowed || char === "_") {
			if (!lastWasUnderscore) {
				result += "_";
				lastWasUnderscore = true;
			}
			continue;
		}

		result += char;
		lastWasUnderscore = false;
	}

	return lastWasUnderscore ? result.slice(0, -1) : result;
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export function buildConfiguredAgentToolName(agentName: string): string {
	const sanitized = sanitizeAgentName(agentName) || "agent";
	const hashSuffix = hashString(agentName).slice(0, 6);
	const base = `${CONFIGURED_AGENT_TOOL_NAME_PREFIX}${sanitized}`;

	if (base.length <= CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH) {
		return base;
	}

	const maxBodyLength =
		CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH -
		CONFIGURED_AGENT_TOOL_NAME_PREFIX.length -
		hashSuffix.length -
		1;
	const body = sanitized.slice(0, Math.max(1, maxBodyLength));
	return `${CONFIGURED_AGENT_TOOL_NAME_PREFIX}${body}_${hashSuffix}`.slice(
		0,
		CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH,
	);
}

export function buildConfiguredAgentToolDescriptors(
	agents: readonly ConfiguredAgentConfig[],
): ConfiguredAgentToolDescriptor[] {
	const usedToolNames = new Set<string>();
	const descriptors: ConfiguredAgentToolDescriptor[] = [];

	for (const config of [...agents].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const baseName = buildConfiguredAgentToolName(config.name);
		let candidate = baseName;
		let suffix = 2;
		while (usedToolNames.has(candidate)) {
			const suffixText = `_${suffix++}`;
			const maxBaseLength = Math.max(
				1,
				CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH - suffixText.length,
			);
			candidate = `${baseName.slice(0, maxBaseLength)}${suffixText}`;
		}
		usedToolNames.add(candidate);
		descriptors.push({ toolName: candidate, config });
	}

	return descriptors;
}

/**
 * The connection one configured agent runs on.
 *
 * Two cases, and only the first used to work. An agent that names a *model*
 * inherits the session's connection and swaps the model — including inside
 * `providerConfig`, which carries its own copy that the gateway reads, and
 * which left the request naming one model at the top level and another
 * underneath.
 *
 * An agent that names a *provider* needs that provider's own credentials, base
 * URL, catalog and context window. Inheriting the session's meant a request to
 * the wrong server with the wrong key, which is what "we have multiple
 * providers that I would like to create agents to handle specific tasks" ran
 * into. The host's proxy/CA-aware `fetch` is carried across from the session's
 * config either way: it belongs to the process, not to the provider.
 */
export function buildAgentRuntimeConfig(
	base: DelegatedAgentRuntimeConfig,
	agent: ConfiguredAgentConfig,
	resolveProviderConnection?: (
		providerId: string,
	) => AgentProviderConnection | undefined,
	resolveProfileConnection?: (
		name: string,
	) => AgentProfileConnection | undefined,
	listProfileNames?: () => string[],
): DelegatedAgentRuntimeConfig {
	// A named profile answers provider, model and connection at once. Resolved
	// first so the two explicit keys can still override it: `profile` plus
	// `modelId` is "that configuration, this model", which is the reason to
	// write both and the only reading under which neither is redundant.
	const profile = agent.profile
		? resolveProfile(agent, resolveProfileConnection, listProfileNames)
		: undefined;
	const providerId = agent.providerId ?? profile?.providerId ?? base.providerId;
	const modelId = agent.modelId ?? profile?.modelId ?? base.modelId;
	const shared = {
		...base,
		providerId,
		modelId,
		maxIterations: agent.maxIterations ?? base.maxIterations,
	};

	// A profile's own connection wins over the session's even when the two name
	// the same provider: its point is the settings it carries -- the context
	// window above all -- and inheriting the session's would discard exactly what
	// the user named it for.
	if (profile && providerId === profile.providerId) {
		return {
			...shared,
			apiKey: profile.apiKey,
			baseUrl: profile.baseUrl,
			headers: profile.headers,
			knownModels: profile.knownModels,
			providerConfig: withSessionFetch(
				withProviderConfigModelId(profile.providerConfig, modelId),
				base.providerConfig,
			),
		};
	}

	if (providerId === base.providerId) {
		return {
			...shared,
			providerConfig: withProviderConfigModelId(base.providerConfig, modelId),
		};
	}

	const resolved = resolveProviderConnection?.(providerId);
	if (!resolved) {
		throw new Error(
			`Subagent "${agent.name}" is configured for provider "${providerId}", which this host cannot resolve credentials for. ` +
				"Configure that provider, or remove the providerId from the agent so it runs on the session's.",
		);
	}
	return {
		...shared,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		headers: resolved.headers,
		knownModels: resolved.knownModels,
		providerConfig: withSessionFetch(
			withProviderConfigModelId(resolved.providerConfig, modelId),
			base.providerConfig,
		),
	};
}

/**
 * The profile an agent named, or an error naming both.
 *
 * Refused rather than quietly ignored: an agent pointed at a profile that no
 * longer exists would otherwise run on the session's model, which is the same
 * silent-wrong-model failure that made the provider case worth fixing.
 */
function resolveProfile(
	agent: ConfiguredAgentConfig,
	resolveProfileConnection?: (
		name: string,
	) => AgentProfileConnection | undefined,
	listProfileNames?: () => string[],
): AgentProfileConnection {
	const resolved = agent.profile
		? resolveProfileConnection?.(agent.profile)
		: undefined;
	if (!resolved) {
		const available = listProfileNames?.() ?? [];
		throw new Error(
			`Subagent "${agent.name}" names the API configuration profile "${agent.profile}", which no longer exists. ` +
				(available.length > 0
					? `Open Agents in settings and set "Runs on" to one of: ${available.join(", ")}. `
					: "This host has no saved profiles. ") +
				"Removing the profile key from the agent runs it on the session's configuration instead.",
		);
	}
	return resolved;
}

/**
 * The gateway reads the model from `providerConfig` as well as from the top
 * level, so an agent that swaps only one of them runs the other's model.
 */
function withProviderConfigModelId(
	providerConfig: unknown,
	modelId: string,
): unknown {
	if (!providerConfig || typeof providerConfig !== "object") {
		return providerConfig;
	}
	return { ...(providerConfig as Record<string, unknown>), modelId };
}

/**
 * A second provider's stored settings carry no `fetch`, and dropping the
 * session's is how a corporate proxy or a self-signed CA stops working for
 * subagents only.
 */
function withSessionFetch(providerConfig: unknown, base: unknown): unknown {
	const sessionFetch = (base as { fetch?: unknown } | undefined)?.fetch;
	if (!sessionFetch || !providerConfig || typeof providerConfig !== "object") {
		return providerConfig;
	}
	return {
		...(providerConfig as Record<string, unknown>),
		fetch: sessionFetch,
	};
}

export function createConfiguredAgentTools(
	options: ConfiguredAgentToolConfig,
): AgentTool[] {
	return buildConfiguredAgentToolDescriptors(options.agents).map(
		({ toolName, config }) => {
			const tool = createTool<ConfiguredAgentInput, SpawnAgentOutput>({
				name: toolName,
				// One call is one agent of this kind. The lead in sx4bp read that as a
				// reason to avoid these tools for a fan-out ("those subagent tools
				// seem to be individual calls") and rebuilt all five roles by hand
				// on spawn_agent. Then in qjryk (2026-09-23) "several calls in one
				// message" came out as one call per message, each waiting for the
				// last -- so name the one call that is the whole fan-out.
				description: `Use the "${config.name}" subagent: ${config.description} Each call runs one agent of this kind. For several, or several kinds at once, use one \`spawn_agent\` call with \`agents\` entries of \`type: "${config.name}"\` and a \`count\`. ${SPAWN_SAMPLING_NOTE}${AGENT_CONTROLS_NOTE}${DELEGATION_PACING_NOTE}`,
				inputSchema: zodToJsonSchema(ConfiguredAgentInputSchema),
				execute: async (input, context) => {
					// Refused before anything is opened; see `spawn_agent`.
					const controls = controlFields(input);
					const baseRuntimeConfig = options.configProvider.getRuntimeConfig();
					const provisional = buildAgentRuntimeConfig(
						baseRuntimeConfig,
						config,
						options.resolveProviderConnection,
						options.resolveProfileConnection,
						options.listProfileNames,
					);
					// Where it runs, before it is built -- the same order
					// `spawn_agent` uses, and for the same reason: a node is a
					// whole agents configuration, so which node took this agent
					// decides which model it is.
					//
					// An agent that names a provider or a profile of its own has
					// its own endpoint, and a node is not where it runs; it keeps
					// the per-endpoint gate below. Without that check a nodeless
					// session behaves exactly as before.
					//
					// This was the second half of a measured failure: two
					// configured agents launched together, both pointed at the
					// session's endpoint, and the slot gate served one while the
					// other waited out the whole run and was aborted with no
					// model turn at all. The nodes were configured and had room;
					// nothing here looked at them.
					const ownsEndpoint =
						agentEndpointKey(provisional) !==
						agentEndpointKey(baseRuntimeConfig);
					const placement = ownsEndpoint
						? undefined
						: baseRuntimeConfig.nodePlacement;
					// Its own abort signal, so a runaway agent can be stopped
					// without cancelling the session and the siblings that are
					// working.
					const cancelId = subagentCancelId(
						context.sessionId,
						context.toolCallId,
					);
					const cancellation = registerSubagentCancellation(
						cancelId,
						context.signal,
						config.name,
					);
					// Announced rather than reconstructed by the reader. The chat row is
					// the thing that offers the stop, and it must name exactly what was
					// registered -- a host rebuilding the same string from its own idea
					// of the session id is a stop button that works until the two drift.
					if (cancelId) {
						context.emitUpdate?.({ cancelId });
					}
					const tools = options.createSubAgentTools
						? await options.createSubAgentTools(config, input, context)
						: [];
					// Its check runs in its own sandbox, open once its tools are.
					const sandbox = controls.check
						? options.commandSandboxFor?.(context.toolCallId)
						: undefined;
					const prompt = controls.check
						? `${input.prompt}\n\n${describeAgentCheck(controls.check, sandbox !== undefined)}`
						: input.prompt;
					// The lead's cap for this call wins over the agent file's.
					const maxIterations = controls.max_iterations ?? config.maxIterations;
					const lifetime = createDelegatedAgentLifetime();
					let capOutcome: DelegatedRunOutcome | undefined;
					// What it is doing, on the tool call that started it. Nothing
					// else reports a running sub-agent to the user at all.
					const progress = createSubagentProgress(
						context.emitUpdate,
						options.onSubAgentEvent,
					);
					// Its own engine session, never the lead's; on a PolyKV node
					// every instance of this agent shares its system prompt and
					// tools as one pool.
					const engineSessionId = `${context.sessionId ?? "cerebriline"}~agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
					// How long it has been stuck, for the lead: after long enough
					// without progress the lead is told, once.
					const trouble = createAgentTroubleWatch({
						sessionId: context.sessionId,
						name: config.name,
						...(options.logger ? { logger: options.logger } : {}),
					});
					// Queued again while its requests wait for room on the engine.
					const stopRoomWatch = watchPolykvRoom(
						engineSessionId,
						context.emitUpdate,
						options.logger,
						(reason) => trouble.waiting(roomWaitTrouble(reason)),
					);
					const parentAgentId = context.agentId;
					// The lead's sampler, when it gave one: applied over whatever
					// connection this agent's file, profile or node resolves to.
					// Drawn once here, so every attempt runs the same random values.
					const sampling = drawSpawnSampling(readSpawnSampling(input));
					let realizedSampling: RealizedSpawnSampling | undefined;
					const spawnInput = {
						systemPrompt: config.systemPrompt,
						task: input.prompt,
					};
					// From the first build and kept across re-placements: the
					// observers identify one delegation, not one attempt at it.
					let started:
						| { subAgentId: string; conversationId: string }
						| undefined;

					// Built per attempt: the node IS the configuration, so
					// re-placing means resolving the connection again.
					const attempt = async (
						runtimeConfig: typeof provisional,
						admitted: () => void,
						recoverTurnFault?: TurnFaultRecovery,
					): Promise<AgentResult> => {
						// The row names the model while it runs, not only once it is done.
						reportSubagentModel(context.emitUpdate, {
							providerId: runtimeConfig.providerId,
							modelId: runtimeConfig.modelId,
						});
						// A random temperature is drawn around the model's own.
						await primeModelTemperature(sampling, runtimeConfig);
						const check = controls.check
							? createDelegatedAgentCheck({
									check: controls.check,
									cwd: sandbox?.cwd ?? runtimeConfig.cwd ?? process.cwd(),
									...(sandbox ? { wrapSpawn: sandbox.wrapSpawn } : {}),
								})
							: undefined;
						const subAgent = createDelegatedAgent({
							...(check ? { check } : {}),
							// What the lead's side turn leaves for it while the lead waits.
							consumePendingUserMessage: async () => cancellation.takeMessage(),
							kind: "subagent",
							prompt: config.systemPrompt,
							engineSessionId,
							...(isPolykvProvider({
								providerId: runtimeConfig.providerId,
								baseUrl: runtimeConfig.baseUrl,
								polykv: (
									runtimeConfig.providerConfig as { polykv?: never } | undefined
								)?.polykv,
							})
								? {
										polykvWorker: {
											group: context.sessionId ?? "cerebriline",
											layers: 0,
										},
									}
								: {}),
							configProvider: createDelegatedAgentConfigProvider(runtimeConfig),
							...(sampling
								? {
										sampling,
										onSampling: (realized: RealizedSpawnSampling) => {
											realizedSampling = realized;
											reportSubagentSampling(context.emitUpdate, realized);
										},
									}
								: {}),
							tools,
							maxIterations,
							parentAgentId: context.agentId,
							abortSignal: cancellation.signal,
							// The caller's hooks for this run alone -- the pause barrier
							// of a background delegation, and nothing in an ordinary
							// call the model makes.
							hooks: readDelegationHooks(context.metadata),
							// The first event is also the engine admitting it.
							onEvent: (event) => {
								if (isAdmissionEvent(event)) {
									admitted();
									trouble.progressed();
								}
								progress.observe(event);
							},
							hookErrorMode: options.hookErrorMode,
							toolPolicies: options.toolPolicies,
							requestToolApproval: options.requestToolApproval,
							// A server restart or a refusal is waited out, never
							// the answer.
							recoverTurnFault:
								recoverTurnFault ??
								createTurnFaultRecovery({
									label: config.name,
									onWaiting: trouble.waiting,
									baseUrl: () => runtimeConfig.baseUrl,
									headers: () => runtimeConfig.headers,
									signal: cancellation.signal,
									...(context.emitUpdate
										? { emitUpdate: context.emitUpdate }
										: {}),
									...(options.logger ? { logger: options.logger } : {}),
								}),
						});
						if (!started) {
							started = {
								subAgentId: subAgent.getAgentId(),
								conversationId: subAgent.getConversationId(),
							};
							if (options.onSubAgentStart) {
								try {
									await options.onSubAgentStart({
										...started,
										parentAgentId,
										input: spawnInput,
										toolCallId: context.toolCallId,
									});
								} catch {
									// Best-effort observer callback.
								}
							}
						}
						// At its cap it waits for the lead, work kept.
						const outcome = await runDelegatedWithCap({
							agent: subAgent,
							start: () => subAgent.run(prompt),
							name: config.name,
							...(maxIterations !== undefined ? { maxIterations } : {}),
							...(context.sessionId ? { sessionId: context.sessionId } : {}),
							...(cancelId ? { cancelId } : {}),
							...(cancellation.signal ? { signal: cancellation.signal } : {}),
							...(context.emitUpdate ? { emitUpdate: context.emitUpdate } : {}),
							...(check ? { check } : {}),
							releaseEngineSession: () => releasePolykvAgent(engineSessionId),
							lifetime,
							onDetachedFinish: async (final) => {
								await notifyEnd(buildOutput(final.result, final), final.result);
							},
						});
						capOutcome = outcome;
						if (outcome.state === "awaiting_lead") {
							return outcome.result;
						}
						// A summary for the lead, and the full report kept for it.
						return summarizeForLead({
							sessionId: context.sessionId,
							name: config.name,
							result: outcome.result,
							summarize: (summaryPrompt) => subAgent.continue(summaryPrompt),
						});
					};

					const buildOutput = (
						result: AgentResult,
						outcome: DelegatedRunOutcome | undefined,
						placed?: { nodeId: string; nodeLabel?: string },
					): SpawnAgentOutput => ({
						text:
							outcome?.state === "awaiting_lead"
								? `${result.text}${awaitingLeadNote(config.name, started?.subAgentId, outcome)}`
								: result.text,
						iterations: result.iterations,
						finishReason: result.finishReason,
						usage: {
							inputTokens: result.usage.inputTokens,
							outputTokens: result.usage.outputTokens,
						},
						// A configured agent is the case where this matters most:
						// its file may name a provider of its own, so its tokens
						// can be billed where the session's are not, or the
						// reverse. Guarded: `model` is bookkeeping, and a result
						// without one is no reason to fail an agent that did its
						// work.
						...(result.model
							? {
									model: {
										id: result.model.id,
										provider: result.model.provider,
									},
								}
							: {}),
						// Where it ran. Only when it was placed: on a session
						// with no nodes there is one place to run and naming it
						// is noise.
						...(placed ? { nodeId: placed.nodeId } : {}),
						...(placed?.nodeLabel ? { nodeLabel: placed.nodeLabel } : {}),
						...(realizedSampling ? { sampling: realizedSampling } : {}),
						...controlReport(started?.subAgentId, outcome),
					});

					const notifyEnd = async (
						output: SpawnAgentOutput | undefined,
						agentResult: AgentResult | undefined,
						error?: unknown,
					): Promise<void> => {
						if (!options.onSubAgentEnd || !started) {
							return;
						}
						try {
							await options.onSubAgentEnd({
								...started,
								parentAgentId,
								input: spawnInput,
								toolCallId: context.toolCallId,
								...(output ? { result: output } : {}),
								...(agentResult ? { agentResult } : {}),
								...(error !== undefined
									? {
											error:
												error instanceof Error
													? error
													: new Error(String(error)),
										}
									: {}),
							});
						} catch {
							// Best-effort observer callback.
						}
					};

					try {
						// Restartable from the row, as `spawn_agent` is.
						const { result, placed } = await cancellation.restartable(
							async (): Promise<{
								result: AgentResult;
								placed?: { nodeId: string; nodeLabel?: string };
							}> => {
								if (placement) {
									const outcome = await runPlacedAgent({
										placement,
										// The attempt's: a restart while queued leaves the queue.
										signal: cancellation.signal,
										emitUpdate: context.emitUpdate,
										...(options.logger ? { logger: options.logger } : {}),
										label: config.name,
										onWaiting: trouble.waiting,
										run: (node, admitted, recoverTurnFault) =>
											attempt(
												buildAgentRuntimeConfig(
													node.configProvider.getRuntimeConfig(),
													config,
													options.resolveProviderConnection,
													options.resolveProfileConnection,
													options.listProfileNames,
												),
												admitted,
												recoverTurnFault,
											),
										beforeRetry: async () => {
											await releasePolykvAgent(engineSessionId);
										},
									});
									return { result: outcome.result, placed: outcome.placed };
								} else {
									// Held to what the endpoint *this* agent resolved to will
									// serve, which is not necessarily the session's: an agent
									// naming a provider or a profile has its own. Two agents on
									// different servers therefore run at once, and two on the
									// same one queue.
									const gate = baseRuntimeConfig.slotGates?.for(
										agentEndpointKey(provisional),
									);
									const run = () => attempt(provisional, () => {});
									return { result: gate ? await gate.run(run) : await run() };
								}
							},
							() => restarted(context.emitUpdate, engineSessionId),
						);
						const output = buildOutput(result, capOutcome, placed);
						// Detached at its cap: its hand-back waits for its real end.
						if (capOutcome?.state !== "awaiting_lead") {
							await notifyEnd(output, result);
						}
						return output;
					} catch (error) {
						await notifyEnd(undefined, undefined, error);
						throw error;
					} finally {
						await lifetime.end(async () => {
							// The lease outlives the run on every path, or a node
							// stays booked for an agent that is no longer on it and
							// the round narrows with each failure. Same for the stop
							// registration: one that outlives its agent is a button
							// that reports success and does nothing.
							cancellation.release();
							stopRoomWatch();
							trouble.dispose();
							// And its workspace, which a run that never started
							// still opened.
							if (options.onSubAgentSettled) {
								try {
									await options.onSubAgentSettled({
										toolCallId: context.toolCallId,
										name: config.name,
									});
								} catch {
									// Best-effort observer callback.
								}
							}
							// Its engine session goes back the moment it ends.
							const released = await releasePolykvAgent(engineSessionId).catch(
								() => undefined,
							);
							for (const failure of released?.failed ?? []) {
								options.logger?.log(
									`[Agents] could not close engine session ${failure.sessionId}: ${failure.error}`,
								);
							}
						});
					}
				},
				timeoutMs: 300000,
				retryable: false,
				// It gates itself -- the node lease when placed, the endpoint's
				// slot gate when not -- so the runtime's pool of eight must not
				// gate it again. Forty requested agents ran eight wide behind it.
				lifecycle: { boundsOwnConcurrency: true },
			});
			return tool as unknown as AgentTool;
		},
	);
}
