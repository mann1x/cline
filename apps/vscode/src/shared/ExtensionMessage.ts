// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'

import type { GeneratedMedia, RequestTimings } from "@cline/shared"
import { WorkspaceRoot } from "@shared/multi-root/types"
import type { NewsItem } from "@shared/News"
import { RemoteConfigFields } from "@shared/storage/state-keys"
import type { UpdateChannel } from "@shared/UpdateSettings"
import type { Environment } from "../config"
import type { AtomicProtocolSessionSettings, AtomicProtocolSettings } from "./AtomicProtocolSettings"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import { ApiConfiguration } from "./api"
import { BrowserSettings } from "./BrowserSettings"
import { ClineFeatureSetting } from "./ClineFeatureSetting"
import { BannerCardData } from "./cline/banner"
import { ClineRulesToggles } from "./cline-rules"
import type { EditVerificationSettings } from "./EditVerificationSettings"
import type { EscalationSettings } from "./EscalationSettings"
import type { FocusChainSettings } from "./FocusChainSettings"
import { HistoryItem } from "./HistoryItem"
import { McpDisplayMode } from "./McpDisplayMode"
import { ClineMessageModelInfo } from "./messages"
import { OnboardingModelGroup } from "./proto/cline/state"
import { Mode } from "./storage/types"
import { TelemetrySetting } from "./TelemetrySetting"
import { UserInfo } from "./UserInfo"
// webview will hold state
export interface ExtensionMessage {
	type: "grpc_response" // New type for gRPC responses
	grpc_response?: GrpcResponse
}

export type GrpcResponse = {
	message?: any // JSON serialized protobuf message
	request_id: string // Same ID as the request
	error?: string // Optional error message
	is_streaming?: boolean // Whether this is part of a streaming response
	sequence_number?: number // For ordering chunks in streaming responses
}

export type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "unknown"

export const DEFAULT_PLATFORM = "unknown"

