import { DEFAULT_MAX_NO_TOOL_CALL_NUDGES } from "@cline/agents";
import { supportsModelTool } from "@cline/llms";
import type {
	AgentTool,
	BasicLogger,
	ITelemetryService,
	ModelTool,
	RuntimeConfigExtensionKind,
	TeamTeammateSpec,
} from "@cline/shared";
import {
	hasRuntimeConfigExtension,
	resolveMcpTimeoutSeconds,
} from "@cline/shared";
import { nanoid } from "nanoid";
import type { AgentPluginPackageMcpServer } from "../../extensions/agent-plugin";
import {
	combineUserInstructionConfigServices,
	createUserInstructionConfigService,
	type UserInstructionConfigService,
} from "../../extensions/config";
import {
	createDefaultMcpServerClientFactory,
	createMcpTools,
	hasMcpSettingsFile,
	InMemoryMcpManager,
	registerMcpServersFromSettingsFile,
	resolveDefaultMcpSettingsPath,
} from "../../extensions/mcp";
import {
	createBuiltinTools,
	DEFAULT_MODEL_TOOL_ROUTING_RULES,
	type QaCredential,
	type RunCommandExecutionController,
	resolveToolPresetName,
	resolveToolRoutingConfig,
	type SkillsExecutorWithMetadata,
	type ToolExecutors,
	ToolPresets,
	type ToolRoutingRule,
} from "../../extensions/tools";
import { createPlanModeCommandGuardExtension } from "../../extensions/tools/command-guard-extension";
import {
	AgentTeamsRuntime,
	agentEndpointKey,
	bootstrapAgentTeams,
	createAgentSlotGateRegistry,
	createDelegatedAgentConfigProvider,
	type DelegatedAgentConnectionConfig,
	slotsAllowParallelDelegation,
	type TeamEvent,
} from "../../extensions/tools/team";
import type { ConfiguredAgentConfig } from "../../extensions/tools/team/configured-agent-config";
import { loadConfiguredAgentConfigs } from "../../extensions/tools/team/configured-agent-config";
import { createConfiguredAgentTools } from "../../extensions/tools/team/configured-agent-tool";
import {
	filterDisabledTools,
	isModelToolEnabledGlobally,
	resolveDisabledToolNames,
} from "../../services/global-settings";
import { createLocalTeamStore } from "../../services/storage/team-store";
import type { CoreAgentMode, CoreSessionConfig } from "../../types/config";
import type {
	RuntimeBuilder,
	RuntimeBuilderInput,
	BuiltRuntime as RuntimeEnvironment,
} from "./session-runtime";

function hasConfigExtension(
	extensions: ReadonlyArray<RuntimeConfigExtensionKind> | undefined,
	kind: RuntimeConfigExtensionKind,
): boolean {
	return hasRuntimeConfigExtension(extensions, kind);
}

function isToolEnabledByPolicies(
	toolName: string,
	toolPolicies: CoreSessionConfig["toolPolicies"],
): boolean {
	const globalPolicy = toolPolicies?.["*"] ?? {};
	const toolPolicy = toolPolicies?.[toolName] ?? {};
	return (
		{
			...globalPolicy,
			...toolPolicy,
		}.enabled !== false
	);
}

function filterToolsByPolicies(
	tools: AgentTool[],
	toolPolicies: CoreSessionConfig["toolPolicies"],
): AgentTool[] {
	return tools.filter((tool) =>
		isToolEnabledByPolicies(tool.name, toolPolicies),
	);
}

function filterAvailableTools(
	tools: AgentTool[],
	toolPolicies: CoreSessionConfig["toolPolicies"],
): AgentTool[] {
	return filterDisabledTools(filterToolsByPolicies(tools, toolPolicies));
}

const CONFIGURED_AGENT_TOOL_NAME_ALIASES: Record<string, string> = {
	apply_diff: "editor",
	attempt_completion: "submit_and_exit",
	bash: "run_commands",
	execute_command: "run_commands",
	list_code_definition_names: "search_codebase",
	list_files: "run_commands",
	read_file: "read_files",
	replace_in_file: "editor",
	search_files: "search_codebase",
	use_skill: "skills",
	write_to_file: "editor",
};

