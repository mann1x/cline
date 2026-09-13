/**
 * The offer the diagnosis earns, and the channel it arrives on.
 */

import type { AgentTool, AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createPendingSuggestion,
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