export const COMMAND_CANCEL_TOKEN = "__cline_command_cancel__"
export interface ExtensionState {
	isNewUser: boolean
	welcomeViewCompleted: boolean
	onboardingModels: OnboardingModelGroup | undefined
	apiConfiguration?: ApiConfiguration
	autoApprovalSettings: AutoApprovalSettings
	browserSettings: BrowserSettings
	remoteBrowserHost?: string
	preferredLanguage?: string
	mode: Mode
	clineMessages: ClineMessage[]
	checkpointRestoreInput?: {
		text: string
		images?: string[]
		files?: string[]
		sessionId: string
	}
	/**
	 * The single authoritative UI mode for the current turn, owned by the extension. The webview
	 * renders the footer/buttons/thinking indicator from this, NOT from the tail of clineMessages.
	 * Optional for classic/legacy (absent => webview falls back to legacy tail heuristics).
	 */
	turnState?: TurnState
	/**
	 * Follow-up prompts submitted while the active agent turn is still running.
	 * These are owned by the SDK pending-prompt queue and are sent after the
	 * current turn reaches a safe continuation point.
	 */
	queuedPrompts?: QueuedPrompt[]
	/**
	 * Monotonic version of this state snapshot. The webview applies a snapshot only if its
	 * stateVersion is newer than the last applied, so stale/out-of-order state pushes are
	 * ignored. Stamped by the extension. Optional for classic/legacy.
	 */
	stateVersion?: number
	/**
	 * Conversation/replica fence for this snapshot (see ClineMessage.epoch). A snapshot with a
	 * newer epoch replaces the webview transcript; an older one is dropped; an equal one merges.
	 * Optional for classic/legacy.
	 */
	epoch?: number
	currentTaskItem?: HistoryItem
	mcpMarketplaceEnabled?: boolean
	mcpDisplayMode: McpDisplayMode
	planActSeparateModelsSetting: boolean
	/** Use a second model to describe images for a primary model that cannot read them. */
	visionModelEnabled: boolean
	/** JSON `ApiConfigurationSnapshot` for the vision model. */
	visionModeApiConfiguration: string
	/** Run delegated agents on a model of their own rather than the session's. */
	agentsModelEnabled: boolean
	/** JSON `ApiConfigurationSnapshot` for delegated agents. */
	agentsModeApiConfiguration: string
	/** JSON `AgentNodeRecord[]`; see `src/shared/agent-nodes.ts`. */
	agentNodes: string
	/** Hand a stuck task to a second, costlier model. */
	escalationModelEnabled: boolean
	/** The escalation path's budgets and switches. */
	escalationSettings: EscalationSettings
	/** JSON `ApiConfigurationSnapshot` for the escalation expert. */
	escalationModeApiConfiguration: string
	/** Whether `generate_image` is offered, pointed at the endpoint below. */
	imageGenEnabled: boolean
	/** JSON `{baseUrl, model, size}` naming where `generate_image` posts. */
	imageGenEndpoint: string
	/** Whether a key is stored for that endpoint. Never the key itself. */
	imageGenApiKeySet: boolean
	/** Whether `jev` is offered and the harness's Jev hooks run. */
	jevEnabled: boolean
	/** JSON `JevSettings` (model, floors, timeout, hook switches). */
	jevSettings: string
	/** Whether a Jev key is stored. Never the key itself. */
	jevApiKeySet: boolean
	/** Whether a run may finish with a file it changed and never checked. */
	editVerificationSettings: EditVerificationSettings
	/** Whether a task runs as judged, revertible transactions. */
	atomicProtocolSettings: AtomicProtocolSettings
	/**
	 * The per-task half of it: engaged, and this task's own check.
	 *
	 * Only meaningful where the mode is `on`. The chat needs it to say whether
	 * the protocol is running right now, which no global setting can answer.
	 */
	atomicProtocolSession: AtomicProtocolSessionSettings
	/** Names of the configured QA credentials. Never their values. */
	qaCredentialNames: string[]
	/** JSON `ApiConfigurationProfile[]`. */
	apiConfigurationProfiles: string
	/** Name of the loaded profile, or "" when the panel matches no profile. */
	activeApiConfigurationProfile: string
	enableCheckpointsSetting?: boolean
	platform: Platform
	environment?: Environment
	shouldShowAnnouncement: boolean
	taskHistory: HistoryItem[]
	telemetrySetting: TelemetrySetting
	shellIntegrationTimeout: number
	/** Per-tool-result character cap; 0 means the SDK default applies. */
	maxToolResultChars?: number
	terminalReuseEnabled?: boolean
	defaultTerminalProfile?: string
	vscodeTerminalExecutionMode: string
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	/**
	 * True while a foreground (VS Code terminal) command is awaited by a
	 * run_commands tool call. Drives the "Proceed While Running" button.
	 */
	foregroundCommandRunning?: boolean
	lastCompletedCommandTs?: number
	userInfo?: UserInfo
	version: string
	/**
	 * Which rollout bundle this build is ("legacy" or "next"). Only present for
	 * bundles built by the combined rollout workflow; undefined for ordinary builds.
	 */
	extensionVariant?: "legacy" | "next"
	distinctId: string
	globalClineRulesToggles: ClineRulesToggles
	localClineRulesToggles: ClineRulesToggles
	localWorkflowToggles: ClineRulesToggles
	globalWorkflowToggles: ClineRulesToggles
	localCursorRulesToggles: ClineRulesToggles
	localWindsurfRulesToggles: ClineRulesToggles
	remoteRulesToggles?: ClineRulesToggles
	remoteWorkflowToggles?: ClineRulesToggles
	localAgentsRulesToggles: ClineRulesToggles
	mcpResponsesCollapsed?: boolean
	useAutoCondense?: boolean
	/** Replaces the built-in compaction summary instruction; empty means default. */
	compactionPrompt?: string
	/**
	 * The built-in instruction, so the settings field can show what it replaces.
	 *
	 * Sent from the host rather than imported: the webview is a browser bundle
	 * and `@cline/core` reaches Node-only code through `@cline/llms`.
	 */
	defaultCompactionPrompt?: string
	/** Whether the most recent messages survive a compaction verbatim. */
	keepRecentMessagesAtCompaction?: boolean
	forceFullFromCompaction?: number
	/** Replaces the built-in instruction used when no recency tail survives. */
	fullCompactionPrompt?: string
	/** The built-in no-tail instruction, shown as that field's placeholder. */
	defaultFullCompactionPrompt?: string
	/** Whether compaction also writes a retrospective over the discarded reasoning. */
	thinkingCompactionEnabled?: boolean
	councilCompactionEnabled?: boolean
	/** Replaces the built-in retrospective instruction; empty means default. */
	thinkingCompactionPrompt?: string
	/** The built-in retrospective instruction, so the field can show what it replaces. */
	defaultThinkingCompactionPrompt?: string
	/** The council's instructions; empty means the built-in. */
	councilWriterPrompt?: string
	defaultCouncilWriterPrompt?: string
	councilCriticPrompt?: string
	defaultCouncilCriticPrompt?: string
	councilSynthesizerPrompt?: string
	defaultCouncilSynthesizerPrompt?: string
	/** Whether Generate also rewrites the compaction prompts into the template. */
	translateCompactionPrompts?: boolean
	/** Whether a turn that ran out of thinking budget has its reasoning condensed. */
	cappedThinkingEnabled?: boolean
	showRequestTimings?: boolean
	/** How the extension keeps itself current. See `shared/UpdateSettings.ts`. */
	updateChannel?: UpdateChannel
	/** The version the last check found, or empty when this build is current. */
	availableUpdate?: string
	/** The fork's current announcements, newest first; empty hides the home panel. */
	news?: NewsItem[]
	/** Replaces the built-in continuation-note instruction; empty means default. */
	cappedThinkingPrompt?: string
	/** The built-in continuation-note instruction, so the field can show what it replaces. */
	defaultCappedThinkingPrompt?: string
	/** Focus Chain / task checklist. Read by the webview so the panel and the
	 * Features toggle agree with what the session was actually configured with. */
	focusChainSettings?: FocusChainSettings
	compactionStrategy?: string
	webSearchEnabled?: boolean
	subagentsEnabled?: boolean
	subagentCommandsEnabled?: boolean
	/** Whether the lead is offered the team_* tools; see state-keys.ts. */
	teammatesEnabled?: boolean
	/** "Use PolyKV agents as Priority 0"; see state-keys.ts. */
	polykvAgentsPriorityZero?: boolean
	agentModelOverride?: string
	strongNudgesEnabled?: boolean
	worktreesEnabled?: ClineFeatureSetting
	favoritedModelIds: string[]
	// NEW: Add workspace information
	workspaceRoots: WorkspaceRoot[]
	primaryRootIndex: number
	isMultiRootWorkspace: boolean
	multiRootSetting: ClineFeatureSetting
	lastDismissedInfoBannerVersion: number
	lastDismissedModelBannerVersion: number
	lastDismissedCliBannerVersion: number
	dismissedBanners?: Array<{ bannerId: string; dismissedAt: number }>
	hooksEnabled?: boolean
	remoteConfigSettings?: Partial<RemoteConfigFields>
	remoteConfigRevision?: number
	globalSkillsToggles?: Record<string, boolean>
	localSkillsToggles?: Record<string, boolean>
	backgroundEditEnabled?: boolean
	optOutOfRemoteConfig?: boolean
	remoteConfigAvailable?: boolean
	showFeatureTips?: boolean
	banners?: BannerCardData[]
	welcomeBanners?: BannerCardData[]
	openAiCodexIsAuthenticated?: boolean
}

