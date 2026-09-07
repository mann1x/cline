import type {
	AgentConfig,
	AgentEvent,
	AgentHooks,
	AgentResult,
	AgentTool,
	BasicLogger,
	ITelemetryService,
	ModelTool,
	RuntimeConfigExtensionKind,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "@cline/shared";
import type {
	AgentPluginPackageMcpServer,
	AgentPluginPackageSkill,
} from "../../extensions/agent-plugin";
import type { UserInstructionConfigService } from "../../extensions/config";
import type {
	RunCommandExecutionController,
	ToolExecutors,
} from "../../extensions/tools";
import type {
	AgentTeamsRuntime,
	DelegatedAgentConfigProvider,
	SubAgentEndContext,
	SubAgentStartContext,
	TeamEvent,
} from "../../extensions/tools/team";
import type { ConfiguredAgentConfig } from "../../extensions/tools/team/configured-agent-config";
import type { WorkspaceManager } from "../../services/workspace/workspace-manager";
import type { CoreSessionConfig } from "../../types/config";

/**
 * Internal structural alias for the lead-agent handle that
 * {@link BuiltRuntime.registerLeadAgent} hands off to
 * `runtime-builder.ts`. Narrowed to only the `.addTools()` surface the
 * callback exercises; avoids depending on `@cline/agents`' `Agent`
 * class during the PLAN.md §3.6 Step 5 type-only migration. When
 * SessionRuntime is rebuilt in Step 6, this field is expected to be
 * dropped entirely per §3.5 row #2.
 */
type LeadAgentHandle = {
	addTools(tools: AgentTool[]): unknown;
};

export interface BuiltRuntime {
	tools: AgentTool[];
	modelTools?: ModelTool[];
	hooks?: AgentHooks;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	teamRuntime?: AgentTeamsRuntime;
	teamRestoredFromPersistence?: boolean;
	delegatedAgentConfigProvider?: DelegatedAgentConfigProvider;
	/**
	 * The agent files this session loaded, kept so a host can list them and
	 * delegate to one on the user's say-so rather than the model's. The tools
	 * built from them are in `tools`; this is the mapping back to what the user
	 * wrote and named.
	 */
	configuredAgents?: readonly ConfiguredAgentConfig[];
	extensions?: AgentConfig["extensions"];
	completionPolicy?: AgentConfig["completionPolicy"];
	registerLeadAgent?: (agent: LeadAgentHandle) => void;
	shutdown: (reason: string) => Promise<void> | void;
}

export interface RuntimeBuilderInput {
	config: CoreSessionConfig;
	/**
	 * Host-resolved stable end-user identity, forwarded so delegated agents
	 * (sub-agents / teammates) emit the same telemetry `userId` as the lead.
	 */
	distinctId?: string;
	hooks?: AgentHooks;
	extensions?: AgentConfig["extensions"];
	onTeamEvent?: (event: TeamEvent) => void;
	onSubAgentEvent?: (event: AgentEvent) => void;
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	createSpawnTool?: () => AgentTool;
	onTeamRestored?: () => void;
	userInstructionService?: UserInstructionConfigService;
	pluginSkillDirectories?: ReadonlyArray<string>;
	agentPluginSkills?: ReadonlyArray<AgentPluginPackageSkill>;
	agentPluginMcpServers?: ReadonlyArray<AgentPluginPackageMcpServer>;
	configExtensions?: RuntimeConfigExtensionKind[];
	toolExecutors?: Partial<ToolExecutors>;
	runCommandExecutionController?: RunCommandExecutionController;
	toolPolicies?: CoreSessionConfig["toolPolicies"];
	workspaceManager?: WorkspaceManager;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
}

export interface RuntimeBuilder {
	build(input: RuntimeBuilderInput): Promise<BuiltRuntime> | BuiltRuntime;
}

export interface SessionRuntime {
	start(config: CoreSessionConfig): Promise<{ sessionId: string }>;
	send(sessionId: string, prompt: string): Promise<AgentResult | undefined>;
	abort(sessionId: string, reason?: unknown): Promise<void>;
	stop(sessionId: string): Promise<void>;
	poll(): Promise<string[]>;
}
