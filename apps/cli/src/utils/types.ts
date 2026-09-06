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
	/**
	 * The `# system` section of the prompt template this session matched.
	 *
	 * Carried on the config because the system prompt is rebuilt more than once
	 * -- switching between plan and act does it, and so does the connector path
	 * -- and a rebuild that cannot see the template silently reverts the session
	 * to the built-in prompt half way through.
	 */
	promptTemplateSystem?: string;
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
	/** Whether the task runs as judged, revertible transactions. */
	atomic?: "off" | "auto" | "always";
	invalidAtomic?: string;
	/** The shell line that decides whether the task worked. */
	oracle?: string;
	/** What that line's output must say, on top of exiting cleanly. */
	oracleExpect?: string;
	invalidOracleExpect?: string;
	/** Changes the model may declare per transaction. */
	maxChanges?: number;
	invalidMaxChanges?: string;
	/** Attempts before the task stops. */
	maxTransactions?: number;
	invalidMaxTransactions?: string;
	/**
	 * What happens where the workspace holds nothing to run.
	 *
	 * `off` leaves the model's own account of its work as the verdict;
	 * `auto` lets it propose a check and approves it without asking, which is
	 * the only way an unattended run can have one at all.
	 */
	proposeCheck?: "off" | "auto";
	invalidProposeCheck?: string;
	/**
	 * Discarded attempts before a check that has never passed may be replaced.
	 *
	 * Zero is off, and off is the freeze as it shipped. Only ever applies to a
	 * check the model proposed for itself.
	 */
	checkReconsiderAfter?: number;
	invalidCheckReconsiderAfter?: string;
	/** Proposals put to the approver before the run gives up on a check. */
	maxCheckProposals?: number;
	invalidMaxCheckProposals?: string;
	/** Whether the model keeps a checklist across the task. */
	taskProgress?: "on" | "off";
	/** Tool calls between checklist reminders. 0 reminds never. */
	taskProgressInterval?: number;
	invalidTaskProgress?: string;
	invalidTaskProgressInterval?: string;
	/** Project checker `check_file` runs on each file it is given. */
	lintCommand?: string;
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