/**
 * The authoritative UI mode for the current agent turn, owned by the extension. The webview reads
 * this instead of inferring mode from the tail of clineMessages.
 */
export type TurnPhase =
	| "idle" // no active turn; input enabled, no buttons
	| "streaming" // model producing content / tool running; Thinking + Cancel
	| "awaiting_approval" // a tool/command/mcp/subagent approval is pending
	| "awaiting_followup" // ask_question / plan_mode_respond / done-without-completion
	| "completed" // attempt_completion done; Start New Task
	| "error" // api_req_failed / fatal; Retry / recovery
	| "resumable" // task cancelled / interrupted; Resume Task

export interface TurnState {
	phase: TurnPhase
	/** ts of the ClineMessage this phase is "about" (e.g. the pending approval/ask). */
	anchorTs?: number
	/** Monotonic; the webview keeps the highest-seq TurnState and ignores older ones. */
	seq: number
}

export interface QueuedPrompt {
	id: string
	prompt: string
	delivery: "queue" | "steer"
	attachmentCount: number
	/** `harness` when the runtime queued it for the model, not the user. */
	origin?: "user" | "harness"
}

export interface ClineMessage {
	ts: number
	type: "ask" | "say"
	ask?: ClineAsk
	say?: ClineSay
	text?: string
	reasoning?: string
	images?: string[]
	media?: GeneratedMedia[]
	files?: string[]
	partial?: boolean
	/**
	 * Freshness counter for convergent-replica merging on the webview side. Monotonically
	 * increasing per process; a higher `seq` means a newer copy of the SAME `ts` (identity).
	 * Stamped by the extension as the message flows to the webview. Optional for classic/legacy.
	 */
	seq?: number
	/**
	 * Conversation/replica fence. Messages from an older epoch (a previous task or a previous
	 * render of the same task) are dropped by the webview. Stamped by the extension. Optional
	 * for classic/legacy.
	 */
	epoch?: number
	commandCompleted?: boolean
	lastCheckpointHash?: string
	isCheckpointCheckedOut?: boolean
	isOperationOutsideWorkspace?: boolean
	conversationHistoryIndex?: number
	conversationHistoryDeletedRange?: [number, number] // for when conversation history is truncated for API requests
	modelInfo?: ClineMessageModelInfo
	/**
	 * How long the run that produced this message took, in milliseconds.
	 *
	 * Set only on the completion row. The duration is chrome, not transcript:
	 * putting it in the model's own sentence would send our annotation back to
	 * it on the next turn as something it had written.
	 */
	runDurationMs?: number
}

