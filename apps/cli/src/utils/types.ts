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
	/**
	 * Whether the task runs as judged, revertible transactions.
	 *
	 * `auto` and `always` are still accepted and both mean `static`, because
	 * this flag is how the measurement harness drives the protocol and those
	 * arm scripts are not ours to rewrite. `on` also means `static` here: it
	 * asks a user to engage the protocol partway through a task, and a CLI run
	 * has nobody to ask.
	 */
	atomic?: "off" | "static";
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
	/**
	 * The Checkpoints switch, mirroring the extension's. Commander writes
	 * `false` here for `--no-checkpoints`; absent means on, as it is in the
	 * panel.
	 */
	checkpoints?: boolean;
	/** Project checker `check_file` runs on each file it is given. */
	lintCommand?: string;
	visionModel?: string;
	/** Model delegated agents run on, instead of the session's. */
	agentsModel?: string;
	/** Context window for that model. A string: it arrives from the flag. */
	agentsNumCtx?: string;
	/**
	 * Model the expert runs on. Absent means no expert, and `escalate` is not
	 * offered at all -- which is the right answer rather than a degraded one:
	 * a tool that replies "nobody is configured" is worst exactly where it is
	 * reached, which is a model already stuck.
	 */
	expertModel?: string;
	/** Context window for the expert. A string, from the flag. */
	expertNumCtx?: string;
	/** Escalations allowed in one task. A string, from the flag. */
	expertMaxEscalations?: string;
	/** Follow-ups inside one escalation. A string, from the flag. */
	expertMaxFollowUps?: string;
	/** Release the expert's conversation at the end of each escalation. */
	expertCloseAfter?: boolean;
	/**
	 * When a run counts as stuck, and how often it may be offered the expert.
	 * Strings, from the flags; absent leaves core's own operating point in
	 * place. They are here because finding their defaults is a measurement,
	 * and the measurement runs from this CLI rather than from the panel.
	 */
	struggleFailedCalls?: string;
	struggleDistressHits?: string;
	struggleWindow?: string;
	struggleMinIteration?: string;
	struggleMaxPerTask?: string;
	struggleEditStreak?: string;
	struggleFailedTransactions?: string;
	/**
	 * The compaction from which the recency tail is dropped. From the flag.
	 *
	 * A string like the struggle thresholds above, and for the same reason:
	 * absent leaves core's measured default in place, and `"0"` is a value that
	 * turns the behaviour off rather than an absence that restores it.
	 */
	forceFullFromCompaction?: string;
	/** Let the base model run while the expert works. From the flag. */
	expertAlternate?: boolean;
	/** With `expertAlternate`, wake the base on the clock and nothing else. */
	expertNoRelay?: boolean;
	/** Concurrent requests this endpoint serves. A string, from the flag. */
	parallelSessions?: string;
	/**
	 * Names of environment variables holding QA secrets.
	 *
	 * Names, not values: the CLI reads them out of its own environment, so the
	 * secret never appears on a command line, in shell history, or in any file
	 * this program writes.
	 */
	/** Repeated `--agent-node` specs; see `runtime/agent-nodes-flag.ts`. */
	agentNode?: string[];
	qaCredential?: string[];
	cwd?: string;
	teamName?: string;
	defaultToolAutoApprove: boolean;
	autoApproveOverride?: boolean;
}
