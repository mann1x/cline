import { describe, expect, it } from "vitest";
import {
	__resetAgentRounds,
	AgentRounds,
	type RoundAgentRecord,
	recordAgentFinalSpend,
	recordAgentSpend,
} from "./agent-rounds";

const record = (): RoundAgentRecord =>
	({ name: "html-review-2", id: "r1-8" }) as unknown as RoundAgentRecord;

describe("an agent's spend", () => {
	it("keeps what a run spent when its runtime starts counting again", () => {
		const agent = record();
		recordAgentSpend(agent, { inputTokens: 40_000, outputTokens: 3_000 });
		recordAgentSpend(agent, { inputTokens: 90_000, outputTokens: 5_000 });
		// A `continue`: the runtime's totals start at zero.
		recordAgentSpend(agent, { inputTokens: 30_000, outputTokens: 400 });
		expect(agent.inputTokens).toBe(120_000);
		expect(agent.outputTokens).toBe(5_400);
	});

	it("adds the finish, which sums the run's segments, to what came before it", () => {
		const agent = record();
		recordAgentSpend(agent, { inputTokens: 90_000, outputTokens: 5_000 });
		recordAgentSpend(agent, { inputTokens: 30_000, outputTokens: 400 });
		// runDelegatedWithCap folds both segments into one figure.
		recordAgentFinalSpend(agent, { inputTokens: 120_000, outputTokens: 5_400 });
		expect(agent.inputTokens).toBe(120_000);
		expect(agent.outputTokens).toBe(5_400);
	});

	it("never lowers a total on a finish that summed less than was seen", () => {
		const agent = record();
		recordAgentSpend(agent, { inputTokens: 90_000, outputTokens: 5_000 });
		recordAgentFinalSpend(agent, { inputTokens: 1_000, outputTokens: 10 });
		expect(agent.inputTokens).toBe(90_000);
		expect(agent.outputTokens).toBe(5_000);
	});

	it("carries one run's spend into the next", () => {
		const agent = record();
		recordAgentSpend(agent, { inputTokens: 50_000, outputTokens: 2_000 });
		recordAgentFinalSpend(agent, { inputTokens: 50_000, outputTokens: 2_000 });
		// A second run of the same agent, counted from zero by its runtime.
		recordAgentSpend(agent, { inputTokens: 10_000, outputTokens: 500 });
		expect(agent.inputTokens).toBe(60_000);
		expect(agent.outputTokens).toBe(2_500);
		recordAgentFinalSpend(agent, { inputTokens: 10_000, outputTokens: 500 });
		expect(agent.inputTokens).toBe(60_000);
		expect(agent.outputTokens).toBe(2_500);
	});

	it("starts from the totals a record read back from disk already shows", () => {
		const agent = {
			...record(),
			inputTokens: 7_000,
			outputTokens: 300,
		} as RoundAgentRecord;
		recordAgentSpend(agent, { inputTokens: 1_000, outputTokens: 50 });
		expect(agent.inputTokens).toBe(8_000);
		expect(agent.outputTokens).toBe(350);
	});
});

// A graceful stop answers with where it stopped: not a finished task.
describe("an agent stopped gracefully", () => {
	it("is recorded as cancelled, its report kept as its result", async () => {
		__resetAgentRounds();
		const rounds = new AgentRounds("s-wrap");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: false,
			agents: [{ name: "a", task: "t" }],
		});
		await handle.run(
			0,
			{ agentId: "lead", conversationId: "c", iteration: 1 } as never,
			async () => ({
				text: "[Stopped by the lead before it finished.]\n\nChanged line 32.",
				finishReason: "completed",
				iterations: 5,
				stopReason: "wrap_up",
				usage: { inputTokens: 10, outputTokens: 2 },
			}),
		);
		expect(handle.agent(0)).toMatchObject({
			state: "cancelled",
			stopReason: "cancelled_by_lead",
			stopDetail: "stopped gracefully; its report is partial work",
		});
	});
});
