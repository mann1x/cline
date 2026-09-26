// Replaces classic message streaming from src/core/task/index.ts (see origin/main)
//
// Translates SDK session events into ClineMessage[] for webview consumption.
// The webview expects ClineMessage objects with ask/say types; this module
// maps SDK CoreSessionEvent and AgentEvent types to that format.
//
// Key mappings:
// - SDK "chunk" event (agent stream) → ClineMessage say="text" with partial=true
// - SDK "agent_event" content_start (text) → ClineMessage say="text" with partial=true
// - SDK "agent_event" content_start (reasoning) → ClineMessage say="reasoning" with partial=true
// - SDK "agent_event" content_start (tool) → ClineMessage say="tool" with partial=true
//   IMPORTANT: The webview's ChatRow.tsx parses message.text as JSON when
//   say==="tool", expecting ClineSayTool format: {tool, path, content, ...}.
//   We must convert SDK tool names (read_files, editor, run_commands, etc.)
//   and their inputs to this format.
// - SDK "agent_event" content_start (tool: MCP) → ClineMessage say="use_mcp_server" with partial=true
//   MCP tools use serverName__toolName naming convention. The webview renders
//   MCP tool calls via say/ask="use_mcp_server" with ClineAskUseMcpServer JSON.
// - SDK "agent_event" content_end (tool: MCP) → say="use_mcp_server" + say="mcp_server_response"
// - SDK "agent_event" content_end → ClineMessage with partial=false
// - SDK "agent_event" content_start (tool: attempt_completion) → ClineMessage say="completion_result"
// - SDK "agent_event" content_end (tool: attempt_completion) → ClineMessage say="completion_result" (final)
// - SDK "agent_event" done (reason "completed", turn ended on text) → retags that final
//   say="text" row in place to say="completion_result" (act) / say="plan_completion_result" (plan)
// - SDK "agent_event" error → ClineMessage say="error"
// - SDK "agent_event" usage → ClineMessage say="api_req_started" with ClineApiReqInfo JSON
// - SDK "ended" event → finalizes the session

import type { CoreSessionEvent } from "@cline/core"
import { describeRestoreTarget, PATCH_MARKERS, projectSessionMessagesForDisplay, readTaskProgress } from "@cline/core"
import {
	OPENCOTI_WINDOW_UNAVAILABLE_CODE,
	parseOpencotiWindowUnavailable,
	type MessageWithMetadata as SdkMessage,
} from "@cline/llms"
import { type AgentEvent, formatDisplayUserInput, type ProviderErrorClass, type RequestTimings } from "@cline/shared"
import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import type {
	ClineApiReqInfo,
	ClineAskUseMcpServer,
	ClineAskUseSubagents,
	ClineCompactionInfo,
	ClineEmptyTurnInfo,
	ClineEscalationInfo,
	ClineMessage,
	ClineOutputLimitRetryInfo,
	ClineSay,
	ClineSaySubagentStatus,
	ClineSayTool,
	ClineSubagentUsageInfo,
	ClineThinkingCondensedInfo,
	ClineTransactionInfo,
	ContextBreakdown,
	ContextWindowGrant,
	SubagentCompactionCause,
	SubagentOracleResult,
	SubagentSampling,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import * as path from "path"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { arePathsEqual, getDesktopDir } from "@/utils/path"
import { CLINE_FREE_PROMOTION_ENDED_ERROR_CODE, isClineFreePromotionEndedMessage } from "../services/error/ClineError"
import { MessageIdMinter } from "./message-id-minter"
import { describeCredentialRejectedError, describeMissingCredentialError } from "./provider-credential-error"
import {
	extractPersistedHookContextChips,
	extractPersistedOutputLimitRetry,
	isSyntheticSdkUserMessage,
	isSyntheticUserPrompt,
} from "./sdk-user-message-mapping"
import { isDeniedToolApprovalMistake, isKnownToolApprovalDenial } from "./tool-approval-denial"

// ---------------------------------------------------------------------------
// Translation result
// ---------------------------------------------------------------------------

/**
 * Result of translating a single SDK event into ClineMessages.
 * May produce zero or more messages.
 */
export interface TranslationResult {
	/** Messages produced by this event */
	messages: ClineMessage[]
	/** Whether the session has ended */
	sessionEnded: boolean
	/** Whether the agent turn is complete */
	turnComplete: boolean
	/** Whether a tool call ended with an error (content_end with event.error) */
	toolError?: boolean
	/** Whether a tool call ended successfully (content_end without error) */
	toolSuccess?: boolean
	/** Usage info if available */
	usage?: {
		tokensIn: number
		tokensOut: number
		cacheWrites?: number
		cacheReads?: number
		totalCost?: number
		reasoningTokens?: number
		timings?: RequestTimings
	}
}

type NormalizedUsage = NonNullable<TranslationResult["usage"]>

function normalizeUsageEvent(usageEvent: {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	cost?: number
	totalCost?: number
	reasoningTokens?: number
	timings?: RequestTimings
}): NormalizedUsage {
	const inputTokens = usageEvent.inputTokens ?? 0
	const cacheReads = usageEvent.cacheReadTokens ?? 0
	const cacheWrites = usageEvent.cacheWriteTokens ?? 0

	// SDK provider usage reports inputTokens as the full request size, with
	// cache reads/writes included. Classic Cline/webview metrics expect
	// tokensIn, cacheReads, and cacheWrites to be disjoint buckets.
	const uncachedInputTokens = Math.max(0, inputTokens - cacheReads - cacheWrites)

	return {
		tokensIn: uncachedInputTokens,
		tokensOut: usageEvent.outputTokens ?? 0,
		cacheWrites,
		cacheReads,
		totalCost: usageEvent.cost ?? usageEvent.totalCost ?? 0,
		...(usageEvent.reasoningTokens ? { reasoningTokens: usageEvent.reasoningTokens } : {}),
		...(usageEvent.timings ? { timings: usageEvent.timings } : {}),
	}
}

// ---------------------------------------------------------------------------
// State tracking for partial messages
// ---------------------------------------------------------------------------

/**
 * Tracks the state of streaming content to properly handle
 * partial message updates.
 */
/**
 * Whether a tool call is a sub-agent being spawned.
 *
 * Two tools do it. `spawn_agent` is the open-ended one the model reaches for
 * on its own; `subagent_<name>` is a configured agent, one per file in
 * `.cline/agents`, and there is one such tool per agent the workspace defines.
 *
 * Only the first was ever routed to the rich row. Measured on pandorum
 * 2026-09-22: a run that spawned `subagent_game_logic_reviewer`,
 * `subagent_js_syntactic` and `subagent_html_structure_checker` in one batch
 * rendered three bare "Cerebriline used `subagent_js_syntactic`:" headers --
 * no name, no colour, no prompt, and no sign that three agents were running.
 * The agents are the same agents; only the tool that starts them differs.
 */
export function isSubagentSpawnTool(toolName: string | undefined): boolean {
	return toolName === "spawn_agent" || (toolName?.startsWith("subagent_") ?? false)
}

/**
 * `agents` as the tool reads it (`readAgentsField` in core): the array, or the
 * text of one -- including the text of one with the call's other fields run on
 * after it, `[...], "merge": true`, which is how qwen sent it on pandorum.
 */
function agentsList(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) {
		return value.length > 0 ? value : undefined
	}
	if (typeof value !== "string") {
		return undefined
	}
	for (const text of [value, `{"agents":${value}}`]) {
		try {
			const parsed: unknown = JSON.parse(text)
			const list = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown } | null)?.agents
			if (Array.isArray(list) && list.length > 0) {
				return list
			}
		} catch {
			// The next reading, or none.
		}
	}
	return undefined
}

/**
 * The agents of a `spawn_agent` batch (`agents: [...]`), when the call is one.
 *
 * One call, one row per agent: the call id alone would put every member of a
 * batch on one row, and the stop, the node and the speed are all per agent.
 * Members are keyed `<call id>#<index>`, the same key the tool registers each
 * member's stop under.
 */
export function spawnBatchMembers(input: unknown): Array<{ task: string; name?: string }> | undefined {
	const call = (input ?? {}) as { agents?: unknown; merge?: unknown; count?: unknown; task?: unknown; name?: unknown }
	const agents = agentsList(call.agents)
	if (!agents) {
		// A swarm of one task, a stated number of times: that many agents,
		// and as many rows. The tool keys them the same way. `count: "max"` is
		// the engine's number and stays one row, the call's.
		if (call.merge === true && typeof call.count === "number" && call.count > 1 && typeof call.task === "string") {
			const base = typeof call.name === "string" && call.name.trim() ? call.name.trim() : "worker"
			return Array.from({ length: Math.min(call.count, 64) }, (_entry, index) => ({
				task: call.task as string,
				name: `${base}-${index + 1}`,
			}))
		}
		return undefined
	}
	// `count` spelled out the way the tool does (`expandAgentCounts` in core):
	// the rows are keyed by position after expansion, so both have to agree.
	return agents.flatMap((entry, index) => {
		const member = (entry ?? {}) as { task?: unknown; name?: unknown; type?: unknown; count?: unknown }
		const name =
			typeof member.name === "string" && member.name.trim()
				? member.name.trim()
				: typeof member.type === "string" && member.type.trim()
					? member.type.trim()
					: `agent-${index + 1}`
		const task = typeof member.task === "string" ? member.task : ""
		const count = typeof member.count === "number" ? Math.min(100, Math.max(1, Math.floor(member.count))) : 1
		return count === 1
			? [{ task, name }]
			: Array.from({ length: count }, (_copy, copy) => ({ task, name: `${name}-${copy + 1}` }))
	})
}

export function spawnMemberKey(callId: string, index: number): string {
	return `${callId}#${index}`
}

/** A spawned agent's report, onto its row: text, tokens, model and node. */
/** Entries an agent's activity keeps: enough to see a pattern, not a transcript. */
export const SUBAGENT_ACTIVITY_LIMIT = 12

/**
 * Add a line to an agent's activity. A repeat of the last line is dropped, so
 * a tool called ten times running is one line, not ten.
 */
function pushSubagentActivity(entry: SubagentStatusItem, text: string, severity?: "warn", at: number = Date.now()): void {
	const line = text.trim()
	if (!line) {
		return
	}
	const activity = entry.activity ?? []
	const last = activity[activity.length - 1]
	if (last?.text === line && last.severity === severity) {
		return
	}
	activity.push({ at, text: line, ...(severity ? { severity } : {}) })
	entry.activity = activity.slice(-SUBAGENT_ACTIVITY_LIMIT)
}

/**
 * One entry of a batch result's `agents` index: an object, or for a round too
 * large for that, a `name|status|failureClass` string.
 */
function readBatchIndexEntry(value: unknown): { status: string; error?: string } | undefined {
	if (typeof value === "string") {
		const [, status] = value.split("|")
		return status ? { status } : undefined
	}
	if (value && typeof value === "object" && typeof (value as { status?: unknown }).status === "string") {
		const entry = value as { status: string; error?: unknown }
		return { status: entry.status, ...(typeof entry.error === "string" ? { error: entry.error } : {}) }
	}
	return undefined
}

const SUBAGENT_COMPACTION_CAUSES: readonly SubagentCompactionCause[] = ["auto", "pressure", "overflow", "manual"]

function isSubagentCompactionCause(value: unknown): value is SubagentCompactionCause {
	return SUBAGENT_COMPACTION_CAUSES.includes(value as SubagentCompactionCause)
}

/**
 * The agent's compaction count, from its progress update: the total, the
 * count by cause, and the last one. Exported for the tests.
 */
export function applySubagentCompactions(entry: SubagentStatusItem, update: Record<string, unknown>): void {
	if (typeof update.compactions === "number" && Number.isFinite(update.compactions)) {
		entry.compactions = update.compactions
	}
	const byCause = update.compactionsByCause
	if (byCause && typeof byCause === "object") {
		const counts: Partial<Record<SubagentCompactionCause, number>> = {}
		for (const [cause, count] of Object.entries(byCause as Record<string, unknown>)) {
			if (isSubagentCompactionCause(cause) && typeof count === "number" && Number.isFinite(count)) {
				counts[cause] = count
			}
		}
		entry.compactionsByCause = counts
	}
	const last = update.lastCompaction as Record<string, unknown> | undefined
	if (last && typeof last === "object" && isSubagentCompactionCause(last.cause)) {
		entry.lastCompaction = {
			cause: last.cause,
			...(typeof last.tokensBefore === "number" ? { tokensBefore: last.tokensBefore } : {}),
			...(typeof last.tokensAfter === "number" ? { tokensAfter: last.tokensAfter } : {}),
		}
	}
}

/** Where teammate indexes start; see `buildTeammateStatusMessage`. */
const TEAMMATE_INDEX_BASE = 1000

/** A teammate as `team_progress` reports it. */
type TeammateProgress = NonNullable<Extract<CoreSessionEvent, { type: "team_progress" }>["payload"]["teammates"]>[number]

/**
 * A realized sampler as the spawn tools report it (`RealizedSpawnSampling` in
 * core), keeping only the fields of the shape it should have.
 */
export function readSubagentSampling(value: unknown): SubagentSampling | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const record = value as Record<string, unknown>
	const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : undefined)
	const sampling: SubagentSampling = {}
	const temperature = number(record.temperature)
	const seed = number(record.seed)
	const temperatureBase = number(record.temperatureBase)
	const temperatureRange = number(record.temperatureRange)
	if (temperature !== undefined) sampling.temperature = temperature
	if (seed !== undefined) sampling.seed = seed
	if (record.seedRandom === true) sampling.seedRandom = true
	if (temperatureBase !== undefined) sampling.temperatureBase = temperatureBase
	if (temperatureRange !== undefined) sampling.temperatureRange = temperatureRange
	if (typeof record.note === "string" && record.note.trim()) sampling.note = record.note.trim()
	return Object.keys(sampling).length > 0 ? sampling : undefined
}

/**
 * The lead's check as a report carries it (`AgentOracleResult` in core),
 * keeping only the fields of the shape it should have. Exported for the tests.
 */
export function readSubagentOracle(value: unknown): SubagentOracleResult | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const record = value as Record<string, unknown>
	const status = record.status
	if (status !== "pass" && status !== "fail" && status !== "not_run") {
		return undefined
	}
	const text = (field: unknown) => (typeof field === "string" ? field : undefined)
	const command = text(record.command)
	const expect = text(record.expect)
	const reason = text(record.reason)
	return {
		status,
		exitCode: typeof record.exitCode === "number" && Number.isFinite(record.exitCode) ? record.exitCode : null,
		output: text(record.output) ?? "",
		...(command !== undefined ? { command } : {}),
		...(expect !== undefined ? { expect } : {}),
		...(record.must === "match" || record.must === "not_match" ? { must: record.must } : {}),
		...(typeof record.runs === "number" ? { runs: record.runs } : {}),
		...(reason ? { reason } : {}),
	}
}

/**
 * The iteration cap from a progress update or a report: the cap, the stop
 * reason, and whether it is waiting for the lead. Exported for the tests.
 */
export function applySubagentIterationCap(entry: SubagentStatusItem, update: Record<string, unknown>): void {
	const positive = (field: unknown) => (typeof field === "number" && Number.isFinite(field) && field > 0 ? field : undefined)
	const cap = positive(update.maxIterations)
	if (cap !== undefined) {
		entry.maxIterations = cap
	}
	if (update.stopReason === "iteration_cap" || update.stopReason === "loop_guard" || update.stopReason === "supervisor") {
		entry.stopReason = update.stopReason
	}
	// Waiting, from the spawn tool's own update while the round is open...
	const waiting = update.awaitingLead
	if (waiting && typeof waiting === "object") {
		const record = waiting as Record<string, unknown>
		const maxIterations = positive(record.maxIterations) ?? entry.maxIterations ?? 0
		const iterations = positive(record.iterations) ?? maxIterations
		const reason = record.reason === "looping" || record.reason === "struggling" ? record.reason : undefined
		const detail = reason && typeof record.detail === "string" ? record.detail : undefined
		if (!entry.awaitingLead) {
			pushSubagentActivity(
				entry,
				reason === "looping"
					? "Looping: stopped by the loop guard, awaiting lead"
					: reason === "struggling"
						? "Struggling: stopped by the struggle supervisor, awaiting lead"
						: `Awaiting lead (iteration cap ${maxIterations})`,
				"warn",
			)
		}
		entry.awaitingLead = {
			iterations,
			maxIterations,
			...(reason ? { reason } : {}),
			...(detail ? { detail } : {}),
		}
		entry.maxIterations = maxIterations
	} else if (waiting === null && entry.awaitingLead) {
		entry.awaitingLead = undefined
		// Its call may have returned while it waited: working again.
		if (entry.status === "completed") entry.status = "running"
		pushSubagentActivity(entry, "Resumed by the lead")
	}
	// ...or from a report that returned while it still waits.
	if (update.state === "awaiting_lead") {
		const maxIterations = cap ?? entry.maxIterations ?? 0
		const reason =
			update.stopReason === "loop_guard"
				? ("looping" as const)
				: update.stopReason === "supervisor"
					? ("struggling" as const)
					: entry.awaitingLead?.reason
		entry.awaitingLead = {
			iterations: positive(update.iterations) ?? maxIterations,
			maxIterations,
			...(reason ? { reason } : {}),
			...(entry.awaitingLead?.detail ? { detail: entry.awaitingLead.detail } : {}),
		}
	}
}

/** An agent whose call returned while it went on: in the background, or waiting at its cap. */
function isSpawnAgentOut(entry: SubagentStatusItem): boolean {
	return entry.status === "running" || entry.status === "pending" || entry.awaitingLead !== undefined
}

/** How many earlier spawn rows are kept to be followed; see `parkedSpawnGroups`. */
const PARKED_SPAWN_GROUPS_MAX = 64

/** The lead running an agent of an earlier call again: its row starts over. */
function isRerunUpdate(updateData: Record<string, unknown> | undefined): boolean {
	return !!updateData && typeof updateData.rerun === "object" && updateData.rerun !== null
}

/**
 * The row a rerun's update is for, when the call that drew it is gone: the
 * control call (`restart_agent`, `retry_failed`) carries the update, tagged
 * with the original call and, in a batch, the agent's index.
 */
function readRoundRow(updateData: Record<string, unknown> | undefined): string | undefined {
	const target = updateData?.roundRow as { toolCallId?: unknown; member?: unknown } | undefined
	if (!target || typeof target.toolCallId !== "string" || !target.toolCallId) {
		return undefined
	}
	return typeof target.member === "number" ? spawnMemberKey(target.toolCallId, target.member) : target.toolCallId
}

/** A round's agent, as the core's round registry recorded it. */
interface RoundAgentLike {
	index: number
	state?: string
	stopReason?: string
	stopDetail?: string
	awaitingReason?: string
	iterations?: number
	maxIterations?: number
}

/** A round, as the core's round registry recorded it: what a reopened row is drawn from. */
export interface RoundRowSource {
	toolCallId?: string
	rowed?: boolean
	agents: RoundAgentLike[]
}

/**
 * A row drawn from the transcript, set to how the round registry says its
 * agent is: the transcript holds what the call returned -- "running in the
 * background", "awaiting the lead" -- not how the agent ended.
 */
function applyRoundAgentState(entry: SubagentStatusItem, agent: RoundAgentLike): void {
	switch (agent.state) {
		case "done":
			entry.status = "completed"
			entry.awaitingLead = undefined
			break
		case "failed":
		case "cancelled": {
			entry.status = "failed"
			entry.awaitingLead = undefined
			const why = agent.stopReason ?? agent.state
			entry.error = agent.stopDetail ? `${why}: ${agent.stopDetail}` : (entry.error ?? why)
			break
		}
		case "awaiting_lead": {
			const maxIterations = agent.maxIterations ?? entry.maxIterations ?? 0
			entry.status = "running"
			entry.awaitingLead = {
				iterations: agent.iterations ?? maxIterations,
				maxIterations,
				...(agent.awaitingReason === "looping" || agent.awaitingReason === "struggling"
					? { reason: agent.awaitingReason }
					: {}),
				...(agent.stopDetail ? { detail: agent.stopDetail } : {}),
			}
			break
		}
		// Waiting on the server -- a full window, a refusal, an outage -- is
		// queued too: nothing of the agent runs until the server takes it.
		case "queued":
		case "waiting_infra":
			entry.status = "pending"
			break
		case "running":
			entry.status = "running"
			break
	}
}

/**
 * One progress update from a spawn tool, onto its agent's row: the current
 * iteration's, or one kept from an earlier call whose agents are still out.
 */
