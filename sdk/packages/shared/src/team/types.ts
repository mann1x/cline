/**
 * Team data types and interfaces.
 *
 * These are the pure data-shape contracts for the multi-agent team system.
 * They intentionally avoid referencing @cline/agents types so that shared
 * can remain dependency-free of the agents package.
 */

export type TeamTaskStatus =
	| "pending"
	| "in_progress"
	| "blocked"
	| "completed";

export interface TeamTask {
	id: string;
	title: string;
	description: string;
	status: TeamTaskStatus;
	createdAt: Date;
	updatedAt: Date;
	createdBy: string;
	assignee?: string;
	dependsOn: string[];
	summary?: string;
}

export interface TeamTaskListItem extends TeamTask {
	isReady: boolean;
	blockedBy: string[];
}

export type MissionLogKind =
	| "progress"
	| "handoff"
	| "blocked"
	| "decision"
	| "done"
	| "error";

export interface MissionLogEntry {
	id: string;
	ts: Date;
	teamId: string;
	agentId: string;
	taskId?: string;
	kind: MissionLogKind;
	summary: string;
	evidence?: string[];
	nextAction?: string;
}

export interface TeamMailboxMessage {
	id: string;
	teamId: string;
	fromAgentId: string;
	toAgentId: string;
	subject: string;
	body: string;
	taskId?: string;
	sentAt: Date;
	readAt?: Date;
}

/**
 * What a delegated agent has done, as its row counts it: tool calls, and
 * compactions with why each ran and the last one's context before and after.
 * The same figures a `spawn_agent` row carries.
 */
export interface TeamAgentActivity {
	toolCalls: number;
	compactions: number;
	compactionsByCause?: Partial<
		Record<"auto" | "pressure" | "overflow" | "manual", number>
	>;
	lastCompaction?: {
		cause: "auto" | "pressure" | "overflow" | "manual";
		tokensBefore?: number;
		tokensAfter?: number;
	};
}

export interface TeamMemberSnapshot {
	agentId: string;
	role: "lead" | "teammate";
	description?: string;
	status: "idle" | "running" | "stopped";
	/** A teammate's counts over its whole life, across every task. */
	activity?: TeamAgentActivity;
	/** Its counts for the task it is running, or last ran. */
	taskActivity?: TeamAgentActivity;
	/** The seed and temperature it was spawned with, when the lead set any. */
	sampling?: TeamAgentSampling;
	/**
	 * While it runs a task: the id its row's stop and restart send, and what
	 * the lead's controls know it by.
	 */
	cancelId?: string;
}

/**
 * A delegated agent's realized sampler: what it runs with, and for a value the
 * lead asked to be `"random"`, what it was drawn around.
 */
export interface TeamAgentSampling {
	temperature?: number;
	seed?: number;
	seedRandom?: boolean;
	temperatureBase?: number;
	temperatureRange?: number;
	note?: string;
}

export interface TeammateLifecycleSpec {
	rolePrompt: string;
	modelId?: string;
	maxIterations?: number;
	/** The sampler the lead spawned it with; absent is the model's own. */
	temperature?: number;
	seed?: number;
	/** The seed was drawn per agent (`seed: "random"`), not given. */
	seedRandom?: boolean;
	/** For a randomized temperature: what it was drawn around, and by what percent. */
	temperatureBase?: number;
	temperatureRange?: number;
	runtimeAgentId?: string;
	conversationId?: string;
	parentAgentId?: string | null;
}

export type TeamRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

/**
 * Shared representation of a teammate run record.
 *
 * The `result` field is typed as `unknown` at the shared contract level
 * because the concrete type (`AgentResult`) lives in `@cline/agents`.
 * Consuming packages narrow this via their own type assertions.
 */
