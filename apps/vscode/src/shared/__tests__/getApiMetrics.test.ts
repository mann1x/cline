import { describe, it } from "bun:test"
import { strict as assert } from "node:assert"
import type { ClineMessage } from "../ExtensionMessage"
import { getApiMetrics, getContextWindowUsage, getLastApiReqTotalTokens } from "../getApiMetrics"

describe("getApiMetrics", () => {
	// The expert is the one model whose cost has to be separable: it is usually
	// the metered one, and a total that folds it into the session's own answers
	// no question anybody has about a paid account.
	it("keeps the expert's spend apart from the session's own", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 1_000, tokensOut: 100 }),
			},
			{
				ts: 2,
				type: "say",
				say: "escalation",
				text: JSON.stringify({
					phase: "reply",
					text: "done",
					usage: {
						tokensIn: 40_000,
						tokensOut: 2_000,
						generateTokens: 2_000,
						generateMs: 80_000,
						wallMs: 95_000,
						requests: 1,
					},
				}),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 1_000)
		assert.equal(metrics.totalTokensOut, 100)
		assert.equal(metrics.expert?.tokensIn, 40_000)
		assert.equal(metrics.expert?.tokensOut, 2_000)
		assert.equal(metrics.expert?.generateTokens, 2_000)
		assert.equal(metrics.expert?.generateMs, 80_000)
		assert.equal(metrics.expert?.requests, 1)
	})

	// Every delivery of every escalation, summed. A task that escalated three
	// times spent three times.
	it("sums every delivery the expert made", () => {
		const delivery = (tokensIn: number, ts: number): ClineMessage => ({
			ts,
			type: "say",
			say: "escalation",
			text: JSON.stringify({
				phase: "reply",
				text: "done",
				usage: {
					tokensIn,
					tokensOut: 100,
					generateTokens: 100,
					generateMs: 1_000,
					wallMs: 1_200,
					requests: 1,
				},
			}),
		})

		const metrics = getApiMetrics([delivery(1_000, 1), delivery(2_000, 2)])

		assert.equal(metrics.expert?.tokensIn, 3_000)
		assert.equal(metrics.expert?.requests, 2)
	})

	// The brief and the closing line carry no usage, and a zero on the header
	// would read as an expert that answered for free.
	it("reports no expert at all when none was called", () => {
		const metrics = getApiMetrics([
			{
				ts: 1,
				type: "say",
				say: "escalation",
				text: JSON.stringify({ phase: "started", text: "the brief" }),
			},
		])

		assert.equal(metrics.expert, undefined)
	})

	it("includes subagent_usage in aggregate totals", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 10,
					tokensOut: 20,
					cacheWrites: 3,
					cacheReads: 1,
					cost: 0.12,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 4,
					tokensOut: 8,
					cacheWrites: 2,
					cacheReads: 1,
					cost: 0.05,
				}),
			},
			{
				ts: 3,
				type: "say",
				say: "deleted_api_reqs",
				text: JSON.stringify({
					tokensIn: 6,
					tokensOut: 9,
					cacheWrites: 1,
					cacheReads: 0,
					cost: 0.03,
				}),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 20)
		assert.equal(metrics.totalTokensOut, 37)
		assert.equal(metrics.totalCacheWrites, 6)
		assert.equal(metrics.totalCacheReads, 2)
		assert.ok(Math.abs(metrics.totalCost - 0.2) < 1e-9)
	})

	// The reason the split exists: the lead runs on a paid endpoint while the
	// sub-agents run on a local one, and a single total cannot say which of
	// those tokens cost anything.
	it("splits the totals by the connection that spent them", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 100,
					tokensOut: 20,
					cost: 0.5,
					providerId: "anthropic",
					modelId: "claude-sonnet-4-5",
					timings: { generateTokens: 20, generateMs: 1000 },
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 400,
					tokensOut: 80,
					cost: 0,
					providerId: "ollama",
					modelId: "qwen3",
				}),
			},
			{
				ts: 3,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 150,
					tokensOut: 30,
					cost: 0.25,
					providerId: "anthropic",
					modelId: "claude-sonnet-4-5",
					timings: { generateTokens: 30, generateMs: 1000 },
				}),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 650)
		assert.equal(metrics.totalTokensOut, 130)
		assert.equal(metrics.byProvider.length, 2)

		const anthropic = metrics.byProvider.find((entry) => entry.providerId === "anthropic")
		assert.ok(anthropic)
		assert.equal(anthropic.tokensIn, 250)
		assert.equal(anthropic.tokensOut, 50)
		assert.ok(Math.abs(anthropic.cost - 0.75) < 1e-9)

		const ollama = metrics.byProvider.find((entry) => entry.providerId === "ollama")
		assert.ok(ollama)
		assert.equal(ollama.tokensOut, 80)
		assert.equal(ollama.cost, 0)
	})

	// Only the requests whose provider timed itself. Deriving a rate from wall
	// clock would fold in queueing and tool time and stop being the model's.
	it("sums generation throughput only where the provider reported it", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 10,
					tokensOut: 40,
					timings: { generateTokens: 40, generateMs: 2000 },
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 10, tokensOut: 60 }),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensOut, 100)
		assert.equal(metrics.totalGenerateTokens, 40)
		assert.equal(metrics.totalGenerateMs, 2000)
	})

	// The spinner row carries no usage, and one is emitted per iteration. Left
	// in, the breakdown grows an empty entry for every turn of the task.
	it("does not open a connection row for a request that has no usage yet", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({}) },
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 10, tokensOut: 5, providerId: "ollama" }),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.byProvider.length, 1)
		assert.equal(metrics.byProvider[0].providerId, "ollama")
	})

	it("ignores malformed usage payloads", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: "{not-json",
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 0)
		assert.equal(metrics.totalTokensOut, 0)
		assert.equal(metrics.totalCost, 0)
	})
})

