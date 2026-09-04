/**
 * @cline/core
 *
 * Core contracts, shared state utilities, and Node runtime services.
 */

export * as Llms from "@cline/llms";
export {
	ClineFreeModelLimitError,
	ClineNotSubscribedError,
	ClineOrgIndividualInferenceSubscriptionError,
	ClinePassLimitError,
	extractClineFreeModelLimitResetTime,
	extractClinePassLimitMessage,
	getClineNotSubscribedMessage,
	getClineOrgIndividualInferenceSubscriptionMessage,
	getClinePassSubscriptionUrl,
	isClineFreeModelLimitError,
	isClineFreeModelLimitMessage,
	isClineModelNotFoundMessage,
	isClineNotSubscribedError,
	isClineNotSubscribedMessage,
	isClineOrgIndividualInferenceSubscriptionError,
	isClineOrgIndividualInferenceSubscriptionMessage,
	isClinePassLimitError,
	isClinePassLimitMessage,
	// A host that resolves the context window itself has to be able to ask the
	// server what the model declares, and to ask before the first request —
	// otherwise the window the sampler uses and the one compaction sizes itself
	// against are two different numbers.
	primeDeclaredNumCtx,
	readDeclaredFamily,
	readDeclaredNumCtx,
} from "@cline/llms";
// Shared contracts and path helpers re-exported for app consumers.
export type {
	AddProviderActionRequest,
	AgentConfig,
	AgentEvent,
	AgentExtension as AgentPlugin, // Public-facing alias for extensions
	AgentExtensionCommand,
	AgentExtensionCommand as AgentPluginCommand,
	AgentExtensionCommandResult,
	AgentHooks,
	AgentMode,
	AgentResult,
	AgentRunResult,
	AgentRunStatus,
	AgentTool,
	AgentToolContext,
	AutomationEventEnvelope,
	BasicLogger,
	BasicLogger as Logger,
	CaptureSdkErrorInput,
	ChatRunTurnRequest,
	ChatRuntimeConfig,
	ChatStartSessionArtifacts,
	ChatStartSessionRequest,
	ChatTurnResult,
	ClineAccountActionRequest,
	ConnectorHookEvent,
	ContentBlock,
	FeatureFlag,
	FeatureFlagPayload,
	FeatureFlagsAndPayloads,
	FeatureFlagsContext,
	FeatureFlagsSettings,
	FileContent,
	GetProviderModelsActionRequest,
	HookSessionContext,
	IFeatureFlagsProvider,
	ImageContent,
	ITelemetryService,
	ListProvidersActionRequest,
	Message,
	MessageWithMetadata,
	ProviderActionRequest,
	ProviderCatalogResponse,
	ProviderListItem,
	ProviderModel,
	ProviderOAuthLoginResponse,
	RuntimeLoggerConfig,
	SaveProviderSettingsActionRequest,
	SdkTelemetryErrorComponent,
	SdkTelemetryErrorSeverity,
	SessionLineage,
	TEAM_LIFECYCLE_EVENT_TYPE,
	TEAM_PROGRESS_EVENT_TYPE,
	TeamProgressProjectionEvent,
	TelemetryArray,
	TelemetryMetadata,
	TelemetryObject,
	TelemetryPrimitive,
	TelemetryProperties,
	TelemetryValue,
	TextContent,
	ThinkingContent,
	ToolApprovalRequest,
	ToolApprovalResult,
	ToolPolicy,
	ToolResultContent,
	ToolUseContent,
	WorkspaceInfo,
	WorkspaceInfoSchema,
	WorkspaceManifest,
	WorkspaceManifestSchema,
} from "@cline/shared";
export {
	buildClineSystemPrompt as getClineDefaultSystemPrompt,
	buildSdkErrorProperties,
	ContributionRegistry,
	captureSdkError,
	createClineTelemetryServiceConfig,
	createClineTelemetryServiceMetadata,
	createContributionRegistry,
	createTool,
	emptyWorkspaceManifest,
	FEATURE_FLAGS,
	FeatureFlagDefaultValue,
	formatDisplayUserInput,
	noopBasicLogger,
	normalizeSdkError,
	normalizeUserInput,
	parseUserCommandEnvelope,
	registerDisposable,
	SDK_ERROR_TELEMETRY_EVENT,
	stripUtf8Bom,
} from "@cline/shared";
export * from "@cline/shared/storage";
export {
	type ClineAccountBalance,
	type ClineAccountOperations,
	type ClineAccountOrganization,
	type ClineAccountOrganizationBalance,
	type ClineAccountOrganizationUsageTransaction,
	type ClineAccountPaymentTransaction,
	ClineAccountService,
	type ClineAccountServiceOptions,
	type ClineAccountUsageTransaction,
	type ClineAccountUser,
	type ClineOrganization,
	type ClineSubscriptionPlan,
	executeClineAccountAction,
	type FeaturebaseTokenResponse,
	isClineAccountActionRequest,
	type ProviderActionExecutor,
	RpcClineAccountService,
	type UserCurrentPlan,
	type UserRemoteConfigOrganization,
	type UserRemoteConfigResponse,
} from "./account";
export {
	createOAuthClientCallbacks,
	type OAuthClientCallbacksOptions,
} from "./auth/client";
export {
	completeClineDeviceAuth,
	getValidClineCredentials,
	loginClineOAuth,
	refreshClineToken,
	startClineDeviceAuth,
} from "./auth/cline";
export {
	getValidOpenAICodexCredentials,
	loginOpenAICodex,
	refreshOpenAICodexToken,
} from "./auth/codex";
export {
	getValidOcaCredentials,
	loginOcaOAuth,
	refreshOcaToken,
} from "./auth/oca";
export {
	formatProviderOAuthApiKey,
	getPersistedProviderApiKey,
	getProviderAuthHandler,
	getProviderAuthStorageId,
	getProviderOAuthCredentialsFromSettings,
	isOAuthProvider,
	loginAndSaveProviderOAuthCredentials,
	type ProviderAuthHandler,
	type ProviderAuthLoginInput,
	type ProviderAuthRefreshInput,
	type ProviderAuthSaveCredentialsInput,
	type ProviderOAuthCredentials,
	resolveProviderApiKeyFromSettings,
	saveProviderOAuthCredentials,
} from "./auth/provider-auth-registry";
export type {
	LocalOAuthServer,
	LocalOAuthServerOptions,
	OAuthCallbackPayload,
	OAuthServerCloseInfo,
	OAuthServerListeningInfo,
} from "./auth/server";
export { startLocalOAuthServer } from "./auth/server";
export type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProviderInterface,
	OcaClientMetadata,
	OcaMode,
	OcaOAuthConfig,
	OcaOAuthEnvironmentConfig,
	OcaOAuthProviderOptions,
	OcaTokenResolution,
} from "./auth/types";
export { ClineCore } from "./ClineCore";
export type {
	ClineAutomationEventIngressResult,
	ClineAutomationEventLog,
	ClineAutomationEventSuppression,
	ClineAutomationListEventsOptions,
	ClineAutomationListRunsOptions,
	ClineAutomationListSpecsOptions,
	ClineAutomationRun,
	ClineAutomationRunStatus,
	ClineAutomationSpec,
	ClineCoreAutomationApi,
	ClineCoreAutomationOptions,
	ClineCoreListHistoryOptions,
	ClineCoreOptions,
	ClineCoreSettingsApi,
	ClineCoreStartInput,
	CompareCheckpointInput,
	CompareCheckpointResult,
	HubOptions,
	RemoteOptions,
	RestoreInput,
	RestoreOptions,
	RestoreResult,
} from "./cline-core/types";
export type {
	AgentPluginPackageDiagnostic,
	AgentPluginPackageDiagnosticScope,
	AgentPluginPackageLoadReport,
	AgentPluginPackageManifest,
	AgentPluginPackageMcpServer,
	AgentPluginPackageSkill,
	AgentSkillMetadata,
	LoadAgentPluginFromPathOptions,
	LoadAgentPluginPackagesOptions,
	LoadedAgentPluginPackage,
	ParsedAgentSkill,
	PluginInitializationFailure,
	PluginInitializationWarning,
	PluginLoadDiagnostics,
	ResolveAgentPluginPathsOptions,
} from "./extensions";
export {
	AGENT_PLUGINS_V1_MANIFEST_SCHEMA,
	AGENT_PLUGINS_V1_MCP_SCHEMA,
	discoverPluginModulePaths,
	getPluginDisplayName,
	loadAgentPluginFromPath,
	loadAgentPluginPackages,
	loadAgentPluginsFromPaths,
	loadAgentPluginsFromPathsWithDiagnostics,
	parseAgentSkillMarkdown,
	resolveAgentPluginPaths,
	resolveAndLoadAgentPlugins,
	resolvePluginConfigSearchPaths,
	resolvePluginSkillDirectoriesFromPaths,
} from "./extensions";
export type {
	AvailableRuntimeCommand,
	CreateInstructionWatcherOptions,
	CreateRulesConfigDefinitionOptions,
	CreateSkillsConfigDefinitionOptions,
	CreateUserInstructionConfigServiceOptions,
	CreateWorkflowsConfigDefinitionOptions,
	ParseMarkdownFrontmatterResult,
	ResolveRuntimeSlashCommandOptions,
	RuleConfig,
	SkillConfig,
	UnifiedConfigDefinition,
	UnifiedConfigFileCandidate,
	UnifiedConfigFileContext,
	UnifiedConfigRecord,
	UnifiedConfigWatcherEvent,
	UnifiedConfigWatcherOptions,
	UserInstructionConfig,
	UserInstructionConfigRecord,
	UserInstructionConfigService,
	UserInstructionConfigType,
	WorkflowConfig,
} from "./extensions/config";
export {
	type AuditPromptTemplateProposalArgs,
	auditPromptTemplateProposal,
	combineUserInstructionConfigServices,
	createPromptTemplateHooks,
	createRulesConfigDefinition,
	createSkillsConfigDefinition,
	createUserInstructionConfigService,
	createWorkflowsConfigDefinition,
	DEFAULT_REQUIRED_REWRITES,
	describeResolvedPromptTemplate,
	type GeneratePromptTemplateArgs,
	type GeneratePromptTemplateResult,
	generatePromptTemplate,
	getBuiltinPromptTemplateSource,
	getBuiltinPromptTemplates,
	getShippedToolCallSignatures,
	HOST_TOOL_INPUT_SCHEMAS,
	loadPromptTemplates,
	loadPromptTemplatesFromDirectory,
	PROMPT_TEMPLATES_DIRECTORY_NAME,
	type PromptTemplateDirectory,
	type PromptTemplateFileWarnings,
	type PromptTemplateHooksOptions,
	type PromptTemplateLoadError,
	type PromptTemplateLoadResult,
	type PromptTemplateParseInput,
	type PromptTemplateParseResult,
	type PromptTemplateProposalAudit,
	parsePromptTemplate,
	parseRuleConfigFromMarkdown,
	parseSkillConfigFromMarkdown,
	parseWorkflowConfigFromMarkdown,
	RULES_CONFIG_DIRECTORY_NAME,
	resolvePromptTemplateDirectories,
	resolveRulesConfigSearchPaths,
	resolveSessionPromptTemplateFrom,
	resolveSkillsConfigSearchPaths,
	resolveWorkflowsConfigSearchPaths,
	type SessionPromptTemplateRequest,
	type SessionPromptTemplateResult,
	SKILLS_CONFIG_DIRECTORY_NAME,
	summarizeToolCallSignatures,
	type ToolCallSignature,
	UnifiedConfigFileWatcher,
	WORKFLOWS_CONFIG_DIRECTORY_NAME,
} from "./extensions/config";
export {
	type AuthorizeMcpServerOAuthOptions,
	type AuthorizeMcpServerOAuthResult,
	augmentMcpTimeoutError,
	authorizeMcpServerOAuth,
	type CreateDisabledMcpToolPoliciesOptions,
	type CreateDisabledMcpToolPolicyOptions,
	type CreateMcpToolsOptions,
	createDefaultMcpServerClientFactory,
	createDisabledMcpToolPolicies,
	createDisabledMcpToolPolicy,
	createMcpTools,
	DEFAULT_MCP_CONNECT_TIMEOUT_MS,
	type DefaultMcpServerClientFactoryOptions,
	getMcpServerOAuthState,
	getMcpServerOAuthStatus,
	hasMcpSettingsFile,
	InMemoryMcpManager,
	type LoadMcpSettingsOptions,
	listMcpServerOAuthStatuses,
	loadMcpSettingsFile,
	type McpConnectionStatus,
	type McpManager,
	type McpManagerOptions,
	McpOAuthClientChangedError,
	type McpServerClient,
	type McpServerClientFactory,
	type McpServerOAuthClientConfig,
	type McpServerOAuthState,
	type McpServerOAuthStatus,
	type McpServerRegistration,
	type McpServerSnapshot,
	type McpServerTransportConfig,
	type McpSettingsFile,
	type McpSettingsLockOptions,
	McpSettingsLockTimeoutError,
	type McpSettingsMutator,
	McpSettingsMutatorPurityError,
	McpSettingsUpdateSkippedError,
	type McpSseTransportConfig,
	type McpStdioTransportConfig,
	type McpStreamableHttpTransportConfig,
	type McpToolCallRequest,
	type McpToolCallResult,
	type McpToolDescriptor,
	type McpToolNameTransform,
	type McpToolProvider,
	type ProbeMcpServerConnectionOptions,
	type ProbeMcpServerConnectionResult,
	parseMcpServerRegistration,
	probeMcpServerConnection,
	type RegisterMcpServersFromSettingsOptions,
	registerMcpServersFromSettingsFile,
	resolveDefaultMcpSettingsPath,
	resolveMcpServerRegistration,
	resolveMcpServerRegistrations,
	type SetMcpServerDisabledOptions,
	setMcpServerDisabled,
	type UpdateMcpServerOAuthStateOptions,
	updateMcpServerOAuthState,
	updateMcpServerOAuthStateAsync,
	updateMcpSettingsFile,
	updateMcpSettingsFileSync,
} from "./extensions/mcp";
export {
	type AgentProfileConnection,
	type AgentProviderConnection,
	type AgentTask,
	AgentTeam,
	AgentTeamsRuntime,
	type AgentTeamsRuntimeOptions,
	type BootstrapAgentTeamsOptions,
	type BootstrapAgentTeamsResult,
	bootstrapAgentTeams,
	buildConfiguredAgentToolDescriptors,
	buildConfiguredAgentToolName,
	buildDelegatedAgentConfig,
	buildTeamProgressSummary,
	type ConfiguredAgentConfig,
	type ConfiguredAgentInput,
	type ConfiguredAgentLoadResult,
	type ConfiguredAgentReadError,
	type ConfiguredAgentToolConfig,
	type ConfiguredAgentToolDescriptor,
	type CreateAgentTeamsToolsOptions,
	createAgentTeamsTools,
	createConfiguredAgentTools,
	createDelegatedAgent,
	createDelegatedAgentConfigProvider,
	createSpawnAgentTool,
	type DelegatedAgentConfigProvider,
	type DelegatedAgentConnectionConfig,
	type DelegatedAgentKind,
	type DelegatedAgentRuntimeConfig,
	loadConfiguredAgentConfigs,
	parseConfiguredAgentConfig,
	reviveTeamStateDates,
	type SpawnTeammateOptions,
	type SubAgentEndContext,
	type SubAgentStartContext,
	type TaskResult,
	type TeamEvent,
	type TeamMemberConfig,
	type TeamTeammateRuntimeConfig,
	toTeamProgressLifecycleEvent,
} from "./extensions/tools/team";
export {
	createAgentHooksExtension,
	createHookAuditHooks,
	createHookConfigFileExtension,
	createHookConfigFileHooks,
	createSubprocessHooks,
	HOOK_CONFIG_FILE_EVENT_MAP,
	HOOKS_CONFIG_DIRECTORY_NAME,
	type HookConfigFileEntry,
	HookConfigFileName,
	type HookEventName,
	HookEventNameSchema,
	type HookEventPayload,
	HookEventPayloadSchema,
	listHookConfigFiles,
	mergeAgentHooks,
	parseHookEventPayload,
	type RunHookOptions,
	type RunHookResult,
	type RunSubprocessEventOptions,
	type RunSubprocessEventResult,
	resolveHooksConfigSearchPaths,
	runHook,
	runSubprocessEvent,
	type SubprocessHookControl,
	type SubprocessHooksOptions,
	toHookConfigFileName,
} from "./hooks";
export type {
	CheckpointEntry,
	CheckpointMetadata,
} from "./hooks/checkpoint-hooks";
export * from "./hub";
export { HubRuntimeHost } from "./hub/runtime-host/hub-runtime-host";
export { RemoteRuntimeHost } from "./hub/runtime-host/remote-runtime-host";
export {
	hashSecret,
	sdkDebug,
	setSdkLogger,
} from "./logging/early-logger";
export {
	buildRemoteConfigSessionBlobUploadMetadata,
	createRemoteConfigSessionMessagesArtifactUploader,
	type PreparedRemoteConfigCoreIntegration,
	type PrepareRemoteConfigCoreIntegrationOptions,
	prepareRemoteConfigCoreIntegration,
	REMOTE_CONFIG_SESSION_BLOB_UPLOAD_METADATA_KEY,
	readRemoteConfigSessionBlobUploadMetadata,
	registerRemoteConfigSessionBlobUpload,
} from "./remote-config/integration";
export type { RuntimeCapabilities } from "./runtime/capabilities";
export { normalizeRuntimeCapabilities } from "./runtime/capabilities";
export type {
	ConnectionUpdate,
	ConnectionUpdateInput,
} from "./runtime/config/connection-update";
export { buildConnectionUpdate } from "./runtime/config/connection-update";
export { listSessionHistoryFromBackend } from "./runtime/host/history";
export type { SessionBackend } from "./runtime/host/host";
export {
	createRuntimeHost,
	createRuntimeHost as createSessionHost,
	resolveSessionBackend,
} from "./runtime/host/host";
export { LocalRuntimeHost } from "./runtime/host/local-runtime-host";
export type {
	CommandExecutionRuntimeService,
	PendingPromptMutationResult,
	PendingPromptsDeleteInput,
	PendingPromptsListInput,
	PendingPromptsRuntimeService,
	PendingPromptsServiceApi,
	PendingPromptsUpdateInput,
	RestoreSessionInput,
	RestoreSessionResult,
	RuntimeHost,
	RuntimeHost as SessionHost,
	RuntimeHostMode,
	RuntimeHostSubscribeOptions,
	SendSessionInput,
	SessionAccumulatedUsage,
	SessionUsageSummary,
	StartSessionConfig,
	StartSessionInput,
	StartSessionResult,
} from "./runtime/host/runtime-host";
export {
	isSessionNotFoundError,
	isUnusableSessionError,
	SESSION_NOT_FOUND_ERROR_CODE,
	SessionNotFoundError,
	splitCoreSessionConfig,
} from "./runtime/host/runtime-host";
export {
	createTeamName,
	DefaultRuntimeBuilder,
} from "./runtime/orchestration/runtime-builder";
export {
	OAuthReauthRequiredError,
	type RuntimeOAuthResolution,
	RuntimeOAuthTokenManager,
} from "./runtime/orchestration/runtime-oauth-token-manager";
export type {
	BuiltRuntime,
	RuntimeBuilder,
	RuntimeBuilderInput,
	SessionRuntime,
} from "./runtime/orchestration/session-runtime";
export {
	getProcessStartToken,
	getProcessStartTokenAsync,
	type ProcessStartTokenProbeResult,
	probeProcessStartToken,
	probeProcessStartTokenAsync,
} from "./runtime/process-start-token";
export {
	formatRulesForSystemPrompt,
	isRuleEnabled,
	mergeRulesForSystemPrompt,
} from "./runtime/safety/rules";
export {
	type SandboxCallOptions,
	SubprocessSandbox,
	type SubprocessSandboxOptions,
} from "./runtime/tools/subprocess-sandbox";
export {
	type DesktopToolApprovalOptions,
	requestDesktopToolApproval,
} from "./runtime/tools/tool-approval";
export { listActiveConnectors } from "./services/connectors/active-connectors";
export {
	disableConnectorAutostart,
	getPersistedConnectorConnection,
	persistConnectorConnection,
	type ReconnectAttempt,
	type ReconnectPersistedConnectorsOptions,
	type ReconnectTarget,
	reconnectPersistedConnectors,
	removePersistedConnectorConnection,
} from "./services/connectors/connector-autostart";
export { buildConnectorChildEnv } from "./services/connectors/connector-child-env";
export { cleanupConnectorInstanceViaCli } from "./services/connectors/connector-cleanup";
export {
	ADOPTED_POLL_INTERVAL_MS,
	ConnectorSupervisor,
	type ConnectorSupervisorDeps,
	getActiveConnectorSupervisor,
	RESTART_BASE_DELAY_MS,
	RESTART_COUNTER_RESET_MS,
	RESTART_GIVE_UP_AFTER,
	RESTART_MAX_DELAY_MS,
	STOP_SIGKILL_TIMEOUT_MS,
	STOP_SIGTERM_TIMEOUT_MS,
	setActiveConnectorSupervisor,
} from "./services/connectors/connector-supervisor";
export {
	FeatureFlagsService,
	type FeatureFlagsServiceOptions,
	NoOpFeatureFlagsProvider,
} from "./services/feature-flags";
export type {
	GlobalCompactionMode,
	GlobalCompactionStrategy,
	GlobalPlanActMode,
	GlobalSettings,
} from "./services/global-settings";
export {
	filterDisabledPluginPaths,
	filterDisabledTools,
	filterExtensionToolRegistrations,
	GlobalSettingsSchema,
	isAgentPluginDisabledGlobally,
	isAutoUpdateEnabledGlobally,
	isModelToolEnabledGlobally,
	isPluginDisabledGlobally,
	isTelemetryOptedOutGlobally,
	isToolDisabledGlobally,
	readCompactionModeGlobally,
	readCompactionStrategyGlobally,
	readGlobalSettings,
	readPlanActModeGlobally,
	readToolAutoApproveGlobally,
	readTuiThemeGlobally,
	resolveDisabledAgentPluginNames,
	resolveDisabledPluginPaths,
	resolveDisabledToolNames,
	resolveModelToolSettings,
	setAutoUpdateEnabledGlobally,
	setCompactionModeGlobally,
	setCompactionStrategyGlobally,
	setDisabledAgentPlugin,
	setDisabledPlugin,
	setDisabledTools,
	setModelToolEnabledGlobally,
	setPlanActModeGlobally,
	setTelemetryOptOutGlobally,
	setToolAutoApproveGlobally,
	setTuiThemeGlobally,
	toggleDisabledTool,
	writeGlobalSettings,
} from "./services/global-settings";
export type {
	MarketplaceActionResult,
	MarketplaceEntryInput,
	MarketplacePrimitiveType,
	MarketplaceSpawnCommand,
	MarketplaceSpawnResult,
	UninstallMarketplaceEntryOptions,
} from "./services/marketplace";
export {
	findInstalledGlobalMarketplaceSkillName,
	getGlobalMarketplaceSkillPaths,
	getMarketplaceSkillCandidates,
	isMarketplaceSkillInstalled,
	marketplaceEntryKey,
	resolveMarketplaceMcpServerName,
	uninstallMarketplaceEntry,
	uninstallMarketplaceMcpServerFromSettings,
	uninstallMarketplacePlugin,
	uninstallMarketplaceSkill,
} from "./services/marketplace";
export type {
	McpInstallOptions,
	McpInstallResult,
	McpUninstallOptions,
	McpUninstallResult,
} from "./services/mcp-install";
export {
	buildMcpInstallTransport,
	installMcpServer,
	parseMcpInstallArgs,
	uninstallMcpServer,
} from "./services/mcp-install";
export type {
	ParsedPluginSource,
	PluginInstallOptions,
	PluginInstallResult,
	PluginInstallSourceType,
	PluginMcpOAuthCandidate,
} from "./services/plugin-install";
export {
	collectPluginMcpOAuthCandidates,
	installPlugin,
	isOfficialPluginSlug,
	parsePluginSource,
} from "./services/plugin-install";
export type {
	PluginMcpSettingsMutation,
	PluginMcpSettingsSyncResult,
	RemovePluginMcpServersFromSettingsOptions,
	SyncPluginMcpServersToSettingsOptions,
} from "./services/plugin-mcp-settings";
export {
	disablePluginMcpServersInSettings,
	removePluginMcpServersFromSettings,
	syncPluginMcpServersToSettings,
} from "./services/plugin-mcp-settings";
export type {
	ListPluginToolsResult,
	PluginContributionSummary,
	PluginToolSummary,
} from "./services/plugin-tools";
export {
	listPluginTools,
	listPluginToolsWithDiagnostics,
} from "./services/plugin-tools";
export type {
	PluginUninstallOptions,
	PluginUninstallResult,
} from "./services/plugin-uninstall";
export { uninstallPlugin } from "./services/plugin-uninstall";
export {
	ensureCustomProvidersLoadedSync,
	readModelsFileSync,
	resolveModelsRegistryPath,
	type StoredModelEntry,
	type StoredProviderEntry,
	syncStoredProviderRegistration,
	writeModelsFileSync,
} from "./services/providers/local-provider-registry";
export {
	addLocalProvider,
	type CreateConfiguredStreamingTranscriptionSessionRequest,
	createConfiguredStreamingTranscriptionSession,
	type DeleteLocalProviderRequest,
	deleteLocalProvider,
	ensureCustomProvidersLoaded,
	getLocalProviderModels,
	isDedicatedTranscriptionModel,
	listLocalProviders,
	loginAndSaveLocalProviderOAuthCredentials,
	loginLocalProvider,
	markLocalProviderEnabled,
	normalizeOAuthProvider,
	refreshProviderModelsFromSource,
	resolveLocalClineAuthToken,
	saveLocalProviderOAuthCredentials,
	saveLocalProviderSettings,
	saveVoiceInputSettings,
	type TranscribeConfiguredVoiceInputRequest,
	type TranscribeLocalAudioRequest,
	transcribeConfiguredVoiceInput,
	transcribeLocalAudio,
	type UpdateLocalProviderRequest,
	updateLocalProvider,
} from "./services/providers/local-provider-service";
export {
	getProviderConfigFields,
	type ProviderConfigFieldKey,
	type ProviderConfigFieldRequirement,
	type ProviderConfigFields,
} from "./services/providers/provider-config-fields";
export { isProviderSettingsUsable } from "./services/providers/provider-readiness";
export * from "./services/session-import";
export {
	type MigrateLegacyProviderSettingsOptions,
	type MigrateLegacyProviderSettingsResult,
	migrateLegacyProviderSettings,
} from "./services/storage/provider-settings-legacy-migration";
export { ProviderSettingsManager } from "./services/storage/provider-settings-manager";
export { SqliteSessionStore } from "./services/storage/sqlite-session-store";
export {
	SqliteTeamStore,
	type SqliteTeamStoreOptions,
} from "./services/storage/team-store";
export {
	resolveCoreDeviceId,
	resolveCoreDistinctId,
} from "./services/telemetry";
export type {
	CaptureAgentUnexpectedReasoningTokensInput,
	CaptureCompactionExecutedProperties,
	CaptureCompactionSkippedProperties,
	TelemetryAgentIdentityProperties,
	TelemetryAgentKind,
	TelemetryCompactionMode,
	TelemetryCompactionStrategy,
	WorkspaceInitErrorProperties,
	WorkspaceInitializedProperties,
	WorkspacePathResolvedProperties,
} from "./services/telemetry/core-events";
export {
	CORE_TELEMETRY_EVENTS,
	captureAgentCreated,
	captureAgentTeamCreated,
	captureAgentUnexpectedReasoningTokens,
	captureAuthFailed,
	captureAuthLoggedOut,
	captureAuthRefreshSoftFailure,
	captureAuthStarted,
	captureAuthSucceeded,
	captureCompactionExecuted,
	captureCompactionSkipped,
	captureConversationTurnEvent,
	captureDiffEditFailure,
	captureExtensionActivated,
	captureHookDiscovery,
	captureMentionFailed,
	captureMentionSearchResults,
	captureMentionUsed,
	captureMistakeLimitReached,
	captureModeSwitch,
	captureProviderApiError,
	captureProviderConfigured,
	captureSkillUsed,
	captureSubagentExecution,
	captureTaskCompleted,
	captureTaskCreated,
	captureTaskRestarted,
	captureTokenUsage,
	captureToolUsage,
	captureWorkspaceInitError,
	captureWorkspaceInitialized,
	captureWorkspacePathResolved,
	identifyAccount,
} from "./services/telemetry/core-events";
export type { ITelemetryAdapter } from "./services/telemetry/ITelemetryAdapter";
export {
	type ConfiguredTelemetryHandle,
	type CreateOpenTelemetryTelemetryServiceOptions,
	createConfiguredTelemetryHandle,
	createConfiguredTelemetryService,
	createOpenTelemetryTelemetryService,
	OpenTelemetryProvider,
	type OpenTelemetryProviderOptions,
} from "./services/telemetry/OpenTelemetryProvider";
export {
	TelemetryLoggerSink,
	type TelemetryLoggerSinkOptions,
} from "./services/telemetry/TelemetryLoggerSink";
export {
	accumulateUsageTotals,
	createInitialAccumulatedUsage,
	getCurrentContextSize,
	summarizeUsageFromMessages,
} from "./services/usage";
export type {
	FastFileIndexOptions,
	MentionEnricherOptions,
	MentionEnrichmentResult,
} from "./services/workspace";
export {
	enrichPromptWithMentions,
	ensureChatWorkspace,
	getFileIndex,
	prewarmFileIndex,
} from "./services/workspace";
export type {
	WorkspaceManager,
	WorkspaceManagerEvent,
} from "./services/workspace/workspace-manager";
export { InMemoryWorkspaceManager } from "./services/workspace/workspace-manager";
export {
	buildWorkspaceMetadata,
	generateWorkspaceInfo,
	generateWorkspaceInfoWithDiagnostics,
	normalizeWorkspacePath,
} from "./services/workspace/workspace-manifest";
export {
	buildCheckpointWorkspaceDiff,
	type CheckpointComparePlan,
	type CheckpointContentDiff,
	type CheckpointWorkspaceCompareResult,
	compareCheckpointToWorkspace,
	createCheckpointComparePlan,
} from "./session/checkpoint-diff";
export {
	createRestoredCheckpointMetadata,
	findCheckpointForRun,
	readSessionCheckpointHistory,
	trimMessagesBeforeUserRun,
} from "./session/checkpoint-restore";
export {
	projectSessionMessagesForDisplay,
	type SessionDisplayMessage,
} from "./session/display-messages";
export {
	deriveSubsessionStatus,
	makeSubSessionId,
	makeTeamTaskSubSessionId,
	sanitizeSessionToken,
} from "./session/models/session-graph";
export type { SessionManifest } from "./session/models/session-manifest";
export type { SessionRow } from "./session/models/session-row";
export * from "./session/search";
export type {
	CreateRootSessionWithArtifactsInput,
	RootSessionArtifacts,
} from "./session/services/session-service";
export { CoreSessionService } from "./session/services/session-service";
export type {
	CoreSessionCheckpointSnapshot,
	CoreSessionSnapshot,
} from "./session/session-snapshot";
export { createCoreSessionSnapshot } from "./session/session-snapshot";
export type {
	SessionCheckpointRestoreContext,
	SessionCheckpointRestoreResult,
	SessionVersioningErrorCode,
} from "./session/session-versioning-service";
export {
	SessionVersioningError,
	SessionVersioningService,
} from "./session/session-versioning-service";
export {
	FileTeamPersistenceStore,
	type FileTeamPersistenceStoreOptions,
} from "./session/stores/team-persistence-store";
export {
	countUserRunMessages,
	getUserRunSpan,
	isUserRunMessage,
	type MessageDisplayRole,
	resolveMessageDisplayRole,
} from "./session/user-run-messages";
export type {
	CorePluginContributions,
	CorePluginSettingsSnapshot,
	CorePluginSettingsSource,
	CoreSettingsItem,
	CoreSettingsItemKind,
	CoreSettingsItemSource,
	CoreSettingsListInput,
	CoreSettingsMutationResult,
	CoreSettingsServiceOptions,
	CoreSettingsSnapshot,
	CoreSettingsToggleInput,
	CoreSettingsType,
} from "./settings";
export {
	CoreSettingsService,
	createCoreSettingsService,
} from "./settings";
export * from "./tasks";
export type {
	ChatMessage,
	ChatMessageImage,
	ChatSessionConfig,
	ChatSessionStatus,
	ChatSummary,
	ChatViewState,
} from "./types/chat-schema";
export {
	ChatMessageImageSchema,
	ChatMessageRoleSchema,
	ChatMessageSchema,
	ChatSessionConfigSchema,
	ChatSessionStatusSchema,
	ChatSummarySchema,
	ChatViewStateSchema,
} from "./types/chat-schema";
export type { SessionMessagesArtifactUploader } from "./types/session";
export { CORE_BUILD_VERSION } from "./version";
export async function loadOpenTelemetryAdapter() {
	return import("./services/telemetry/index.js");
}
export { Agent, createAgentRuntime } from "@cline/agents";
export {
	createCappedThinkingNoteWriter,
	createCappedThinkingPrepareTurn,
	DEFAULT_CAPPED_THINKING_PROMPT,
	findCappedThinkingIndex,
} from "./extensions/context/capped-thinking";
export {
	createCompactionStateAwarePrepareTurn,
	createContextCompactionPrepareTurn,
} from "./extensions/context/compaction";
// Exported so the settings panel can show the built-in prompt as the
// placeholder for the field that replaces it.
export {
	DEFAULT_COMPACTION_PROMPT,
	DEFAULT_THINKING_COMPACTION_PROMPT,
} from "./extensions/context/compaction-shared";
export {
	ALL_DEFAULT_TOOL_NAMES,
	type ApplyPatchExecutor,
	type ApplyPatchInput,
	type AskQuestionExecutor,
	type BuiltinToolAvailabilityContext,
	CommandExitError,
	type CreateBuiltinToolsOptions,
	type CreateDefaultToolsOptions,
	computePatchChanges,
	createApplyPatchExecutor,
	createBuiltinTools,
	createDefaultExecutors,
	createDefaultShellExecutor,
	createDefaultTools,
	createDefaultToolsWithPreset,
	createEditorExecutor,
	createFileReadExecutor,
	createReadReceipts,
	createSecretRedactor,
	createShellExecutor,
	createShellTool,
	createToolPoliciesWithPreset,
	type DefaultExecutorsOptions,
	type DefaultToolName,
	DefaultToolNames,
	type DefaultToolsConfig,
	type EditFileInput,
	type EditorExecutor,
	type EditorExecutorOptions,
	getCoreAcpToolNames,
	getCoreBuiltinToolCatalog,
	getCoreDefaultEnabledToolIds,
	getCoreHeadlessToolNames,
	isCoreBuiltinToolAvailable,
	isSkillsToolAvailable,
	MAX_COMMAND_OUTPUT_CHARS,
	PATCH_MARKERS,
	PatchActionType,
	type PatchFileChange,
	type ReadReceipts,
	resolveCoreSelectedToolIds,
	resolveToolClientType,
	type ShellExecutionOptions,
	type ShellExecutor,
	type ShellExecutorOptions,
	type StructuredCommandInput,
	StructuredCommandInputSchema,
	TEAM_TOOL_NAMES,
	type ToolCatalogEntry,
	type ToolClientType,
	type ToolExecutors,
	type ToolPolicyPresetName,
	type ToolPresetName,
	ToolPresets,
	truncateCommandOutput,
} from "./extensions/tools";
// The browser and the language-server tools. Both were the extension's alone,
// and that was the difference between the two hosts: the CLI could not check
// that a page runs, and could not ask what a symbol means. Each takes its host
// half as an injected interface -- a `BrowserDriver`, a `CodeIntelProvider` --
// so the definition and the description are shared while VS Code keeps its
// language servers and the CLI brings its own.
export {
	BROWSER_ACTIONS,
	BROWSER_TOOL_DESCRIPTION,
	BROWSER_TOOL_INPUT_SCHEMA,
	BROWSER_TOOL_NAME,
	type BrowserActionResult,
	type BrowserDriver,
	type BrowserToolAction,
	type BrowserToolOptions,
	createBrowserTool,
	localPathOf,
	renderBrowserResult,
	splitDataUrl,
	toNavigableUrl,
} from "./extensions/tools/browser";
export {
	buildCheckFileDescription,
	buildLintCommand,
	CHECK_FILE_TOOL_DESCRIPTION,
	CHECK_FILE_TOOL_INPUT_SCHEMA,
	CHECK_FILE_TOOL_NAME,
	checkSource,
	compileCheck,
	createCheckFileTool,
	extractScripts,
	LINT_COMMAND_FILE_PLACEHOLDER,
	type LintCommandResult,
} from "./extensions/tools/check-file";
export {
	CODE_INTEL_OPERATIONS,
	CODE_INTEL_TOOL_DESCRIPTION,
	CODE_INTEL_TOOL_INPUT_SCHEMA,
	CODE_INTEL_TOOL_NAME,
	type CodeIntelLocation,
	type CodeIntelOperation,
	type CodeIntelProvider,
	type CodeIntelSymbol,
	type CodeIntelToolOptions,
	createCodeIntelTool,
	type ParsedCodeIntelRequest,
	parseCodeIntelRequest,
} from "./extensions/tools/code-intel";
// The bracket scanner is host-independent and two hosts want it: the checker
// above, and VS Code's own `check_file`, which pairs it with the language
// servers this one has no access to.
export {
	type DelimiterFinding,
	type DelimiterScan,
	describeDelimiterBalance,
	scanDelimiters,
	scanWithBalance,
} from "./extensions/tools/delimiter-balance";
// The workspace lister, and the tool that reads it. Both hosts install this:
// the reflex it displaces -- `ls`, `dir /s` -- is not VS Code's, it is any
// model that has no other way to find out what exists.
export {
	createListFilesTool,
	createLocalWorkspaceLister,
	type DirectoryEntry,
	globToRegExp,
	isWithin,
	LIST_FILES_TOOL_DESCRIPTION,
	LIST_FILES_TOOL_INPUT_SCHEMA,
	LIST_FILES_TOOL_NAME,
	type ListFilesToolOptions,
	normalizeMaxResults,
	renderDirectory,
	renderMatches,
	type WorkspaceLister,
} from "./extensions/tools/list-files";
export {
	commandText,
	describeQaCredentials,
	type NormalizedQaCredentials,
	normalizeQaCredentials,
	QA_CREDENTIAL_MIN_VALUE_LENGTH,
	QA_CREDENTIAL_NAME_PATTERN,
	type QaCredential,
	qaCredentialNames,
	type RejectedQaCredential,
	referencedCredentialNames,
	resolveCredentialEnv,
} from "./extensions/tools/qa-credentials";
// The check a model proposes and a host puts to the user. A host that has
// somewhere to ask supplies `approveCheck`; one that has not leaves it out.
export type {
	CheckApproval,
	CheckApprover,
	CheckProposal,
} from "./runtime/atomic/proposal";
export {
	applyClineFeaturedModels,
	type ClineRecommendedModel,
	type ClineRecommendedModelsData,
	FALLBACK_CLINE_RECOMMENDED_MODELS,
	type FetchClineRecommendedModelsOptions,
	fetchClineRecommendedModels,
	getCachedClineRecommendedModels,
	peekClineRecommendedModels,
	resetClineRecommendedModelsCacheForTests,
} from "./services/llms/cline-recommended-models";
// Exported so a host can build a *second* model from a session's own settings —
// a describer that reads images for the session's model. The extension builds
// one from its own handler; the CLI had no way to reach this at all, which is
// why the vision path could not be run headlessly.
export { createAgentModelFromConfig } from "./services/llms/handler-factory";
export {
	clearLiveModelsCatalogCache,
	clearPrivateModelsCatalogCache,
	DEFAULT_MODELS_CATALOG_URL,
	getLiveModelsCatalog,
	getProviderConfig,
	isPrivateModelCatalogProvider,
	OPENAI_COMPATIBLE_PROVIDERS,
	resolveProviderConfig,
} from "./services/llms/provider-defaults";
export type {
	AuthSettings,
	AwsSettings,
	AzureSettings,
	BuiltInProviderId,
	GcpSettings,
	ModelCatalogConfig,
	ModelCatalogSettings,
	OcaSettings,
	ProviderCapability,
	ProviderClient,
	ProviderConfig,
	ProviderDefaultsConfig,
	ProviderId,
	ProviderProtocol,
	ProviderSettings,
	ReasoningSettings,
	SamplingSettings,
	SapSettings,
	ToProviderConfigOptions,
} from "./services/llms/provider-settings";
export {
	AuthSettingsSchema,
	AwsSettingsSchema,
	AzureSettingsSchema,
	BUILT_IN_PROVIDER,
	BUILT_IN_PROVIDER_IDS,
	createProviderConfig,
	GcpSettingsSchema,
	isBuiltInProviderId,
	ModelCatalogSettingsSchema,
	normalizeProviderId,
	OcaSettingsSchema,
	ProviderClientSchema,
	ProviderIdSchema,
	ProviderProtocolSchema,
	ProviderSettingsSchema,
	parseSettings,
	ReasoningSettingsSchema,
	SamplingSettingsSchema,
	SapSettingsSchema,
	safeCreateProviderConfig,
	safeParseSettings,
	toProviderConfig,
} from "./services/llms/provider-settings";
export {
	defineLlmsConfig,
	loadLlmsConfigFromFile,
} from "./services/llms/runtime-config";
export {
	createLlmsSdk,
	DefaultLlmsSdk,
} from "./services/llms/runtime-registry";
export type {
	BuiltInProviderSummary,
	CreateHandlerInput,
	LlmsConfig,
	LlmsSdk,
	ProviderConfigDefaults,
	ProviderSelectionConfig,
	RegisterBuiltinProviderInput,
	RegisteredProviderSummary,
	RegisterModelInput,
	RegisterProviderInput,
} from "./services/llms/runtime-types";
export {
	TelemetryService,
	type TelemetryServiceOptions,
} from "./services/telemetry/TelemetryService";
export {
	createSessionCompactionState,
	parseSessionCompactionState,
	projectSessionCompactionState,
	type SessionCompactionState,
} from "./session/models/session-compaction";
// Compatibility barrel (legacy imports).
export type { RuntimeEnvironment } from "./types";
export type { SessionStatus } from "./types/common";
export { SESSION_STATUSES, SessionSource } from "./types/common";
export type {
	ClineCoreStartConfig,
	CoreAgentMode,
	CoreCheckpointConfig,
	CoreCheckpointContext,
	CoreCompactionConfig,
	CoreCompactionContext,
	CoreCompactionResult,
	CoreCompactionStrategy,
	CoreCompactionSummarizerConfig,
	CoreModelConfig,
	CoreRuntimeFeatures,
	CoreSessionConfig,
	DelegatedAgentConnectionOverride,
} from "./types/config";
export type {
	CoreSessionEvent,
	SessionChunkEvent,
	SessionEndedEvent,
	SessionPendingPrompt,
	SessionPendingPromptSubmittedEvent,
	SessionPendingPromptsEvent,
	SessionTeamProgressEvent,
	SessionToolEvent,
} from "./types/events";
export type {
	ProviderTokenSource,
	StoredProviderModes,
	StoredProviderSettings,
	StoredProviderSettingsEntry,
} from "./types/provider-settings";
export {
	emptyStoredProviderSettings,
	StoredProviderModesSchema,
	StoredProviderSettingsEntrySchema,
	StoredProviderSettingsSchema,
} from "./types/provider-settings";
export type {
	SessionHistoryMetadata,
	SessionHistoryRecord,
	SessionRecord,
	SessionRef,
} from "./types/sessions";
export type { ArtifactStore, SessionStore, TeamStore } from "./types/storage";