export interface TeamRunRecord {
	id: string;
	agentId: string;
	taskId?: string;
	status: TeamRunStatus;
	message: string;
	priority: number;
	retryCount: number;
	maxRetries: number;
	nextAttemptAt?: Date;
	continueConversation?: boolean;
	/** The task's iteration cap, when the lead set one. */
	maxIterations?: number;
	startedAt: Date;
	endedAt?: Date;
	leaseOwner?: string;
	heartbeatAt?: Date;
	lastProgressAt?: Date;
	lastProgressMessage?: string;
	currentActivity?: string;
	/** What the teammate did on this run: its tool calls and compactions. */
	activity?: TeamAgentActivity;
	result?: unknown;
	error?: string;
}

export type TeamOutcomeStatus = "draft" | "in_review" | "finalized";

export interface TeamOutcome {
	id: string;
	teamId: string;
	title: string;
	status: TeamOutcomeStatus;
	requiredSections: string[];
	createdBy: string;
	createdAt: Date;
	finalizedAt?: Date;
}

export type TeamOutcomeFragmentStatus = "draft" | "reviewed" | "rejected";

export interface TeamOutcomeFragment {
	id: string;
	teamId: string;
	outcomeId: string;
	section: string;
	sourceAgentId: string;
	sourceRunId?: string;
	content: string;
	status: TeamOutcomeFragmentStatus;
	reviewedBy?: string;
	reviewedAt?: Date;
	createdAt: Date;
}

export interface TeamRuntimeSnapshot {
	teamId: string;
	teamName: string;
	members: TeamMemberSnapshot[];
	taskCounts: Record<TeamTaskStatus, number>;
	unreadMessages: number;
	missionLogEntries: number;
	activeRuns: number;
	queuedRuns: number;
	outcomeCounts: Record<TeamOutcomeStatus, number>;
}

export interface TeamRuntimeState {
	teamId: string;
	teamName: string;
	members: TeamMemberSnapshot[];
	tasks: TeamTask[];
	mailbox: TeamMailboxMessage[];
	missionLog: MissionLogEntry[];
	runs: TeamRunRecord[];
	outcomes: TeamOutcome[];
	outcomeFragments: TeamOutcomeFragment[];
}

export interface AppendMissionLogInput {
	agentId: string;
	taskId?: string;
	kind: MissionLogKind;
	summary: string;
	evidence?: string[];
	nextAction?: string;
}

export interface CreateTeamTaskInput {
	title: string;
	description: string;
	createdBy: string;
	dependsOn?: string[];
	assignee?: string;
}

export interface CreateTeamOutcomeInput {
	title: string;
	requiredSections: string[];
	createdBy: string;
}

export interface AttachTeamOutcomeFragmentInput {
	outcomeId: string;
	section: string;
	sourceAgentId: string;
	sourceRunId?: string;
	content: string;
}

export interface ReviewTeamOutcomeFragmentInput {
	fragmentId: string;
	reviewedBy: string;
	approved: boolean;
}

export interface RouteToTeammateOptions {
	taskId?: string;
	fromAgentId?: string;
	continueConversation?: boolean;
	/** This task's iteration cap, over the teammate's own, for this run only. */
	maxIterations?: number;
}

export enum TeamMessageType {
	TaskStart = "task_start",
	TaskEnd = "task_end",
	AgentEvent = "agent_event",
	TeammateSpawned = "teammate_spawned",
	TeammateShutdown = "teammate_shutdown",
	TeamTaskUpdated = "team_task_updated",
	TeamMessage = "team_message",
	TeamMissionLog = "team_mission_log",
	TeamTaskCompleted = "team_task_completed",
	RunStarted = "run_started",
	RunQueued = "run_queued",
	RunProgress = "run_progress",
	RunCompleted = "run_completed",
	RunFailed = "run_failed",
	RunCancelled = "run_cancelled",
	RunInterrupted = "run_interrupted",
	OutcomeCreated = "outcome_created",
	OutcomeFragmentAttached = "outcome_fragment_attached",
	OutcomeFragmentReviewed = "outcome_fragment_reviewed",
	OutcomeFinalized = "outcome_finalized",
	/** `team_cleanup` wiped the team: its tasks, runs, mail, log and teammates. */
	TeamCleaned = "team_cleaned",
}