function applySpawnAgentUpdate(entry: SubagentStatusItem, updateData: Record<string, unknown>): void {
	// The lead ran it again (restart_agent, retry_failed): the row starts
	// over -- running, its last end cleared -- and follows the new run.
	if (isRerunUpdate(updateData)) {
		const attempt = (updateData.rerun as { attempt?: unknown }).attempt
		entry.status = "running"
		entry.error = undefined
		entry.result = undefined
		entry.awaitingLead = undefined
		entry.stopReason = undefined
		entry.oracle = undefined
		entry.latestToolCall = undefined
		pushSubagentActivity(
			entry,
			typeof attempt === "number" ? `Run again by the lead (attempt ${attempt})` : "Run again by the lead",
		)
	}
	if (typeof updateData.toolCalls === "number") entry.toolCalls = updateData.toolCalls
	applySubagentCompactions(entry, updateData)
	if (typeof updateData.inputTokens === "number") entry.inputTokens = updateData.inputTokens
	if (typeof updateData.outputTokens === "number") entry.outputTokens = updateData.outputTokens
	if (typeof updateData.totalCost === "number") entry.totalCost = updateData.totalCost
	if (typeof updateData.contextTokens === "number") entry.contextTokens = updateData.contextTokens
	if (typeof updateData.contextWindow === "number") entry.contextWindow = updateData.contextWindow
	if (typeof updateData.contextUsagePercentage === "number") entry.contextUsagePercentage = updateData.contextUsagePercentage
	if (typeof updateData.latestToolCall === "string") {
		if (updateData.latestToolCall !== entry.latestToolCall) {
			pushSubagentActivity(entry, updateData.latestToolCall)
		}
		entry.latestToolCall = updateData.latestToolCall
	}
	// Its tool has ended and it is thinking again (#77): the row
	// stops naming the tool rather than showing it until the next.
	if (updateData.latestToolCall === null) entry.latestToolCall = undefined
	if (typeof updateData.latestOutput === "string") entry.latestOutput = updateData.latestOutput
	if (updateData.latestOutputKind === "text" || updateData.latestOutputKind === "reasoning")
		entry.latestOutputKind = updateData.latestOutputKind
	// How the row stops this agent. Sent by the spawn tool
	// as soon as it registers, so the button exists before
	// the agent's first tool call rather than after it.
	if (typeof updateData.cancelId === "string") entry.cancelId = updateData.cancelId
	// Waiting for a node, or placed on one. Every entry starts as
	// running, so without this a fan-out larger than its nodes
	// showed every agent at work while most of them were queued.
	if (updateData.queued === true && entry.status === "running") entry.status = "pending"
	if (updateData.queued === false && entry.status === "pending") entry.status = "running"
	// The node it runs on, known at placement -- not only at the
	// end, when it no longer explains anything.
	if (typeof updateData.nodeId === "string") entry.nodeId = updateData.nodeId
	if (typeof updateData.nodeLabel === "string") entry.nodeLabel = updateData.nodeLabel
	// The model it runs on, sent when its attempt is built (#78). The
	// final result still overwrites these with what actually answered.
	if (typeof updateData.providerId === "string") entry.providerId = updateData.providerId
	if (typeof updateData.modelId === "string") entry.modelId = updateData.modelId
	// The sampler its attempt was built with -- a random seed or
	// temperature as drawn -- sent beside the model.
	const sampling = readSubagentSampling(updateData.sampling)
	if (sampling) entry.sampling = sampling
	if (updateData.queued === false && (typeof updateData.nodeLabel === "string" || typeof updateData.nodeId === "string")) {
		pushSubagentActivity(entry, `Placed on ${entry.nodeLabel ?? entry.nodeId}`)
	}
	// What the tool, the placement queue and the engine said about
	// it: a wait, a refusal, a pool that shares nothing.
	const activity = updateData.activity as { text?: unknown; severity?: unknown } | undefined
	if (activity && typeof activity.text === "string") {
		pushSubagentActivity(entry, activity.text, activity.severity === "warn" ? "warn" : undefined)
	}
	// Stopped at its iteration cap, waiting for the lead; or resumed.
	if ("awaitingLead" in updateData) applySubagentIterationCap(entry, updateData)
	if (typeof updateData.genTps === "number" && Number.isFinite(updateData.genTps)) entry.genTps = updateData.genTps
	// Ended, on its own: a batch or swarm member's row finishes
	// when that agent does, not with the call. Until then a done
	// agent sat on a "running" row, its output showing, until the
	// slowest of the round finished.
	const finished = updateData.finished
	if (finished && typeof finished === "object") {
		const report = finished as Record<string, unknown>
		applySpawnAgentOutput(entry, report)
		if (typeof report.error === "string" && report.error) {
			entry.status = "failed"
			entry.error = report.error
			pushSubagentActivity(entry, `Failed: ${report.error}`, "warn")
		} else {
			entry.status = "completed"
			pushSubagentActivity(entry, "Finished")
		}
	}
	// Its end, after it had waited at its cap: no longer waiting.
	if (updateData.finished && typeof updateData.finished === "object" && entry.awaitingLead) {
		entry.awaitingLead = undefined
	}
}

function applySpawnAgentOutput(entry: SubagentStatusItem, output: Record<string, unknown>): void {
	applySubagentIterationCap(entry, output)
	const oracle = readSubagentOracle(output.oracle)
	if (oracle) {
		entry.oracle = oracle
	}
	entry.result = typeof output.text === "string" ? output.text : undefined
	const usage = output.usage as Record<string, unknown> | undefined
	if (usage) {
		if (typeof usage.inputTokens === "number") entry.inputTokens = usage.inputTokens
		if (typeof usage.outputTokens === "number") entry.outputTokens = usage.outputTokens
	}
	// Which connection it actually ran on. Agents can be
	// given one of their own, and a configured agent may
	// name a provider per file, so this is not the lead's
	// to assume.
	const model = output.model as Record<string, unknown> | undefined
	if (model) {
		if (typeof model.provider === "string") entry.providerId = model.provider
		if (typeof model.id === "string") entry.modelId = model.id
	}
	// Which node took it. Present only on a session
	// that has nodes, which is the only session where
	// the answer is worth anything.
	if (typeof output.nodeId === "string") {
		entry.nodeId = output.nodeId
	}
	// And what the settings panel calls it. The id is a
	// storage key the panel never shows, so naming a run
	// by it told the user nothing they could look up.
	if (typeof output.nodeLabel === "string") {
		entry.nodeLabel = output.nodeLabel
	}
	// The seed and temperature it ran with, when the lead set any.
	const sampling = readSubagentSampling(output.sampling)
	if (sampling) {
		entry.sampling = sampling
	}
}

/**
 * The agent's name as the workspace spells it, from the tool that runs it.
 *
 * `buildConfiguredAgentToolName` builds `subagent_js_syntactic` from
 * "js-syntactic" by lowercasing and replacing every run of non-alphanumerics
 * with `_`, which cannot be reversed exactly -- a hyphen and an underscore
 * both arrive as `_`. Undoing it to a hyphen matches how the agent files are
 * named in practice, and the name is a label, not a key.
 */
export function subagentNameFromToolName(toolName: string): string | undefined {
	if (!toolName.startsWith("subagent_")) {
		return undefined
	}
	const name = toolName.slice("subagent_".length).replace(/_/g, "-")
	return name || undefined
}

export class MessageTranslatorState {
	/** Current streaming text message timestamp (used for dedup) */
	private streamingTextTs: number | undefined
	/** Accumulated streaming text (SDK text events are deltas) */
	private streamingText = ""
	/** Current streaming reasoning message timestamp */
	private streamingReasoningTs: number | undefined
	/** Accumulated streaming reasoning text (SDK reasoning events are deltas) */
	private streamingReasoningText = ""
	/** Current streaming tool message timestamp */
	private streamingToolTs: number | undefined
	/** Stored tool input from content_start — used at content_end which doesn't carry input */
	private streamingToolInput: unknown | undefined
	/** Stored tool name from content_start — used at content_end for consistency */
	private streamingToolName: string | undefined
	/** Approved tool-call ids mapped to the approval row that should be updated in place. */
	private approvedToolMessageTsByCallId = new Map<string, number>()
	/**
	 * Images a tool showed the user but not the model (#53), by tool call, as
	 * data URLs: shown under the tool's row when it ends.
	 */
	private displayImagesByCallId = new Map<string, string[]>()
	/**
	 * The in-flight compaction divider's ts, so the "completed"/"skipped" notice
	 * (or a turn error/abort) updates the same row in place. Deliberately NOT
	 * cleared by the per-iteration `reset()`: the started/completed notices both
	 * fire inside prepareTurn, before the next `iteration_start`, but an error
	 * or abort mid-compaction must still be able to finalize the open row.
	 */
	private openCompactionTs: number | undefined
	/** Tool calls rejected by the user; they should not render as red tool failures. */
	private deniedToolApprovalsByCallId = new Map<string, { toolName: string; reason: string }>()
	/**
	 * Process-wide id/seq/epoch authority. Shared with the interaction coordinator and history
	 * rendering so that message ids never collide across generators. See message-id-minter.ts.
	 */
	private readonly minter: MessageIdMinter

	constructor(
		minter: MessageIdMinter = new MessageIdMinter(),
		private readonly getActiveProviderId?: () => string | undefined,
		private readonly getUiMode?: () => "plan" | "act" | "yolo" | undefined,
		private readonly getCwd?: () => string | undefined,
		private readonly getActiveModelId?: () => string | undefined,
		private readonly getContextWindowGrant?: () => ContextWindowGrant | undefined,
	) {
		this.minter = minter
	}

	/**
	 * The window the server granted the request a usage event is for.
	 *
	 * Read when the usage arrives, which is after the response whose
	 * `X-Context-Window` it reports: the grant and the cost of one request land
	 * on the same `api_req_started`, the only row the context bar reads.
	 */
	contextWindowGrant(): ContextWindowGrant | undefined {
		return this.getContextWindowGrant?.()
	}

	/**
	 * The fixed price the last prepare-turn measured, until the next one.
	 *
	 * The core emits it once per turn, before the request; the usage event that
	 * carries the request's cost arrives after. Held here so the two meet on
	 * one `api_req_started`, which is the only row the context bar reads.
	 */
	private contextBreakdownSeen: ContextBreakdown | undefined

	/** Provider backing the active turn, if the host can supply it. */
	activeProviderId(): string | undefined {
		return this.getActiveProviderId?.()
	}

	/** Record the fixed-price breakdown the current turn was prepared with. */
	noteContextBreakdown(breakdown: ContextBreakdown): void {
		this.contextBreakdownSeen = breakdown
	}

	/** The last measured fixed price, if any turn has reported one. */
	contextBreakdown(): ContextBreakdown | undefined {
		return this.contextBreakdownSeen
	}

	/** Model backing the active turn, if the host can supply it. */
	activeModelId(): string | undefined {
		return this.getActiveModelId?.()
	}

	/**
	 * The task's working directory, used to relativize the absolute filesystem
	 * paths in tool inputs before they reach the webview. Undefined when the
	 * host doesn't supply a cwd source (paths are then displayed as-is).
	 */
	currentCwd(): string | undefined {
		return this.getCwd?.()
	}

	/**
	 * Plan/act mode governing the current turn, used to style the inferred turn-final
	 * response (plan → yellow plan box, act/yolo → green completion box).
	 * Defaults to act when the host doesn't supply a mode source.
	 */
	currentUiMode(): "plan" | "act" {
		return this.getUiMode?.() === "plan" ? "plan" : "act"
	}

	/** The shared minter, exposed so coordinators and history rendering mint from the same source. */
	getMinter(): MessageIdMinter {
		return this.minter
	}

	/** Generate a unique message id (identity). Pure monotonic counter; never reads the clock. */
	nextTs(): number {
		return this.minter.nextId()
	}

	/** Mint and remember the ts of an in-flight compaction divider. */
	beginCompaction(): number {
		this.openCompactionTs = this.nextTs()
		return this.openCompactionTs
	}

	/** The in-flight compaction divider's ts, left open for the next update. */
	peekOpenCompactionTs(): number | undefined {
		return this.openCompactionTs
	}

	/** Take (and clear) the in-flight compaction divider's ts, if any. */
	takeOpenCompactionTs(): number | undefined {
		const ts = this.openCompactionTs
		this.openCompactionTs = undefined
		return ts
	}

	/**
	 * The ts of the row an escalation's progress is being written to.
	 *
	 * One row per hand-over, rewritten in place, and the delivery takes it over
	 * when it arrives. Twelve separate "the expert called read_files" rows would
	 * bury the delivery they lead to, and a progress row left standing beside
	 * the delivery would have its spend counted twice on the task header.
	 */
	private openExpertProgressTs: number | undefined

	/** Mint or reuse the ts of the live expert-progress row. */
	expertProgressTs(): number {
		this.openExpertProgressTs ??= this.nextTs()
		return this.openExpertProgressTs
	}

	/** Take (and clear) the live expert-progress row's ts, if any. */
	takeOpenExpertProgressTs(): number | undefined {
		const ts = this.openExpertProgressTs
		this.openExpertProgressTs = undefined
		return ts
	}

	// What this iteration actually put in front of the user. A turn that
	// produced none of it renders as nothing at all between two request rows,
	// which is indistinguishable from the model still working -- and a model
	// that answers with an empty turn is a real failure mode that currently
	// leaves no trace in the panel. Counted here rather than derived at
	// `iteration_end`, because by then the streaming buffers have been cleared.
	private iterationTextChars = 0
	private iterationReasoningChars = 0
	private iterationToolCalls = 0

	/** Record that this iteration finalized visible assistant prose. */
	noteIterationText(text: string): void {
		this.iterationTextChars += text.trim().length
	}

	/** Record that this iteration produced reasoning. */
	noteIterationReasoning(reasoning: string): void {
		this.iterationReasoningChars += reasoning.trim().length
	}

	/** Record that this iteration called a tool. */
	noteIterationToolCall(): void {
		this.iterationToolCalls += 1
	}

	/**
	 * The iteration's output, for deciding whether it left any trace.
	 *
	 * Reasoning is reported but does NOT count as output: a turn that thought
	 * at length and then said nothing and called nothing is exactly the case
	 * worth surfacing, and the character count is what separates it from a
	 * turn that produced literally nothing.
	 */
	iterationOutput(): { textChars: number; reasoningChars: number; toolCalls: number } {
		return {
			textChars: this.iterationTextChars,
			reasoningChars: this.iterationReasoningChars,
			toolCalls: this.iterationToolCalls,
		}
	}

	/** Get and increment for streaming text */
	getStreamingTextTs(): number {
		if (!this.streamingTextTs) {
			this.streamingTextTs = this.nextTs()
		}
		return this.streamingTextTs
	}

	/** Append a text delta and return the accumulated text */
	appendStreamingText(textDelta: string): string {
		this.streamingText += textDelta
		return this.streamingText
	}

	/** Clear streaming text (content ended) */
	clearStreamingText(): number {
		const ts = this.streamingTextTs ?? this.nextTs()
		this.streamingTextTs = undefined
		this.streamingText = ""
		return ts
	}

	/** Get and increment for streaming reasoning */
	getStreamingReasoningTs(): number {
		if (!this.streamingReasoningTs) {
			this.streamingReasoningTs = this.nextTs()
		}
		return this.streamingReasoningTs
	}

	/** Append a reasoning delta and return the accumulated reasoning text */
	appendStreamingReasoning(reasoningDelta: string): string {
		this.streamingReasoningText += reasoningDelta
		return this.streamingReasoningText
	}

	/** Clear streaming reasoning (content ended) */
	clearStreamingReasoning(): number {
		const ts = this.streamingReasoningTs ?? this.nextTs()
		this.streamingReasoningTs = undefined
		this.streamingReasoningText = ""
		return ts
	}

	/** Get streaming tool ts */
	getStreamingToolTs(): number {
		if (!this.streamingToolTs) {
			this.streamingToolTs = this.nextTs()
		}
		return this.streamingToolTs
	}

	/** Store tool input from content_start for use at content_end */
	setStreamingToolContext(toolName: string, input: unknown): void {
		this.streamingToolName = toolName
		this.streamingToolInput = input
	}

	/** Remember the approval prompt row for a tool call after the user approves it. */
	recordApprovedToolMessageTs(toolCallId: string, messageTs: number): void {
		this.approvedToolMessageTsByCallId.set(toolCallId, messageTs)
	}

	/** Clear approved prompt rows that no longer have a live tool event to consume them. */
	clearApprovedToolMessageTs(): void {
		this.approvedToolMessageTsByCallId.clear()
	}

	recordDeniedToolApproval(toolCallId: string, toolName: string, reason: string): void {
		this.deniedToolApprovalsByCallId.set(toolCallId, { toolName, reason })
	}

	isToolApprovalDenied(toolCallId: string | undefined): boolean {
		return toolCallId !== undefined && this.deniedToolApprovalsByCallId.has(toolCallId)
	}

	/**
	 * Returns true when the given toolCallId was previously denied and its events should be
	 * suppressed. This intentionally does not remove the entry because the denial must persist
	 * past content_end so the follow-on error event can also be suppressed.
	 */
	checkDeniedToolApproval(toolCallId: string | undefined): boolean {
		if (toolCallId === undefined || !this.deniedToolApprovalsByCallId.has(toolCallId)) {
			return false
		}
		return true
	}

	isSuppressedToolApprovalDenial(value: unknown): boolean {
		return isDeniedToolApprovalMistake(value, this.deniedToolApprovalsByCallId.values())
	}

	/** Reuse and remove a previously-approved prompt row for the matching tool event. */
	consumeApprovedToolMessageTs(toolCallId: string | undefined): number | undefined {
		if (!toolCallId) {
			return undefined
		}
		const messageTs = this.approvedToolMessageTsByCallId.get(toolCallId)
		if (messageTs !== undefined) {
			this.approvedToolMessageTsByCallId.delete(toolCallId)
		}
		return messageTs
	}

	/** Force the active tool stream to update a known row instead of minting a new row. */
	setStreamingToolTs(ts: number): void {
		this.streamingToolTs = ts
	}

	/** Get the stored tool input (from content_start) */
	getStreamingToolInput(): unknown | undefined {
		return this.streamingToolInput
	}

	/** Get the stored tool name (from content_start) */
	getStreamingToolName(): string | undefined {
		return this.streamingToolName
	}

	/** Clear streaming tool */
	clearStreamingTool(): number {
		const ts = this.streamingToolTs ?? this.nextTs()
		this.streamingToolTs = undefined
		this.streamingToolInput = undefined
		this.streamingToolName = undefined
		return ts
	}

	/** Whether attempt_completion tool was called in this turn */
	private attemptCompletionSeen = false

	/** Mark that attempt_completion was called */
	setAttemptCompletionSeen(): void {
		this.attemptCompletionSeen = true
	}

	/** Check if attempt_completion was called in this turn */
	wasAttemptCompletionSeen(): boolean {
		return this.attemptCompletionSeen
	}

	/** Whether a provider/agent error surfaced in this turn (ask:"api_req_failed" emitted) */
	private errorSeen = false

	/** Mark that this turn surfaced an error */
	setErrorSeen(): void {
		this.errorSeen = true
	}

	/** Check if this turn surfaced an error — drives the "error" turn phase (Retry / New Task) */
	wasErrorSeen(): boolean {
		return this.errorSeen
	}

	/**
	 * Forget an error the turn went on to recover from.
	 *
	 * `errorSeen` is sticky for the whole turn, which is right while the turn is
	 * still running — but a turn that ends with `done(reason: "completed")` did
	 * not fail, whatever happened in the middle of it. Left sticky, one
	 * recovered provider hiccup in a 438-message turn resolves the finished
	 * turn to the error phase: Retry / Start New Task, and `sendingDisabled`,
	 * so the user cannot even type a reply to a task that just succeeded.
	 */
	clearErrorSeen(): void {
		this.errorSeen = false
	}

	// -----------------------------------------------------------------------
	// Turn-final text tracking — the SDK agent usually ends a turn with a plain
	// text response instead of a completion tool. When a turn ends cleanly with
	// text as its last content, that text row is retagged in place (same ts) to
	// say:"completion_result" (act) or say:"plan_completion_result" (plan) so
	// the webview shows the legacy-style completion feedback box.
	// -----------------------------------------------------------------------

	/** ts of the last finalized (non-partial, non-empty) text message of the current turn */
	private turnFinalTextTs: number | undefined
	/** Text of the message tracked by turnFinalTextTs */
	private turnFinalText = ""

	/** Remember the most recent finalized text as the candidate turn-final response. */
	recordTurnFinalText(ts: number, text: string): void {
		this.turnFinalTextTs = ts
		this.turnFinalText = text
	}

	/** Forget the candidate turn-final text (tool activity means the turn didn't end on it). */
	clearTurnFinalText(): void {
		this.turnFinalTextTs = undefined
		this.turnFinalText = ""
	}

	/** Take (and clear) the candidate turn-final text, if any. */
	takeTurnFinalText(): { ts: number; text: string } | undefined {
		if (this.turnFinalTextTs === undefined) {
			return undefined
		}
		const result = { ts: this.turnFinalTextTs, text: this.turnFinalText }
		this.clearTurnFinalText()
		return result
	}

	// -----------------------------------------------------------------------
	// spawn_agent tracking — aggregates parallel spawn_agent tool calls into
	// the rich SubagentStatusRow UI (use_subagents + subagent messages).
	// -----------------------------------------------------------------------

	/** Active spawn_agent entries keyed by toolCallId */
	private spawnAgentEntries = new Map<string, SubagentStatusItem>()
	/** Stable timestamp for the combined say:"use_subagents" prompts message */
	private spawnAgentPromptsTs: number | undefined
	/** Stable timestamp for the combined say:"subagent" status message */
	private spawnAgentStatusTs: number | undefined
	/** Counter for assigning index to new spawn_agent entries */
	private spawnAgentNextIndex = 0

	/** Register a new spawn_agent call. Returns the entry for this call. */
	addSpawnAgent(toolCallId: string, prompt: string, agentName?: string): SubagentStatusItem {
		const trimmedName = agentName?.trim()
		const entry: SubagentStatusItem = {
			index: ++this.spawnAgentNextIndex,
			...(trimmedName ? { agentName: trimmedName } : {}),
			prompt,
			status: "running",
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		}
		this.spawnAgentEntries.set(toolCallId, entry)
		return entry
	}

	/** Get a spawn_agent entry by toolCallId */
	getSpawnAgent(toolCallId: string): SubagentStatusItem | undefined {
		return this.spawnAgentEntries.get(toolCallId)
	}

	/** How many batch members a `spawn_agent` call registered; 0 for a single agent. */
	countSpawnMembers(toolCallId: string): number {
		let count = 0
		while (this.spawnAgentEntries.has(spawnMemberKey(toolCallId, count))) {
			count += 1
		}
		return count
	}

	/** Whether there are any active spawn_agent calls */
	hasSpawnAgents(): boolean {
		return this.spawnAgentEntries.size > 0
	}

