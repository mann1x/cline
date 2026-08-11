import type {
	AgentMode,
	CoreSessionConfig,
	Llms,
	ProviderSettings,
	RuntimeLoggerConfig,
	SessionLineage,
	SessionManifest,
	ToolPolicy,
} from "@cline/core";
import type { Message } from "@cline/shared";

export type CliOutputMode = "text" | "json";
export type CliAgentMode = AgentMode;
export type CliReasoningEffort = NonNullable<
	NonNullable<ProviderSettings["reasoning"]>["effort"]
>;
export type CliCompactionMode = "agentic" | "basic" | "off";

export interface Config extends Omit<CoreSessionConfig, "apiKey" | "mode"> {
	apiKey: string;
	knownModels?: Record<string, Llms.ModelInfo>;
	loggerConfig?: RuntimeLoggerConfig;
	verbose: boolean;
	timeoutSeconds?: number;
	sandbox: boolean;
	sandboxDataDir?: string;
	thinking?: boolean;
	outputMode: CliOutputMode;
	mode: CliAgentMode;
	defaultToolAutoApprove: boolean;
	toolPolicies: Record<string, ToolPolicy>;
}

export interface ActiveCliSession {
	manifest: SessionManifest;
}

export interface StoredApiMessages {
	version: 1;
	updated_at: string;
	messages: Message[];
}

export interface SessionDbRow {
	session_id: string;
	provider: string;
	model: string;
	cwd: string;
	workspace_root: string;
	team_name?: string | null;
	enable_tools: number;
	enable_spawn: number;
	enable_teams: number;
	prompt?: string | null;
}

export interface SubagentSessionInput
	extends Required<
		Pick<SessionLineage, "agentId" | "parentAgentId" | "conversationId">
	> {
	prompt?: string;
	rootSessionId?: string;
}

export interface ParsedArgs {
	prompt?: string;
	systemPrompt?: string;
	key?: string;
	verbose: boolean;
	interactive: boolean;
	outputMode: CliOutputMode;
	mode: CliAgentMode;
	/** Whether a mode flag (--plan/--act/--yolo/--zen) was explicitly provided */
	modeExplicitlySet?: boolean;
	timeoutSeconds?: number;
	invalidTimeoutSeconds?: string;
	thinking: boolean;
	/** Whether --thinking was explicitly provided on the command line */
	thinkingExplicitlySet?: boolean;
	reasoningEffort?: CliReasoningEffort;
	invalidThinkingLevel?: string;
	compactionMode?: CliCompactionMode;
	invalidCompactionMode?: string;
	invalidAutoApprove?: string;
	sandbox: boolean;
	dataDir?: string;
	configDir?: string;
	hooksDir?: string;
	worktree?: boolean;
	acpMode: boolean;
	model?: string;
	provider?: string;
	id?: string;
	retries?: number;
	editVerification?: "off" | "nudge" | "require";
	invalidEditVerification?: string;
	invalidRetries?: string;
	/** Whether the model keeps a checklist across the task. */
	taskProgress?: "on" | "off";
	/** Tool calls between checklist reminders. 0 reminds never. */
	taskProgressInterval?: number;
	invalidTaskProgress?: string;
	invalidTaskProgressInterval?: string;
	visionModel?: string;
	/** Model delegated agents run on, instead of the session's. */
	agentsModel?: string;
	/** Context window for that model. A string: it arrives from the flag. */
	agentsNumCtx?: string;
	/** Concurrent requests this endpoint serves. A string, from the flag. */
	parallelSessions?: string;
	/**
	 * Names of environment variables holding QA secrets.
	 *
	 * Names, not values: the CLI reads them out of its own environment, so the
	 * secret never appears on a command line, in shell history, or in any file
	 * this program writes.
	 */
	qaCredential?: string[];
	cwd?: string;
	teamName?: string;
	defaultToolAutoApprove: boolean;
	autoApproveOverride?: boolean;
}