export type ClineAsk =
	| "followup"
	| "plan_mode_respond"
	| "act_mode_respond"
	| "command"
	| "command_output"
	| "completion_result"
	| "tool"
	| "api_req_failed"
	| "resume_task"
	| "resume_completed_task"
	| "mistake_limit_reached"
	| "browser_action_launch"
	| "use_mcp_server"
	| "new_task"
	| "condense"
	| "summarize_task"
	| "report_bug"
	| "use_subagents"

export type ClineSay =
	| "task"
	| "error"
	| "api_req_started"
	| "api_req_finished"
	| "text"
	| "reasoning"
	| "completion_result"
	| "plan_completion_result" // turn-final plan-mode response inferred at turn end (SDK path)
	| "user_feedback"
	| "user_feedback_diff"
	| "command"
	| "command_output"
	| "tool"
	| "shell_integration_warning"
	| "shell_integration_warning_with_suggestion"
	| "browser_action_launch"
	| "browser_action"
	| "browser_action_result"
	| "browser_screenshot" // a screenshot the `browser` tool returned, shown under its tool row
	| "mcp_server_request_started"
	| "mcp_server_response"
	| "mcp_notification"
	| "use_mcp_server"
	| "diff_error"
	| "deleted_api_reqs"
	| "clineignore_error"
	| "command_permission_denied"
	| "checkpoint_created"
	| "load_mcp_documentation"
	| "info" // Added for general informational messages like retry status
	| "task_progress"
	| "hook_status"
	| "hook_output_stream"
	| "subagent"
	| "use_subagents"
	| "subagent_usage"
	| "conditional_rules_applied"
	| "compaction" // context compaction progress/result divider
	| "thinking_condensed" // a capped turn's reasoning, replaced by the note it left itself
	| "empty_turn" // a turn that produced neither prose nor a tool call
	| "output_limit_retry" // a turn cut off at the output cap, being retried
	| "transaction" // a change transaction kept, or discarded and put back
	| "escalation" // the exchange with the expert a stuck task was handed to

export interface ClineSayTool {
	tool:
		| "editedExistingFile"
		| "newFileCreated"
		| "fileDeleted"
		| "readFile"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "listCodeDefinitionNames"
		| "searchFiles"
		| "webFetch"
		| "webSearch"
		| "summarizeTask"
		| "useSkill"
	path?: string
	diff?: string
	content?: string
	regex?: string
	filePattern?: string
	operationIsLocatedInWorkspace?: boolean
	/** Starting line numbers in the original file where each SEARCH block matched */
	startLineNumbers?: number[]
	/**
	 * Which shape of edit this is — SEARCH/REPLACE, a line range, an insert.
	 *
	 * The card said "Cerebriline wants to edit this file" for all of them, which is
	 * the one thing about an edit that is never in question. What the edit is
	 * doing is inside the payload, and the payload is collapsed.
	 */
	editMode?: string
	/** One-based inclusive line range requested by read_file; readLineEnd omitted = open-ended read (for UI summaries). */
	readLineStart?: number
	readLineEnd?: number
	/**
	 * The header sentence for this row, when the call's own arguments change
	 * what the row is reporting and the tool's name alone would misstate it.
	 *
	 * `restore_file` is why this exists. Its row header was a constant —
	 * "put this file back as the transaction found it" — written before the
	 * tool could return to anything other than the transaction's base. It now
	 * takes a `revision`, and a `find` that restores nothing at all, so the
	 * constant asserted both the wrong target and, for a search, a write that
	 * never happened.
	 */
	headline?: string
}