	/**
	 * Rows of a call that returned while its agents work on (`wait: false`).
	 * They run beside the lead rather than in place of its turn, so they do not
	 * count as the spawn in flight that holds the lead's own events back.
	 */
	private readonly backgroundSpawnKeys = new Set<string>()

	markSpawnAgentBackground(key: string): void {
		this.backgroundSpawnKeys.add(key)
	}

	/** Whether any registered spawn_agent call has not finished yet. */
	hasRunningSpawnAgents(): boolean {
		return Array.from(this.spawnAgentEntries.entries()).some(
			([key, entry]) => !this.backgroundSpawnKeys.has(key) && (entry.status === "running" || entry.status === "pending"),
		)
	}

	/** Get all spawn_agent entries as an ordered array */
	getSpawnAgentItems(): SubagentStatusItem[] {
		return Array.from(this.spawnAgentEntries.values()).sort((a, b) => a.index - b.index)
	}

	/** Get or create the stable timestamp for say:"use_subagents" prompts messages */
	getSpawnAgentPromptsTs(): number {
		if (!this.spawnAgentPromptsTs) {
			this.spawnAgentPromptsTs = this.nextTs()
		}
		return this.spawnAgentPromptsTs
	}

	/** Force the aggregated spawn-agent prompt row to update a known approval row. */
	setSpawnAgentPromptsTs(ts: number): void {
		this.spawnAgentPromptsTs = ts
	}

	/** Get or create the stable timestamp for subagent status messages */
	getSpawnAgentStatusTs(): number {
		if (!this.spawnAgentStatusTs) {
			this.spawnAgentStatusTs = this.nextTs()
		}
		return this.spawnAgentStatusTs
	}

	/** Build a ClineSaySubagentStatus from the current entries */
	buildSubagentStatus(
		overallStatus: ClineSaySubagentStatus["status"],
		items: SubagentStatusItem[] = this.getSpawnAgentItems(),
	): ClineSaySubagentStatus {
		const completed = items.filter((e) => e.status === "completed" || e.status === "failed").length
		const successes = items.filter((e) => e.status === "completed").length
		const failures = items.filter((e) => e.status === "failed").length
		return {
			status: overallStatus,
			total: items.length,
			completed,
			successes,
			failures,
			toolCalls: items.reduce((acc, e) => acc + (e.toolCalls || 0), 0),
			compactions: items.reduce((acc, e) => acc + (e.compactions || 0), 0),
			inputTokens: items.reduce((acc, e) => acc + (e.inputTokens || 0), 0),
			outputTokens: items.reduce((acc, e) => acc + (e.outputTokens || 0), 0),
			contextWindow: items.reduce((acc, e) => Math.max(acc, e.contextWindow || 0), 0),
			maxContextTokens: items.reduce((acc, e) => Math.max(acc, e.contextTokens || 0), 0),
			maxContextUsagePercentage: items.reduce((acc, e) => Math.max(acc, e.contextUsagePercentage || 0), 0),
			items,
		}
	}

	// -----------------------------------------------------------------------
	// Teammates -- one row for the session's teammates, from team_progress.
	// -----------------------------------------------------------------------

	private teammateRowTs: number | undefined
	private teammateRowRunning = false
	private lastTeammateRowText: string | undefined
	private readonly teammateIndex = new Map<string, number>()

	/**
	 * The teammates' status row, or nothing when it would say what it said
	 * last. Index 1000 and up: the working-agents strip keys agents by index,
	 * and a teammate must not collide with a sub-agent of the same round.
	 */
	buildTeammateStatusMessage(teammates: readonly TeammateProgress[]): ClineMessage | undefined {
		const items: SubagentStatusItem[] = teammates.map((teammate) => {
			let index = this.teammateIndex.get(teammate.agentId)
			if (index === undefined) {
				index = TEAMMATE_INDEX_BASE + this.teammateIndex.size + 1
				this.teammateIndex.set(teammate.agentId, index)
			}
			const item: SubagentStatusItem = {
				index,
				agentName: teammate.agentId,
				prompt: teammate.description ?? "",
				status: teammate.status === "running" ? "running" : "completed",
				toolCalls: teammate.activity?.toolCalls ?? 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				contextTokens: 0,
				contextWindow: 0,
				contextUsagePercentage: 0,
			}
			// The seed and temperature it was spawned with, as drawn.
			const sampling = readSubagentSampling(teammate.sampling)
			if (sampling) {
				item.sampling = sampling
			}
			// Its stop and restart in the strip, while it runs a task: the id
			// the team runtime registered that task under, not one rebuilt here.
			if (item.status === "running" && typeof teammate.cancelId === "string") {
				item.cancelId = teammate.cancelId
			}
			if (teammate.activity) {
				applySubagentCompactions(item, teammate.activity as unknown as Record<string, unknown>)
			}
			if (teammate.taskActivity) {
				// Read through the same reader as the life count, into its own record.
				const task = { toolCalls: teammate.taskActivity.toolCalls } as SubagentStatusItem
				applySubagentCompactions(task, teammate.taskActivity as unknown as Record<string, unknown>)
				item.lastTask = {
					toolCalls: task.toolCalls,
					...(task.compactions !== undefined ? { compactions: task.compactions } : {}),
					...(task.compactionsByCause ? { compactionsByCause: task.compactionsByCause } : {}),
					...(task.lastCompaction ? { lastCompaction: task.lastCompaction } : {}),
				}
			}
			return item
		})
		const running = items.some((item) => item.status === "running")
		const status: ClineSaySubagentStatus = {
			kind: "team",
			status: running ? "running" : "completed",
			total: items.length,
			completed: items.filter((item) => item.status !== "running").length,
			successes: items.filter((item) => item.status === "completed").length,
			failures: 0,
			toolCalls: items.reduce((acc, item) => acc + item.toolCalls, 0),
			compactions: items.reduce((acc, item) => acc + (item.compactions ?? 0), 0),
			inputTokens: 0,
			outputTokens: 0,
			contextWindow: 0,
			maxContextTokens: 0,
			maxContextUsagePercentage: 0,
			items,
		}
		const text = JSON.stringify(status)
		if (text === this.lastTeammateRowText) {
			return undefined
		}
		this.lastTeammateRowText = text
		if (this.teammateRowTs === undefined) {
			this.teammateRowTs = this.nextTs()
		}
		this.teammateRowRunning = running
		return { ts: this.teammateRowTs, type: "say", say: "subagent" as ClineSay, text, partial: running }
	}

	/**
	 * The next change to the teammates starts a new row, down where the
	 * conversation is -- unless one is still running, whose row stays where it
	 * is until it is done. Called with the lead's every new iteration.
	 */
	releaseTeammateRow(): void {
		if (!this.teammateRowRunning) {
			this.teammateRowTs = undefined
		}
	}

	/**
	 * Rows of earlier iterations' spawn calls, kept past the iteration that
	 * made them. Agents still out -- a background round, an agent detached at
	 * its iteration cap -- keep sending updates through the call's tool
	 * events, and each lands on its row, at the row's own timestamp. A row
	 * whose agents have all ended is kept too, the most recent
	 * {@link PARKED_SPAWN_GROUPS_MAX} of them: the lead can run one of its
	 * agents again (`restart_agent`, `retry_failed`), and the rerun follows
	 * on that row.
	 */
	private readonly parkedSpawnGroups = new Map<string, { ts: number; entries: Map<string, SubagentStatusItem> }>()

	private parkSpawnGroup(ts: number, entries: Map<string, SubagentStatusItem>): void {
		this.parkedSpawnGroups.delete(String(ts))
		this.parkedSpawnGroups.set(String(ts), { ts, entries })
		while (this.parkedSpawnGroups.size > PARKED_SPAWN_GROUPS_MAX) {
			const oldest = this.parkedSpawnGroups.keys().next().value
			if (oldest === undefined) {
				break
			}
			this.parkedSpawnGroups.delete(oldest)
		}
	}

	/** The kept rows, for a translator that follows them next: a reopened task's. */
	exportParkedSpawnGroups(): Array<{ ts: number; entries: Array<[string, SubagentStatusItem]> }> {
		return Array.from(this.parkedSpawnGroups.values(), (group) => ({
			ts: group.ts,
			entries: Array.from(group.entries.entries(), ([key, entry]) => [key, structuredClone(entry)]),
		}))
	}

	/**
	 * Follow these rows from now on, in place of any kept before: the rows of
	 * a task just drawn from its transcript, whose agents the lead may run
	 * again.
	 */
	adoptParkedSpawnGroups(groups: ReadonlyArray<{ ts: number; entries: ReadonlyArray<[string, SubagentStatusItem]> }>): void {
		this.parkedSpawnGroups.clear()
		for (const group of groups) {
			this.parkSpawnGroup(group.ts, new Map(group.entries.map(([key, entry]) => [key, structuredClone(entry)])))
		}
	}

	/** A kept row's agent, set from the round registry: the row's ts, or `undefined` for no such row. */
	applyRoundToParkedRow(key: string, agent: RoundAgentLike): number | undefined {
		const parked = this.getParkedSpawnAgent(key)
		if (!parked) {
			return undefined
		}
		applyRoundAgentState(parked.entry, agent)
		return parked.groupTs
	}

	/** A kept row's agent, by the key its updates name. */
	getParkedSpawnAgent(key: string): { entry: SubagentStatusItem; groupTs: number } | undefined {
		for (const group of this.parkedSpawnGroups.values()) {
			const entry = group.entries.get(key)
			if (entry) {
				return { entry, groupTs: group.ts }
			}
		}
		return undefined
	}

	/** This iteration's spawn row as it stands: running while an agent of it is out. */
	buildCurrentSubagentMessage(): ClineMessage {
		const items = this.getSpawnAgentItems()
		const out = items.some(isSpawnAgentOut)
		const status = this.buildSubagentStatus(
			out ? "running" : items.some((item) => item.status === "failed") ? "failed" : "completed",
			items,
		)
		return {
			ts: this.getSpawnAgentStatusTs(),
			type: "say",
			say: "subagent" as ClineSay,
			text: JSON.stringify(status),
			partial: out,
		}
	}

	/** The kept row at `ts`, as a status message. */
	buildParkedSubagentMessage(ts: number): ClineMessage | undefined {
		const group = this.parkedSpawnGroups.get(String(ts))
		if (!group) {
			return undefined
		}
		const items = Array.from(group.entries.values()).sort((a, b) => a.index - b.index)
		const out = items.some(isSpawnAgentOut)
		const status = this.buildSubagentStatus(
			out ? "running" : items.some((item) => item.status === "failed") ? "failed" : "completed",
			items,
		)
		return { ts, type: "say", say: "subagent" as ClineSay, text: JSON.stringify(status), partial: out }
	}

	/** Clear all spawn_agent state (called at iteration_start) */
	clearSpawnAgents(): void {
		if (this.spawnAgentStatusTs !== undefined && this.spawnAgentEntries.size > 0) {
			this.parkSpawnGroup(this.spawnAgentStatusTs, new Map(this.spawnAgentEntries))
		}
		this.spawnAgentEntries.clear()
		this.backgroundSpawnKeys.clear()
		this.spawnAgentPromptsTs = undefined
		this.spawnAgentStatusTs = undefined
		this.spawnAgentNextIndex = 0
	}

	/**
	 * Reset per-iteration STREAMING state: the open text/reasoning/tool stream pointers and the
	 * spawn-agent aggregation. Called on each `iteration_start`, which is mid-turn within the same
	 * conversation, so it deliberately does NOT touch turn-outcome signals such as
	 * `attemptCompletionSeen` — those are scoped to the whole turn and survive its iterations.
	 */
	/** Keep images a tool sent for the user alone, until its row is built. */
	addToolDisplayImages(toolCallId: string, images: string[]): void {
		if (images.length === 0) {
			return
		}
		this.displayImagesByCallId.set(toolCallId, [...(this.displayImagesByCallId.get(toolCallId) ?? []), ...images])
	}

	/** The images a tool showed the user alone, once: they belong to one row. */
	takeToolDisplayImages(toolCallId: string | undefined): string[] {
		if (!toolCallId) {
			return []
		}
		const images = this.displayImagesByCallId.get(toolCallId) ?? []
		this.displayImagesByCallId.delete(toolCallId)
		return images
	}

	reset(): void {
		this.iterationTextChars = 0
		this.iterationReasoningChars = 0
		this.iterationToolCalls = 0
		this.streamingTextTs = undefined
		this.streamingReasoningTs = undefined
		this.streamingToolTs = undefined
		this.streamingToolInput = undefined
		this.streamingToolName = undefined
		this.clearApprovedToolMessageTs()
		this.deniedToolApprovalsByCallId.clear()
		this.clearSpawnAgents()
		this.releaseTeammateRow()
	}

	/**
	 * Clear turn-outcome signals (`attemptCompletionSeen`, the turn-final text candidate).
	 * Called at a new user turn / task boundary so each turn's phase is computed fresh; it is
	 * intentionally separate from the per-iteration `reset()` so the completion signal persists
	 * across the iterations of one turn.
	 */
	clearTurnOutcome(): void {
		this.attemptCompletionSeen = false
		this.errorSeen = false
		this.clearTurnFinalText()
	}
}

// ---------------------------------------------------------------------------
// Display-path relativization
// ---------------------------------------------------------------------------

/**
 * Tools whose ClineSayTool.path is a filesystem path. webFetch/webSearch/
 * useSkill and MCP tools reuse `path` for URLs, queries, and names, so they
 * are deliberately excluded.
 */
const FILESYSTEM_PATH_TOOLS: ReadonlySet<ClineSayTool["tool"]> = new Set([
	"readFile",
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"editedExistingFile",
	"newFileCreated",
	"fileDeleted",
	"searchFiles",
])

/**
 * Relativize a ClineSayTool's filesystem paths against the task cwd before it
 * is shown in the chat view, restoring the classic extension's getReadablePath
 * display behavior that was lost in the SDK migration (the SDK works with
 * absolute paths). Display-only — executors receive the raw tool input.
 */
function toDisplaySayTool(sayTool: ClineSayTool, cwd: string | undefined): ClineSayTool {
	if (!cwd || !FILESYSTEM_PATH_TOOLS.has(sayTool.tool)) {
		return sayTool
	}
	if (sayTool.tool === "readFile") {
		// The webview's readFile card opens `content` in the editor on click, so it
		// carries the absolute path (classic-extension behavior). Already-absolute
		// paths pass through untouched — path.resolve would rewrite a drive-less
		// absolute path onto the current drive on Windows.
		const openTarget = sayTool.path
			? path.isAbsolute(sayTool.path)
				? sayTool.path
				: path.resolve(cwd, sayTool.path)
			: sayTool.content
		return {
			...sayTool,
			path: toDisplayPath(sayTool.path, cwd),
			content: openTarget,
		}
	}
	return {
		...sayTool,
		path: toDisplayPath(sayTool.path, cwd),
		// apply_patch payloads carry "*** Update File: <path>" markers that
		// DiffEditRow renders as the diff headers, so relativize those too.
		content: relativizePatchPaths(sayTool.content, cwd),
		diff: relativizePatchPaths(sayTool.diff, cwd),
	}
}

/**
 * Mirror the classic getReadablePath: paths inside the cwd render relative,
 * the cwd itself renders as its basename, and anything outside the cwd stays
 * absolute so the user still sees exactly where the operation happened.
 */
function toDisplayPath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath || !path.isAbsolute(rawPath)) {
		return rawPath
	}
	// User opened VS Code without a workspace, so the cwd fell back to the
	// Desktop. Keep full absolute paths so the user stays aware of where
	// operations occur (classic getReadablePath behavior).
	if (arePathsEqual(cwd, getDesktopDir())) {
		return rawPath.replace(/\\/g, "/")
	}
	const relative = path.relative(cwd, rawPath)
	if (relative === "") {
		return path.basename(rawPath).replace(/\\/g, "/")
	}
	// Outside the cwd (or on another drive on Windows) — keep the absolute path.
	// Match ".." only as a whole segment so an in-cwd entry literally named
	// "..config" is not misclassified as outside.
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return rawPath.replace(/\\/g, "/")
	}
	return relative.replace(/\\/g, "/")
}

/** Rewrite the "*** Add/Update/Delete File:" and "*** Move to:" markers inside a patch payload. */
function relativizePatchPaths(patch: string | undefined, cwd: string): string | undefined {
	if (!patch) {
		return patch
	}
	const fileMarkers = [PATCH_MARKERS.ADD, PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE, PATCH_MARKERS.MOVE]
	return patch
		.split("\n")
		.map((line) => {
			const marker = fileMarkers.find((m) => line.startsWith(m))
			return marker ? marker + (toDisplayPath(line.substring(marker.length).trim(), cwd) ?? "") : line
		})
		.join("\n")
}

// ---------------------------------------------------------------------------
// SDK tool name → classic ClineSayTool mapping
// ---------------------------------------------------------------------------

/**
 * Map an SDK tool name and its input to a ClineSayTool object that the
 * webview's ChatRow.tsx can render.
 *
 * The webview does `JSON.parse(message.text) as ClineSayTool` when
 * `say === "tool"`, so the text MUST be valid ClineSayTool JSON.
 *
 * SDK tool names → classic tool names:
 *   read_files/read_file               → readFile
 *   list_files                         → listFilesTopLevel / listFilesRecursive
 *   list_code_definition_names         → listCodeDefinitionNames
 *   editor/replace_in_file             → editedExistingFile
 *   write_to_file                      → newFileCreated
 *   apply_patch                        → editedExistingFile
 *   delete_file                        → fileDeleted
 *   run_commands/execute_command       → (uses say="command", NOT say="tool")
 *   search_codebase/search_files       → searchFiles
 *   grep/sed/awk                       → (generic row: file + the script it runs)
 *   fetch_web_content/web_fetch        → webFetch
 *   web_search                         → webSearch
 *   skills/use_skill                   → useSkill
 *   ask_question/ask_followup_question → (not a visual tool — handled by askQuestion executor in SdkController)
 *   MCP tools (serverName__toolName)   → (handled before reaching sdkToolToClineSayTool — emitted as say="use_mcp_server")
 */
