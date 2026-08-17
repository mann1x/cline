// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'

import { WorkspaceRoot } from "@shared/multi-root/types"
import { RemoteConfigFields } from "@shared/storage/state-keys"
import type { Environment } from "../config"
import type { AtomicProtocolSettings } from "./AtomicProtocolSettings"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import { ApiConfiguration } from "./api"
import { BrowserSettings } from "./BrowserSettings"
import { ClineFeatureSetting } from "./ClineFeatureSetting"
import { BannerCardData } from "./cline/banner"
import { ClineRulesToggles } from "./cline-rules"
import type { EditVerificationSettings } from "./EditVerificationSettings"
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
	/** Whether a run may finish with a file it changed and never checked. */
	editVerificationSettings: EditVerificationSettings
	/** Whether a task runs as judged, revertible transactions. */
	atomicProtocolSettings: AtomicProtocolSettings
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
	yoloModeToggled?: boolean
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
	/** Whether compaction also writes a retrospective over the discarded reasoning. */
	thinkingCompactionEnabled?: boolean
	/** Replaces the built-in retrospective instruction; empty means default. */
	thinkingCompactionPrompt?: string
	/** The built-in retrospective instruction, so the field can show what it replaces. */
	defaultThinkingCompactionPrompt?: string
	/** Whether a turn that ran out of thinking budget has its reasoning condensed. */
	cappedThinkingEnabled?: boolean
	/** Replaces the built-in continuation-note instruction; empty means default. */
	cappedThinkingPrompt?: string
	/** The built-in continuation-note instruction, so the field can show what it replaces. */
	defaultCappedThinkingPrompt?: string
	/** Focus Chain / task checklist. Read by the webview so the panel and the
	 * Features toggle agree with what the session was actually configured with. */
	focusChainSettings?: FocusChainSettings
	compactionStrategy?: string
	subagentsEnabled?: boolean
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
	globalSkillsToggles?: Record<string, boolean>
	localSkillsToggles?: Record<string, boolean>
	backgroundEditEnabled?: boolean
	optOutOfRemoteConfig?: boolean
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
}

export interface ClineMessage {
	ts: number
	type: "ask" | "say"
	ask?: ClineAsk
	say?: ClineSay
	text?: string
	reasoning?: string
	images?: string[]
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
	| "transaction" // a change transaction kept, or discarded and put back

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
	 * The card said "Cline wants to edit this file" for all of them, which is
	 * the one thing about an edit that is never in question. What the edit is
	 * doing is inside the payload, and the payload is collapsed.
	 */
	editMode?: string
	/** One-based inclusive line range requested by read_file; readLineEnd omitted = open-ended read (for UI summaries). */
	readLineStart?: number
	readLineEnd?: number
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

export interface SubagentStatusItem {
	index: number
	prompt: string
	status: SubagentExecutionStatus
	toolCalls: number
	inputTokens: number
	outputTokens: number
	totalCost: number
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
	latestToolCall?: string
	result?: string
	error?: string
}

export interface ClineSaySubagentStatus {
	status: "running" | "completed" | "failed"
	total: number
	completed: number
	successes: number
	failures: number
	toolCalls: number
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
	cancelReason?: ClineApiReqCancelReason
	streamingFailedMessage?: string
}

/**
 * JSON payload of a say:"compaction" message. Mirrors the CLI's compaction
 * divider (apps/cli/src/tui/utils/compaction-status.ts): a "started" row shows
 * a spinner and is later updated in place (same ts) to its terminal status.
 */
export interface ClineCompactionInfo {
	status: "started" | "completed" | "skipped" | "failed" | "cancelled"
	mode: "auto" | "manual"
	tokensBefore?: number
	tokensAfter?: number
	messagesBefore?: number
	messagesAfter?: number
	/** The summary this compaction wrote, so the row can show it on demand. */
	summary?: string
	/** The retrospective written alongside it, when the second phase ran. */
	thinkingSummary?: string
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
	/** What the check said, when there was one to run. */
	output?: string
	/** Files put back, created ones removed, deleted ones recreated. */
	filesPutBack?: number
	/** The one-line verdict, already written for a human. */
	message: string
}

export interface ClineSubagentUsageInfo {
	source: "subagents"
	tokensIn: number
	tokensOut: number
	cacheWrites: number
	cacheReads: number
	cost: number
}

type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled" | "retries_exhausted"

export const COMPLETION_RESULT_CHANGES_FLAG = "HAS_CHANGES"
