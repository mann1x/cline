import { ClineMessage, ContextBreakdown } from "./ExtensionMessage"

/**
 * What one connection spent over a task.
 *
 * Kept per provider and model because a task is routinely more than one of
 * each: the user can switch mid-task, and sub-agents can be pointed at another
 * endpoint entirely. A single total cannot say which of those tokens were free
 * -- a local Ollama -- and which were billed, which is the whole reason to
 * show the numbers at all.
 */
export interface ProviderApiMetrics {
	providerId?: string
	modelId?: string
	/**
	 * What the connection was used for.
	 *
	 * Absent means the task's own turns. `"subagents"` is a delegated batch,
	 * which is routinely the *same* provider and model as the lead -- so it is
	 * part of the key, not a label applied afterwards. Without it a sub-agent
	 * on the lead's endpoint merged into the lead's row and the breakdown said
	 * "one connection" about two quite different pieces of spending.
	 *
	 * The escalation expert is deliberately not a source here: it has its own
	 * row, because the question it answers is what handing the task over cost.
	 */
	source?: "subagents"
	/**
	 * Requests made on this connection.
	 *
	 * Counted from the request rows themselves, so a `deleted_api_reqs`
	 * aggregate -- one message standing for many deleted requests -- contributes
	 * its tokens and no count. An undercounted number is better than one
	 * invented from an aggregate that never carried it.
	 */
	requests: number
	/** Sub-agents summarized into this row. Zero on a row that is not one. */
	agents: number
	tokensIn: number
	tokensOut: number
	cacheWrites: number
	cacheReads: number
	cost: number
	/**
	 * Generation throughput, summed over the requests that reported it.
	 *
	 * Only some providers time their own work (Ollama and llama.cpp do), so
	 * these stay zero elsewhere and the rate is simply not shown. An estimate
	 * from wall-clock would include queueing, prompt processing and the
	 * client's own latency, and calling that the model's speed would make the
	 * comparison it exists for meaningless.
	 */
	generateTokens: number
	generateMs: number
}

/**
 * What the expert spent, if a task escalated.
 *
 * Kept out of the session's own totals deliberately. The expert is usually the
 * metered model -- a cloud account, a shared allowance -- and folding its
 * tokens into the session's produces one number that answers neither "what did
 * this task cost me" nor "what did my own model do". Absent when no escalation
 * delivered anything.
 */
export interface ExpertApiMetrics {
	tokensIn: number
	tokensOut: number
	generateTokens: number
	generateMs: number
	/** Wall-clock the expert was running, queueing included. */
	wallMs: number
	/** Turns asked of the expert across every escalation. */
	requests: number
}

interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
	/** The same totals, split by the connection that spent them. */
	byProvider: ProviderApiMetrics[]
	/** Generation throughput across every request that reported timings. */
	totalGenerateTokens: number
	totalGenerateMs: number
	/** What the expert spent, when the task escalated. */
	expert?: ExpertApiMetrics
}