function sdkToolToClineSayTool(toolName: string, input?: unknown): ClineSayTool {
	// Parse input if it's a string (some SDK tools pass stringified JSON)
	const parsedInput = parseToolInput(input)

	switch (toolName) {
		case "read_files":
		case "read_file": {
			const fileRead = extractFileReads(parsedInput)[0]
			return {
				tool: "readFile",
				path: fileRead?.path ?? "",
				...readLineRangeFields(fileRead),
			}
		}

		case "list_files": {
			const dirPath = getStringField(parsedInput, "path") ?? ""
			const recursive = getBooleanField(parsedInput, "recursive") ?? false
			return {
				tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
				path: dirPath,
			}
		}

		case "list_code_definition_names": {
			const dirPath = getStringField(parsedInput, "path") ?? ""
			return {
				tool: "listCodeDefinitionNames",
				path: dirPath,
			}
		}

		case "editor":
		case "replace_in_file": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			const newText =
				getStringField(parsedInput, "new_text") ??
				getStringField(parsedInput, "new_str") ??
				getStringField(parsedInput, "content")
			const patch = getStringField(parsedInput, "patch") ?? getStringField(parsedInput, "diff")
			const oldText = getStringField(parsedInput, "old_text") ?? getStringField(parsedInput, "old_str")
			// `insert_line` inserts into an existing file (the SDK editor executor requires
			// the file to already exist), so it is an edit — not a new-file creation. Without
			// this the card mislabels a prepend/insert as "Cerebriline wants to create a new file".
			const insertLine = getNumberField(parsedInput, "insert_line")
			// So does a line range: you cannot replace line 92 of a file that does not
			// exist. This predicate knew about `old_text` and `insert_line` but not about
			// `start_line`, which arrived later — and a line-range replace is the shape a
			// model reaches for on minified or generated files, so most of the edit cards
			// in a session were reading "Cerebriline wants to create a new file".
			const startLine = getNumberField(parsedInput, "start_line")
			// Named here so the predicate below can read it: `end_line` says the
			// same thing `start_line` does -- you cannot end-line a file that does
			// not exist yet -- and was simply missed when that reasoning was
			// written down.
			const endLineField = getNumberField(parsedInput, "end_line")
			// And a call that names no file creates none.
			//
			// Reported as "every time v9-agentic is using 'Cerebriline wants to
			// create a new file', something goes wrong and the thinking or output
			// of the model ends up in the tool output and the tool fails". It was
			// never creating a file: across two pandorum sessions, every card of
			// that kind was an `editor` call whose `path` had been swallowed by a
			// mis-parsed payload, and the card then rendered 21,769 and 84,739
			// characters of `new_text` as the file being created. The refusal
			// underneath said so; the card above it said the opposite.
			const isEdit =
				toolName === "replace_in_file" ||
				!!oldText ||
				insertLine != null ||
				startLine != null ||
				endLineField != null ||
				!filePath

			// When the SDK provides both old and new text, build a search/replace
			// diff in the format DiffEditRow expects. ChatRow passes `content` to
			// DiffEditRow's `patch` prop, so the formatted diff must go into `content`.
			const diffContent = oldText && newText ? `------- SEARCH\n${oldText}\n=======\n${newText}\n+++++++ REPLACE` : newText

			// Named from the arguments rather than guessed from the payload: the
			// executor branches on exactly these fields, so this is the same
			// decision it makes, reported rather than re-derived.
			const endLine = endLineField
			const editMode =
				oldText && newText
					? "SEARCH/REPLACE"
					: insertLine != null
						? `INSERT at ${insertLine}`
						: startLine != null
							? endLine != null && endLine !== startLine
								? `LINES ${startLine}-${endLine}`
								: `LINE ${startLine}`
							: undefined

			return {
				tool: isEdit ? "editedExistingFile" : "newFileCreated",
				path: filePath,
				content: diffContent,
				diff: patch,
				...(editMode ? { editMode } : {}),
			}
		}

		case "write_to_file": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			const content = getStringField(parsedInput, "content") ?? getStringField(parsedInput, "new_text")
			return {
				tool: "newFileCreated",
				path: filePath,
				content,
			}
		}

		case "apply_patch": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			const patch = getApplyPatchString(input)
			return {
				tool: "editedExistingFile",
				path: filePath,
				content: patch,
				diff: patch,
				editMode: "PATCH",
			}
		}

		case "delete_file": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			return {
				tool: "fileDeleted",
				path: filePath,
			}
		}

		case "search_codebase":
		case "search_files": {
			// The SDK's SearchCodebaseUnionInputSchema accepts multiple formats:
			//   1. { queries: string[] }  — standard object (parsedInput handles this)
			//   2. { queries: string }    — queries as single string
			//   3. { query: … }           — the singular the tool's own results use
			//   4. string[]               — bare array (parseToolInput returns undefined for arrays)
			//   5. string                 — bare string (parseToolInput tries JSON.parse, returns undefined if not an object)
			// We must handle all five to avoid showing empty regex in the UI. The
			// singular was the visible half of the bug in #52: a model that sent
			// `{"query":"…"}` had the call rejected by the schema *and* rendered
			// here as `"" in codebase`, so the row named neither what was searched
			// nor why it failed.
			let regex = ""
			if (parsedInput) {
				// Cases 1-3: input was an object carrying the pattern under one of
				// the accepted names.
				const queries = getArrayField(parsedInput, "queries") ?? getArrayField(parsedInput, "query")
				regex =
					queries?.join(", ") ??
					getStringField(parsedInput, "queries") ??
					getStringField(parsedInput, "query") ??
					getStringField(parsedInput, "regex") ??
					""
			} else if (Array.isArray(input)) {
				// Case 3: bare array of query strings
				regex = input.map(String).join(", ")
			} else if (typeof input === "string") {
				// Case 4: bare string query
				regex = input
			}
			const path = getStringField(parsedInput, "path")
			const filePattern = getStringField(parsedInput, "file_pattern") ?? getStringField(parsedInput, "filePattern")
			return {
				tool: "searchFiles",
				regex,
				path,
				filePattern,
			}
		}

		case "fetch_web_content":
		case "web_fetch": {
			// fetch_web_content carries { requests: [{ url, prompt }] };
			// web_fetch carries { url, prompt } directly.
			let url = getStringField(parsedInput, "url") ?? ""
			if (!url && parsedInput) {
				const requests = parsedInput.requests
				if (Array.isArray(requests) && requests.length > 0) {
					const firstRequest = requests[0]
					if (typeof firstRequest === "object" && firstRequest !== null) {
						url = ((firstRequest as Record<string, unknown>).url as string) ?? ""
					}
				}
			}
			return {
				tool: "webFetch",
				path: url,
			}
		}

		case "web_search": {
			const query = getStringField(parsedInput, "query") ?? getStringField(parsedInput, "q") ?? ""
			return {
				tool: "webSearch",
				path: query,
			}
		}

		case "skills":
		case "use_skill": {
			// skills carries { skill: "name", args?: "..." };
			// use_skill carries { skill_name: "name" }.
			const skillName =
				getStringField(parsedInput, "skill_name") ??
				getStringField(parsedInput, "skill") ??
				getStringField(parsedInput, "name") ??
				""
			return {
				tool: "useSkill",
				path: skillName,
			}
		}

		case "plan": {
			// The plan tool names no file and runs no command, so the generic
			// lookup below found nothing to show and the row rendered as a bare
			// "Cerebriline used `plan`:" header with an empty body. What the user wants
			// from this row is the plan itself, and it is right here in the input.
			return {
				tool: toolName as ClineSayTool["tool"],
				path: "",
				content: describePlanCall(parsedInput),
			}
		}

		case "restore_file": {
			// The row's header used to be a constant: "put this file back as the
			// transaction found it". The tool has taken a `revision` since it
			// learned to hold file history, so that sentence named the base for
			// every restore -- a return to `#3` was reported as a return to the
			// file the transaction opened with. It also takes a `find`, which
			// searches the history and writes nothing at all, so the constant
			// asserted a write that never happened.
			//
			// Measured on pandorum session 1789378195473_62r4h: one call, with
			// `revision: "#3"`, rendered as the base.
			const searched = getStringField(parsedInput, "find")
			const target = describeRestoreTarget(getStringField(parsedInput, "revision"))
			const headline = searched
				? "Cerebriline searched this file's earlier versions:"
				: target.kind === "numbered"
					? `Cerebriline put this file back to revision #${target.index}:`
					: target.kind === "last"
						? "Cerebriline undid its last change to this file:"
						: target.kind === "unreadable"
							? `Cerebriline could not read which version to put back (\`${target.requested}\`):`
							: "Cerebriline put this file back as the transaction found it:"
			return {
				tool: toolName as ClineSayTool["tool"],
				path: getStringField(parsedInput, "path") ?? "",
				headline,
			}
		}

		case "agents_status": {
			// The lead looking at its delegated agents. What it looked at is the
			// row: its raw arguments said `{"round_id":"r3"}`.
			return {
				tool: toolName as ClineSayTool["tool"],
				headline: "Cerebriline checked on its agents:",
				path: describeAgentTargets(parsedInput) ?? "every round",
			}
		}

		case "await_agents": {
			// The lead waiting on purpose for rounds it had sent to the background.
			const ids = [
				...(Array.isArray(parsedInput?.round_ids)
					? (parsedInput.round_ids as unknown[]).filter((entry): entry is string => typeof entry === "string")
					: []),
				...(getStringField(parsedInput, "round_id") ? [getStringField(parsedInput, "round_id") as string] : []),
			]
				.map((entry) => entry.trim())
				.filter(Boolean)
			return {
				tool: toolName as ClineSayTool["tool"],
				headline: "Cerebriline waited for its agents:",
				path:
					ids.length === 0 ? "every running round" : ids.length === 1 ? `round ${ids[0]}` : `rounds ${ids.join(", ")}`,
			}
		}

		case "requeue_agent":
		case "restart_agent":
		case "resume_agent":
		case "retry_failed":
		case "message_agents":
		case "stop_agents": {
			// The lead acting on its agents: which agent, and what it did.
			const reason = getStringField(parsedInput, "reason")?.trim()
			const extra = Number(parsedInput?.extra_iterations)
			const named = Array.isArray(parsedInput?.agents)
				? (parsedInput.agents as unknown[]).filter((entry): entry is string => typeof entry === "string")
				: []
			const headline =
				toolName === "requeue_agent"
					? `Cerebriline requeued an agent${reason ? ` (${reason})` : ""}:`
					: toolName === "restart_agent"
						? "Cerebriline restarted an agent:"
						: toolName === "resume_agent"
							? Number.isFinite(extra) && extra > 0
								? `Cerebriline gave an agent ${extra} more iterations:`
								: "Cerebriline gave an agent more iterations:"
							: toolName === "retry_failed"
								? "Cerebriline ran its failed agents again:"
								: toolName === "stop_agents"
									? "Cerebriline stopped its agents:"
									: "Cerebriline sent its agents a message:"
			const path =
				toolName === "message_agents" || toolName === "stop_agents"
					? named.length > 0
						? named.join(", ")
						: "every running agent"
					: (describeAgentTargets(parsedInput) ?? "")
			const content =
				toolName === "restart_agent"
					? getStringField(parsedInput, "instructions")
					: toolName === "message_agents"
						? getStringField(parsedInput, "text")
						: undefined
			return {
				tool: toolName as ClineSayTool["tool"],
				headline,
				path,
				...(content ? { content } : {}),
			}
		}

		case "grep":
		case "sed":
		case "awk": {
			// These three name their files under `files` and carry the thing the
			// user actually wants to read -- the pattern, the script, the program
			// -- in a second field. The generic branch below shows one or the
			// other, never both, so a `sed` row either named no file or hid the
			// script that was about to rewrite it.
			const named = Array.isArray(parsedInput?.files)
				? (parsedInput.files as unknown[]).filter((entry): entry is string => typeof entry === "string")
				: []
			const program =
				getStringField(parsedInput, "script") ??
				getStringField(parsedInput, "pattern") ??
				getStringField(parsedInput, "program") ??
				""
			const inPlace = getBooleanField(parsedInput, "in_place") === true
			return {
				tool: toolName as ClineSayTool["tool"],
				path: named.length > 1 ? `${named[0]} (+${named.length - 1} more)` : (named[0] ?? ""),
				content: [inPlace ? `${toolName} -i` : toolName, program].filter(Boolean).join(" "),
			}
		}

		default: {
			// MCP tools and unknown tools — pass through with the raw tool name.
			// `ChatRow` renders these generically rather than swallowing them, so
			// whatever is found here is what the user sees.
			//
			// `paths` as well as `path`: the atomic protocol's `check_file` takes
			// an array, so the singular lookup found nothing and the row named no
			// file. Measured on pandorum session 1789122866533_br1d0, where six
			// of the run's `check_file` calls were on one file.
			// `files` as well as `paths`: `grep`, `sed` and `awk` take an array
			// under that name, so the lookup below found nothing and the row
			// named no file at all.
			const pathsField = parsedInput?.paths ?? parsedInput?.files
			const firstPath = Array.isArray(pathsField)
				? pathsField.filter((entry): entry is string => typeof entry === "string")
				: []
			const filePath =
				getStringField(parsedInput, "path") ??
				getStringField(parsedInput, "url") ??
				getStringField(parsedInput, "command") ??
				(firstPath.length > 0
					? firstPath.length === 1
						? firstPath[0]
						: `${firstPath[0]} (+${firstPath.length - 1} more)`
					: "") ??
				""
			return {
				tool: toolName as ClineSayTool["tool"],
				path: filePath,
				// A tool that names neither a file nor a command still did
				// something, and a header over an empty body says less than the
				// name alone did. Fall back to the arguments it was called with.
				...(filePath ? {} : { content: describeToolArguments(parsedInput) }),
			}
		}
	}
}

/**
 * The plan a `plan` call states or amends, as the chat row should show it.
 *
 * The tool takes three shapes — state the list, mark an item landed, mark one
 * failed — and each of them is one line or a few. Rendering the raw arguments
 * would work but reads as JSON; this reads as a plan, which is what the row is
 * for. The numbering is the tool's, so it is deliberately not reproduced here
 * for `changes`: the list arrives unnumbered and the tool assigns the ids.
 */
function describePlanCall(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) {
		return undefined
	}
	const changes = Array.isArray(input.changes) ? input.changes : undefined
	if (changes && changes.length > 0) {
		return changes
			.map((entry, index) => {
				const item = typeof entry === "object" && entry ? (entry as Record<string, unknown>) : {}
				const lines = [`${index + 1}. ${getStringField(item, "what") ?? "(no change stated)"}`]
				const where = getStringField(item, "where")
				const why = getStringField(item, "why")
				if (where) {
					lines.push(`   where: ${where}`)
				}
				if (why) {
					lines.push(`   why:   ${why}`)
				}
				return lines.join("\n")
			})
			.join("\n")
	}
	const note = getStringField(input, "note")
	const suffix = note ? ` — ${note}` : ""
	if (typeof input.done === "number") {
		return `Marked #${input.done} as landed${suffix}`
	}
	if (typeof input.failed === "number") {
		return `Marked #${input.failed} as failed${suffix}`
	}
	return describeToolArguments(input)
}

/**
 * A tool's arguments, for a row that has nothing better to show.
 *
 * Long values are cut: this is a row in a chat, not a transcript of the call,
 * and a tool that was handed a whole file should not push the next message off
 * the screen.
 */
/** The agents or round one of the lead's agent tools names, in a line. */
function describeAgentTargets(input: Record<string, unknown> | undefined): string | undefined {
	const agents = [
		...(typeof input?.agent_id === "string" ? [input.agent_id] : []),
		...(Array.isArray(input?.agent_ids)
			? (input.agent_ids as unknown[]).filter((entry): entry is string => typeof entry === "string")
			: []),
	]
		.map((entry) => entry.trim())
		.filter(Boolean)
	if (agents.length > 0) {
		return agents.length > 6 ? `${agents.slice(0, 6).join(", ")} (+${agents.length - 6} more)` : agents.join(", ")
	}
	const round = getStringField(input, "round_id")?.trim()
	return round ? `round ${round}` : undefined
}

function describeToolArguments(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) {
		return undefined
	}
	const lines = Object.entries(input).map(([key, value]) => {
		const rendered = typeof value === "string" ? value : JSON.stringify(value)
		if (rendered === undefined) {
			return `${key}: (not shown)`
		}
		return `${key}: ${rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered}`
	})
	return lines.length > 0 ? lines.join("\n") : undefined
}

/**
 * Parse tool input into a record if it's a string or object.
 */
function parseToolInput(input: unknown): Record<string, unknown> | undefined {
	if (!input) return undefined
	if (typeof input === "object" && !Array.isArray(input)) {
		return input as Record<string, unknown>
	}
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input)
			if (typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed
			}
		} catch {
			// Not JSON — return undefined
		}
	}
	return undefined
}

/**
 * Whether a tool name is the agent's completion tool — the one that declares the task done and
 * drives the green completion box plus the `completed` turn phase. Two names are accepted:
 * the legacy VSCode extra tool `attempt_completion` (no longer registered for new sessions,
 * but still present in persisted transcripts) and the SDK's built-in `submit_and_exit`
 * (DefaultToolNames.SUBMIT_AND_EXIT, lifecycle.completesRun=true).
 */
function isCompletionTool(toolName: string): boolean {
	return toolName === "submit_and_exit" || toolName === "attempt_completion"
}

/**
 * Extract the completion summary text from a completion-tool input. `attempt_completion` carries
 * it in `result`; `submit_and_exit` carries it in `summary`. Either renders the same completion UI.
 */
function getCompletionResultText(input: unknown): string {
	const parsed = parseToolInput(input)
	return getStringField(parsed, "summary") ?? getStringField(parsed, "result") ?? ""
}

/** A single file read request parsed from a read_files/read_file input */
interface FileReadRequest {
	path: string
	startLine?: number
	endLine?: number
}

/** Extract file read requests (path + optional one-based inclusive line range) from a read_files/read_file input */
function extractFileReads(input: Record<string, unknown> | undefined): FileReadRequest[] {
	if (!input) return []
	const files = input.files
	if (Array.isArray(files) && files.length > 0) {
		const reads = files
			.map((f): FileReadRequest => {
				if (typeof f === "string") return { path: f }
				if (typeof f === "object" && f !== null) {
					const entry = f as Record<string, unknown>
					return {
						path: (entry.path as string) ?? "",
						startLine: getNumberField(entry, "start_line"),
						endLine: getNumberField(entry, "end_line"),
					}
				}
				return { path: "" }
			})
			.filter((read) => read.path)
		if (reads.length > 0) {
			return reads
		}
	}
	const singlePath =
		(input.path as string) ?? (input.file_path as string) ?? (input.filePath as string) ?? (input.filename as string) ?? ""
	return singlePath
		? [{ path: singlePath, startLine: getNumberField(input, "start_line"), endLine: getNumberField(input, "end_line") }]
		: []
}

/**
 * Map a read request's line range onto ClineSayTool fields. An omitted start_line with an
 * explicit end_line means the read began at line 1; an omitted end_line stays undefined
 * (open-ended read — the UI renders it as "start+").
 */
function readLineRangeFields(read: FileReadRequest | undefined): Pick<ClineSayTool, "readLineStart" | "readLineEnd"> {
	if (!read || (read.startLine == null && read.endLine == null)) {
		return {}
	}
	return { readLineStart: read.startLine ?? 1, readLineEnd: read.endLine }
}

/** Get a string field from a parsed input object */
function getStringField(input: Record<string, unknown> | undefined, field: string): string | undefined {
	if (!input) return undefined
	const value = input[field]
	if (typeof value === "string") return value
	return undefined
}

/** Get a finite number field from a parsed input object (null/non-number → undefined) */
function getNumberField(input: Record<string, unknown> | undefined, field: string): number | undefined {
	if (!input) return undefined
	const value = input[field]
	if (typeof value === "number" && Number.isFinite(value)) return value
	return undefined
}

function getApplyPatchString(input: unknown): string | undefined {
	const parsed = parseToolInput(input)
	const fromFields = getStringField(parsed, "patch") ?? getStringField(parsed, "diff") ?? getStringField(parsed, "input")
	if (fromFields !== undefined) {
		return fromFields
	}
	return typeof input === "string" ? input : undefined
}

/**
 * Split a multi-file apply_patch string into one ClineSayTool per file so each
 * "Cerebriline wants to edit this file" row renders only that file's diff (cline#9904).
 *
 * Returns [] for single-file (or unparseable) patches so callers keep the existing
 * single-message behavior — only genuinely multi-file patches are split.
 */
function splitApplyPatchByFile(patch: string): ClineSayTool[] {
	const lines = patch.split("\n")
	const blocks: { tool: ClineSayTool["tool"]; path: string; lines: string[] }[] = []
	let current: { tool: ClineSayTool["tool"]; path: string; lines: string[] } | undefined

	for (const line of lines) {
		if (line === PATCH_MARKERS.END) {
			break
		}
		const marker = [PATCH_MARKERS.ADD, PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE].find((m) => line.startsWith(m))
		if (marker) {
			if (current) {
				blocks.push(current)
			}
			const tool: ClineSayTool["tool"] =
				marker === PATCH_MARKERS.ADD
					? "newFileCreated"
					: marker === PATCH_MARKERS.DELETE
						? "fileDeleted"
						: "editedExistingFile"
			current = { tool, path: line.substring(marker.length).trim(), lines: [line] }
		} else if (current) {
			current.lines.push(line)
		}
	}
	if (current) {
		blocks.push(current)
	}

	// Only split genuine multi-file patches. Bail out (→ single whole-patch
	// message) if fewer than two files, or if any block has an empty path — a
	// pathless row can't route to the per-file diff view (cline#9904).
	if (blocks.length < 2 || blocks.some((block) => block.path === "")) {
		return []
	}

	return blocks.map((block) => {
		if (block.tool === "fileDeleted") {
			return { tool: block.tool, path: block.path }
		}
		const subPatch = [PATCH_MARKERS.BEGIN, ...block.lines, PATCH_MARKERS.END].join("\n")
		return { tool: block.tool, path: block.path, content: subPatch, diff: subPatch }
	})
}

/** Get an array field from a parsed input object */
function getArrayField(input: Record<string, unknown> | undefined, field: string): string[] | undefined {
	if (!input) return undefined
	const value = input[field]
	if (Array.isArray(value)) return value.map(String)
	return undefined
}

function formatStructuredCommand(command: unknown): string {
	if (typeof command === "string") return command
	if (command && typeof command === "object" && !Array.isArray(command)) {
		const record = command as Record<string, unknown>
		if (typeof record.command === "string") {
			const args = Array.isArray(record.args) ? record.args.map(String) : []
			return args.length > 0 ? `${record.command} ${args.join(" ")}` : record.command
		}
	}
	return String(command)
}

function getCommandArrayField(input: Record<string, unknown> | undefined, field: string): string[] | undefined {
	if (!input) return undefined
	const value = input[field]
	if (Array.isArray(value)) return value.map(formatStructuredCommand)
	return undefined
}

/** Get a boolean field from a parsed input object */
function getBooleanField(input: Record<string, unknown> | undefined, field: string): boolean | undefined {
	if (!input) return undefined
	const value = input[field]
	if (typeof value === "boolean") return value
	return undefined
}

/**
 * Extract raw text output from an SDK tool's output.
 *
 * The SDK's run_commands tool returns `ToolOperationResult[]` where each
 * result has `{ query, result, success, error? }`. The `result` field
 * contains the raw terminal output as a string. If the output is already
 * a string, it is returned as-is. If it's an array of ToolOperationResult
 * objects, extract and join the text from each result.
 */
export function extractToolOutputText(output: unknown): string {
	if (output == null) return ""
	if (typeof output === "string") return output

	// Handle ToolOperationResult[] from SDK tools (run_commands, search_codebase, etc.)
	if (Array.isArray(output)) {
		const parts: string[] = []
		for (const item of output) {
			if (typeof item === "string") {
				parts.push(item)
			} else if (typeof item === "object" && item !== null) {
				const record = item as Record<string, unknown>
				// ToolOperationResult has { query, result, success, error? }
				if ("result" in record && typeof record.result === "string" && record.result) {
					parts.push(record.result)
				} else if ("error" in record && typeof record.error === "string" && record.error) {
					parts.push(record.error)
				} else if (record.type === "text" && typeof record.text === "string" && record.text) {
					// Content-block output, as the browser tool returns alongside its
					// screenshot. Without this the whole array — base64 image and all —
					// went through JSON.stringify below and became the row's text.
					parts.push(record.text)
				}
			}
		}
		if (parts.length > 0) {
			return parts.join("\n")
		}
	}

	// Fallback for unknown structured output
	return JSON.stringify(output)
}

/**
 * Pull image content blocks out of a tool result as data URLs.
 *
 * Tools hand images back as `{ type: "image", data, mediaType }` with raw base64,
 * while everything on the webview side — attachments, thumbnails, the image
 * opener — speaks data URLs. Converting here means the rest of the UI needs no
 * special case for an image that came from a tool rather than from the user.
 */
export function extractToolOutputImages(output: unknown): string[] {
	if (!Array.isArray(output)) {
		return []
	}
	const images: string[] = []
	for (const item of output) {
		if (typeof item !== "object" || item === null) {
			continue
		}
		const record = item as Record<string, unknown>
		if (record.type !== "image" || typeof record.data !== "string" || record.data === "") {
			continue
		}
		const mediaType = typeof record.mediaType === "string" && record.mediaType ? record.mediaType : "image/png"
		images.push(record.data.startsWith("data:") ? record.data : `data:${mediaType};base64,${record.data}`)
	}
	return images
}