describe("getLastApiReqTotalTokens", () => {
	it("uses only the latest api_req_started payload", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 100,
					tokensOut: 200,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 11,
					tokensOut: 7,
					cacheWrites: 2,
					cacheReads: 3,
				}),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23)
	})

	it("scales the last request by the shrink ratio of a compaction completed after it", () => {
		// The compaction counters are the SDK's estimate — a different scale from
		// the provider-reported request total. Only the ratio carries over.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 90_000, tokensOut: 5_000, cacheReads: 5_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 200_000, tokensAfter: 50_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 25_000)
	})

	it("compounds multiple compactions completed since the last request", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 100_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 200_000, tokensAfter: 100_000 }),
			},
			{
				ts: 3,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 100_000, tokensAfter: 50_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 25_000)
	})

	it("grows the request total when a compaction made the estimated context larger", () => {
		// Compacting a tiny conversation can produce a summary bigger than the
		// original messages. The header must follow the divider's direction
		// instead of freezing at the pre-compaction value.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 4_000, tokensOut: 1_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 1_000, tokensAfter: 1_300 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 6_500)
	})

	it("leaves the request total unscaled when a completed compaction lacks token counters", () => {
		// The coordinator's fallback divider carries only message counts.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 40_000, tokensOut: 2_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", messagesBefore: 40, messagesAfter: 6 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 42_000)
	})

	it("returns 0 when a compaction completed but no request preceded it", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 95_000, tokensAfter: 30_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 0)
	})

	it("ignores compaction rows without a usable compacted size", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 11, tokensOut: 7, cacheWrites: 2, cacheReads: 3 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "started", mode: "auto" }),
			},
			{
				ts: 3,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "failed", mode: "auto" }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23)
	})

	it("prefers a request newer than the last compaction", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "auto", tokensBefore: 95_000, tokensAfter: 30_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 31_000, tokensOut: 1_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 32_000)
	})
})

