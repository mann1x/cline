/**
 * The offer the diagnosis earns, and the channel it arrives on.
 */

import type { AgentTool, AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createPendingSuggestion,
	describeEscalationNudge,
	describeEscalationOffer,
	withStruggleSuggestion,
} from "./struggle-offer";

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
} as AgentToolContext;

function tool(name: string, result = "done"): AgentTool<unknown, unknown> {
	return {
		name,
		description: name,
		inputSchema: { type: "object", properties: {}, required: [] },
		execute: async () => result,
	} as unknown as AgentTool<unknown, unknown>;
}

describe("the offer", () => {
	it("names the tool, the budget and the cost", () => {
		const offer = describeEscalationOffer({
			diagnosis: "Over your last 10 turns: 4 tool calls came back as failures.",
			remaining: 2,
		});

		expect(offer).toContain("escalate");
		expect(offer).toContain("2 escalations left");
		expect(offer).toContain("4 tool calls");
	});

	// The half that is easy to leave out. A paragraph that only warned about
	// cost would produce a model that never escalates, which is the more
	// expensive failure of the two.
	it("says the expert is there to be used", () => {
		const offer = describeEscalationOffer({ diagnosis: "d", remaining: 1 });

		expect(offer).toContain("one escalation left");
		expect(offer).toMatch(/exists to be used/);
	});

	// The forcing path is a different mechanism at a different place, and a
	// suggestion that reads like an order makes the run's one real stop
	// indistinguishable from a nudge.
	it("does not order the model to escalate", () => {
		const offer = describeEscalationOffer({ diagnosis: "d", remaining: 3 });

		expect(offer).toContain("your call");
		expect(offer).not.toMatch(/you must|stop now/i);
	});
});

describe("how it reaches the model", () => {
	it("rides the next tool result", async () => {
		const pending = createPendingSuggestion();
		const [wrapped] = withStruggleSuggestion([tool("read_files")], pending);
		pending.hold("the offer");

		const result = await (
			wrapped as unknown as AgentTool<unknown, unknown>
		).execute({}, context);

		expect(result).toContain("done");
		expect(result).toContain("the offer");
	});

	it("says it once, not on every call after it", async () => {
		const pending = createPendingSuggestion();
		const [wrapped] = withStruggleSuggestion([tool("read_files")], pending);
		pending.hold("the offer");
		const live = wrapped as unknown as AgentTool<unknown, unknown>;

		await live.execute({}, context);
		const second = await live.execute({}, context);

		expect(second).not.toContain("the offer");
	});

	// A model that has just taken the advice does not need to be given it again
	// inside the answer.
	it("stays out of the escalation's own result", async () => {
		const pending = createPendingSuggestion();
		const [wrapped] = withStruggleSuggestion([tool("escalate")], pending);
		pending.hold("the offer");

		const result = await (
			wrapped as unknown as AgentTool<unknown, unknown>
		).execute({}, context);

		expect(result).not.toContain("the offer");
	});

	it("leaves a result that is not text alone", async () => {
		const pending = createPendingSuggestion();
		const structured = {
			...tool("read_files"),
			execute: async () => ({ rows: 3 }),
		} as unknown as AgentTool<unknown, unknown>;
		const [wrapped] = withStruggleSuggestion([structured], pending);
		pending.hold("the offer");

		const result = await (
			wrapped as unknown as AgentTool<unknown, unknown>
		).execute({}, context);

		expect(result).toEqual({ rows: 3 });
	});
});