// ---------------------------------------------------------------------------
// MCP tool detection
// ---------------------------------------------------------------------------

/**
 * MCP tools created by `createMcpTools()` use `serverName__toolName` format
 * (double underscore separator). This function detects MCP tools and parses
 * the server name and tool name.
 *
 * Returns undefined if the tool name doesn't match the MCP naming convention.
 */
function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | undefined {
	const separatorIndex = toolName.indexOf("__")
	if (separatorIndex <= 0) return undefined
	const serverName = toolName.substring(0, separatorIndex)
	const mcpToolName = toolName.substring(separatorIndex + 2)
	if (!mcpToolName) return undefined
	return { serverName, toolName: mcpToolName }
}

/**
 * Build a ClineAskUseMcpServer JSON payload for MCP tool calls.
 * This is what the webview's ChatRow expects when rendering MCP tool calls
 * (message.ask === "use_mcp_server" or message.say === "use_mcp_server").
 */
function buildMcpToolPayload(mcpInfo: { serverName: string; toolName: string }, input?: unknown): string {
	const parsedInput = parseToolInput(input)
	// Format arguments as a JSON string (matching classic ClineAskUseMcpServer.arguments)
	let argumentsStr: string | undefined
	if (parsedInput && Object.keys(parsedInput).length > 0) {
		argumentsStr = JSON.stringify(parsedInput, null, 2)
	} else if (typeof input === "string" && input.trim()) {
		argumentsStr = input
	}

	return JSON.stringify({
		type: "use_mcp_tool",
		serverName: mcpInfo.serverName,
		toolName: mcpInfo.toolName,
		arguments: argumentsStr,
	} satisfies ClineAskUseMcpServer)
}

function extractCommandText(input: unknown): string {
	if (Array.isArray(input)) {
		return input.map(formatStructuredCommand).join(" && ")
	}
	if (typeof input === "string") {
		return input
	}
	const parsedInput = parseToolInput(input)
	const commands = getCommandArrayField(parsedInput, "commands")
	return (
		commands?.join(" && ") ??
		(typeof parsedInput?.commands === "object" ? formatStructuredCommand(parsedInput.commands) : undefined) ??
		getStringField(parsedInput, "commands") ??
		(typeof parsedInput?.command === "string" ? formatStructuredCommand(parsedInput) : undefined) ??
		""
	)
}

/**
 * Build the Cerebriline approval ask message for an SDK tool approval request.
 * Keeps approval prompts aligned with the SDK event translator so the webview
 * can render specialized rows (MCP, commands, subagents) instead of a generic
 * tool approval with missing context.
 */
export function buildToolApprovalAskMessage(toolName: string, input: unknown, ts: number, cwd?: string): ClineMessage {
	const mcpInfo = parseMcpToolName(toolName)
	if (mcpInfo) {
		return {
			ts,
			type: "ask",
			ask: "use_mcp_server",
			text: buildMcpToolPayload(mcpInfo, input),
			partial: false,
		}
	}

	if (toolName === "run_commands" || toolName === "execute_command") {
		return {
			ts,
			type: "ask",
			ask: "command",
			text: extractCommandText(input),
			partial: false,
		}
	}

	if (isSubagentSpawnTool(toolName)) {
		const parsedInput = parseToolInput(input)
		const members = spawnBatchMembers(parsedInput)
		if (members) {
			return {
				ts,
				type: "ask",
				ask: "use_subagents",
				text: JSON.stringify({
					prompts: members.map((member) => member.task),
					names: members.map((member) => member.name ?? null),
				} satisfies ClineAskUseSubagents),
				partial: false,
			}
		}
		const taskPrompt = getStringField(parsedInput, "task") ?? getStringField(parsedInput, "prompt") ?? ""
		const agentName = getStringField(parsedInput, "name") ?? subagentNameFromToolName(toolName)
		return {
			ts,
			type: "ask",
			ask: "use_subagents",
			text: JSON.stringify({
				prompts: [taskPrompt],
				...(agentName ? { names: [agentName] } : {}),
			} satisfies ClineAskUseSubagents),
			partial: false,
		}
	}

	return {
		ts,
		type: "ask",
		ask: "tool",
		text: JSON.stringify(toDisplaySayTool(sdkToolToClineSayTool(toolName, input), cwd)),
		partial: false,
	}
}

// ---------------------------------------------------------------------------
// Agent event translation
// ---------------------------------------------------------------------------

/**
 * Translate an SDK AgentEvent into ClineMessage(s).
 */
/**
 * Extract a compaction divider payload from a status notice's metadata.
 * Mirrors the CLI's parseCompactionNoticeMetadata
 * (apps/cli/src/tui/utils/compaction-status.ts). Returns undefined for
 * non-compaction status notices.
 */
