import { ClineMessage } from "./ExtensionMessage"

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
		if (
			message.type === "say" &&
			(message.say === "api_req_started" || message.say === "deleted_api_reqs" || message.say === "subagent_usage") &&
			message.text
		) {
			try {
				const parsedData = JSON.parse(message.text)
				const { tokensIn, tokensOut, cacheWrites, cacheReads, cost, providerId, modelId, timings } = parsedData

				// A request row with no usage on it yet -- the spinner one -- is
				// not a connection that spent anything, and adding it would put
				// an empty row in the breakdown for every turn.
				const carriesUsage =
					typeof tokensIn === "number" ||
					typeof tokensOut === "number" ||
					typeof cacheWrites === "number" ||
					typeof cacheReads === "number" ||
					typeof cost === "number"
				const key = `${typeof providerId === "string" ? providerId : ""}\u0000${
					typeof modelId === "string" ? modelId : ""
				}`
				let connection = byConnection.get(key)
				if (!connection && carriesUsage) {
					connection = {
						...(typeof providerId === "string" ? { providerId } : {}),
						...(typeof modelId === "string" ? { modelId } : {}),
						tokensIn: 0,
						tokensOut: 0,
						cacheWrites: 0,
						cacheReads: 0,
						cost: 0,
						generateTokens: 0,
						generateMs: 0,
					}
					byConnection.set(key, connection)
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
