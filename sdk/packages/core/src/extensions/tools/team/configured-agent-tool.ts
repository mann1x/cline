import {
	type AgentEvent,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	createTool,
	type HookErrorMode,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { agentEndpointKey } from "./agent-slot-gate";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import {
	createDelegatedAgent,
	createDelegatedAgentConfigProvider,
	type DelegatedAgentConfigProvider,
	type DelegatedAgentRuntimeConfig,
} from "./delegated-agent";
import type {
	SpawnAgentOutput,
	SubAgentEndContext,
	SubAgentStartContext,
} from "./spawn-agent-tool";

const CONFIGURED_AGENT_TOOL_NAME_PREFIX = "subagent_";
const CONFIGURED_AGENT_TOOL_NAME_MAX_LENGTH = 64;

const ConfiguredAgentInputSchema = z.object({
	prompt: z.string().trim().min(1).describe("Task for the subagent to perform"),
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
				description: `Use the "${config.name}" subagent: ${config.description}`,
				inputSchema: zodToJsonSchema(ConfiguredAgentInputSchema),
				execute: async (input, context) => {
					const baseRuntimeConfig = options.configProvider.getRuntimeConfig();
					const runtimeConfig = buildAgentRuntimeConfig(
						baseRuntimeConfig,
						config,
						options.resolveProviderConnection,
						options.resolveProfileConnection,
						options.listProfileNames,
					);
					const configProvider =
						createDelegatedAgentConfigProvider(runtimeConfig);
					const tools = options.createSubAgentTools
						? await options.createSubAgentTools(config, input, context)
						: [];
					const subAgent = createDelegatedAgent({
						kind: "subagent",
						prompt: config.systemPrompt,
						configProvider,
						tools,
						maxIterations: config.maxIterations,
						parentAgentId: context.agentId,
						abortSignal: context.signal,
						onEvent: options.onSubAgentEvent,
						hookErrorMode: options.hookErrorMode,
						toolPolicies: options.toolPolicies,
						requestToolApproval: options.requestToolApproval,
					});
					const subAgentId = subAgent.getAgentId();
					const conversationId = subAgent.getConversationId();
					const parentAgentId = context.agentId;
					const spawnInput = {
						systemPrompt: config.systemPrompt,
						task: input.prompt,
					};

					if (options.onSubAgentStart) {
						try {
							await options.onSubAgentStart({
								subAgentId,
								conversationId,
								parentAgentId,
								input: spawnInput,
							});
						} catch {
							// Best-effort observer callback.
						}
					}

					try {
						// Held to what the endpoint *this* agent resolved to will
						// serve, which is not necessarily the session's: an agent
						// naming a provider or a profile has its own. Two agents on
						// different servers therefore run at once, and two on the same
						// one queue. Gated around the run alone, like `spawn_agent` --
						// building the toolset and telling the observers costs the
						// server nothing, and holding a slot across them would leave
						// the endpoint idle while a slot was booked.
						const gate = baseRuntimeConfig.slotGates?.for(
							agentEndpointKey(runtimeConfig),
						);
						const result: AgentResult = gate
							? await gate.run(() => subAgent.run(input.prompt))
							: await subAgent.run(input.prompt);
						const output: SpawnAgentOutput = {
							text: result.text,
							iterations: result.iterations,
							finishReason: result.finishReason,
							usage: {
								inputTokens: result.usage.inputTokens,
								outputTokens: result.usage.outputTokens,
							},
						};
						if (options.onSubAgentEnd) {
							try {
								await options.onSubAgentEnd({
									subAgentId,
									conversationId,
									parentAgentId,
									input: spawnInput,
									result: output,
									agentResult: result,
								});
							} catch {
								// Best-effort observer callback.
							}
						}
						return output;
					} catch (error) {
						if (options.onSubAgentEnd) {
							try {
								await options.onSubAgentEnd({
									subAgentId,
									conversationId,
									parentAgentId,
									input: spawnInput,
									error:
										error instanceof Error ? error : new Error(String(error)),
								});
							} catch {
								// Best-effort observer callback.
							}
						}
						throw error;
					}
				},
				timeoutMs: 300000,
				retryable: false,
			});
			return tool as unknown as AgentTool;
		},
	);
}