/**
 * Calculates API metrics from an array of ClineMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: ClineMessage[]): ApiMetrics {
	const result: ApiMetrics = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
		byProvider: [],
		totalGenerateTokens: 0,
		totalGenerateMs: 0,
	}
	// Insertion-ordered, so the connections appear in the order the task used
	// them rather than alphabetically -- the lead's first, and an agents-only
	// endpoint below it.
	const byConnection = new Map<string, ProviderApiMetrics>()

	messages.forEach((message) => {
		// The expert's deliveries, summed apart from everything above. Read off
		// the escalation row rather than given a connection of its own in the
		// breakdown: the question this answers is "what did handing the task
		// over cost", which is about the escalation and not about the endpoint
		// it happened to run on.
		if (message.type === "say" && message.say === "escalation" && message.text) {
			try {
				const parsed = JSON.parse(message.text)
				const usage = parsed?.usage
				if (usage && typeof usage === "object") {
					const expert = (result.expert ??= {
						tokensIn: 0,
						tokensOut: 0,
						generateTokens: 0,
						generateMs: 0,
						wallMs: 0,
						requests: 0,
					})
					expert.tokensIn += typeof usage.tokensIn === "number" ? usage.tokensIn : 0
					expert.tokensOut += typeof usage.tokensOut === "number" ? usage.tokensOut : 0
					expert.generateTokens += typeof usage.generateTokens === "number" ? usage.generateTokens : 0
					expert.generateMs += typeof usage.generateMs === "number" ? usage.generateMs : 0
					expert.wallMs += typeof usage.wallMs === "number" ? usage.wallMs : 0
					expert.requests += typeof usage.requests === "number" ? usage.requests : 0
				}
			} catch {
				// Ignore JSON parse errors
			}
			return
		}
		if (
			message.type === "say" &&
			(message.say === "api_req_started" || message.say === "deleted_api_reqs" || message.say === "subagent_usage") &&
			message.text
		) {
			try {
				const parsedData = JSON.parse(message.text)
				const { tokensIn, tokensOut, cacheWrites, cacheReads, cost, providerId, modelId, timings, source, agents } =
					parsedData

				// A request row with no usage on it yet -- the spinner one -- is
				// not a connection that spent anything, and adding it would put
				// an empty row in the breakdown for every turn.
				const carriesUsage =
					typeof tokensIn === "number" ||
					typeof tokensOut === "number" ||
					typeof cacheWrites === "number" ||
					typeof cacheReads === "number" ||
					typeof cost === "number"
				// The source is part of the key. A sub-agent batch usually runs on
				// the lead's own provider and model, and merging the two rows
				// loses the only split anyone opens this breakdown to see.
				const usageSource = source === "subagents" ? ("subagents" as const) : undefined
				const key = `${typeof providerId === "string" ? providerId : ""}\u0000${
					typeof modelId === "string" ? modelId : ""
				}\u0000${usageSource ?? ""}`
				let connection = byConnection.get(key)
				if (!connection && carriesUsage) {
					connection = {
						...(typeof providerId === "string" ? { providerId } : {}),
						...(typeof modelId === "string" ? { modelId } : {}),
						...(usageSource ? { source: usageSource } : {}),
						tokensIn: 0,
						tokensOut: 0,
						cacheWrites: 0,
						cacheReads: 0,
						cost: 0,
						generateTokens: 0,
						generateMs: 0,
						requests: 0,
						agents: 0,
					}
					byConnection.set(key, connection)
				}
				if (connection) {
					if (message.say === "api_req_started") {
						connection.requests += 1
					}
					if (typeof agents === "number") {
						connection.agents += agents
					}
				}

				if (typeof tokensIn === "number") {
					result.totalTokensIn += tokensIn
					if (connection) connection.tokensIn += tokensIn
				}
				if (typeof tokensOut === "number") {
					result.totalTokensOut += tokensOut
					if (connection) connection.tokensOut += tokensOut
				}
				if (typeof cacheWrites === "number") {
					result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
					if (connection) connection.cacheWrites += cacheWrites
				}
				if (typeof cacheReads === "number") {
					result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
					if (connection) connection.cacheReads += cacheReads
				}
				if (typeof cost === "number") {
					result.totalCost += cost
					if (connection) connection.cost += cost
				}
				// Only requests whose provider timed itself contribute, so the
				// rate stays "what the model did", not "how long the task took".
				const generateTokens = timings?.generateTokens
				const generateMs = timings?.generateMs
				if (typeof generateTokens === "number" && typeof generateMs === "number" && generateMs > 0) {
					result.totalGenerateTokens += generateTokens
					result.totalGenerateMs += generateMs
					if (connection) {
						connection.generateTokens += generateTokens
						connection.generateMs += generateMs
					}
				}
			} catch {
				// Ignore JSON parse errors
			}
		}
	})

	result.byProvider = [...byConnection.values()]
	return result
}

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * A completed compaction divider that postdates the last request rescales that
 * request's total by the compaction's tokensAfter/tokensBefore ratio, so the
 * context-window bar updates immediately instead of waiting for the next
 * request to run. The ratio is used rather than tokensAfter itself because the
 * compaction counters are the SDK's estimate (chars/4-class), a different
 * scale from the provider-reported usage that normally drives this value —
 * substituting the estimate would make the bar visibly re-snap when the next
 * request's real usage lands. Both counters come from the same estimator, so
 * their ratio is scale-free. Multiple compactions since the last request
 * compound. The ratio is deliberately not clamped to 1: compacting a small
 * conversation can grow the context (the summary outweighs the original
 * messages), and the header must move in the same direction as the divider row
 * (e.g. "1k → 1.3k tokens") rather than silently show the stale value.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns The total tokens (tokensIn + tokensOut + cacheWrites + cacheReads) from the last api_req_started message, rescaled by any completed compactions that happened after it, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: ClineMessage[]): number {
	let shrinkFraction: number | undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type !== "say" || !msg.text) {
			continue
		}
		if (msg.say === "compaction") {
			try {
				const { status, tokensBefore, tokensAfter } = JSON.parse(msg.text)
				if (
					status === "completed" &&
					typeof tokensBefore === "number" &&
					typeof tokensAfter === "number" &&
					tokensBefore > 0 &&
					tokensAfter > 0
				) {
					shrinkFraction = (shrinkFraction ?? 1) * (tokensAfter / tokensBefore)
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
		if (msg.say === "api_req_started") {
			try {
				const { tokensIn, tokensOut, cacheWrites, cacheReads } = JSON.parse(msg.text)
				const total = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
				if (total > 0) {
					return shrinkFraction === undefined ? total : Math.ceil(total * shrinkFraction)
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
	}
	return 0
}

/** What the context bar draws. */
export interface ContextWindowUsage {
	/**
	 * The tokens occupying the window right now: the fixed price plus what the
	 * conversation costs, with any compaction since the last request applied to
	 * the conversation alone.
	 */
	used: number
	/** The fixed part, as measured, never rescaled. */
	breakdown?: ContextBreakdown
	/**
	 * A compaction is open. Nothing about the window is settled until it
	 * finishes — the transcript is mid-rewrite and the summarizer's own model
	 * calls report usage of their own — so the caller holds its last value
	 * rather than animating through numbers that describe neither state.
	 */
	compacting: boolean
}