// must keep in sync with system prompt
const browserActions = ["launch", "click", "type", "scroll_down", "scroll_up", "close"] as const
export type BrowserAction = (typeof browserActions)[number]

export interface ClineSayBrowserAction {
	action: BrowserAction
	coordinate?: string
	text?: string
}

export type SubagentExecutionStatus = "pending" | "running" | "completed" | "failed"

/**
 * Why a sub-agent compacted: its own context threshold, KV pressure on the
 * server, recovery from a request the provider rejected as too long, or a
 * manual request.
 */
export type SubagentCompactionCause = "auto" | "pressure" | "overflow" | "manual"

export interface SubagentCompaction {
	cause: SubagentCompactionCause
	tokensBefore?: number
	tokensAfter?: number
}

export interface SubagentTaskActivity {
	toolCalls: number
	compactions?: number
	compactionsByCause?: Partial<Record<SubagentCompactionCause, number>>
	lastCompaction?: SubagentCompaction
}

export interface SubagentStatusItem {
	index: number
	/**
	 * What the lead called this sub-agent, when it called it anything.
	 *
	 * Optional all the way down: `spawn_agent`'s `name` is optional, older
	 * transcripts have none, and a sub-agent without one is still shown -- by
	 * its index, which is what every sub-agent had before.
	 */
	agentName?: string
	prompt: string
	status: SubagentExecutionStatus
	toolCalls: number
	/**
	 * How many times it compacted its context, when it has. Optional: a
	 * transcript saved before this was counted has none, and reads as none.
	 */
	compactions?: number
	/** The same count, by why each compaction ran. */
	compactionsByCause?: Partial<Record<SubagentCompactionCause, number>>
	/** The most recent one, with the context before and after it when known. */
	lastCompaction?: SubagentCompaction
	/**
	 * A teammate's counts on the task it is running, or last ran. The counts
	 * above are then its whole life's, across every task it was given.
	 */
	lastTask?: SubagentTaskActivity
	inputTokens: number
	outputTokens: number
	totalCost: number
	/** The connection this sub-agent ran on, which need not be the lead's. */
	providerId?: string
	modelId?: string
	/**
	 * Which agent node it was placed on, when the session has any.
	 *
	 * Separate from the model: two nodes can carry the same model on two
	 * endpoints, and which node took an agent is what explains a fan-out that
	 * ran one at a time.
	 */
	nodeId?: string
	/** What the settings panel calls that node: `Node1`, `Node2`. */
	nodeLabel?: string
	/**
	 * The seed and temperature it ran with, when the lead set a sampler on the
	 * spawn -- as drawn, when it asked for "random". Kept on the row, which is
	 * persisted with the task, so a swarm experiment can be reproduced.
	 */
	sampling?: SubagentSampling
	/** The iteration cap the lead set on it, as it stands after any resume. */
	maxIterations?: number
	/**
	 * Set while it waits for the lead to resume it (`resume_agent`), restart
	 * or stop it -- its work kept: stopped at its iteration cap, or (`reason:
	 * "looping"`) stopped by the loop guard for repeating the same call, or
	 * (`reason: "struggling"`) stopped by the struggle supervisor.
	 */
	awaitingLead?: { iterations: number; maxIterations: number; reason?: "looping" | "struggling"; detail?: string }
	/** Why it ended when that was not its own answer: the iteration cap, a loop, or the struggle supervisor. */
	stopReason?: "iteration_cap" | "loop_guard" | "supervisor"
	/** How the lead's check on it came out, when the lead set one. */
	oracle?: SubagentOracleResult
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
	latestToolCall?: string
	/**
	 * The tail of what the agent is writing right now, or of its reasoning when
	 * it has written nothing yet. `latestOutputKind` says which.
	 */
	latestOutput?: string
	latestOutputKind?: "text" | "reasoning"
	/** Tokens per second it is generating at, measured over the last couple of seconds. */
	genTps?: number
	/**
	 * How to stop this agent, while it is running.
	 *
	 * Sent by the spawn tool that registered it rather than rebuilt here: a
	 * reader composing the same string from its own idea of the session id is
	 * a stop button that works until the two drift apart.
	 */
	cancelId?: string
	result?: string
	error?: string
	/**
	 * What the agent has been doing, newest last, and what went wrong on the way.
	 *
	 * The row's other fields say only what it is doing now, so a fault the turn
	 * survives -- a pool that shared 4 of its 5,627 tokens on every turn, a node
	 * that refused it twelve times -- was visible in the logs and nowhere else.
	 */
	activity?: SubagentActivityEntry[]
}