describe("an offer that cannot ride the result it was given", () => {
	// The bug this covers, measured on manic-harness run 0298 (jackod4ac 9B,
	// 4.100.108, 155 iterations): the detector fired at iteration 130 and the
	// word "escalate" appears nowhere in the transcript. `take()` consumed the
	// offer before checking whether the result could carry it, so a structured
	// result swallowed it. 106 of that run's 154 calls were `read_files` or
	// `run_commands`, neither of which answers with a plain string.
	it("keeps the offer held when the result cannot carry it", async () => {
		const pending = createPendingSuggestion();
		const structured = {
			...tool("run_commands"),
			execute: async () => ({ rows: 3 }),
		} as unknown as AgentTool<unknown, unknown>;
		const [wrappedStructured] = withStruggleSuggestion([structured], pending);
		const [wrappedText] = withStruggleSuggestion([tool("editor")], pending);
		pending.hold("the offer");

		const first = await (
			wrappedStructured as unknown as AgentTool<unknown, unknown>
		).execute({}, context);
		expect(first).toEqual({ rows: 3 });

		// Still owed, so the next result that can carry it does.
		const second = await (
			wrappedText as unknown as AgentTool<unknown, unknown>
		).execute({}, context);
		expect(second).toContain("the offer");
	});

	// `read_files` answers with one entry per path. It is the most likely call
	// to follow a diagnosis -- a model told it is struggling reads before it
	// edits -- so the offer has to reach this shape rather than wait it out.
	it("rides a per-file result list", async () => {
		const pending = createPendingSuggestion();
		const reader = {
			...tool("read_files"),
			execute: async () => [
				{ query: "a.js", result: "contents of a", success: true },
				{ query: "b.js", result: "contents of b", success: true },
			],
		} as unknown as AgentTool<unknown, unknown>;
		const [wrapped] = withStruggleSuggestion([reader], pending);
		pending.hold("the offer");

		const result = (await (
			wrapped as unknown as AgentTool<unknown, unknown>
		).execute({}, context)) as {
			result: string;
		}[];

		expect(result[0]?.result).toBe("contents of a");
		expect(result[1]?.result).toContain("contents of b");
		expect(result[1]?.result).toContain("the offer");
	});

	it("does not attach to an entry that failed, and stays held", async () => {
		const pending = createPendingSuggestion();
		const failing = {
			...tool("read_files"),
			execute: async () => [
				{ query: "a.js", result: "", success: false, error: "no such file" },
			],
		} as unknown as AgentTool<unknown, unknown>;
		const [wrapped] = withStruggleSuggestion([failing], pending);
		const [wrappedText] = withStruggleSuggestion([tool("editor")], pending);
		pending.hold("the offer");

		await (wrapped as unknown as AgentTool<unknown, unknown>).execute(
			{},
			context,
		);
		const next = await (
			wrappedText as unknown as AgentTool<unknown, unknown>
		).execute({}, context);
		expect(next).toContain("the offer");
	});
});

/**
 * The nudge, which is the offer's quieter predecessor and must stay quieter.
 *
 * If it read like the offer, a model would meet the full proposal on every
 * ordinary bad patch and learn to skip the one that matters.
 */
describe("the nudge", () => {
	const diagnosis =
		"Over your last 10 turns: 2 tool calls came back as failures or refusals.";

	it("states what was measured and proposes nothing", () => {
		const text = describeEscalationNudge({
			diagnosis,
			complexity: [],
			high: false,
			remaining: 3,
		});

		expect(text).toContain("2 tool calls");
		expect(text).not.toContain("escalate");
	});

	it("carries the complexity lines with their bound attached", () => {
		const text = describeEscalationNudge({
			diagnosis,
			complexity: [
				"Cognitive complexity of game.html:30-133: 238. That measures how hard the code is to read, not how likely this change is to work — treat it as context, not as evidence.",
			],
			high: true,
			remaining: 2,
		});

		expect(text).toContain("238");
		expect(text).toContain("treat it as context, not as evidence");
	});

	it("names the expert only where the code is dense", () => {
		const dense = describeEscalationNudge({
			diagnosis,
			complexity: ["Cognitive complexity of game.html:1-200: 238."],
			high: true,
			remaining: 2,
		});
		expect(dense).toContain("escalate");
		expect(dense).toContain("you have 2 left");

		const ordinary = describeEscalationNudge({
			diagnosis,
			complexity: ["Cognitive complexity of small.js:1-20: 3."],
			high: false,
			remaining: 2,
		});
		expect(ordinary).not.toContain("escalate");
	});

	// An offer the budget would refuse is worse than no offer.
	it("says nothing about the expert with nothing left to spend", () => {
		const text = describeEscalationNudge({
			diagnosis,
			complexity: ["Cognitive complexity of game.html:1-200: 238."],
			high: true,
			remaining: 0,
		});

		expect(text).not.toContain("escalate");
	});
});
