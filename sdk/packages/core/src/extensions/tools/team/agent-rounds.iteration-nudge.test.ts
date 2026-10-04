import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRounds, describeIterationMilestones } from "./agent-rounds";
import { LEAD_NUDGE_BATCH_MS, onLeadNudge } from "./agent-trouble";

const context = { agentId: "lead", iteration: 1, sessionId: "s-mile" } as never;

// User ruling (2026-09-28): no iteration cap on a swarm; the lead is told
// every 60 iterations to check on a long-running agent, and nothing stops.
describe("the lead's note about long-running agents", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("tells the lead once per 60 iterations crossed, batched, and stops nothing", async () => {
		const heard: string[] = [];
		const stop = onLeadNudge("s-mile", (text) => heard.push(text));
		const rounds = new AgentRounds("s-mile");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: true,
			agents: [{ name: "brace-fixer-1", task: "t" }],
		});
		const ran = handle.run(0, context, async (ctx) => {
			for (const iterations of [1, 59, 60, 61, 119, 120]) {
				ctx.emitUpdate?.({ iterations });
			}
			return { text: "done", finishReason: "completed" };
		});
		await ran;
		expect(heard).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(LEAD_NUDGE_BATCH_MS);
		expect(heard).toHaveLength(1);
		expect(heard[0]).toContain("brace-fixer-1");
		expect(heard[0]).toContain("60 iterations");
		expect(heard[0]).toContain("120 iterations");
		expect(heard[0]).toContain("nothing was stopped");
		expect(heard[0]).toContain(`agents_status(round_id: "${handle.id}")`);
		stop();
	});

	it("says nothing before the first 60", async () => {
		const heard: string[] = [];
		const stop = onLeadNudge("s-mile", (text) => heard.push(text));
		const rounds = new AgentRounds("s-mile");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: true,
			agents: [{ name: "a", task: "t" }],
		});
		await handle.run(0, context, async (ctx) => {
			ctx.emitUpdate?.({ iterations: 59 });
			return { text: "done", finishReason: "completed" };
		});
		await vi.advanceTimersByTimeAsync(LEAD_NUDGE_BATCH_MS * 2);
		expect(heard).toHaveLength(0);
		stop();
	});

	it("reads as one note for several agents", () => {
		const text = describeIterationMilestones([
			{ round: "r2", id: "r2-1", name: "a", iterations: 60, phase: "thinking" },
			{ round: "r2", id: "r2-2", name: "b", iterations: 120 },
		]);
		expect(text).toContain("2 agents have been running a long time");
		expect(text).toContain("- a (r2-1): 60 iterations, now thinking");
		expect(text).toContain("- b (r2-2): 120 iterations");
	});

	it("says how many calls failed, and never the bare word requesting", () => {
		// wlafh r3: "60 iterations, now requesting" was read as an agent
		// asking for more iterations.
		const text = describeIterationMilestones([
			{
				round: "r3",
				id: "r3-11",
				name: "braces-2",
				iterations: 60,
				phase: "requesting",
				toolCalls: 58,
				toolFailures: 14,
			},
		]);
		expect(text).toContain(
			"- braces-2 (r3-11): 60 iterations, 14 of 58 tool calls failed, now waiting for the model",
		);
		expect(text).not.toContain("now requesting");
	});
});