describe("the connection breakdown", () => {
	function usageRow(say: string, payload: Record<string, unknown>): ClineMessage {
		return { ts: Date.now(), type: "say", say: say as ClineMessage["say"], text: JSON.stringify(payload) }
	}

	// The case the breakdown exists for and could not show: a delegated batch
	// runs on the lead's own provider and model, so keying on the pair alone
	// merged the two and reported one connection.
	it("keeps sub-agents apart from the lead on the same provider and model", () => {
		const metrics = getApiMetrics([
			usageRow("api_req_started", { providerId: "ollama", modelId: "gemma4:31b", tokensIn: 100, tokensOut: 10 }),
			usageRow("subagent_usage", {
				source: "subagents",
				providerId: "ollama",
				modelId: "gemma4:31b",
				tokensIn: 40,
				tokensOut: 4,
				agents: 3,
			}),
		])

		assert.equal(metrics.byProvider.length, 2)
		assert.equal(metrics.byProvider[0].source, undefined)
		assert.equal(metrics.byProvider[0].tokensIn, 100)
		assert.equal(metrics.byProvider[0].requests, 1)
		assert.equal(metrics.byProvider[0].agents, 0)
		assert.equal(metrics.byProvider[1].source, "subagents")
		assert.equal(metrics.byProvider[1].tokensIn, 40)
		assert.equal(metrics.byProvider[1].agents, 3)
	})

	// Whatever the split, the rows have to add back up to the line above them.
	it("sums to the task totals", () => {
		const metrics = getApiMetrics([
			usageRow("api_req_started", { providerId: "ollama", modelId: "a", tokensIn: 100, tokensOut: 10 }),
			usageRow("api_req_started", { providerId: "opencoti", modelId: "b", tokensIn: 7, tokensOut: 3 }),
			usageRow("subagent_usage", { source: "subagents", providerId: "ollama", modelId: "a", tokensIn: 40, tokensOut: 4 }),
		])

		assert.equal(
			metrics.byProvider.reduce((total, row) => total + row.tokensIn, 0),
			metrics.totalTokensIn,
		)
		assert.equal(
			metrics.byProvider.reduce((total, row) => total + row.tokensOut, 0),
			metrics.totalTokensOut,
		)
	})

	it("counts a request per request row and none for a deleted aggregate", () => {
		const metrics = getApiMetrics([
			usageRow("api_req_started", { providerId: "ollama", modelId: "a", tokensIn: 100, tokensOut: 10 }),
			usageRow("api_req_started", { providerId: "ollama", modelId: "a", tokensIn: 50, tokensOut: 5 }),
			usageRow("deleted_api_reqs", { providerId: "ollama", modelId: "a", tokensIn: 999, tokensOut: 99 }),
		])

		assert.equal(metrics.byProvider[0].requests, 2)
		assert.equal(metrics.byProvider[0].tokensIn, 1149)
	})
})

