import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetAgentRounds, roundsFor } from "./agent-rounds";
import { createLeadAgentTools } from "./lead-agent-tools";
import {
	__resetSubagentCancellations,
	registerSubagentCancellation,
	subagentCancellation,
} from "./subagent-cancellation";

afterEach(() => {
	__resetAgentRounds();
	__resetSubagentCancellations();
	vi.restoreAllMocks();
});

const context = { agentId: "lead", iteration: 1, sessionId: "s1" } as never;

async function run(name: string, input: unknown, actions?: string[]) {
	const byName = new Map(
		createLeadAgentTools({
			sessionId: "s1",
			onAction: (line) => actions?.push(line),
		}).map((tool) => [tool.name, tool] as const),
	);
	return String(await byName.get(name)?.execute(input, context as never));
}

/** A round of two: `fixer-1` running on Node1 under control `s1::c#0`, `fixer-2` failed. */
async function round() {
	const rounds = roundsFor("s1");
	const handle = rounds.open({
		kind: "spawn_agent",
		tool: "spawn_agent",
		toolCallId: "c",
		background: true,
		agents: [
			{ name: "fixer-1", task: "fix a.js" },
			{ name: "fixer-2", task: "fix b.js" },
		],
	});
	const control = registerSubagentCancellation("s1::c#0", undefined, "fixer-1");
	void handle.run(0, context, (ctx) => {
		ctx.emitUpdate?.({
			cancelId: "s1::c#0",
			nodeId: "node-a",
			nodeLabel: "Node1",
			iterations: 2,
		});
		return new Promise(() => {});
	});
	await handle.run(1, context, async () => ({
		finishReason: "error",
		text: "Tool editor failed: bad input",
	}));
	handle.close();
	return { rounds, handle, control };
}

describe("requeue_agent", () => {
	it("moves a slow agent off its node, keeping its transcript", async () => {
		await round();
		const requeue = vi
			.spyOn(subagentCancellation, "requeue")
			.mockReturnValue(true);
		const actions: string[] = [];
		const text = await run(
			"requeue_agent",
			{ agent_id: "fixer-1", reason: "slow" },
			actions,
		);
		expect(requeue).toHaveBeenCalledWith("s1::c#0", {
			reason: "slow",
			avoidNodeId: "node-a",
		});
		expect(text).toBe(
			"Requeued r1-1 fixer-1 (slow): it stops at its next turn boundary and goes back in the queue with its transcript, placed anywhere but Node1 when another node has room.",
		);
		expect(actions).toEqual([text]);
	});

	it("leaves the node alone when the reason is not the node's", async () => {
		await round();
		const requeue = vi
			.spyOn(subagentCancellation, "requeue")
			.mockReturnValue(true);
		await run("requeue_agent", { agent_id: "r1-1", reason: "rebalance" });
		expect(requeue).toHaveBeenCalledWith("s1::c#0", { reason: "rebalance" });
	});

	it("says a finished agent is not running, and what runs it again", async () => {
		await round();
		expect(await run("requeue_agent", { agent_id: "r1-2" })).toBe(
			"r1-2 fixer-2 is failed, not running: nothing to requeue. restart_agent or retry_failed runs it again.",
		);
	});

	it("names the agents there are when it is given one that is not", async () => {
		await round();
		expect(await run("requeue_agent", { agent_id: "r9-1" })).toBe(
			'No agent "r9-1" in this session. Agents of the latest rounds: r1-1, r1-2; agents_status lists them all.',
		);
	});
});