export function parseCompactionNoticeMetadata(metadata: Record<string, unknown> | undefined): ClineCompactionInfo | undefined {
	if (
		!metadata ||
		(metadata.phase !== "started" &&
			metadata.phase !== "progress" &&
			metadata.phase !== "completed" &&
			metadata.phase !== "skipped")
	) {
		return undefined
	}
	const kind = metadata.kind ?? metadata.reason
	// `overflow_recovery_compaction` was missing here, and the cost was visible:
	// the core emits it with the same phase/token metadata as the other two, but
	// an unrecognised kind falls through to the generic info row below, which
	// prints the notice's slug. A user recovering from an output-limit overflow
	// saw "overflow-recovery-compacting" and "overflow-recovery-compacted" as
	// bare text, with none of the counts those notices were carrying.
	if (kind !== "auto_compaction" && kind !== "manual_compaction" && kind !== "overflow_recovery_compaction") {
		return undefined
	}
	const mode = kind === "manual_compaction" ? "manual" : kind === "overflow_recovery_compaction" ? "overflow" : "auto"
	if (metadata.phase === "started") {
		return { status: "started", mode }
	}
	// Still "started" -- it is the same row, saying which of its calls it is on.
	// A progress notice with no counters would open a second divider, so the
	// pair is required rather than optional here.
	if (metadata.phase === "progress") {
		const step = asFiniteNumber(metadata.step)
		const stepTotal = asFiniteNumber(metadata.stepTotal)
		if (step === undefined || stepTotal === undefined) {
			return undefined
		}
		return {
			status: "started",
			mode,
			step,
			stepTotal,
			...(typeof metadata.stepLabel === "string" && metadata.stepLabel.trim() ? { stepLabel: metadata.stepLabel } : {}),
		}
	}
	if (metadata.phase === "skipped") {
		return { status: "skipped", mode }
	}
	return {
		status: "completed",
		mode,
		tokensBefore: asFiniteNumber(metadata.tokensBefore),
		tokensAfter: asFiniteNumber(metadata.tokensAfter),
		messagesBefore: asFiniteNumber(metadata.messagesBefore),
		messagesAfter: asFiniteNumber(metadata.messagesAfter),
		durationMs: asFiniteNumber(metadata.durationMs),
		...(typeof metadata.summary === "string" && metadata.summary.trim() ? { summary: metadata.summary } : {}),
		...(typeof metadata.thinkingSummary === "string" && metadata.thinkingSummary.trim()
			? { thinkingSummary: metadata.thinkingSummary }
			: {}),
		...(typeof metadata.toolLedger === "string" && metadata.toolLedger.trim() ? { toolLedger: metadata.toolLedger } : {}),
	}
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Status notices that are internal diagnostics with no user-facing copy — their
 * `message` is a slug, not prose. Only these are suppressed; an unlisted status
 * notice renders as an info row so it doesn't vanish silently. Keep in sync
 * with the `emitStatusNotice` call sites in
 * sdk/packages/core/src/extensions/context/compaction.ts (the compaction phase
 * slugs are handled above via parseCompactionNoticeMetadata instead).
 */
const INTERNAL_STATUS_NOTICES = new Set(["compaction-budget-adjusted", "context-breakdown"])

/**
 * Extract the fixed-price breakdown from a status notice's metadata.
 *
 * Emitted once per prepare-turn by
 * sdk/packages/core/src/extensions/context/compaction.ts. Every field is
 * required: a partial breakdown would colour the bar with slices that do not
 * add up to the overhead, which is worse than not colouring it at all.
 */
function parseContextBreakdownNoticeMetadata(metadata: unknown): ContextBreakdown | undefined {
	if (!metadata || typeof metadata !== "object") {
		return undefined
	}
	const record = metadata as Record<string, unknown>
	if (record.kind !== "context_breakdown") {
		return undefined
	}
	const read = (key: string): number | undefined => {
		const value = record[key]
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
	}
	const systemPromptTokens = read("systemPromptTokens")
	const builtinToolSchemaTokens = read("builtinToolSchemaTokens")
	const mcpToolSchemaTokens = read("mcpToolSchemaTokens")
	const toolCount = read("toolCount")
	const mcpToolCount = read("mcpToolCount")
	if (
		systemPromptTokens === undefined ||
		builtinToolSchemaTokens === undefined ||
		mcpToolSchemaTokens === undefined ||
		toolCount === undefined ||
		mcpToolCount === undefined
	) {
		return undefined
	}
	return { systemPromptTokens, builtinToolSchemaTokens, mcpToolSchemaTokens, toolCount, mcpToolCount }
}

/**
 * Extract an output-limit retry payload from a status notice's metadata.
 *
 * Emitted by the agent runtime when a turn runs past its output cap before
 * finishing and is discarded and retried. Without this the notice fell through
 * to the info row and rendered as the bare sentence the runtime happened to
 * write, with the attempt count, the cap and the compaction decision -- all
 * already in the metadata -- thrown away.
 */
export function parseOutputLimitRetryNoticeMetadata(
	metadata: Record<string, unknown> | undefined,
): ClineOutputLimitRetryInfo | undefined {
	if (!metadata) {
		return undefined
	}
	const kind = metadata.kind ?? metadata.reason
	if (kind !== "max_tokens_turn_recovery") {
		return undefined
	}
	return {
		attempt: asFiniteNumber(metadata.attempt),
		maxAttempts: asFiniteNumber(metadata.maxAttempts),
		capTokens: asFiniteNumber(metadata.capTokens),
		...(typeof metadata.outputCapSource === "string" && metadata.outputCapSource !== "unknown"
			? { capSource: metadata.outputCapSource }
			: {}),
		...(typeof metadata.compacting === "boolean" ? { compacting: metadata.compacting } : {}),
	}
}

/**
 * Extract a condensed-thinking payload from a status notice's metadata.
 *
 * Emitted by the capped-thinking condenser (see
 * sdk/packages/core/src/extensions/context/capped-thinking.ts), which runs
 * inside `prepareTurn` and has no other way to reach the transcript.
 */
export function parseThinkingCondensedNoticeMetadata(
	metadata: Record<string, unknown> | undefined,
): ClineThinkingCondensedInfo | undefined {
	if (!metadata || metadata.kind !== "capped_thinking") {
		return undefined
	}
	const note = typeof metadata.note === "string" ? metadata.note.trim() : ""
	if (note === "") {
		return undefined
	}
	return {
		note,
		thinkingChars: asFiniteNumber(metadata.thinkingChars),
		noteChars: asFiniteNumber(metadata.noteChars),
		thinkingTokens: asFiniteNumber(metadata.thinkingTokens),
		noteTokens: asFiniteNumber(metadata.noteTokens),
		budgetTokens: asFiniteNumber(metadata.budgetTokens),
	}
}

/**
 * Read a transaction's verdict off a status notice.
 *
 * Keyed on `kind` like the others rather than on the message text: the verdict
 * line is written for a human and will be reworded, and a row that stops
 * appearing because someone improved a sentence is worse than no row at all.
 */
export function parseAtomicTransactionNoticeMetadata(
	metadata: Record<string, unknown> | undefined,
	message: string,
): ClineTransactionInfo | undefined {
	if (!metadata || metadata.kind !== "atomic_transaction") {
		return undefined
	}
	const transaction = asFiniteNumber(metadata.transaction)
	if (transaction === undefined || typeof metadata.kept !== "boolean") {
		return undefined
	}
	const filesPutBack = asFiniteNumber(metadata.filesPutBack)
	const elapsedMs = asFiniteNumber(metadata.elapsedMs)
	return {
		transaction,
		kept: metadata.kept,
		...(metadata.carried === true ? { carried: true } : {}),
		message,
		...(typeof metadata.output === "string" && metadata.output.trim() !== "" ? { output: metadata.output } : {}),
		...(filesPutBack !== undefined ? { filesPutBack } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
	}
}

/**
 * Read one turn of an escalation off a status notice.
 *
 * Four kinds collapse into one payload, keyed on `kind` like the others rather
 * than on the message text -- these lines are written for a human and will be
 * reworded, and a row that stops appearing because someone improved a sentence
 * is worse than no row at all.
 */
export function parseEscalationNoticeMetadata(
	metadata: Record<string, unknown> | undefined,
	message: string,
): ClineEscalationInfo | undefined {
	if (!metadata) {
		return undefined
	}
	if (metadata.kind === "escalation_started") {
		const index = asFiniteNumber(metadata.index)
		const of = asFiniteNumber(metadata.of)
		return {
			phase: "started",
			// The brief, not the notice line: the notice repeats it after a
			// heading, and the row renders the brief itself.
			text: typeof metadata.brief === "string" ? metadata.brief : message,
			...(index !== undefined ? { index } : {}),
			...(of !== undefined ? { of } : {}),
		}
	}
	if (metadata.kind === "expert_thinking" || metadata.kind === "expert_message") {
		const index = asFiniteNumber(metadata.index)
		const of = asFiniteNumber(metadata.of)
		return {
			phase: metadata.kind === "expert_thinking" ? "expert_thinking" : "expert_message",
			text: message,
			...(index !== undefined ? { index } : {}),
			...(of !== undefined ? { of } : {}),
		}
	}
	if (metadata.kind === "expert_progress") {
		const index = asFiniteNumber(metadata.index)
		const of = asFiniteNumber(metadata.of)
		const toolCalls = asFiniteNumber(metadata.toolCalls)
		return {
			phase: "working",
			text: message,
			...(index !== undefined ? { index } : {}),
			...(of !== undefined ? { of } : {}),
			...(toolCalls !== undefined ? { toolCalls } : {}),
			...(typeof metadata.lastTool === "string" ? { lastTool: metadata.lastTool } : {}),
			...(readEscalationUsage(metadata.usage) ?? {}),
		}
	}
	if (metadata.kind === "escalation_message") {
		return { phase: "message", text: message }
	}
	if (metadata.kind === "expert_reply") {
		const changed = Array.isArray(metadata.changed)
			? metadata.changed.filter((entry): entry is string => typeof entry === "string")
			: []
		return {
			phase: "reply",
			text: message,
			...(changed.length > 0 ? { changed } : {}),
			...(readEscalationUsage(metadata.usage) ?? {}),
		}
	}
	if (metadata.kind === "escalation_ended") {
		return {
			phase: "ended",
			text: message,
			...(typeof metadata.held === "boolean" ? { held: metadata.held } : {}),
		}
	}
	return undefined
}

/**
 * The expert's spend for one delivery.
 *
 * Absent rather than zeroed when the provider reported nothing: a rate built
 * from a zero is not a slow model, it is a model nobody timed, and the header
 * shows no rate at all in that case.
 */
function readEscalationUsage(value: unknown): { usage: NonNullable<ClineEscalationInfo["usage"]> } | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const record = value as Record<string, unknown>
	const tokensIn = asFiniteNumber(record.inputTokens)
	const tokensOut = asFiniteNumber(record.outputTokens)
	if (tokensIn === undefined && tokensOut === undefined) {
		return undefined
	}
	return {
		usage: {
			tokensIn: tokensIn ?? 0,
			tokensOut: tokensOut ?? 0,
			generateTokens: asFiniteNumber(record.generateTokens) ?? 0,
			generateMs: asFiniteNumber(record.generateMs) ?? 0,
			wallMs: asFiniteNumber(record.wallMs) ?? 0,
			requests: asFiniteNumber(record.requests) ?? 0,
		},
	}
}

/**
 * Read the task checklist off a tool call's input.
 *
 * The parameter is optional on every tool, so most calls carry nothing. What
 * arrives when something does is core's question, not this file's: the field is
 * declared there, widened there, and measured there. This used to answer it a
 * second time — "a non-string value is not a checklist" — and that reading
 * survived core widening its own, so the tracker counted boxes the panel never
 * drew. Measured on pandorum 4.100.124: two v9-agentic sessions sent 52
 * checklists, all 52 as arrays, and this returned `undefined` for every one.
 *
 * So it delegates. The only thing left here is unwrapping the input, which
 * reaches this file as the raw string the stream carried.
 */
export function readTaskProgressFromToolInput(input: unknown): string | undefined {
	return readTaskProgress(typeof input === "string" ? parseToolInput(input) : input)
}

/** Build the say:"compaction" divider message for a compaction status payload. */
export function buildCompactionMessage(info: ClineCompactionInfo, ts: number): ClineMessage {
	return {
		ts,
		type: "say",
		say: "compaction",
		text: JSON.stringify(info),
		partial: false,
	}
}

/**
 * Finalize a dangling "started" compaction divider when the turn ends without
 * the completed/skipped notice (mid-compaction abort or error).
 *
 * This covers auto compaction (driven by turn events). Manual compaction runs
 * outside a turn, so SdkCompactionCoordinator.runCompaction finalizes its own
 * dangling divider in its catch block — if the terminal-state rules change
 * here, change them there too.
 */
function finalizeDanglingCompaction(
	state: MessageTranslatorState,
	messages: ClineMessage[],
	status: "cancelled" | "failed",
): void {
	const ts = state.takeOpenCompactionTs()
	if (ts === undefined) {
		return
	}
	messages.push(buildCompactionMessage({ status, mode: "auto" }, ts))
}

/**
 * A finished batch of sub-agents, as one usage record per connection.
 *
 * Grouped rather than summed because a batch is not necessarily one model's
 * work: the agents may have been given a connection of their own, and a
 * configured agent can name a provider in its own file. Summing them produces
 * a single number that is right only when every agent happened to run on the
 * same endpoint, and silently wrong -- in the direction of under-reporting
 * paid usage -- when they did not.
 *
 * Agents whose output carried no model are grouped together under no provider,
 * which keeps their tokens in the totals rather than dropping them.
 */
/** What core registers a configured agent's tool as (`configured-agent-tool.ts`). */
const CONFIGURED_AGENT_TOOL_PREFIX = "subagent_"

/**
 * One configured agent's run, as a usage record.
 *
 * Reads the `SpawnAgentOutput` the tool returns. Returns nothing when the
 * output is not that shape or carries no tokens, so a tool that merely happens
 * to be named `subagent_*` contributes nothing rather than a row of zeroes.
 */
export function configuredAgentUsage(output: unknown): ClineSubagentUsageInfo | undefined {
	if (typeof output !== "object" || output === null) {
		return undefined
	}
	const usage = (output as Record<string, unknown>).usage as Record<string, unknown> | undefined
	if (!usage) {
		return undefined
	}
	const tokensIn = typeof usage.inputTokens === "number" ? usage.inputTokens : 0
	const tokensOut = typeof usage.outputTokens === "number" ? usage.outputTokens : 0
	if (!tokensIn && !tokensOut) {
		return undefined
	}
	const model = (output as Record<string, unknown>).model as Record<string, unknown> | undefined
	return {
		source: "subagents",
		tokensIn,
		tokensOut,
		cacheWrites: 0,
		cacheReads: 0,
		cost: typeof usage.totalCost === "number" ? usage.totalCost : 0,
		...(typeof model?.provider === "string" ? { providerId: model.provider } : {}),
		...(typeof model?.id === "string" ? { modelId: model.id } : {}),
	}
}

export function summarizeSubagentUsageByProvider(items: readonly SubagentStatusItem[]): ClineSubagentUsageInfo[] {
	const byConnection = new Map<string, ClineSubagentUsageInfo>()
	for (const item of items) {
		const key = `${item.providerId ?? ""}\u0000${item.modelId ?? ""}`
		const existing = byConnection.get(key)
		const usage = existing ?? {
			source: "subagents" as const,
			tokensIn: 0,
			tokensOut: 0,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0,
			agents: 0,
			...(item.providerId ? { providerId: item.providerId } : {}),
			...(item.modelId ? { modelId: item.modelId } : {}),
		}
		usage.tokensIn += item.inputTokens || 0
		usage.tokensOut += item.outputTokens || 0
		usage.cost += item.totalCost || 0
		usage.agents = (usage.agents ?? 0) + 1
		if (!existing) {
			byConnection.set(key, usage)
		}
	}
	return [...byConnection.values()]
}

function translateAgentEvent(event: AgentEvent, state: MessageTranslatorState): ClineMessage[] {
	const messages: ClineMessage[] = []

	switch (event.type) {
		case "content_start": {
			switch (event.contentType) {
				case "text": {
					// The SDK emits MULTIPLE content_start events for streaming text,
					// each carrying one delta. The webview updates the message in-place
					// with the whole text so far, so we accumulate here -- rendering the
					// delta alone would give a "flip book" where each update replaces the
					// previous content with just the new chunk.
					//
					// The accumulation is ours rather than the SDK's on purpose: an
					// `accumulated` field on every delta makes the stream quadratic in
					// the length of the block, which is fine for a few hundred tokens
					// and ruinous for a long one.
					const ts = state.getStreamingTextTs()
					messages.push({
						ts,
						type: "say",
						say: "text",
						text: state.appendStreamingText(event.text ?? ""),
						partial: true,
					})
					break
				}
				case "reasoning": {
					// SDK reasoning content_start events are deltas. The webview renders
					// reasoning from `text`, so keep `text` and `reasoning` populated with
					// the accumulated content for smooth in-place streaming.
					const ts = state.getStreamingReasoningTs()
					const reasoning = state.appendStreamingReasoning(event.reasoning ?? "")
					messages.push({
						ts,
						type: "say",
						say: "reasoning",
						text: reasoning,
						reasoning,
						partial: true,
					})
					break
				}
				case "tool": {
					const toolName = event.toolName ?? "unknown"
					const input = event.input

					// Tool activity after a text block means that text wasn't the
					// turn-final response — drop the retag candidate.
					state.clearTurnFinalText()

					if (state.isToolApprovalDenied(event.toolCallId)) {
						break
					}

					// Store tool context so content_end can use it
					// (content_end doesn't carry the input)
					state.setStreamingToolContext(toolName, input)
					const approvedToolMessageTs = state.consumeApprovedToolMessageTs(event.toolCallId)
					if (approvedToolMessageTs !== undefined) {
						state.setStreamingToolTs(approvedToolMessageTs)
					}

					// ask_question (and ask_followup_question) is NOT a visual tool row: the
					// SdkInteractionCoordinator services it and emits the proper ask:"followup"
					// message. Emitting a generic say:"tool" here would leave an orphan partial
					// row that never finalizes. Suppress it (the CLI does the same).
					if (toolName === "ask_question" || toolName === "ask_followup_question") {
						break
					}

					// The completion tool (attempt_completion / submit_and_exit) is handled specially:
					// it drives the green completion box. We emit say:"completion_result"
					// here (partial) and finalize it at content_end. Recording attemptCompletionSeen
					// makes the turn end in the "completed" phase ("Start New Task") rather than
					// "awaiting_followup".
					if (isCompletionTool(toolName)) {
						state.setAttemptCompletionSeen()
						const resultText = getCompletionResultText(input)
						messages.push({
							ts: state.getStreamingToolTs(),
							type: "say",
							say: "completion_result",
							text: resultText,
							partial: true,
						})
						break
					}

					// command tools use say="command" (not say="tool")
					// because the webview renders commands differently
					if (toolName === "run_commands" || toolName === "execute_command") {
						const commandText = extractCommandText(input)
						// ChatRow treats a command row as "executing" while the COMMAND_OUTPUT_STRING
						// marker is present in the text (and the row isn't yet completed). Include the
						// marker on the running row so it reflects the executing state. content_end
						// rebuilds the full text (command + marker + output) and sets commandCompleted.
						messages.push({
							ts: state.getStreamingToolTs(),
							type: "say",
							say: "command",
							text: `${commandText}\n${COMMAND_OUTPUT_STRING}`,
							partial: true,
						})
						break
					}
					// spawn_agent → rich subagent UI (SubagentStatusRow)
					// Emit say:"use_subagents" with prompts list, then say:"subagent"
					// with running status. Multiple parallel spawn_agent calls in the
					// same iteration are aggregated into a single status message.
					if (isSubagentSpawnTool(toolName)) {
						const parsedInput = parseToolInput(input)
						// `spawn_agent` calls it `task`; a configured agent's tool
						// takes `prompt`. Same field to a reader either way.
						const taskPrompt = getStringField(parsedInput, "task") ?? getStringField(parsedInput, "prompt") ?? ""
						const callId = event.toolCallId ?? `spawn-${state.nextTs()}`
						// A configured agent is named by the tool that runs it, and
						// that name is the whole point of the row: "js-syntactic"
						// says what it is, `subagent_js_syntactic` says how it was
						// called.
						const agentName = getStringField(parsedInput, "name") ?? subagentNameFromToolName(toolName)
						const members = spawnBatchMembers(parsedInput)
						if (members) {
							members.forEach((member, index) => {
								state.addSpawnAgent(spawnMemberKey(callId, index), member.task, member.name)
							})
						} else {
							state.addSpawnAgent(callId, taskPrompt, agentName)
						}
						if (approvedToolMessageTs !== undefined) {
							state.setSpawnAgentPromptsTs(approvedToolMessageTs)
						}

						// Emit the combined prompts list (replaces itself on each new spawn_agent)
						const spawnedSoFar = state.getSpawnAgentItems()
						const approvalPayload: ClineAskUseSubagents = {
							prompts: spawnedSoFar.map((e) => e.prompt),
							// Only when at least one was named -- an all-undefined
							// array in every transcript buys nothing.
							...(spawnedSoFar.some((e) => e.agentName)
								? { names: spawnedSoFar.map((e) => e.agentName ?? null) }
								: {}),
						}
						messages.push({
							ts: state.getSpawnAgentPromptsTs(),
							type: "say",
							say: "use_subagents" as ClineSay,
							text: JSON.stringify(approvalPayload),
							partial: true,
						})

						// Clear the generic streaming tool so it doesn't also emit say:"tool"
						state.clearStreamingTool()
						break
					}

					// MCP tools use serverName__toolName naming convention.
					// The webview renders MCP tool calls via say/ask="use_mcp_server"
					// with ClineAskUseMcpServer JSON, not generic say="tool".
					const mcpInfo = parseMcpToolName(toolName)
					if (mcpInfo) {
						const mcpPayload = buildMcpToolPayload(mcpInfo, input)
						messages.push({
							ts: state.getStreamingToolTs(),
							type: "say",
							say: "use_mcp_server" as ClineSay,
							text: mcpPayload,
							partial: true,
						})
						break
					}

					// All other tools → say="tool" with ClineSayTool JSON
					// apply_patch is intentionally NOT split per-file here: the streaming
					// (partial) row shows the whole patch, and the per-file split happens
					// only at content_end (see below), mirroring read_files. Splitting at
					// content_start would mint streaming ids that content_end cannot
					// reproduce for files ≥2, orphaning those partial rows (cline#9904).
					const sayTool = toDisplaySayTool(sdkToolToClineSayTool(toolName, input), state.currentCwd())
					messages.push({
						ts: state.getStreamingToolTs(),
						type: "say",
						say: "tool",
						text: JSON.stringify(sayTool),
						partial: true,
					})
					break
				}
			}
			break
		}

		case "content_update": {
			// spawn_agent progress updates → emit say:"subagent" with live stats.
			// The SDK's spawn_agent tool may emit content_update events with
			// sub-agent progress (iterations, tool calls, usage). We translate
			// these into the ClineSaySubagentStatus format for the rich UI.
			const updateToolName = event.toolName ?? state.getStreamingToolName()
			// A rerun of an agent whose call is gone, carried by the lead's
			// control call and tagged with the agent's row: that row, wherever
			// it is -- this iteration's or a kept one -- and never the control
			// call's own.
			const taggedRow = readRoundRow(event.update as Record<string, unknown> | undefined)
			// An agent of a call from an earlier iteration, still out or run
			// again: its kept row, at that row's place in the conversation.
			if (taggedRow || (isSubagentSpawnTool(updateToolName) && event.toolCallId)) {
				const updateData = event.update as Record<string, unknown> | undefined
				const member = typeof updateData?.member === "number" ? updateData.member : undefined
				const key =
					taggedRow ??
					(member !== undefined ? spawnMemberKey(event.toolCallId ?? "", member) : (event.toolCallId ?? ""))
				const current = taggedRow ? state.getSpawnAgent(key) : undefined
				if (current) {
					if (updateData) {
						applySpawnAgentUpdate(current, updateData)
					}
					messages.push(state.buildCurrentSubagentMessage())
					break
				}
				const parked = state.getSpawnAgent(key) ? undefined : state.getParkedSpawnAgent(key)
				if (parked) {
					// An ended row is followed again only by a rerun: anything
					// else arriving for it is a straggler of its last run.
					if (isSpawnAgentOut(parked.entry) || isRerunUpdate(updateData)) {
						if (updateData) {
							applySpawnAgentUpdate(parked.entry, updateData)
						}
						const row = state.buildParkedSubagentMessage(parked.groupTs)
						if (row) {
							messages.push(row)
						}
					}
					break
				}
				if (taggedRow) {
					break
				}
			}
			if (isSubagentSpawnTool(updateToolName) && state.hasSpawnAgents()) {
				const callId = event.toolCallId ?? ""
				const updateData = event.update as Record<string, unknown> | undefined
				// A batch member's update names its member; everything else is
				// the call's one agent.
				const member = typeof updateData?.member === "number" ? updateData.member : undefined
				const entry = callId
					? state.getSpawnAgent(member !== undefined ? spawnMemberKey(callId, member) : callId)
					: undefined
				if (entry) {
					if (updateData) {
						applySpawnAgentUpdate(entry, updateData)
					}
				}
				// Emit a running status update
				const status = state.buildSubagentStatus("running")
				messages.push({
					ts: state.getSpawnAgentStatusTs(),
					type: "say",
					say: "subagent" as ClineSay,
					text: JSON.stringify(status),
					partial: true,
				})
				break
			}

			// #53: an image the tool showed the user and not the model -- a
			// generated image when the model reads no images. Held for the row
			// the tool's end builds, so it sits under its own tool call.
			const displayUpdate = event.update as { displayImages?: unknown } | undefined
			if (event.toolCallId && Array.isArray(displayUpdate?.displayImages)) {
				state.addToolDisplayImages(event.toolCallId, extractToolOutputImages(displayUpdate.displayImages))
			}

			// For all other tools, content_update is otherwise ignored — the
			// content_start message with partial=true is sufficient until
			// content_end finalizes it.
			break
		}

		case "content_end": {
			switch (event.contentType) {
				case "text": {
					const ts = state.clearStreamingText()
					const finalText = event.text ?? ""
					messages.push({
						ts,
						type: "say",
						say: "text",
						text: finalText,
						partial: false,
					})
					state.noteIterationText(finalText)
					// Candidate for the turn-final response: if the turn ends cleanly with
					// this text as its last content, `done` retags it as a completion row.
					if (finalText.trim()) {
						state.recordTurnFinalText(ts, finalText)
					}
					break
				}
				case "reasoning": {
					const ts = state.clearStreamingReasoning()
					const reasoning = event.reasoning ?? ""
					state.noteIterationReasoning(reasoning)
					messages.push({
						ts,
						type: "say",
						say: "reasoning",
						text: reasoning,
						reasoning,
						partial: false,
					})
					break
				}
				case "media": {
					const media = event.media
					if (!media) {
						break
					}
					messages.push({
						ts: state.nextTs(),
						type: "say",
						say: "text",
						text: "",
						media: [media],
						partial: false,
					})
					break
				}
				case "tool": {
					const toolName = event.toolName ?? "unknown"

					// Counted before the denial branch below: a call the user
					// refused is still something the turn did, and still leaves a
					// row on screen, so it is not an empty turn.
					state.noteIterationToolCall()

					// A completed tool call after a text block means that text wasn't the
					// turn-final response — drop the retag candidate.
					state.clearTurnFinalText()

					if (state.checkDeniedToolApproval(event.toolCallId) || isKnownToolApprovalDenial(event.error)) {
						state.clearStreamingTool()
						break
					}

					// The checklist rides along on whatever tool the model was already
					// calling, so it has to be read before the branches below claim
					// that call. It used to sit in the tail branch, past four `break`s
					// — `ask_question`, the completion tools, `run_commands`, MCP — and
					// a checklist on any of those was dropped without a word. On
					// pandorum `run_commands` carried more of them than any other tool.
					//
					// Emitted as its own say:"task_progress" row rather than folded into
					// the tool row: the panel wants the newest checklist regardless of
					// which tool carried it, and `openFocusChainFile` looks for exactly
					// this message type. Reading is non-destructive — the stored input
					// stays put for the branch that owns the row.
					const checklist = readTaskProgressFromToolInput(state.getStreamingToolInput())
					if (checklist) {
						messages.push({
							ts: state.nextTs(),
							type: "say",
							say: "task_progress" as ClineSay,
							text: checklist,
							partial: false,
						})
					}

					// ask_question is serviced by the interaction coordinator (see content_start);
					// it produces no transcript row of its own, so its content_end is a no-op.
					if (toolName === "ask_question" || toolName === "ask_followup_question") {
						break
					}

					// spawn_agent → finalize the subagent entry and emit
					// say:"subagent" (completed/failed) + say:"subagent_usage".
					// When all spawn_agent calls in this iteration finish, the
					// final say:"subagent" has partial=false.
					if (isSubagentSpawnTool(toolName)) {
						const callId = event.toolCallId ?? ""
						const output = event.output as Record<string, unknown> | undefined
						// Returned at once, its agents working on (`wait: false`):
						// their rows stay open and follow them past this iteration.
						const backgroundRound =
							output?.background === true && typeof output.round === "string" ? output.round : undefined
						// A batch: each member's own report, on its own row. A
						// merged swarm returns one digest and no per-agent
						// reports, so its rows end with the call.
						const batchSize = callId ? state.countSpawnMembers(callId) : 0
						if (backgroundRound && !event.error) {
							const keys =
								batchSize > 0
									? Array.from({ length: batchSize }, (_, index) => spawnMemberKey(callId, index))
									: [callId]
							for (const key of keys) {
								const entry = state.getSpawnAgent(key)
								if (entry) {
									state.markSpawnAgentBackground(key)
									pushSubagentActivity(entry, `Running in the background as round ${backgroundRound}`)
								}
							}
						} else if (batchSize > 0) {
							const results = Array.isArray(output?.results) ? (output.results as unknown[]) : []
							// The batch result sized for the model: an index of every
							// agent (status and why), and not every report. Each row
							// already has its full report from its own `finished`
							// update, so the index only settles the status.
							const agentIndex = Array.isArray(output?.agents) ? (output.agents as unknown[]) : []
							for (let index = 0; index < batchSize; index += 1) {
								const memberEntry = state.getSpawnAgent(spawnMemberKey(callId, index))
								if (!memberEntry) {
									continue
								}
								const result = results[index] as Record<string, unknown> | undefined
								if (result) {
									applySpawnAgentOutput(memberEntry, result)
								}
								const indexed = readBatchIndexEntry(agentIndex[index])
								const failure =
									event.error ??
									(typeof result?.error === "string" ? result.error : undefined) ??
									(indexed && indexed.status !== "completed" && indexed.status !== "awaiting_lead"
										? (indexed.error ?? memberEntry.error ?? `Agent ${indexed.status}`)
										: undefined)
								if (failure) {
									memberEntry.status = "failed"
									memberEntry.error = failure
								} else {
									memberEntry.status = "completed"
								}
							}
						}
						const entry = callId && batchSize === 0 && !backgroundRound ? state.getSpawnAgent(callId) : undefined
						if (entry) {
							// Extract output stats from SpawnAgentOutput
							if (output) {
								applySpawnAgentOutput(entry, output)
							}
							if (event.error) {
								entry.status = "failed"
								entry.error = event.error
							} else {
								entry.status = "completed"
							}
						}

						// Determine overall status — all done when every entry is completed/failed
						const items = state.getSpawnAgentItems()
						const allDone = items.every((e) => e.status === "completed" || e.status === "failed")
						const hasFailed = items.some((e) => e.status === "failed")
						const overallStatus: ClineSaySubagentStatus["status"] = allDone
							? hasFailed
								? "failed"
								: "completed"
							: "running"

						const status = state.buildSubagentStatus(overallStatus)
						messages.push({
							ts: state.getSpawnAgentStatusTs(),
							type: "say",
							say: "subagent" as ClineSay,
							text: JSON.stringify(status),
							partial: !allDone,
						})

						// When all done, emit subagent_usage for cost accounting --
						// one message per connection the batch ran on. Summing a
						// mixed batch into a single row would attribute billed
						// tokens to whichever provider happened to be named, or to
						// none at all.
						if (allDone) {
							for (const usagePayload of summarizeSubagentUsageByProvider(items)) {
								messages.push({
									ts: state.nextTs(),
									type: "say",
									say: "subagent_usage" as ClineSay,
									text: JSON.stringify(usagePayload),
									partial: false,
								})
							}
						}

						// Don't clear the generic streaming tool — spawn_agent
						// didn't use it (we cleared it at content_start)
						break
					}

					// A configured agent reaches the model as `subagent_<name>`,
					// not `spawn_agent`, so none of the above runs for it and it
					// renders as an ordinary tool call. That is fine for the
					// transcript and wrong for the totals: its tokens were never
					// counted anywhere the task header can see, and a configured
					// agent is the one most likely to be on another provider --
					// its file can name one. Emit the usage record here and let
					// the generic rendering below carry on.
					if (toolName.startsWith(CONFIGURED_AGENT_TOOL_PREFIX) && !event.error) {
						const usagePayload = configuredAgentUsage(event.output)
						if (usagePayload) {
							messages.push({
								ts: state.nextTs(),
								type: "say",
								say: "subagent_usage" as ClineSay,
								text: JSON.stringify(usagePayload),
								partial: false,
							})
						}
					}

					// Completion tool (attempt_completion / submit_and_exit) → finalize the green
					// completion box. The partial say:"completion_result" was emitted at
					// content_start; here we emit the non-partial version.
					if (isCompletionTool(toolName)) {
						const storedInput = state.getStreamingToolInput()
						const ts = state.clearStreamingTool()
						const resultText = getCompletionResultText(storedInput)
						// Finalize the say:"completion_result" (non-partial)
						// This renders the green completion box.
						messages.push({
							ts,
							type: "say",
							say: "completion_result",
							text: resultText,
							partial: false,
						})
						// Only the say:"completion_result" is emitted (the green box). No
						// ask:"completion_result" is produced — the webview's footer/buttons read
						// the authoritative TurnState (phase "completed") rather than the message
						// tail, so the completion UI is immune to trailing bookkeeping events such as
						// the usage say:"api_req_started" that arrives between content_end and done.
						break
					}

					// command tools finalize as say="command" with commandCompleted=true.
					// We keep the same timestamp to replace the streaming partial command row
					// in-place, so it doesn't disappear (command_output rows are filtered out
					// by combineCommandSequences in the chat pipeline).
					if (toolName === "run_commands" || toolName === "execute_command") {
						const storedInput = state.getStreamingToolInput()
						const commandText = extractCommandText(storedInput)
						const outputStr = event.error ? `Error: ${event.error}` : extractToolOutputText(event.output)
						const ts = state.clearStreamingTool()
						messages.push({
							ts,
							type: "say",
							say: "command",
							text: outputStr ? `${commandText}\n${COMMAND_OUTPUT_STRING}\n${outputStr}` : commandText,
							partial: false,
							commandCompleted: true,
						})
						break
					}

					// MCP tools → finalize as say="use_mcp_server" + say="mcp_server_response"
					// The classic extension emits:
					//   1. say/ask: "use_mcp_server" (tool call display with args)
					//   2. say: "mcp_server_request_started" (spinner)
					//   3. say: "mcp_server_response" (tool output)
					// In the SDK path, by content_end the tool has already executed,
					// so we emit the finalized tool call + response together.
					const mcpInfoEnd = parseMcpToolName(toolName)
					if (mcpInfoEnd) {
						const storedMcpInput = state.getStreamingToolInput()
						const mcpTs = state.clearStreamingTool()
						const mcpPayload = buildMcpToolPayload(mcpInfoEnd, storedMcpInput)

						// Finalize the use_mcp_server message (non-partial)
						messages.push({
							ts: mcpTs,
							type: "say",
							say: "use_mcp_server" as ClineSay,
							text: mcpPayload,
							partial: false,
						})

						// Emit the MCP server response with the tool output
						const mcpOutputStr = event.error ? `Error: ${event.error}` : extractToolOutputText(event.output)
						if (mcpOutputStr) {
							messages.push({
								ts: state.nextTs(),
								type: "say",
								say: "mcp_server_response" as ClineSay,
								text: mcpOutputStr,
								partial: false,
							})
						}
						break
					}

					// All other tools → finalize the say="tool" message
					// Use the stored input from content_start since content_end
					// doesn't carry the input (S6-24 fix)
					const storedInput = state.getStreamingToolInput()
					const ts = state.clearStreamingTool()

					// Special handling: read_files may read multiple files in one tool call.
					// Emit one readFile UI message per file so the tool group summary and
					// list reflect what was actually read.
					if (toolName === "read_files" || toolName === "read_file") {
						const parsedInput = parseToolInput(storedInput)
						const fileReads = extractFileReads(parsedInput)
						if (fileReads.length > 1) {
							const cwd = state.currentCwd()
							fileReads.forEach((fileRead, index) => {
								const sayTool: ClineSayTool = {
									tool: "readFile",
									path: fileRead.path,
									...readLineRangeFields(fileRead),
								}
								messages.push({
									ts: index === 0 ? ts : state.nextTs(),
									type: "say",
									say: "tool",
									text: JSON.stringify(toDisplaySayTool(sayTool, cwd)),
									partial: false,
								})
							})
							break
						}
					}

					// apply_patch may edit multiple files in one call. Emit one tool
					// message per file so each diff row shows only that file's changes
					// instead of the whole multi-file patch (cline#9904). Single-file
					// patches fall through to the single-message path below.
					if (toolName === "apply_patch" && !event.error) {
						const patch = getApplyPatchString(storedInput)
						const perFileTools = patch ? splitApplyPatchByFile(patch) : []
						if (perFileTools.length > 1) {
							const cwd = state.currentCwd()
							perFileTools.forEach((sayTool, index) => {
								messages.push({
									ts: index === 0 ? ts : state.nextTs(),
									type: "say",
									say: "tool",
									text: JSON.stringify(toDisplaySayTool(sayTool, cwd)),
									partial: false,
								})
							})
							break
						}
					}

					const sayTool = toDisplaySayTool(sdkToolToClineSayTool(toolName, storedInput), state.currentCwd())
					// If there's an error, include it in the tool message
					if (event.error) {
						messages.push({
							ts,
							type: "say",
							say: "tool",
							text: JSON.stringify(sayTool),
							partial: false,
						})
						// Also push an error message
						messages.push({
							ts: state.nextTs(),
							type: "say",
							say: "error",
							text: event.error,
							partial: false,
						})
					} else {
						messages.push({
							ts,
							type: "say",
							say: "tool",
							text: JSON.stringify(sayTool),
							partial: false,
						})
					}

					// The browser tool hands the model a screenshot, and until now the user
					// could not see it: the tool row is built from the call's *input*, and
					// the output — where the image lives — was dropped. So the model was
					// looking at the page and the person watching was not, which is the one
					// case where the user has something to say that the model cannot know.
					// Emitted as its own row so the image sits under the tool call it came
					// from, and carried in `images` (the field user attachments already use)
					// so referencing one back into a reply is just re-attaching it.
					// A tool may also have shown the user an image it kept from
					// the model (#53): a text-only model gets the text, the person
					// watching still sees what was made.
					const screenshots = [
						...extractToolOutputImages(event.output),
						...state.takeToolDisplayImages(event.toolCallId),
					]
					if (screenshots.length > 0) {
						messages.push({
							ts: state.nextTs(),
							type: "say",
							say: "browser_screenshot" as ClineSay,
							text: extractToolOutputText(event.output),
							images: screenshots,
							partial: false,
						})
					}
					break
				}
			}
			break
		}

		case "iteration_start": {
			// New iteration — reset streaming state for the new turn
			state.reset()

			// Emit an api_req_started message before each API request so the
			// webview shows its request spinner and cost display.
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					request: undefined, // Will be filled in by usage event
				} satisfies ClineApiReqInfo),
				partial: false,
			})
			break
		}

		case "iteration_end": {
			// A turn that put nothing in front of the user leaves no row at all,
			// which in the panel is indistinguishable from the model still
			// working. Measured 2026-09-12: a turn that emitted only a tool call
			// under `think: false` was read as lost model output, and the only
			// way to tell what had happened was `tokensOut` in the extension log.
			// A turn with neither prose nor a tool call is worse -- it is a real
			// failure mode (a model answering with nothing) and it is currently
			// invisible everywhere except the token count.
			//
			// Reasoning deliberately does not count as output. A turn that
			// reasoned at length and then said nothing and called nothing is the
			// case most worth seeing, so the row reports the reasoning it did
			// rather than being suppressed by it.
			{
				const output = state.iterationOutput()
				if (output.textChars === 0 && output.toolCalls === 0) {
					messages.push({
						ts: state.nextTs(),
						type: "say",
						say: "empty_turn",
						text: JSON.stringify({ reasoningChars: output.reasoningChars } satisfies ClineEmptyTurnInfo),
						partial: false,
					})
				}
			}
			break
		}

		case "notice": {
			// Status notices carry structured runtime progress. Compaction ones
			// become a live divider row that is updated in place from "started" to
			// its terminal state; the known-internal ones are diagnostics with no
			// user-facing copy, so drop them explicitly. Any other status notice
			// falls through to the info row below so a future one surfaces (as its
			// raw slug) instead of silently vanishing.
			if (event.noticeType === "status") {
				const compaction = parseCompactionNoticeMetadata(event.metadata)
				if (compaction) {
					// A progress update is the same divider, not a new one: it
					// reuses the open ts and leaves it open, so the row is
					// rewritten in place all the way to its terminal state.
					const ts =
						compaction.status !== "started"
							? (state.takeOpenCompactionTs() ?? state.nextTs())
							: compaction.step !== undefined
								? (state.peekOpenCompactionTs() ?? state.beginCompaction())
								: state.beginCompaction()
					messages.push(buildCompactionMessage(compaction, ts))
					break
				}
				const breakdown = parseContextBreakdownNoticeMetadata(event.metadata)
				if (breakdown) {
					// Recorded, not rendered: it is a measurement of the request
					// about to be made, and it reaches the user as the colours of
					// the context bar rather than as a row in the transcript.
					state.noteContextBreakdown(breakdown)
					break
				}
				const transaction = parseAtomicTransactionNoticeMetadata(event.metadata, event.message ?? "")
				if (transaction) {
					messages.push({
						ts: state.nextTs(),
						type: "say",
						say: "transaction",
						text: JSON.stringify(transaction),
						partial: false,
					})
					break
				}
				const escalation = parseEscalationNoticeMetadata(event.metadata, event.message ?? "")
				if (escalation) {
					// The progress row is rewritten in place, and the delivery
					// that ends the turn takes the same row over -- which is
					// what keeps the expert's spend from being counted once
					// while it works and again when it answers.
					// The progress row is rewritten in place, and the delivery
					// that ends the turn takes the same row over -- which is
					// what keeps the expert's spend from being counted once
					// while it works and again when it answers. Everything else,
					// the expert's own thinking and messages included, is a row
					// of its own: they are a transcript, and a transcript that
					// overwrote itself would only ever show its last line.
					const ts =
						escalation.phase === "working"
							? state.expertProgressTs()
							: escalation.phase === "reply"
								? (state.takeOpenExpertProgressTs() ?? state.nextTs())
								: state.nextTs()
					messages.push({
						ts,
						type: "say",
						say: "escalation",
						text: JSON.stringify(escalation),
						partial: false,
					})
					break
				}
				const outputLimitRetry = parseOutputLimitRetryNoticeMetadata(event.metadata)
				if (outputLimitRetry) {
					messages.push({
						ts: state.nextTs(),
						type: "say",
						say: "output_limit_retry",
						text: JSON.stringify(outputLimitRetry),
						partial: false,
					})
					break
				}
				const condensed = parseThinkingCondensedNoticeMetadata(event.metadata)
				if (condensed) {
					messages.push({
						ts: state.nextTs(),
						type: "say",
						say: "thinking_condensed",
						text: JSON.stringify(condensed),
						partial: false,
					})
					break
				}
				if (INTERNAL_STATUS_NOTICES.has(event.message ?? "")) {
					break
				}
			}

			// Non-status agent notices (and unrecognized status notices) are informational
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "info",
				text: event.message ?? "",
				partial: false,
			})
			break
		}

		case "usage": {
			// Usage events carry token counts. The webview reads them from an
			// api_req_started message's ClineApiReqInfo, so emit a follow-up
			// api_req_started update carrying the usage data for cost display.
			const usageEvent = normalizeUsageEvent(event)
			const apiReqInfo: ClineApiReqInfo = {
				tokensIn: usageEvent.tokensIn,
				tokensOut: usageEvent.tokensOut,
				cacheWrites: usageEvent.cacheWrites,
				cacheReads: usageEvent.cacheReads,
				cost: usageEvent.totalCost,
				// Stamped per request, not read from the session at display
				// time: the model can change mid-task, and tokens already
				// spent belong to the model that spent them.
				...(state.activeProviderId() ? { providerId: state.activeProviderId() } : {}),
				...(state.activeModelId() ? { modelId: state.activeModelId() } : {}),
				...(usageEvent.reasoningTokens ? { reasoningTokens: usageEvent.reasoningTokens } : {}),
				...(usageEvent.timings ? { timings: usageEvent.timings } : {}),
				// Measured before the request this usage is for, so the bar can
				// say how much of what it is showing was spent before the first
				// message.
				...(state.contextBreakdown() ? { contextBreakdown: state.contextBreakdown() } : {}),
				// The window this request was granted, when the server said.
				...(state.contextWindowGrant() ? { contextWindowGrant: state.contextWindowGrant() } : {}),
			}
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "api_req_started",
				text: JSON.stringify(apiReqInfo),
				partial: false,
			})
			break
		}

		case "done": {
			// Agent turn is complete. Footer/buttons come from the authoritative TurnState the
			// session-event coordinator sets on turn end (completed when the completion tool was
			// used this turn, otherwise awaiting_followup) — never from the message tail.
			// A compaction divider still open here means the turn was aborted mid-compaction.
			finalizeDanglingCompaction(state, messages, "cancelled")

			// The terminal reason is the authority on the outcome, and only
			// "completed" means the run reached its end. Everything else — an
			// error, a mistake-limit stop, max iterations, an abort — is a run
			// that STOPPED, and the footer has to offer a way out of it.
			//
			// `error` was the only reason handled here, which worked only because
			// a mistake notice happened to set the same flag mid-run. Once those
			// notices stopped ending the turn (4.99.68, correctly — they were
			// putting Retry on screen over a task that was still working), nothing
			// carried the outcome to the end: a mistake-limit stop resolved to
			// "awaiting_followup", which shows no buttons at all. Measured:
			// `AgentRuntimeAbortError: mistake_limit_reached` at 22:18:15, and the
			// task sat there with no Retry and no Start New Task.
			if (event.reason === "completed") {
				// Whatever failed mid-turn was recovered from; the run finished.
				state.clearErrorSeen()
			} else {
				state.setErrorSeen()
			}

			// Inferred completion feedback: the SDK agent normally ends a turn with a plain
			// text response rather than a completion tool. When the turn ended cleanly and its
			// last content was text, retag that text row in place (same ts → upserted by the
			// message store / webview reducer) so the user gets the legacy-style "done" visual:
			// green box in act mode, yellow plan box in plan mode. Turns
			// that ended via the completion tool already rendered their green box at the tool's
			// content_end; aborted/errored turns keep their plain text.
			if (event.reason === "completed" && !state.wasAttemptCompletionSeen()) {
				const finalText = state.takeTurnFinalText()
				if (finalText) {
					messages.push({
						ts: finalText.ts,
						type: "say",
						say: state.currentUiMode() === "plan" ? "plan_completion_result" : "completion_result",
						text: finalText.text,
						partial: false,
					})
				}
			} else {
				state.clearTurnFinalText()
			}
			break
		}

		case "error": {
			if (state.isSuppressedToolApprovalDenial(event.error)) {
				break
			}

			// `recoverable: true` is an in-run NOTICE, not a failed turn. The
			// MistakeTracker emits one for every recorded mistake ("1 tool call(s)
			// failed: [task_progress] ..."), and extension setup failures surface the
			// same way — the run carries straight on afterwards. Treating those like a
			// terminal provider error put the footer into Retry / Start New Task and
			// marked the session not-running while the agent was still working, and
			// nothing on the continuing run ever cleared it. Only `run-failed` carries
			// `recoverable: false`.
			if (event.recoverable === true) {
				messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "error",
					text: event.error instanceof Error ? event.error.message : String(event.error ?? ""),
					partial: false,
				})
				break
			}

			finalizeDanglingCompaction(state, messages, "failed")
			// An errored turn didn't end on its text response — no completion retag.
			state.clearTurnFinalText()

			// Record the error outcome so turn end resolves to the "error" phase
			// (footer shows Retry / Start New Task) instead of awaiting_followup.
			state.setErrorSeen()

			// Serialize the error message for the webview's ErrorRow to parse.
			// The webview uses ClineError.parse() on the `api_req_failed` text to
			// detect special error types (insufficient credits, spend limit, auth,
			// quota exceeded) and render appropriate UI (e.g. "Add Credits" button).
			//
			// The error object from the SDK is a standard JS Error. Its `message`
			// may contain JSON from the API (e.g. Cline provider's 402 response with
			// `code: "insufficient_credits"`). We try to reshape it into the
			// ClineError-serialized format the webview expects so that ErrorRow
			// can render the correct UI (Buy Credits button, etc.).
			const errorPayload = reshapeErrorForWebview(
				event.error,
				state.activeProviderId(),
				state.activeModelId(),
				event.errorClass,
			)

			// Emit an api_req_started with streamingFailedMessage so the
			// RequestStartRow renders the error via ErrorRow. This replaces
			// the spinner on the last API request row.
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					streamingFailedMessage: errorPayload,
				} satisfies ClineApiReqInfo),
				partial: false,
			})

			// Emit ask:"api_req_failed" as the LAST message so the webview
			// shows error recovery UI (Retry button, Add Credits button,
			// Sign In button, etc.) instead of a stuck "Thinking..." spinner.
			messages.push({
				ts: state.nextTs(),
				type: "ask",
				ask: "api_req_failed",
				text: errorPayload,
				partial: false,
			})
			break
		}

		default: {
			// Log unhandled event types for debugging
			Logger.warn(`[MessageTranslator] Unhandled agent event type: ${(event as AgentEvent).type}`)
			break
		}
	}

	return messages
}