/** The lead's check on a sub-agent (`check: {command, expect, must?}`), as its report states it. */
export interface SubagentOracleResult {
	status: "pass" | "fail" | "not_run"
	command?: string
	expect?: string
	must?: "match" | "not_match"
	/** `null` when it could not start, or was not run. */
	exitCode: number | null
	/** The end of its last run's output. */
	output: string
	runs?: number
	/** Why it was not run, or what stopped it being re-run. */
	reason?: string
}

export interface SubagentSampling {
	temperature?: number
	seed?: number
	/** The seed was drawn for this agent (`seed: "random"`). */
	seedRandom?: boolean
	/** A randomized temperature: what it was drawn around, and +/- what percent. */
	temperatureBase?: number
	temperatureRange?: number
	/** Why a requested value was not applied, e.g. the model's temperature was unknown. */
	note?: string
}

export interface SubagentActivityEntry {
	/** Epoch ms. */
	at: number
	text: string
	/** `warn` is a fault: shown with a warning sign, in the warning colour. */
	severity?: "warn"
}

export interface ClineSaySubagentStatus {
	/**
	 * `team`: the session's teammates rather than one call's sub-agents. A
	 * teammate outlives the call that started it, so its row is not closed by
	 * the conversation moving on.
	 */
	kind?: "team"
	status: "running" | "completed" | "failed"
	total: number
	completed: number
	successes: number
	failures: number
	toolCalls: number
	/** Compactions across every agent of the batch. Absent on an older transcript. */
	compactions?: number
	inputTokens: number
	outputTokens: number
	contextWindow: number
	maxContextTokens: number
	maxContextUsagePercentage: number
	items: SubagentStatusItem[]
}

export type BrowserActionResult = {
	screenshot?: string
	logs?: string
	currentUrl?: string
	currentMousePosition?: string
}

export interface ClineAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
}

export interface ClineAskUseSubagents {
	prompts: string[]
	/**
	 * Names positionally matching `prompts`, so the approval row can show the
	 * same tags the status row will. `null` where the lead named nothing --
	 * this is a JSON payload, and an array hole serializes to null.
	 */
	names?: (string | null)[]
}

export interface ClinePlanModeResponse {
	response: string
	options?: string[]
	selected?: string
}

export interface ClineAskQuestion {
	question: string
	options?: string[]
	selected?: string
}

export interface ClineApiReqInfo {
	request?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	/**
	 * Which provider and model this request was billed to.
	 *
	 * A task is not always one model's: a mid-task switch changes it, and
	 * sub-agents can run on a connection of their own. Without it the totals
	 * can only be one number, and a run split between a local server and a
	 * paid endpoint cannot say which half cost anything.
	 */
	providerId?: string
	modelId?: string
	/** Hidden reasoning tokens, where the provider reports them separately. */
	reasoningTokens?: number
	/**
	 * What this request cost in time.
	 *
	 * Always written when the request produced usage, whether or not the user
	 * has the display switched on: the switch decides what is shown, not what
	 * is recorded, so turning it on shows the history that was already there
	 * rather than only requests made from that moment on.
	 */
	timings?: RequestTimings
	cancelReason?: ClineApiReqCancelReason
	streamingFailedMessage?: string
	/**
	 * What this request cost before a single message, split by what it is.
	 *
	 * The context bar shows one bar and one number, and on a local model most
	 * of that bar is a price nobody typed: measured on pandorum against a
	 * 65,536-token window, 21,000-24,000 tokens of system prompt and tool
	 * schemas before the first word. The parts are carried separately because
	 * they have separate remedies -- shorten the prompt, turn off a tool, turn
	 * off an MCP server -- and a single total asks for none of them.
	 *
	 * Absent on a request whose turn emitted no breakdown (an older session's
	 * history, or a host running a core that predates it); the bar then renders
	 * exactly as it did before.
	 */
	contextBreakdown?: ContextBreakdown
	/**
	 * The window the server granted this request, where it reported one.
	 *
	 * opencoti books a window per conversation and may grant less than was
	 * asked -- down to the floor -- so the configured context size is not the
	 * number the bar should be drawn against. Absent on every other provider,
	 * and on a response that did not state a grant: that is "unknown", and the
	 * bar falls back to the configured window rather than to a stale grant.
	 */
	contextWindowGrant?: ContextWindowGrant
}