function readBreakdown(info: Record<string, unknown>): ContextBreakdown | undefined {
	const breakdown = info.contextBreakdown as ContextBreakdown | undefined
	return breakdown && typeof breakdown.systemPromptTokens === "number" ? breakdown : undefined
}

/**
 * What to draw on the context window bar.
 *
 * Three things this does that {@link getLastApiReqTotalTokens} does not, each
 * of which was visible as the bar moving for reasons the session had not:
 *
 * **The reply is not in the window.** `tokensOut` is what the model wrote, not
 * what occupied its context — that arrives in the *next* request's prompt and
 * is counted there. Summed into a context meter it makes the bar swing by the
 * length of the last answer: measured on pandorum over 57 turns of one session,
 * `observedOutputTokens` ranged 0 to 8,054 on a 65,536-token window, so a
 * thinking turn and the tool call after it differ by 12% of the bar with the
 * conversation unchanged. That is the "it goes up and down during tool usage"
 * report. The prompt — input plus whatever was served from cache — is the
 * number the window holds.
 *
 * **A compaction shrinks the conversation, not the prompt or the schemas.**
 * Scaling the whole total by `tokensAfter/tokensBefore` shrinks the fixed price
 * too, which nothing did: the system prompt and the tool schemas are re-sent at
 * full size on the very next request. Two compactions compounding drove the
 * total below the fixed price, at which point the conversation read as empty
 * and the fixed slices were squeezed to fit — "the system and tools part became
 * much smaller, around 4-5k instead of 12k". The ratio now applies to the
 * conversation term alone, which is the only thing it ever described.
 *
 * **A sub-agent's request is not the task's window.** Rows carrying a `source`
 * are a delegated batch, routinely on the lead's own provider and model, and
 * they were moving the lead's bar.
 *
 * The breakdown is read from the same row as the total, so the coloured parts
 * and the length always describe one request.
 */
export function getContextWindowUsage(messages: ClineMessage[]): ContextWindowUsage {
	let shrinkFraction = 1
	let newestCompactionStatus: string | undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type !== "say" || !msg.text) {
			continue
		}
		if (msg.say === "compaction") {
			try {
				const { status, tokensBefore, tokensAfter } = JSON.parse(msg.text)
				newestCompactionStatus ??= typeof status === "string" ? status : undefined
				if (
					status === "completed" &&
					typeof tokensBefore === "number" &&
					typeof tokensAfter === "number" &&
					tokensBefore > 0 &&
					tokensAfter > 0
				) {
					shrinkFraction *= tokensAfter / tokensBefore
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
		if (msg.say === "api_req_started") {
			try {
				const info = JSON.parse(msg.text) as Record<string, unknown>
				// A delegated batch spends on its own window, not on this one.
				if (info.source !== undefined) {
					continue
				}
				const prompt = (Number(info.tokensIn) || 0) + (Number(info.cacheWrites) || 0) + (Number(info.cacheReads) || 0)
				if (prompt > 0) {
					const breakdown = readBreakdown(info)
					const fixed = breakdown
						? breakdown.systemPromptTokens + breakdown.builtinToolSchemaTokens + breakdown.mcpToolSchemaTokens
						: 0
					// Clamped rather than scaled: below the fixed price the
					// conversation is empty, and squeezing the measured parts to
					// fit would report the drawing instead of the measurement.
					const conversation = Math.max(0, prompt - fixed) * shrinkFraction
					return {
						used: Math.ceil(fixed + conversation),
						breakdown,
						compacting: newestCompactionStatus === "started",
					}
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
	}
	return { used: 0, compacting: newestCompactionStatus === "started" }
}