// ---------------------------------------------------------------------------
// Core session event translation
// ---------------------------------------------------------------------------

/**
 * Translate an SDK CoreSessionEvent into a TranslationResult.
 *
 * This is the primary entry point for event translation. It handles
 * both top-level session events (chunk, ended, status) and nested
 * agent events.
 */
export function translateSessionEvent(event: CoreSessionEvent, state: MessageTranslatorState): TranslationResult {
	const result: TranslationResult = {
		messages: [],
		sessionEnded: false,
		turnComplete: false,
	}

	switch (event.type) {
		case "chunk": {
			// Raw chunk events from the session stream.
			// IMPORTANT: We do NOT emit these as text messages. The SDK sends
			// raw model output (which may contain JSON, tool call fragments, etc.)
			// as chunk events. The structured agent_event system (content_start,
			// content_update, content_end) is the proper way to get displayable
			// content. Emitting raw chunks would show JSON like
			// {"type":"iteration_start",...} in the webview.
			//
			// The chunk events are useful for logging but should not be
			// displayed to the user.
			break
		}

		case "agent_event": {
			// Sub-agent events should NOT produce ClineMessages in the main chat.
			// The sub-agent's work is represented by the parent's spawn_agent tool
			// events (content_start/update/end), which we translate into the rich
			// SubagentStatusRow UI. Without this filter, every sub-agent tool call,
			// text output, iteration, and usage event floods the main chat.
			const agentEvent = event.payload.event
			// A teammate's events carry teamRole, not parentAgentId. Rendered, its
			// text and tool rows read as the lead's and its `done` ended the lead's
			// turn. Only its usage goes on, for the task's totals -- as the CLI
			// keeps it -- without a request row of its own in the lead's chat.
			if (event.payload.teamRole === "teammate") {
				if (agentEvent.type === "usage") {
					result.usage = normalizeUsageEvent(agentEvent)
				}
				break
			}
			const isToolLifecycleEvent =
				agentEvent.type === "content_start" || agentEvent.type === "content_update" || agentEvent.type === "content_end"
			const isSpawnAgentToolEvent =
				isToolLifecycleEvent && agentEvent.contentType === "tool" && isSubagentSpawnTool(agentEvent.toolName)

			// Newer SDK events carry parentAgentId on sub-agent events. Older/local
			// RuntimeEventAdapter output does not, so while spawn_agent calls are in
			// flight we also suppress every non-spawn_agent event. This preserves the
			// parent spawn_agent status updates while hiding sub-agent internals.
			if (agentEvent.parentAgentId || (state.hasRunningSpawnAgents() && !isSpawnAgentToolEvent)) {
				break
			}

			// Agent events contain structured content (text, reasoning, tools)
			const agentMessages = translateAgentEvent(agentEvent, state)
			result.messages.push(...agentMessages)

			// Check for done/error events
			if (agentEvent.type === "done") {
				result.turnComplete = true
			}
			// Recoverable errors don't end the turn — the run continues (see the
			// translator's "error" case), so they must not resolve the turn phase.
			if (
				agentEvent.type === "error" &&
				!agentEvent.recoverable &&
				!state.isSuppressedToolApprovalDenial(agentEvent.error)
			) {
				result.turnComplete = true
			}

			// Track tool success/error for consecutive mistake counting.
			// A content_end event with contentType "tool" signals a completed
			// tool call — if event.error is set, the tool failed.
			if (agentEvent.type === "content_end" && agentEvent.contentType === "tool") {
				if (
					agentEvent.error &&
					!isKnownToolApprovalDenial(agentEvent.error) &&
					!state.isToolApprovalDenied(agentEvent.toolCallId)
				) {
					result.toolError = true
				} else if (!agentEvent.error) {
					result.toolSuccess = true
				}
			}

			// Extract usage from usage events
			if (agentEvent.type === "usage") {
				result.usage = normalizeUsageEvent(agentEvent)
			}
			break
		}

		case "ended": {
			result.sessionEnded = true
			result.turnComplete = true
			state.reset()
			break
		}

		case "hook": {
			// Sub-agent hook events are internal progress and should not pollute the
			// main chat. Their aggregate progress is shown by SubagentStatusRow.
			if (event.payload.parentAgentId) {
				break
			}

			// Tool hook events — translate to hook_status messages
			const payload = event.payload
			const hookName = payload.hookEventName
			const toolName = payload.toolName

			if (hookName === "tool_call") {
				result.messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "hook_status" as ClineSay,
					text: toolName ? `Running ${toolName}...` : "Running tool...",
					partial: false,
				})
			} else if (hookName === "tool_result") {
				result.messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "hook_status" as ClineSay,
					text: toolName ? `${toolName} completed` : "Tool completed",
					partial: false,
				})
			}
			break
		}

		case "status": {
			// Status updates — informational
			Logger.log(`[MessageTranslator] Session status: ${event.payload.status}`)
			break
		}

		case "pending_prompt_submitted": {
			const { prompt, userImages, userFiles } = event.payload
			// Text the runtime queued for the model (a side turn's recap, a
			// round's report, a nudge about stuck agents) is not the user's:
			// it is shown as a note, never as a user bubble.
			if (event.payload.origin === "harness") {
				result.messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "info",
					text: `Note from Cerebriline to the model:\n\n${prompt.trim()}`,
					partial: false,
				})
				break
			}
			// Synthetic prompts (task resumption, plan -> act auto-continue) are
			// hidden from every other transcript surface, and this echo must
			// hide them too: a send that races a settling abort is auto-queued
			// by the runtime, so a bare Resume can arrive here carrying the
			// synthetic resumption prompt. Echoing it would leak model-facing
			// text as a user bubble and shift the visible-user-message ordinals
			// that edit/regenerate mapping relies on. Attachments the user
			// supplied alongside a synthetic prompt still render (matching
			// isSyntheticSdkUserMessage, which counts those as visible).
			// Display boundary: formatDisplayUserInput strips runtime-generated
			// notice elements (e.g. mode_notice) that normalizeUserInput must
			// preserve, since the latter also sanitizes model-bound prompts.
			const displayPrompt = isSyntheticUserPrompt(prompt) ? "" : formatDisplayUserInput(prompt)
			const hasPrompt = displayPrompt.trim().length > 0
			const hasImages = (userImages?.length ?? 0) > 0
			const hasFiles = (userFiles?.length ?? 0) > 0
			if (hasPrompt || hasImages || hasFiles) {
				result.messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "user_feedback",
					text: displayPrompt,
					images: userImages,
					files: userFiles,
					partial: false,
				})
			}
			break
		}

		case "team_progress": {
			// The teammates' row: each one's tool calls and compactions, over
			// its life and on its current task. Only when something changed --
			// this event fires for every token a teammate streams.
			const teammates = event.payload.teammates
			if (teammates && teammates.length > 0) {
				const row = state.buildTeammateStatusMessage(teammates)
				if (row) {
					result.messages.push(row)
				}
			}
			break
		}

		case "pending_prompts": {
			// These are handled by the team/subagent system, not translated
			// to ClineMessages at this layer
			break
		}

		case "session_snapshot": {
			// The host projects the snapshot itself; there is nothing in it to
			// draw. It was falling through to the warning below, 127 times per
			// pandorum run, which is how a warning stops being read.
			break
		}

		default: {
			Logger.warn(`[MessageTranslator] Unhandled session event type: ${(event as CoreSessionEvent).type}`)
			break
		}
	}

	return result
}

// ---------------------------------------------------------------------------
// Persisted SDK message history translation
// ---------------------------------------------------------------------------

type SdkContentBlock = Exclude<SdkMessage["content"], string>[number]
type SdkToolUseBlock = Extract<SdkContentBlock, { type: "tool_use" }>
type SdkMessageWithMetrics = SdkMessage & {
	/**
	 * Plan/act mode recovered from the persisted <user_input mode="..."> wrapper before display
	 * sanitization strips it (see sanitizeSdkUserMessagesForDisplay in sdk-task-history.ts).
	 * Only meaningful on user messages; governs the turn that follows.
	 */
	uiMode?: "plan" | "act" | "yolo"
}

function textContentBlocksToText(content: SdkMessage["content"]): string {
	if (typeof content === "string") {
		return content.trim()
	}

	const text: string[] = []
	for (const block of content) {
		if (block.type === "text" && block.text.trim()) {
			text.push(block.text.trim())
		} else if (block.type === "file" && block.content.trim()) {
			text.push(block.content.trim())
		}
	}
	return text.join("\n").trim()
}

function agentEventToMessages(event: AgentEvent, state: MessageTranslatorState): ClineMessage[] {
	return translateSessionEvent(
		{
			type: "agent_event",
			payload: {
				sessionId: "history",
				event,
			},
		},
		state,
	).messages
}

function appendPersistedMetricsMessage(
	clineMessages: ClineMessage[],
	message: SdkMessageWithMetrics,
	state: MessageTranslatorState,
): void {
	if (!message.metrics) {
		return
	}

	const usage = normalizeUsageEvent({
		inputTokens: message.metrics.inputTokens,
		outputTokens: message.metrics.outputTokens,
		cacheReadTokens: message.metrics.cacheReadTokens,
		cacheWriteTokens: message.metrics.cacheWriteTokens,
		cost: message.metrics.cost,
		reasoningTokens: message.metrics.reasoningTokenCount,
		timings: message.metrics.timings,
	})

	if (
		usage.tokensIn === 0 &&
		usage.tokensOut === 0 &&
		(usage.cacheWrites ?? 0) === 0 &&
		(usage.cacheReads ?? 0) === 0 &&
		(usage.totalCost ?? 0) === 0
	) {
		return
	}

	clineMessages.push({
		ts: state.nextTs(),
		type: "say",
		say: "api_req_started",
		text: JSON.stringify({
			tokensIn: usage.tokensIn,
			tokensOut: usage.tokensOut,
			cacheWrites: usage.cacheWrites,
			cacheReads: usage.cacheReads,
			cost: usage.totalCost,
			...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
			...(usage.timings ? { timings: usage.timings } : {}),
		} satisfies ClineApiReqInfo),
		partial: false,
	})
}