/** See {@link ClineApiReqInfo.contextWindowGrant}. */
export interface ContextWindowGrant {
	/** The window the conversation can fill, in tokens. */
	grantedTokens: number
	/** What the conversation asked for when it was opened, in tokens. */
	askedTokens?: number
}

/** The fixed price of a request, as {@link ClineApiReqInfo.contextBreakdown}. */
export interface ContextBreakdown {
	/** The system prompt, prompt template included -- it is rendered into it. */
	systemPromptTokens: number
	/** The schemas of the tools the agent builds for itself. */
	builtinToolSchemaTokens: number
	/** The schemas of tools from MCP servers, which the agent did not choose. */
	mcpToolSchemaTokens: number
	toolCount: number
	mcpToolCount: number
}

/**
 * JSON payload of a say:"compaction" message. Mirrors the CLI's compaction
 * divider (apps/cli/src/tui/utils/compaction-status.ts): a "started" row shows
 * a spinner and is later updated in place (same ts) to its terminal status.
 */
export interface ClineCompactionInfo {
	status: "started" | "completed" | "skipped" | "failed" | "cancelled"
	/**
	 * Which of the three compactions this is.
	 *
	 * `overflow` is the one that runs after a turn was cut off at the output
	 * limit, and it was missing here: the core emits `overflow_recovery_compaction`
	 * and the parser accepted only the other two, so both of its notices fell
	 * through to the generic info row and printed their raw slugs --
	 * "overflow-recovery-compacting" and "overflow-recovery-compacted" -- next
	 * to the retry message, with none of the token counts the metadata was
	 * already carrying.
	 */
	mode: "auto" | "manual" | "overflow"
	tokensBefore?: number
	tokensAfter?: number
	messagesBefore?: number
	messagesAfter?: number
	/**
	 * How far through its own model calls a running compaction is.
	 *
	 * A compaction is several sequential requests -- the summary, the
	 * retrospective, then the council's three -- and on a local model the whole
	 * sequence runs for minutes behind one spinner. A run that looked hung on
	 * 2026-09-21 was four calls deep and working. `stepTotal` grows when a stage
	 * is retried, so the pair stays honest rather than pinning at its plan.
	 */
	step?: number
	stepTotal?: number
	/** Which stage the current call belongs to: summary, retrospective, review. */
	stepLabel?: string
	/** How long the compaction took, wall clock, once it is done. */
	durationMs?: number
	/** The summary this compaction wrote, so the row can show it on demand. */
	summary?: string
	/** The retrospective written alongside it, when the second phase ran. */
	thinkingSummary?: string
	/** What the harness recorded being called, when checkpoints are on. */
	toolLedger?: string
}

/**
 * JSON payload of a say:"output_limit_retry" message.
 *
 * A turn that ran past the output cap before it finished is discarded and
 * retried. That is a recovery, not a failure, and the row should read like
 * one -- and it should say what the reader needs to judge it: which attempt
 * this is out of how many, what the cap was and where it came from, and
 * whether the transcript is being compacted before the retry.
 */
export interface ClineOutputLimitRetryInfo {
	/** 1-based attempt number. */
	attempt?: number
	/** How many retries the completion policy allows. */
	maxAttempts?: number
	/** The output cap the turn ran into. */
	capTokens?: number
	/** Where that cap came from — `remaining-context`, `model-max-output`, `requested`. */
	capSource?: string
	/**
	 * Whether the transcript is compacted before retrying.
	 *
	 * False means the cap was a ceiling the caller set, which no amount of
	 * compaction can raise — so a reader seeing repeated retries without
	 * compaction is looking at a limit to change, not a context to shrink.
	 */
	compacting?: boolean
}

/**
 * JSON payload of a say:"empty_turn" message.
 *
 * A turn that produced no assistant text and called no tool leaves no row of
 * its own, so in the panel it is indistinguishable from the model still
 * working. This row is that turn's trace.
 */
export interface ClineEmptyTurnInfo {
	/**
	 * Characters of reasoning the turn produced, if any.
	 *
	 * Reasoning does not make a turn non-empty -- a turn that thought at length
	 * and then said nothing and called nothing is the case most worth seeing --
	 * but it is what separates that from a turn that produced literally
	 * nothing, so the row reports it rather than hiding it.
	 */
	reasoningChars?: number
}