function resolveConfiguredAgentToolName(toolName: string): string {
	const normalized = toolName.trim().toLowerCase();
	return CONFIGURED_AGENT_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

function filterToolsForConfiguredAgent(
	tools: AgentTool[],
	agent: ConfiguredAgentConfig,
): AgentTool[] {
	if (agent.tools === undefined) {
		return tools;
	}

	const allowedToolNames = new Set(
		agent.tools.map(resolveConfiguredAgentToolName),
	);
	if (agent.skills !== undefined) {
		allowedToolNames.add("skills");
	}
	return tools.filter((tool) => allowedToolNames.has(tool.name));
}

export function createTeamName(): string {
	return `team-${nanoid(5)}`;
}

function createBuiltinToolsList(
	cwd: string,
	providerId: string,
	mode: CoreAgentMode,
	modelId: string,
	toolRoutingRules: ToolRoutingRule[] | undefined,
	toolPolicies: CoreSessionConfig["toolPolicies"],
	skillsExecutor?: SkillsExecutorWithMetadata,
	executorOverrides?: Partial<ToolExecutors>,
	telemetry?: ITelemetryService,
	qaCredentials?: QaCredential[],
	runCommandExecutionController?: RunCommandExecutionController,
): AgentTool[] {
	const preset = ToolPresets[resolveToolPresetName({ mode })];
	const toolRoutingConfig = resolveToolRoutingConfig(
		providerId,
		modelId,
		mode,
		toolRoutingRules ?? DEFAULT_MODEL_TOOL_ROUTING_RULES,
	);

	return filterAvailableTools(
		createBuiltinTools({
			cwd,
			telemetry,
			qaCredentials,
			executorOptions: {
				bash: { executionController: runCommandExecutionController },
			},
			...preset,
			enableSkills: !!skillsExecutor,
			...toolRoutingConfig,
			executors: {
				...(skillsExecutor
					? {
							skills: skillsExecutor,
						}
					: {}),
				...(executorOverrides ?? {}),
			},
		}),
		toolPolicies,
	);
}

function isSkillsToolEnabledForSession(input: {
	cwd: string;
	providerId: string;
	mode: CoreAgentMode;
	modelId: string;
	toolRoutingRules?: ToolRoutingRule[];
	toolPolicies?: CoreSessionConfig["toolPolicies"];
	toolExecutors?: Partial<ToolExecutors>;
}): boolean {
	return createBuiltinToolsList(
		input.cwd,
		input.providerId,
		input.mode,
		input.modelId,
		input.toolRoutingRules,
		input.toolPolicies,
		SKILLS_PROBE_EXECUTOR,
		input.toolExecutors,
		// No telemetry and no credentials: this builds a throwaway tool list only
		// to ask whether `skills` is in it. Handing it secrets would put them in a
		// closure nothing ever calls.
	).some((tool) => tool.name === "skills");
}

const SKILLS_PROBE_EXECUTOR = (async () => "") as SkillsExecutorWithMetadata;

async function loadConfiguredMcpTools(options: {
	logger?: BasicLogger;
	includeSettings: boolean;
	agentPluginServers?: ReadonlyArray<AgentPluginPackageMcpServer>;
}): Promise<{
	tools: AgentTool[];
	shutdown?: () => Promise<void>;
}> {
	const settingsPath = resolveDefaultMcpSettingsPath();
	const hasSettings =
		options.includeSettings && hasMcpSettingsFile({ filePath: settingsPath });
	if (!hasSettings && !options.agentPluginServers?.length) {
		return { tools: [] };
	}

	const settingsClientFactory = createDefaultMcpServerClientFactory({
		settingsPath,
	});
	const agentPluginClientFactory = createDefaultMcpServerClientFactory({
		restrictConfiguredHeadersToOrigin: true,
	});
	const manager = new InMemoryMcpManager({
		clientFactory: (registration) =>
			registration.metadata?.source === "agent-plugin"
				? agentPluginClientFactory(registration)
				: settingsClientFactory(registration),
	});

	let registrations: Awaited<
		ReturnType<typeof registerMcpServersFromSettingsFile>
	> = [];
	if (hasSettings) {
		try {
			registrations = await registerMcpServersFromSettingsFile(manager, {
				filePath: settingsPath,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.logger?.log(
				`[mcp] Failed to load MCP settings, skipping settings-backed MCP tools: ${message}`,
			);
		}
	}

	const registeredNames = new Set(registrations.map((entry) => entry.name));
	for (const agentPluginServer of options.agentPluginServers ?? []) {
		const registration = agentPluginServer.registration;
		if (registeredNames.has(registration.name)) {
			options.logger?.log(
				`[agent-plugins] MCP server '${registration.name}' conflicts with an existing server and was skipped.`,
				{ severity: "error" },
			);
			continue;
		}
		try {
			await manager.registerServer(registration);
			registrations.push(registration);
			registeredNames.add(registration.name);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.logger?.log(
				`[agent-plugins] Failed to register MCP server '${registration.name}', skipping: ${message}`,
				{ severity: "error" },
			);
		}
	}

	if (registrations.length === 0) {
		await manager.dispose().catch(() => {});
		return { tools: [] };
	}

	const enabled = registrations.filter((r) => r.disabled !== true);
	const results = await Promise.allSettled(
		enabled.map((r) =>
			createMcpTools({
				serverName: r.name,
				provider: manager,
				// Keep the tool wrapper timeout in agreement with the MCP
				// request timeout: both derive from the server's registration.
				timeoutMs: resolveMcpTimeoutSeconds(r.timeoutSeconds) * 1000,
			}),
		),
	);
	const tools: AgentTool[] = [];
	for (const [i, result] of results.entries()) {
		if (result.status === "fulfilled") {
			tools.push(...result.value);
		} else {
			const message =
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
			options.logger?.log(
				`[mcp] Failed to load tools from MCP server "${enabled[i].name}", skipping: ${message}`,
			);
		}
	}

	return {
		tools,
		shutdown: async () => {
			await manager.dispose();
		},
	};
}

function shutdownTeamRuntime(
	teamRuntime: AgentTeamsRuntime | undefined,
	reason: string,
): void {
	if (!teamRuntime) {
		return;
	}
	for (const teammateId of teamRuntime.getTeammateIds()) {
		try {
			teamRuntime.shutdownTeammate(teammateId, reason);
		} catch {
			// Best-effort shutdown for all teammates.
		}
	}
}

function isRuntimeLifecycleShutdownReason(reason: string | undefined): boolean {
	if (reason === undefined) {
		return true;
	}
	switch (reason) {
		case "session_stop":
		case "session_complete":
		case "session_error":
		case "session_manager_dispose":
		case "cli_run_shutdown":
		case "cli_interactive_shutdown":
		case "cli_interactive_startup_cancelled":
		case "provider_change":
		case "acp_shutdown":
		case "hub_server_stop":
		case "vscode_webview_dispose":
			return true;
		default:
			return false;
	}
}

function normalizeConfig(
	config: CoreSessionConfig,
): Required<
	Pick<
		CoreSessionConfig,
		| "mode"
		| "enableTools"
		| "enableSpawnAgent"
		| "enableAgentTeams"
		| "disableMcpSettingsTools"
		| "yolo"
		| "missionLogIntervalSteps"
		| "missionLogIntervalMs"
		| "sessionId"
	>
> {
	const preset = ToolPresets[resolveToolPresetName({ mode: config.mode })];
	return {
		sessionId: config.sessionId || "",
		mode:
			config.mode === "plan" ? "plan" : config.mode === "yolo" ? "yolo" : "act",
		enableTools: config.enableTools !== false,
		enableSpawnAgent:
			config.enableSpawnAgent ?? preset.enableSpawnAgent ?? true,
		// The team tools exist to run agents beside one another. On an endpoint
		// that serves one request at a time there is no beside, so they are
		// withheld rather than offered and silently serialised -- see
		// {@link slotsAllowParallelDelegation}. The host's flag does not turn
		// them back on: this is what the server does, not what anyone prefers.
		enableAgentTeams:
			slotsAllowParallelDelegation(config.maxConcurrentAgents) &&
			(config.enableAgentTeams ?? preset.enableAgentTeams ?? true),
		disableMcpSettingsTools: config.disableMcpSettingsTools === true,
		yolo: config.yolo === true,
		missionLogIntervalSteps:
			typeof config.missionLogIntervalSteps === "number" &&
			Number.isFinite(config.missionLogIntervalSteps)
				? config.missionLogIntervalSteps
				: 3,
		missionLogIntervalMs:
			typeof config.missionLogIntervalMs === "number" &&
			Number.isFinite(config.missionLogIntervalMs)
				? config.missionLogIntervalMs
				: 120000,
	};
}

export class DefaultRuntimeBuilder implements RuntimeBuilder {
	private readonly teamRuntimeEntries = new Map<
		string,
		{
			runtime?: AgentTeamsRuntime;
			delegatedAgentConfigProvider: ReturnType<
				typeof createDelegatedAgentConfigProvider
			>;
		}
	>();

	async build(input: RuntimeBuilderInput): Promise<RuntimeEnvironment> {
		const {
			config,
			hooks,
			extensions,
			logger,
			telemetry,
			createSpawnTool,
			onTeamRestored,
			userInstructionService: sharedUserInstructionService,
			configExtensions,
			toolExecutors,
		} = input;
		const onTeamEvent = input.onTeamEvent ?? (() => {});
		const normalized = normalizeConfig(config);
		const modelTools: ModelTool[] = [];
		if (
			normalized.enableTools &&
			isModelToolEnabledGlobally("web_search") &&
			supportsModelTool(
				{ providerId: config.providerId, modelId: config.modelId },
				"web_search",
			)
		) {
			modelTools.push({ name: "web_search" });
		}
		if (
			normalized.enableTools &&
			supportsModelTool(
				{ providerId: config.providerId, modelId: config.modelId },
				"image_generation",
			)
		) {
			modelTools.push({ name: "image_generation", outputFormat: "png" });
		}
		const workspaceConfigRoot = config.workspaceRoot ?? config.cwd;
		const effectiveToolPolicies = input.toolPolicies ?? config.toolPolicies;
		const globallyDisabledToolNames = resolveDisabledToolNames();
		const tools: AgentTool[] = [];
		const effectiveTeamName = config.teamName?.trim() || createTeamName();
		const teamStoreKey = config.sessionId?.trim() || effectiveTeamName;
		const configuredAgents = normalized.enableSpawnAgent
			? loadConfiguredAgentConfigs({
					workspaceRoot: workspaceConfigRoot,
				})
			: { configs: [], errors: [], searchPaths: [] };
		const configuredAgentsNeedSkills = configuredAgents.configs.some(
			(agent) => agent.skills !== undefined,
		);
		const rulesEnabled = hasConfigExtension(configExtensions, "rules");
		const rootSkillsEnabled = hasConfigExtension(configExtensions, "skills");
		const needsSkillsConfigService =
			rootSkillsEnabled || configuredAgentsNeedSkills;
		const workflowsEnabled = hasConfigExtension(configExtensions, "workflows");
		const pluginsEnabled = hasConfigExtension(configExtensions, "plugins");
		const userInstructionsEnabled =
			rulesEnabled || rootSkillsEnabled || workflowsEnabled;
		let teamToolsRegistered = false;
		const ownedUserInstructionServices: UserInstructionConfigService[] = [];
		let userInstructionService = sharedUserInstructionService;
		let mcpShutdown: (() => Promise<void>) | undefined;

		for (const error of configuredAgents.errors) {
			(logger ?? config.logger)?.log?.(
				`[agents] Failed to load agent config at ${error.path}: ${error.error.message}`,
			);
		}

		// Said whichever way it went, and said only when subagents are on. Zero
		// agent files is not an error -- nothing is wrong, there is just nothing
		// to offer -- so without this the feature is silent in exactly the case
		// where a user is wondering why nothing happens.
		if (normalized.enableSpawnAgent) {
			(logger ?? config.logger)?.log?.(
				configuredAgents.configs.length > 0
					? `[agents] ${configuredAgents.configs.length} configured agent(s): ${configuredAgents.configs
							.map((agent) => agent.name)
							.join(", ")}`
					: `[agents] No configured agents found. Looked in: ${configuredAgents.searchPaths.join(", ") || "(no search path)"}`,
			);

			// A profile is usually deleted long after the agent naming it was
			// written, and nothing rewrites the agent file. Left to itself that
			// surfaces as a failed delegation halfway through a task, which
			// reads as the subagent being broken rather than as configuration
			// that went stale. Said here instead, before anything calls it.
			const danglingProfiles = configuredAgents.configs.filter(
				(agent) =>
					agent.profile !== undefined &&
					config.resolveProfileConnection?.(agent.profile) === undefined,
			);
			for (const agent of danglingProfiles) {
				const available = config.listProfileNames?.() ?? [];
				(logger ?? config.logger)?.log?.(
					`[agents] "${agent.name}" names the API configuration profile "${agent.profile}", which no longer exists, and will fail when called. ` +
						(available.length > 0
							? `Available profiles: ${available.join(", ")}.`
							: "This host has no saved profiles."),
					{ severity: "warn" },
				);
			}
		}

		if (
			!userInstructionService &&
			(userInstructionsEnabled || configuredAgentsNeedSkills)
		) {
			userInstructionService = createUserInstructionConfigService({
				skills: needsSkillsConfigService
					? {
							workspacePath: workspaceConfigRoot,
							includePluginSkills: pluginsEnabled,
							pluginSkillDirectories: pluginsEnabled
								? input.pluginSkillDirectories
								: undefined,
							pluginPaths: config.pluginPaths,
							cwd: config.cwd,
							agentPluginSkills: pluginsEnabled
								? input.agentPluginSkills
								: undefined,
						}
					: { workspacePath: workspaceConfigRoot },
				rules: { workspacePath: config.cwd },
				workflows: { workspacePath: config.cwd },
			});
			ownedUserInstructionServices.push(userInstructionService);
		} else if (
			userInstructionService &&
			pluginsEnabled &&
			input.agentPluginSkills?.length &&
			(userInstructionsEnabled || configuredAgentsNeedSkills)
		) {
			const agentPluginInstructionService = createUserInstructionConfigService({
				skills: {
					directories: [],
					agentPluginSkills: input.agentPluginSkills,
				},
				rules: { directories: [] },
				workflows: { directories: [] },
			});
			ownedUserInstructionServices.push(agentPluginInstructionService);
			userInstructionService = combineUserInstructionConfigServices([
				userInstructionService,
				agentPluginInstructionService,
			]);
		}

		if (userInstructionService) {
			await userInstructionService.start().catch(() => {});
		}

		const registerSkillsTool =
			normalized.enableTools &&
			rootSkillsEnabled &&
			Boolean(userInstructionService) &&
			userInstructionService?.hasConfiguredSkills(config.skills) === true &&
			isSkillsToolEnabledForSession({
				cwd: config.cwd,
				providerId: config.providerId,
				mode: normalized.mode,
				modelId: config.modelId,
				toolRoutingRules: config.toolRoutingRules,
				toolPolicies: effectiveToolPolicies,
				toolExecutors,
			});

		const userInstructionPlugin =
			userInstructionService && userInstructionsEnabled
				? userInstructionService.createExtension({
						includeRules: rulesEnabled,
						includeSkills: rootSkillsEnabled,
						includeWorkflows: workflowsEnabled,
						registerSkillsTool,
						allowedSkillNames: config.skills,
					})
				: undefined;
		// Plan mode keeps run_commands for read-only investigation; this
		// beforeTool hook is the hard backstop that rejects file-editing
		// commands before approval/execution. Registered as an extension so it
		// rides the shared hook merge for the lead agent, host-provided
		// run_commands replacements (e.g. the VS Code terminal tool), and
		// delegated sub-agents alike. Mode switches rebuild the runtime, so
		// the guard appears/disappears with the mode.
		const planModeCommandGuard =
			normalized.mode === "plan" && normalized.enableTools
				? createPlanModeCommandGuardExtension({
						telemetry: telemetry ?? config.telemetry,
					})
				: undefined;
		const injectedExtensions = [
			userInstructionPlugin,
			planModeCommandGuard,
		].filter((extension) => extension !== undefined);
		const runtimeExtensions =
			injectedExtensions.length > 0
				? [...(extensions ?? config.extensions ?? []), ...injectedExtensions]
				: (extensions ?? config.extensions);

		if (normalized.enableTools) {
			tools.push(
				...createBuiltinToolsList(
					config.cwd,
					config.providerId,
					normalized.mode,
					config.modelId,
					config.toolRoutingRules,
					effectiveToolPolicies,
					undefined,
					toolExecutors,
					telemetry ?? config.telemetry,
					config.qaCredentials,
					input.runCommandExecutionController,
				),
			);
			const agentPluginMcpServers = pluginsEnabled
				? input.agentPluginMcpServers
				: undefined;
			if (
				!normalized.disableMcpSettingsTools ||
				agentPluginMcpServers?.length
			) {
				const mcpRuntime = await loadConfiguredMcpTools({
					logger: config.logger,
					includeSettings: !normalized.disableMcpSettingsTools,
					agentPluginServers: agentPluginMcpServers,
				});
				tools.push(...mcpRuntime.tools);
				mcpShutdown = mcpRuntime.shutdown;
			}
		}

		let teamRuntime: AgentTeamsRuntime | undefined;
		const teamStore = normalized.enableAgentTeams
			? createLocalTeamStore()
			: undefined;
		const restoredTeam = teamStore?.loadRuntime(teamStoreKey);
		const restoredTeamState = restoredTeam?.state;
		const restoredTeammateSpecs = restoredTeam?.teammates ?? [];
		const teammateSpecs = new Map(
			restoredTeammateSpecs.map((spec) => [spec.agentId, spec] as const),
		);
		const registryKey = config.sessionId || effectiveTeamName;
		let leadAgentInstance:
			| {
					addTools: (tools: AgentTool[]) => void;
			  }
			| undefined;
		let pendingLeadTeamTools: AgentTool[] = [];
		let restoredStateHydratedIntoRuntime = false;
		// A connection of their own, when the host gave them one. Only the fields
		// it actually names are taken: an override that says which model to call
		// and nothing else still inherits the session's sampler and thinking
		// budget, which is the sensible reading of a tab where those were left
		// alone. Those same fields are then pinned, so the connection updates the
		// host pushes for the session's model do not move the agents back onto it.
		const agentsConnection = config.delegatedAgentConnection;
		// One registry for the session, so every spawn path shares the bound and
		// agents on one endpoint queue together wherever they were spawned from.
		const agentSlotGates = createAgentSlotGateRegistry(
			config.maxConcurrentAgents,
		);
		const agentsOverrides: Partial<DelegatedAgentConnectionConfig> =
			agentsConnection
				? {
						providerId: agentsConnection.providerId,
						modelId: agentsConnection.modelId,
						...(agentsConnection.apiKey !== undefined
							? { apiKey: agentsConnection.apiKey }
							: {}),
						...(agentsConnection.baseUrl !== undefined
							? { baseUrl: agentsConnection.baseUrl }
							: {}),
						...(agentsConnection.headers !== undefined
							? { headers: agentsConnection.headers }
							: {}),
						...(agentsConnection.knownModels !== undefined
							? { knownModels: agentsConnection.knownModels }
							: {}),
						...(agentsConnection.providerConfig !== undefined
							? { providerConfig: agentsConnection.providerConfig }
							: {}),
					}
				: {};
		const delegatedAgentConfigProvider = createDelegatedAgentConfigProvider(
			{
				providerId: config.providerId,
				modelId: config.modelId,
				distinctId: input.distinctId,
				sessionId: config.sessionId,
				cwd: config.cwd,
				apiKey: config.apiKey ?? "",
				baseUrl: config.baseUrl,
				headers: config.headers,
				providerConfig: config.providerConfig,
				knownModels: config.knownModels,
				thinking: config.thinking,
				reasoningEffort: config.reasoningEffort,
				thinkingBudgetTokens: config.thinkingBudgetTokens,
				maxTokensPerTurn: config.maxTokensPerTurn,
				maxToolResultChars: config.maxToolResultChars,
				temperature: config.temperature,
				maxIterations: config.maxIterations,
				hooks,
				extensions: runtimeExtensions,
				logger: logger ?? config.logger,
				telemetry: input.telemetry ?? config.telemetry,
				workspaceMetadata: config.workspaceMetadata,
				// One gate for the spawn paths that do all read this provider -- the
				// team runtime, the lead's `spawn_agent`, and a sub-agent spawning
				// its own -- and the registry beside it for the one that does not.
				// The session's endpoint takes its gate from the same registry, so a
				// configured agent left on the session's connection queues with the
				// free-form sub-agents rather than beside them.
				slotGate: agentSlotGates.for(
					agentEndpointKey({
						providerId: agentsOverrides.providerId ?? config.providerId,
						baseUrl: agentsOverrides.baseUrl ?? config.baseUrl,
					}),
				),
				slotGates: agentSlotGates,
				...agentsOverrides,
			},
			Object.keys(agentsOverrides) as (keyof DelegatedAgentConnectionConfig)[],
		);
		if (agentsConnection) {
			(logger ?? config.logger)?.log(
				`[Agents] Delegated agents run on provider=${agentsConnection.providerId} model=${agentsConnection.modelId}, not the session's`,
			);
		}
		// Tools that are simply absent are their own kind of confusion, so the
		// one place that knows why says so.
		if (
			!slotsAllowParallelDelegation(config.maxConcurrentAgents) &&
			(config.enableSpawnAgent !== false || config.enableAgentTeams !== false)
		) {
			(logger ?? config.logger)?.log(
				"[Agents] spawn_agent and the team tools are withheld: this endpoint serves 1 request at a time, so a delegated agent would run after the agent that spawned it rather than beside it. Raise the profile's parallel sessions to offer them.",
			);
		}
		if (normalized.enableSpawnAgent) {
			if (configuredAgents.configs.length > 0) {
				tools.push(
					...filterAvailableTools(
						createConfiguredAgentTools({
							configProvider: delegatedAgentConfigProvider,
							agents: configuredAgents.configs,
							// An agent naming a second provider needs that provider's
							// own credentials and base URL, and only the host knows
							// where its provider store is.
							resolveProviderConnection: config.resolveProviderConnection,
							resolveProfileConnection: config.resolveProfileConnection,
							listProfileNames: config.listProfileNames,
							createSubAgentTools: (agent) =>
								normalized.enableTools
									? filterToolsForConfiguredAgent(
											createBuiltinToolsList(
												config.cwd,
												agent.providerId ?? config.providerId,
												normalized.mode,
												agent.modelId ?? config.modelId,
												config.toolRoutingRules,
												effectiveToolPolicies,
												agent.skills !== undefined &&
													userInstructionService?.createSkillsExecutor
													? userInstructionService.createSkillsExecutor(
															agent.skills,
														)
													: undefined,
												toolExecutors,
												telemetry ?? config.telemetry,
												config.qaCredentials,
												input.runCommandExecutionController,
											),
											agent,
										)
									: [],
							hookErrorMode: config.hookErrorMode,
							toolPolicies: effectiveToolPolicies,
							requestToolApproval: input.requestToolApproval,
							onSubAgentEvent: input.onSubAgentEvent,
							onSubAgentStart: input.onSubAgentStart,
							onSubAgentEnd: input.onSubAgentEnd,
						}),
						effectiveToolPolicies,
					),
				);
			}
		}
		if (!this.teamRuntimeEntries.has(registryKey)) {
			this.teamRuntimeEntries.set(registryKey, {
				delegatedAgentConfigProvider,
			});
		}

		const ensureTeamRuntime = (): AgentTeamsRuntime | undefined => {
			if (!normalized.enableAgentTeams) {
				return undefined;
			}

			const registryEntry = this.teamRuntimeEntries.get(registryKey) ?? {
				delegatedAgentConfigProvider,
			};
			this.teamRuntimeEntries.set(registryKey, registryEntry);
			teamRuntime = registryEntry.runtime;

			if (!teamRuntime) {
				teamRuntime = new AgentTeamsRuntime({
					teamName: effectiveTeamName,
					leadAgentId: config.sessionId || "lead",
					// The team runtime has always had a bound of its own; until now it
					// was a hardcoded 2 that no caller ever set, which is the wrong
					// number on a one-slot server and on a ten-slot one alike. `0` is
					// the host saying admission control decides, so the counting bound
					// stands down rather than becoming the thing that refuses a run.
					maxConcurrentRuns:
						config.maxConcurrentAgents === 0
							? Number.POSITIVE_INFINITY
							: config.maxConcurrentAgents,
					missionLogIntervalSteps: normalized.missionLogIntervalSteps,
					missionLogIntervalMs: normalized.missionLogIntervalMs,
					onTeamEvent: (event: TeamEvent) => {
						onTeamEvent(event);
						if (teamRuntime && teamStore) {
							if (
								event.type === "teammate_spawned" &&
								event.teammate?.rolePrompt
							) {
								const spec: TeamTeammateSpec = {
									agentId: event.agentId,
									rolePrompt: event.teammate.rolePrompt,
									modelId: event.teammate.modelId,
									maxIterations: event.teammate.maxIterations,
								};
								teammateSpecs.set(spec.agentId, spec);
							}
							if (
								event.type === "teammate_shutdown" &&
								!isRuntimeLifecycleShutdownReason(event.reason)
							) {
								teammateSpecs.delete(event.agentId);
							}
							teamStore.handleTeamEvent(teamStoreKey, event);
							teamStore.persistRuntime(
								teamStoreKey,
								teamRuntime.exportState(),
								Array.from(teammateSpecs.values()),
							);
						}
					},
				});
				if (restoredTeamState) {
					teamRuntime.hydrateState(restoredTeamState);
					restoredStateHydratedIntoRuntime = true;
				}
				registryEntry.runtime = teamRuntime;
			}

			if (!teamToolsRegistered) {
				if (!teamRuntime) {
					return undefined;
				}
				teamToolsRegistered = true;

				const teamBootstrap = bootstrapAgentTeams({
					runtime: teamRuntime,
					leadAgentId: config.sessionId || "lead",
					restoredFromPersistence: Boolean(restoredTeamState),
					restoredTeammates: restoredTeammateSpecs,
					includeLeadSpawnTool: true,
					includeLeadManagementTools: true,
					onLeadToolsUnlocked: (teamTools) => {
						pendingLeadTeamTools = teamTools;
						leadAgentInstance?.addTools(teamTools);
					},
					createBaseTools: normalized.enableTools
						? () =>
								createBuiltinToolsList(
									config.cwd,
									config.providerId,
									normalized.mode,
									config.modelId,
									config.toolRoutingRules,
									effectiveToolPolicies,
									undefined,
									toolExecutors,
									telemetry ?? config.telemetry,
									config.qaCredentials,
									input.runCommandExecutionController,
								)
						: undefined,
					teammateConfigProvider: delegatedAgentConfigProvider,
				});

				if (restoredStateHydratedIntoRuntime) {
					teamRuntime.recoverActiveRuns("runtime_recovered");
				}

				if (teamBootstrap.restoredFromPersistence) {
					onTeamRestored?.();
				}
				tools.push(...teamBootstrap.tools);
			}

			return teamRuntime;
		};

		// `spawn_agent` goes the same way as the team tools and for the same
		// reason. The configured agents above do not: one of those exists
		// because someone wrote a file naming it, with its own model and often
		// its own provider, and a deliberate hand-off is worth serialising. This
		// is the open-ended one the model reaches for on its own.
		if (
			normalized.enableSpawnAgent &&
			createSpawnTool &&
			slotsAllowParallelDelegation(config.maxConcurrentAgents)
		) {
			const spawnTool = createSpawnTool();
			tools.push({
				...spawnTool,
				execute: async (spawnInput, context) => {
					ensureTeamRuntime();
					return spawnTool.execute(spawnInput, context);
				},
			});
		}

		if (normalized.enableAgentTeams) {
			ensureTeamRuntime();
		}

		const finalTools = filterAvailableTools(tools, effectiveToolPolicies);
		const requiresCompletionTool = finalTools.some(
			(tool) =>
				tool.name === "submit_and_exit" &&
				tool.lifecycle?.completesRun === true,
		);
		const teamCompletionGuard = normalized.enableAgentTeams
			? (): string | undefined => {
					const rt = this.teamRuntimeEntries.get(registryKey)?.runtime;
					if (!rt) return undefined;
					const tasks = rt.listTasks();
					const hasInProgress = tasks.some(
						(t) => t.status === "in_progress" || t.status === "pending",
					);
					const runs = rt.listRuns({});
					const hasActiveRuns = runs.some(
						(r) => r.status === "running" || r.status === "queued",
					);
					if (hasInProgress || hasActiveRuns) {
						const pending = tasks
							.filter(
								(t) => t.status === "in_progress" || t.status === "pending",
							)
							.map((t) => `${t.id} (${t.status}): ${t.title}`)
							.join(", ");
						const activeRunSummary = runs
							.filter((r) => r.status === "running" || r.status === "queued")
							.map((r) => `${r.id} (${r.status})`)
							.join(", ");
						const parts = [];
						if (pending) parts.push(`Unfinished tasks: ${pending}`);
						if (activeRunSummary)
							parts.push(`Active runs: ${activeRunSummary}`);
						return `[SYSTEM] You still have team obligations. ${parts.join(". ")}. Use team_run_task to delegate work, or team_task with action=complete to mark tasks done, or team_await_runs to wait for active runs. Do NOT stop until all tasks are completed.`;
					}
					return undefined;
				}
			: undefined;
		// `maxNoToolCallNudges` is always set here: the SDK leaves it off so the
		// bare runtime keeps its "a turn with no tool calls ends the run"
		// contract, but a coding agent is the case the nudge exists for. A model
		// that announces edits and stops leaves the task undone and the user
		// restarting the same cycle by hand.
		const completionPolicy = {
			...(requiresCompletionTool ? { requireCompletionTool: true } : {}),
			...(teamCompletionGuard ? { completionGuard: teamCompletionGuard } : {}),
			maxNoToolCallNudges: DEFAULT_MAX_NO_TOOL_CALL_NUDGES,
		};

		return {
			tools: finalTools,
			modelTools,
			logger: logger ?? config.logger,
			telemetry: telemetry ?? config.telemetry,
			teamRuntime,
			teamRestoredFromPersistence: Boolean(restoredTeamState),
			delegatedAgentConfigProvider:
				this.teamRuntimeEntries.get(registryKey)
					?.delegatedAgentConfigProvider ?? delegatedAgentConfigProvider,
			extensions: runtimeExtensions,
			completionPolicy,
			registerLeadAgent: (agent) => {
				leadAgentInstance = agent;
				if (pendingLeadTeamTools.length > 0) {
					agent.addTools(
						filterDisabledTools(pendingLeadTeamTools, [
							...globallyDisabledToolNames,
						]),
					);
				}
			},
			shutdown: async (reason: string) => {
				shutdownTeamRuntime(teamRuntime, reason);
				this.teamRuntimeEntries.delete(registryKey);
				await mcpShutdown?.();
				for (const service of ownedUserInstructionServices) {
					service.stop();
				}
			},
		};
	}
}