function finalizePersistedToolUse(
	toolUse: SdkToolUseBlock,
	state: MessageTranslatorState,
	output?: unknown,
	isError?: boolean,
): ClineMessage[] {
	// Reuse the same content_start → content_end path as live SDK events. The
	// start event seeds MessageTranslatorState with the tool input; the end event
	// produces the final non-partial ClineMessage shape the webview expects.
	agentEventToMessages(
		{
			type: "content_start",
			contentType: "tool",
			toolName: toolUse.name,
			toolCallId: toolUse.id,
			input: toolUse.input,
		} as AgentEvent,
		state,
	)

	return agentEventToMessages(
		{
			type: "content_end",
			contentType: "tool",
			toolName: toolUse.name,
			toolCallId: toolUse.id,
			output,
			error: isError ? extractToolOutputText(output) : undefined,
		} as AgentEvent,
		state,
	)
}

export interface SdkMessagesToClineMessagesOptions {
	/**
	 * Whether the transcript's LAST agent turn ended cleanly (per the session record's status).
	 * Only that final turn is ever retagged into the inferred completion row — persisted
	 * transcripts carry no per-turn outcome, so earlier turns always render as plain text —
	 * and the terminal text of a session that failed, was cancelled, or died mid-run must not
	 * be retagged either, or a reopened broken task would render its dangling response as a
	 * green/plan "done" box. Defaults to true.
	 */
	finalTurnCompleted?: boolean
	/**
	 * The task's working directory (as recorded on the session record), used to
	 * relativize the absolute filesystem paths in persisted tool inputs for
	 * display, matching the live streaming path.
	 */
	cwd?: string
	/**
	 * The session's rounds, as the core's round registry has them. The
	 * transcript holds what a spawn call returned -- "running in the
	 * background", "awaiting the lead" -- and these say how its agents are
	 * now: each round's rows are drawn from them.
	 */
	rounds?: ReadonlyArray<RoundRowSource>
	/**
	 * The spawn rows as drawn, for the live translator to follow: an agent the
	 * lead runs again after the task was reopened lands on its row.
	 */
	onSpawnRows?: (groups: ReturnType<MessageTranslatorState["exportParkedSpawnGroups"]>) => void
}

/**
 * Convert SDK-persisted LLM messages back into the ClineMessage format used by
 * the webview. Keep this in the live message translator so history rendering
 * and streaming rendering share the same SDK tool → Cerebriline UI mapping.
 */
export function sdkMessagesToClineMessages(
	messages: SdkMessageWithMetrics[],
	minter?: MessageIdMinter,
	options?: SdkMessagesToClineMessagesOptions,
): ClineMessage[] {
	const clineMessages: ClineMessage[] = []
	// Plan/act mode of the turn currently being replayed, recovered from each user message's
	// persisted <user_input mode="..."> wrapper (stamped as `uiMode` before sanitization).
	let currentMode: "plan" | "act" | "yolo" | undefined
	// Use the process-wide minter when provided so regenerated history ids are globally unique
	// and never overlap live-session ids. Falls back to a private minter for standalone tests.
	const state = new MessageTranslatorState(
		minter,
		undefined,
		() => currentMode,
		() => options?.cwd,
	)
	const pendingToolUses = new Map<string, SdkToolUseBlock>()

	const flushUnmatchedToolUses = () => {
		for (const toolUse of pendingToolUses.values()) {
			clineMessages.push(...finalizePersistedToolUse(toolUse, state))
		}
		pendingToolUses.clear()
	}

	// Add or update by ts — the synthesized turn-end `done` below retags an already-emitted
	// text row in place (same ts), mirroring the live path's upsert-by-ts message store.
	const upsertClineMessages = (updates: ClineMessage[]) => {
		for (const update of updates) {
			const existingIndex = clineMessages.findIndex((m) => m.ts === update.ts)
			if (existingIndex !== -1) {
				clineMessages[existingIndex] = update
			} else {
				clineMessages.push(update)
			}
		}
	}

	// Close out the transcript's FINAL agent turn by replaying the same `done` translation as
	// the live path, so a final turn that ended on a text response gets the inferred completion
	// retag (green box in act mode, yellow plan box in plan mode) when rehydrated from SDK
	// history. Only the final turn is eligible: persisted transcripts carry no per-turn
	// outcome, so an earlier turn that the user cancelled mid-response and then followed up on
	// is indistinguishable from one that ended cleanly — retagging it would present an
	// interrupted response as a deliberate turn end. The final turn's outcome IS known (the
	// caller gates it on the session record's status via `finalTurnCompleted`).
	const endFinalTurn = () => {
		upsertClineMessages(
			agentEventToMessages({ type: "done", reason: "completed", text: "", iterations: 0 } as AgentEvent, state),
		)
		state.clearTurnOutcome()
	}

	for (const { message, sourceIndex } of projectSessionMessagesForDisplay(messages)) {
		const sourceMessage = messages[sourceIndex]
		if (message.role === "assistant") {
			flushUnmatchedToolUses()
			// Each assistant message is an iteration, as live: its spawn calls
			// get a row of their own, and the last iteration's is kept.
			state.clearSpawnAgents()

			if (typeof message.content === "string") {
				const text = message.content.trim()
				if (text) {
					clineMessages.push(
						...agentEventToMessages({ type: "content_end", contentType: "text", text } as AgentEvent, state),
					)
				}
				appendPersistedMetricsMessage(clineMessages, message, state)
				continue
			}

			for (const [blockIndex, block] of message.content.entries()) {
				switch (block.type) {
					case "text":
						if (block.text.trim()) {
							clineMessages.push(
								...agentEventToMessages(
									{
										type: "content_end",
										contentType: "text",
										text: block.text.trim(),
									} as AgentEvent,
									state,
								),
							)
						}
						break
					case "thinking":
						if (block.thinking.trim()) {
							clineMessages.push(
								...agentEventToMessages(
									{
										type: "content_end",
										contentType: "reasoning",
										reasoning: block.thinking.trim(),
									} as AgentEvent,
									state,
								),
							)
						}
						break
					case "image":
						if (block.data && block.mediaType.startsWith("image/")) {
							clineMessages.push(
								...agentEventToMessages(
									{
										type: "content_end",
										contentType: "media",
										media: {
											id: `${message.id ?? `history-${sourceIndex}`}:media:${blockIndex}`,
											modality: "image",
											mediaType: block.mediaType,
											source: { type: "base64", data: block.data },
										},
									} as AgentEvent,
									state,
								),
							)
						}
						break
					case "media":
						clineMessages.push(
							...agentEventToMessages(
								{
									type: "content_end",
									contentType: "media",
									media: block.media,
								} as AgentEvent,
								state,
							),
						)
						break
					case "tool_use":
						// Tool activity after a text block means that text wasn't the
						// turn-final response (also covers dangling tool_use blocks whose
						// results never arrived — an aborted turn must not retag).
						state.clearTurnFinalText()
						pendingToolUses.set(block.id, block)
						break
				}
			}
			appendPersistedMetricsMessage(clineMessages, message, state)
			continue
		}

		// A turn discarded at the output cap is not a user turn either, and its
		// row lived only in an event. Rebuild it here or a reopened task says
		// nothing happened, which is how three thrown-away turns and a run that
		// died on the output limit left a transcript with no explanation in it.
		const outputLimitRetry = extractPersistedOutputLimitRetry(message)
		if (outputLimitRetry) {
			clineMessages.push({
				ts: state.nextTs(),
				type: "say",
				say: "output_limit_retry",
				text: JSON.stringify(outputLimitRetry),
				partial: false,
			})
			continue
		}

		// Runtime-injected hook context is not a user turn: reconstruct the hook
		// status rows shown live and leave turn/mode state untouched, so the
		// final turn's completion retag survives the injection.
		const hookChips = extractPersistedHookContextChips(message)
		if (hookChips.length > 0) {
			for (const chip of hookChips) {
				clineMessages.push({
					ts: state.nextTs(),
					type: "say",
					say: "hook_status",
					text: JSON.stringify(chip),
					partial: false,
				})
			}
			continue
		}

		if (typeof message.content === "string") {
			const text = message.content.trim()
			if (text) {
				// User text marks a turn boundary: drop the preceding turn's outcome
				// signals (its text is NOT retagged — see endFinalTurn) and pick up the mode
				// of the NEW turn from this message's wrapper. Synthetic runtime prompts
				// (task resumption, plan -> act auto-continue) still advance the turn/mode
				// state but never had a visible bubble live, so don't emit one here either.
				state.clearTurnOutcome()
				currentMode = sourceMessage.uiMode ?? currentMode
				if (!isSyntheticSdkUserMessage(message)) {
					clineMessages.push({
						ts: state.nextTs(),
						type: "say",
						say: clineMessages.length === 0 ? "task" : "user_feedback",
						text,
						partial: false,
					})
				}
			}
			continue
		}

		const userText = textContentBlocksToText(message.content)
		if (userText) {
			state.clearTurnOutcome()
			currentMode = sourceMessage.uiMode ?? currentMode
			if (!isSyntheticSdkUserMessage(message)) {
				clineMessages.push({
					ts: state.nextTs(),
					type: "say",
					say: clineMessages.length === 0 ? "task" : "user_feedback",
					text: userText,
					partial: false,
				})
			}
		}

		for (const block of message.content) {
			if (block.type !== "tool_result") {
				continue
			}

			const toolUse = pendingToolUses.get(block.tool_use_id)
			if (!toolUse) {
				continue
			}

			pendingToolUses.delete(block.tool_use_id)
			clineMessages.push(...finalizePersistedToolUse(toolUse, state, block.content, block.is_error))
		}
	}

	// The spawn rows, as the round registry says their agents are now -- and
	// handed on, so the live translator follows them if the lead runs an
	// agent of them again.
	state.clearSpawnAgents()
	if (options?.rounds?.length) {
		const touched = new Set<number>()
		for (const round of options.rounds) {
			if (!round.toolCallId) {
				continue
			}
			for (const agent of round.agents) {
				const key = round.rowed ? spawnMemberKey(round.toolCallId, agent.index) : round.toolCallId
				const ts = state.applyRoundToParkedRow(key, agent)
				if (ts !== undefined) {
					touched.add(ts)
				}
			}
		}
		for (const ts of touched) {
			const row = state.buildParkedSubagentMessage(ts)
			if (row) {
				upsertClineMessages([row])
			}
		}
	}
	options?.onSpawnRows?.(state.exportParkedSpawnGroups())

	// Close out the transcript's final agent turn so its terminal text (if the turn ended on
	// text) gets the inferred completion retag. Skipped when the session record says the last
	// run failed, was cancelled, or died mid-turn: its terminal text is a dangling partial
	// response, not a completion, and must stay a plain text row.
	if (options?.finalTurnCompleted !== false) {
		endFinalTurn()
	}

	// Always emit ask:"completion_result"
	// as the LAST message so it comes after the usage event's
	// say:"api_req_started". This is critical: the webview uses
	// the last raw message to determine UI state. If the usage
	// event is last, the webview shows "Thinking..." instead of
	// the completion UI
	clineMessages.push({
		ts: state.nextTs(),
		type: "ask",
		ask: "completion_result",
		text: "",
		partial: false,
	})

	flushUnmatchedToolUses()
	return clineMessages
}

// ---------------------------------------------------------------------------
// HistoryItem ↔ SessionRecord mapping
// ---------------------------------------------------------------------------

/**
 * Map a HistoryItem (classic format) to a partial SessionRecord-like object.
 * Used when loading tasks from legacy storage.
 */
export function historyItemToSessionFields(item: {
	id: string
	task: string
	ts: number
	tokensIn: number
	tokensOut: number
	totalCost: number
	modelId?: string
}): {
	sessionId: string
	prompt: string
	startedAt: string
	usage: { tokensIn: number; tokensOut: number; totalCost: number }
	modelId?: string
} {
	return {
		sessionId: item.id,
		prompt: item.task,
		startedAt: new Date(item.ts).toISOString(),
		usage: {
			tokensIn: item.tokensIn,
			tokensOut: item.tokensOut,
			totalCost: item.totalCost,
		},
		modelId: item.modelId,
	}
}

const MODEL_NOT_FOUND_GUIDANCE =
	"This model may be retired or unavailable on your account. Switch to a different model in API Configuration settings, then retry."

const VERTEX_GLOBAL_REGION_GUIDANCE =
	'This model does not support the Vertex AI global endpoint. Switch Google Cloud Region from "global" to a specific region (e.g. "us-east5") in API Configuration settings, or choose a different model, then retry.'

/**
 * Rewrite a model-not-found error into actionable guidance, or undefined if the
 * message is not one. The provider's HTTP status is stripped upstream, so this
 * matches on text rather than a status code.
 */
function describeModelNotFoundError(rawMessage: string): string | undefined {
	// Anthropic's 404 body collapses to a bare "model: <id>" label.
	const bareModelLabel = rawMessage.match(/^\s*model:\s*(\S+)\s*$/i)
	if (bareModelLabel) {
		return `Model "${bareModelLabel[1]}" was not found. ${MODEL_NOT_FOUND_GUIDANCE}`
	}

	// Keep the not-found signal in the same clause as "model" so errors that
	// merely mention one (plan gating, deprecated features) are left untouched.
	const modelNotFound = /\bmodel\b[^.,;:]*\b(not[ _]?found|does not exist|no such model|unknown model)\b/i
	if (modelNotFound.test(rawMessage)) {
		return `${rawMessage} ${MODEL_NOT_FOUND_GUIDANCE}`
	}

	return undefined
}

/**
 * Rewrite a Vertex "model not available on the global endpoint" rejection into
 * recovery guidance, or undefined for anything else. The picker intentionally
 * no longer filters the catalog by endpoint capability — endpoint support
 * changes faster than any host-maintained allowlist — so an unsupported pick
 * under `vertexRegion: "global"` surfaces here, loud and actionable, instead
 * of hiding models from the picker.
 *
 * Observed shapes: AnthropicVertex's bare `model not available in region:
 * global`, and Google's `Publisher Model `projects/.../locations/global/...`
 * was not found / no access` body. The HTTP status is stripped upstream, so
 * this matches on text.
 */
function describeVertexGlobalRegionError(rawMessage: string, providerId?: string): string | undefined {
	if (providerId !== "vertex") {
		return undefined
	}
	const rejectedFromGlobalRegion =
		/not (?:available|supported|found) in (?:region|location)\b[^.\n]*\bglobal\b/i.test(rawMessage) ||
		/\bregion:\s*global\b/i.test(rawMessage) ||
		(/\blocations\/global\b/.test(rawMessage) && /not found|does not have access|permission denied/i.test(rawMessage))
	if (!rejectedFromGlobalRegion) {
		return undefined
	}
	return `${rawMessage} ${VERTEX_GLOBAL_REGION_GUIDANCE}`
}

/**
 * Reshape an SDK error into the serialized ClineError JSON the webview's
 * ErrorRow expects (`code`, `providerId`, `details`), extracting structured
 * info from the error message when present and falling back to raw text.
 */
export function reshapeErrorForWebview(
	error: { message?: string; status?: number; code?: string },
	providerId?: string,
	modelId?: string,
	errorClass?: ProviderErrorClass,
): string {
	// The ClineError-JSON branches below are cline-provider flows (balance,
	// spend limit), so "cline" stays their fallback id. The missing-credential
	// message instead gets the raw value: defaulting there would name the wrong
	// provider when the active provider id is unknown.
	const clineErrorProviderId = providerId ?? "cline"
	const rawMessage = error.message ?? "Unknown error"

	// opencoti refused the conversation a window it can use. The error object
	// is gone by now; its numbers ride the message, and the card needs them
	// structured: "opened with 256k, the server has 128k free right now".
	const windowRefusal = parseOpencotiWindowUnavailable(rawMessage)
	if (windowRefusal) {
		const prose = rawMessage.replace(/\s*\[opencoti_window_unavailable[^\]]*\]\s*$/, "")
		return JSON.stringify({
			message: prose,
			code: OPENCOTI_WINDOW_UNAVAILABLE_CODE,
			...(providerId ? { providerId } : {}),
			...(modelId ? { modelId } : {}),
			details: { code: OPENCOTI_WINDOW_UNAVAILABLE_CODE, message: prose, ...windowRefusal },
		})
	}

	// A retired cline-free/ model answers "model not found" once its free
	// promotion ends and the id is removed from the catalog. Stamp the payload
	// with a dedicated code so the webview renders the promotion-ended card
	// instead of the generic model-not-found guidance below.
	if (isClineFreePromotionEndedMessage(rawMessage, modelId)) {
		return JSON.stringify({
			message: rawMessage,
			code: CLINE_FREE_PROMOTION_ENDED_ERROR_CODE,
			providerId: clineErrorProviderId,
			modelId,
			details: {
				code: CLINE_FREE_PROMOTION_ENDED_ERROR_CODE,
				message: rawMessage,
			},
		})
	}

	// Vertex global-endpoint rejections get recovery guidance before the
	// generic model-not-found rewrite can claim them (Google's Publisher
	// Model "was not found" body also matches the not-found pattern).
	const vertexGlobalRegionMessage = describeVertexGlobalRegionError(rawMessage, providerId)
	if (vertexGlobalRegionMessage) {
		return vertexGlobalRegionMessage
	}

	// A BYOK provider rejected the configured credentials (llms classified the
	// HTTP 401/403 while the typed error was still available). Raw provider
	// bodies here are dead ends — e.g. Mistral's `{"detail":"Invalid API Key"}`
	// is identical for a wrong, empty, or wrong-scope key — so point the user
	// at the key configuration instead. Cline-account providers keep the JSON
	// path below (the webview renders their auth failures as a sign-in card),
	// and so does an *unknown* provider id: rewriting without knowing the
	// provider could suppress that sign-in card for a cline-account failure.
	if (errorClass === "auth" && providerId !== undefined && !isClineManagedProvider(providerId)) {
		return describeCredentialRejectedError(rawMessage, providerId)
	}

	// Try to extract structured error info from the error message.
	// The SDK often wraps API error JSON in the Error.message field.
	let parsed: Record<string, unknown> | undefined
	try {
		parsed = JSON.parse(rawMessage)
	} catch {
		// Not JSON — try to find JSON embedded in the message
		// (e.g. "Error: {\"code\":\"insufficient_credits\",...}")
		const jsonMatch = rawMessage.match(/\{[\s\S]*"code"[\s\S]*\}/)
		if (jsonMatch) {
			try {
				parsed = JSON.parse(jsonMatch[0])
			} catch {
				// ignore
			}
		}
	}

	if (!parsed) {
		// Plain-text error — the SDK sometimes strips structured API error JSON
		// and delivers only a human-readable string such as
		// "Not enough credits available" or "Your daily spend limit of $20.00
		// has been reached." Detect these by keyword and synthesize the
		// ClineError-compatible JSON the webview expects.
		const lower = rawMessage.toLowerCase()
		if (
			lower.includes("insufficient_credits") ||
			lower.includes("insufficient credits") ||
			lower.includes("insufficient balance") ||
			lower.includes("not enough credits") ||
			lower.includes("run out of credits") ||
			lower.includes("out of credits")
		) {
			// Extract balance from text like "balance is $-0.14" if present
			const balanceMatch = rawMessage.match(/\$(-?\d+(?:\.\d+)?)/)
			const balance = balanceMatch ? Number.parseFloat(balanceMatch[1]) : 0
			return JSON.stringify({
				message: rawMessage,
				code: "insufficient_credits",
				providerId: clineErrorProviderId,
				details: {
					current_balance: balance,
					message: rawMessage,
				},
			})
		}
		if (lower.includes("spend_limit_exceeded") || lower.includes("spend limit")) {
			return JSON.stringify({
				message: rawMessage,
				code: "SPEND_LIMIT_EXCEEDED",
				providerId: clineErrorProviderId,
				details: {
					code: "SPEND_LIMIT_EXCEEDED",
					message: rawMessage,
				},
			})
		}
		const credentialMessage = describeMissingCredentialError(rawMessage, providerId)
		if (credentialMessage) {
			return credentialMessage
		}
		const notFoundMessage = describeModelNotFoundError(rawMessage)
		if (notFoundMessage) {
			return notFoundMessage
		}
		return rawMessage
	}

	// Detect insufficient credits (402) — needs code + current_balance for
	// ClineError.getErrorType() to return ClineErrorType.Balance
	const code = (parsed.code as string) ?? error.code
	if (code === "insufficient_credits" && typeof parsed.current_balance === "number") {
		return JSON.stringify({
			message: (parsed.message as string) ?? rawMessage,
			code: "insufficient_credits",
			providerId: clineErrorProviderId,
			details: {
				current_balance: parsed.current_balance,
				total_spent: parsed.total_spent,
				total_promotions: parsed.total_promotions,
				message: (parsed.message as string) ?? "You have run out of credits.",
				buy_credits_url: parsed.buy_credits_url,
			},
		})
	}

	// Detect spend limit exceeded (429)
	if (code === "SPEND_LIMIT_EXCEEDED") {
		return JSON.stringify({
			message: (parsed.message as string) ?? rawMessage,
			code: "SPEND_LIMIT_EXCEEDED",
			providerId: clineErrorProviderId,
			details: {
				code: "SPEND_LIMIT_EXCEEDED",
				limit_scope: parsed.limit_scope,
				budget_period: parsed.budget_period,
				limit_usd: parsed.limit_usd,
				spent_usd: parsed.spent_usd,
				resets_at: parsed.resets_at,
				message: parsed.message,
			},
		})
	}

	// For other structured errors, pass through the parsed JSON so
	// ClineError.parse() can still extract what it can.
	return JSON.stringify(parsed)
}