describe("restart_agent", () => {
	it("starts a running agent over with the lead's instructions", async () => {
		await round();
		const restart = vi.spyOn(subagentCancellation, "restart");
		const text = await run("restart_agent", {
			agent_id: "fixer-1",
			instructions: "Use the formatter.",
		});
		expect(restart).toHaveBeenCalledWith("s1::c#0", {
			instructions: "Use the formatter.",
		});
		expect(text).toContain(
			"Restarted r1-1 fixer-1 with your revised instructions",
		);
		expect(roundsFor("s1").get("r1")?.agents[0]?.revisedInstructions).toBe(
			"Use the formatter.",
		);
	});

	it("runs a finished agent again from its task", async () => {
		const { rounds } = await round();
		const tasks: string[] = [];
		rounds.registerRunner("spawn_agent", async ({ task }) => {
			tasks.push(task);
			return { finishReason: "completed", text: "done" };
		});
		const text = await run("restart_agent", {
			agent_id: "r1-2",
			instructions: "Check the input first.",
		});
		expect(text).toContain("round r1 reports again when it ends");
		await vi.waitFor(() => expect(tasks).toHaveLength(1));
		expect(tasks[0]).toBe(
			"fix b.js\n\n# Revised instructions from the lead\n\nCheck the input first.",
		);
	});
});

describe("resume_agent", () => {
	it("continues an agent waiting at its cap with more iterations", async () => {
		const rounds = roundsFor("s1");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: true,
			agents: [{ name: "slow", task: "t" }],
		});
		let granted: Promise<number> | undefined;
		void handle.run(0, context, (ctx) => {
			const control = registerSubagentCancellation("s1::w", undefined, "slow");
			ctx.emitUpdate?.({ cancelId: "s1::w", maxIterations: 30 });
			granted = control.awaitLead();
			return new Promise(() => {});
		});
		const text = await run("resume_agent", {
			agent_id: "slow",
			extra_iterations: 10,
		});
		expect(text).toBe(
			"Resumed r1-1 slow with 10 more iterations (cap now 40).",
		);
		await expect(granted).resolves.toBe(10);
	});

	it("refuses an agent that is not waiting, and a count that is not one", async () => {
		await round();
		expect(
			await run("resume_agent", { agent_id: "fixer-1", extra_iterations: 5 }),
		).toBe(
			"r1-1 fixer-1 is running, not waiting at its iteration cap: there is nothing to resume.",
		);
		expect(
			await run("resume_agent", { agent_id: "fixer-1", extra_iterations: 0 }),
		).toContain("at least 1");
	});
});

describe("retry_failed", () => {
	it("runs the round's failed agents again from their stored tasks", async () => {
		const { rounds } = await round();
		const tasks: string[] = [];
		rounds.registerRunner("spawn_agent", async ({ task }) => {
			tasks.push(task);
			return { finishReason: "completed", text: "fixed" };
		});
		const text = await run("retry_failed", { round_id: "r1" });
		expect(text).toBe(
			"Running again from their tasks: r1-2 fixer-2. Round r1 reports again when they finish.",
		);
		await vi.waitFor(() => expect(tasks).toEqual(["fix b.js"]));
	});

	it("says so when there is nothing to retry", async () => {
		await round();
		expect(
			await run("retry_failed", { round_id: "r1", agent_ids: ["fixer-1"] }),
		).toBe("Round r1 has no such failed or cancelled agents to run again.");
		expect(await run("retry_failed", { round_id: "r5" })).toBe(
			"No round r5. Rounds: r1.",
		);
	});
});

describe("message_agents and stop_agents from the lead's turn", () => {
	it("reach an agent by its round id", async () => {
		const { control } = await round();
		expect(
			await run("message_agents", {
				text: "Skip the tests.",
				agents: ["r1-1"],
			}),
		).toBe("Sent to 1 agent(s): r1-1 fixer-1.");
		expect(control.takeMessage()).toBe("Skip the tests.");
	});

	it("stop as the lead, and say which were not running", async () => {
		const { control } = await round();
		expect(await run("stop_agents", { agents: ["r1-1", "r1-2"] })).toBe(
			"Stopped 1 agent(s): r1-1 fixer-1. Not stopped: r1-2 fixer-2 (not running).",
		);
		expect(control.signal?.aborted).toBe(true);
		expect(subagentCancellation.stoppedBy("s1::c#0")).toBe("lead");
	});
});