describe("getContextWindowUsage", () => {
	const breakdown = {
		systemPromptTokens: 1_508,
		builtinToolSchemaTokens: 12_291,
		mcpToolSchemaTokens: 0,
		toolCount: 16,
		mcpToolCount: 0,
	}
	/** pandorum, 2026-09-19, session on v9-agentic_tb:q4km-64k. */
	const FIXED = 13_799

	function request(fields: Record<string, unknown>): ClineMessage {
		return { ts: 100, type: "say", say: "api_req_started", text: JSON.stringify(fields) }
	}

	// `observedOutputTokens` ranged 0 to 8,054 across 57 turns of one session on
	// a 65,536-token window. Counted into the meter, the bar swings by 12% of
	// its own width between a thinking turn and the tool call after it, with the
	// conversation unchanged. The reply is not in the window: it arrives in the
	// next prompt and is counted there.
	it("leaves the reply out of the window it is not in", () => {
		const long = getContextWindowUsage([request({ tokensIn: 40_124, tokensOut: 8_054, contextBreakdown: breakdown })])
		const short = getContextWindowUsage([request({ tokensIn: 40_124, tokensOut: 120, contextBreakdown: breakdown })])

		assert.equal(long.used, 40_124)
		assert.equal(short.used, long.used)
	})

	it("counts what was served from cache, which did occupy the window", () => {
		const usage = getContextWindowUsage([request({ tokensIn: 3, cacheReads: 24_478, cacheWrites: 2, tokensOut: 261 })])

		assert.equal(usage.used, 24_483)
	})

	// Two compactions compounding drove the scaled total below the fixed price,
	// at which point the conversation read as empty and the measured 12k of tool
	// schemas was squeezed to 4-5k to fit. A compaction rewrites the transcript;
	// it does not shorten the system prompt or the tool schemas, which are
	// re-sent whole on the very next request.
	it("shrinks the conversation across a compaction and leaves the fixed price alone", () => {
		const messages: ClineMessage[] = [
			request({ tokensIn: 47_054, tokensOut: 6_020, contextBreakdown: breakdown }),
			{
				ts: 101,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", tokensBefore: 64_723, tokensAfter: 35_735 }),
			},
		]

		const usage = getContextWindowUsage(messages)
		const conversation = 47_054 - FIXED

		assert.equal(usage.used, Math.ceil(FIXED + conversation * (35_735 / 64_723)))
		// The whole point: the fixed part is untouched, so the coloured slices
		// still add up to what was measured.
		assert.ok(usage.used > FIXED)
		assert.deepEqual(usage.breakdown, breakdown)
	})

	it("never reports less than the fixed price, however the ratios compound", () => {
		const messages: ClineMessage[] = [request({ tokensIn: 20_000, contextBreakdown: breakdown })]
		for (const [before, after] of [
			[64_723, 35_735],
			[60_000, 20_000],
			[50_000, 12_000],
		]) {
			messages.push({
				ts: 200,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", tokensBefore: before, tokensAfter: after }),
			})
		}

		const usage = getContextWindowUsage(messages)
		assert.ok(usage.used >= FIXED, `expected at least the fixed price, got ${usage.used}`)
	})

	// A delegated batch runs on its own window, routinely on the lead's own
	// provider and model, and its rows were moving the lead's bar.
	it("ignores a sub-agent's request", () => {
		const messages: ClineMessage[] = [
			request({ tokensIn: 40_000, contextBreakdown: breakdown }),
			request({ source: "subagents", tokensIn: 900, tokensOut: 100 }),
		]

		assert.equal(getContextWindowUsage(messages).used, 40_000)
	})

	// Mid-compaction the transcript is being rewritten and the summarizer is
	// making model calls of its own. Nothing shown then describes either state.
	it("says when a compaction is open so the bar can hold still", () => {
		const open: ClineMessage[] = [
			request({ tokensIn: 40_000, contextBreakdown: breakdown }),
			{ ts: 101, type: "say", say: "compaction", text: JSON.stringify({ status: "started" }) },
		]
		const closed: ClineMessage[] = [
			...open.slice(0, 1),
			{
				ts: 101,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", tokensBefore: 40_000, tokensAfter: 20_000 }),
			},
		]

		assert.equal(getContextWindowUsage(open).compacting, true)
		assert.equal(getContextWindowUsage(closed).compacting, false)
	})

	// The length and the colours have to describe one request. Read from
	// separate rows, a request without a breakdown next to one with it made the
	// coloured part appear and vanish between turns.
	it("takes the total and the breakdown from the same request", () => {
		const messages: ClineMessage[] = [
			request({ tokensIn: 40_000, contextBreakdown: breakdown }),
			request({ tokensIn: 41_000 }),
		]

		const usage = getContextWindowUsage(messages)
		assert.equal(usage.used, 41_000)
		assert.equal(usage.breakdown, undefined)
	})
})