/**
 * JSON payload of a say:"thinking_condensed" message.
 *
 * A turn that runs out of thinking budget is cut mid-sentence, and the next
 * turn is given a short note in its place rather than the abandoned reasoning.
 * That note is the only surviving account of what the turn concluded — what it
 * replaces is never sent again — so it is shown the same way a compaction
 * summary is: a divider that expands.
 */
export interface ClineThinkingCondensedInfo {
	/** Characters of reasoning the note replaces. */
	thinkingChars?: number
	/** Characters of note. */
	noteChars?: number
	/**
	 * The same two, in the unit the budget is set in.
	 *
	 * Estimated at the reasoning rate the core process has calibrated, because
	 * nothing reports a token count for text it is about to throw away. Absent
	 * on messages persisted before this shipped, which is why the character
	 * counts stay: a row rendering an old task has only those, and labelling
	 * them as tokens would be a worse answer than labelling them as what they
	 * are.
	 */
	thinkingTokens?: number
	noteTokens?: number
	/** The allowance the turn ran out of. */
	budgetTokens?: number
	note: string
}

/**
 * JSON payload of a say:"transaction" message.
 *
 * The verdict on one transaction under the change protocol. It gets a row of
 * its own rather than an info line because of what a discarded one means: every
 * file that transaction touched went back to what it was. A run where that
 * happened three times and then finished looks, in the transcript alone,
 * exactly like a run that got it right the first time.
 */
export interface ClineTransactionInfo {
	/** One-based, in the order they were opened. */
	transaction: number
	kept: boolean
	/**
	 * Not kept, and not rolled back either: the check said something it had
	 * never said in this run, so the changes stayed on disk and the next
	 * transaction opened on top of them.
	 */
	carried?: boolean
	/** What the check said, when there was one to run. */
	output?: string
	/** Files put back, created ones removed, deleted ones recreated. */
	filesPutBack?: number
	/** How long the transaction ran, from the change proposal to this verdict. */
	elapsedMs?: number
	/** The one-line verdict, already written for a human. */
	message: string
}

/**
 * JSON payload of a say:"escalation" message.
 *
 * One say type for the whole exchange rather than four, keyed by `phase`: the
 * hand-over, the base model's push-back, the expert's delivery, and the end of
 * it. They are one conversation on screen and reading them as one row type is
 * what lets the chat collapse them together.
 *
 * The usage rides on the delivery because the expert is the one model whose
 * cost has to be separable. A total that folds it into the session's answers
 * no question anybody has about a metered account, and it is the source of the
 * expert figures on the task header's own token line.
 */
export interface ClineEscalationInfo {
	phase: "started" | "working" | "expert_thinking" | "expert_message" | "message" | "reply" | "ended"
	/** Which escalation this is, and how many the task gets. On "started" and "working". */
	index?: number
	of?: number
	/** The brief, the push-back, the delivery, or the closing line. */
	text: string
	/** Tool calls the expert has made in the turn that is running. On "working". */
	toolCalls?: number
	/** The last of those, by name. On "working". */
	lastTool?: string
	/** Workspace-relative paths the expert changed. On "reply". */
	changed?: string[]
	/** Whether the conversation was held rather than released. On "ended". */
	held?: boolean
	/**
	 * What this turn of the exchange spent. On "reply", and on "working" while
	 * it is still spending it -- the delivery replaces that row rather than
	 * following it, so the task header never adds the same turn twice.
	 */
	usage?: {
		tokensIn: number
		tokensOut: number
		generateTokens: number
		generateMs: number
		wallMs: number
		requests: number
	}
}

export interface ClineSubagentUsageInfo {
	source: "subagents"
	tokensIn: number
	tokensOut: number
	cacheWrites: number
	cacheReads: number
	cost: number
	/**
	 * The connection these sub-agents ran on, when they all ran on one.
	 *
	 * One message per provider is emitted rather than a single aggregate,
	 * because a batch can be spread across endpoints -- a configured agent may
	 * name its own -- and rolling those together loses exactly the split that
	 * separates free tokens from billed ones.
	 */
	providerId?: string
	modelId?: string
	/**
	 * How many sub-agents this row summarizes.
	 *
	 * A batch is one message however many agents ran, so without this the
	 * breakdown can say what a delegation spent but not how much of it there
	 * was. It is not a request count: an agent makes as many turns as it needs.
	 */
	agents?: number
}

type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled" | "retries_exhausted"

export const COMPLETION_RESULT_CHANGES_FLAG = "HAS_CHANGES"
