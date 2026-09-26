import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetAgentRounds,
	AgentRounds,
	agentFacts,
	classifyAgentEnd,
	roundsFor,
} from "./agent-rounds";
import {
	__resetSubagentCancellations,
	registerSubagentCancellation,
	subagentCancellation,
} from "./subagent-cancellation";

afterEach(() => {
	__resetAgentRounds();
	__resetSubagentCancellations();
});

const context = { agentId: "lead", iteration: 1, sessionId: "s1" } as never;

/**
 * The lead's evaluation of the 75-agent swarm: once its history was
 * compacted it no longer had the tasks it had given, and it could not see why
 * an agent had stopped. Every spawn call is now a round it can come back to.
 */
describe("a round", () => {
	it("keeps every agent's original task, with an id the controls take", () => {
		const rounds = new AgentRounds("s1");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			toolCallId: "call-1",
			background: false,
			shared: { instructions: "You fix braces." },
			agents: [
				{ name: "fixer-1", task: "fix a.js" },
				{ name: "fixer-2", task: "fix b.js" },
			],
		});
		expect(handle.id).toBe("r1");
		expect(handle.record.agents.map((agent) => [agent.id, agent.task])).toEqual(
			[
				["r1-1", "fix a.js"],
				["r1-2", "fix b.js"],
			],
		);
		expect(rounds.findAgent("fixer-2")?.agent.id).toBe("r1-2");
		expect(rounds.findAgent("r1-1")?.agent.name).toBe("fixer-1");
	});

	it("follows an agent through the queue, a wait on infrastructure, and its end", async () => {
		const rounds = new AgentRounds("s1");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: false,
			agents: [{ name: "a", task: "t" }],
		});
		const seen: string[] = [];
		const output = await handle.run(0, context, async (ctx) => {
			const agent = handle.agent(0);
			ctx.emitUpdate?.({ queued: true });
			seen.push(agent?.state ?? "");
			ctx.emitUpdate?.({
				queued: false,
				nodeId: "node-1",
				nodeLabel: "Node1",
				providerId: "opencoti",
				modelId: "qwen",
				contextWindow: 65_536,
				maxIterations: 40,
			});
			seen.push(agent?.state ?? "");
			ctx.emitUpdate?.({
				waiting: {
					kind: "refusal",
					where: "Node1",
					detail: "projected mean tps below floor",
				},
			});
			seen.push(agent?.state ?? "");
			expect(agent?.waiting?.detail).toBe("projected mean tps below floor");
			ctx.emitUpdate?.({ waiting: null });
			seen.push(agent?.state ?? "");
			ctx.emitUpdate?.({ iterations: 3, inputTokens: 900, outputTokens: 80 });
			ctx.emitUpdate?.({
				compactions: 1,
				compactionsByCause: { pressure: 1 },
				activity: { text: "Compacted its context (KV pressure on the server)" },
			});
			ctx.emitUpdate?.({ genTps: 12.5, latestOutput: "working on it" });
			return {
				text: "fixed",
				finishReason: "completed",
				iterations: 3,
				usage: { inputTokens: 1000, outputTokens: 90 },
			};
		});
		expect(output.text).toBe("fixed");
		expect(seen).toEqual(["queued", "running", "waiting_infra", "running"]);
		const agent = handle.agent(0);
		expect(agent).toMatchObject({
			state: "done",
			stopReason: "completed",
			nodeLabel: "Node1",
			modelId: "qwen",
			contextWindow: 65_536,
			iterations: 3,
			maxIterations: 40,
			inputTokens: 1000,
			outputTokens: 90,
			compactions: 1,
			compactionsByCause: { pressure: 1 },
			genTps: 12.5,
		});
		expect(agent?.activity.map((line) => line.text)).toContain(
			"Compacted its context (KV pressure on the server)",
		);
		expect(agentFacts(handle.record, agent as never)).toMatchObject({
			id: "r1-1",
			round: "r1",
			state: "done",
			stopReason: "completed",
			compactions: { count: 1, byCause: { pressure: 1 } },
			node: "Node1",
		});
	});

	it("does not settle while its opener is still launching", async () => {
		const rounds = new AgentRounds("s1");
		const handle = rounds.open({
			kind: "swarm",
			tool: "spawn_swarm",
			background: true,
			agents: [
				{ name: "w1", task: "t" },
				{ name: "w2", task: "t" },
			],
		});
		const settled: string[] = [];
		rounds.onSettled((round) => settled.push(round.record.id));
		await handle.run(0, context, async () => ({ finishReason: "completed" }));
		expect(handle.record.status).toBe("running");
		expect(settled).toEqual([]);
		await handle.run(1, context, async () => ({ finishReason: "completed" }));
		handle.close();
		expect(handle.record.status).toBe("done");
		expect(settled).toEqual(["r1"]);
	});

	it("hands its report to whoever awaits it rather than delivering it", async () => {
		const rounds = new AgentRounds("s1");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: true,
			agents: [{ name: "a", task: "t" }],
		});
		const delivered: string[] = [];
		rounds.onSettled((round) => delivered.push(round.record.id));
		let finish: () => void = () => {};
		const running = handle.run(
			0,
			context,
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ text: "ok", finishReason: "completed" });
				}),
		);
		handle.close();
		const waited = rounds.waitFor(["r1"]);
		finish();
		await running;
		const [round] = await waited;
		expect(round?.delivered).toBe(true);
		expect(delivered).toEqual([]);
	});
});

describe("why an agent stopped", () => {
	it("names the iteration cap", () => {
		expect(
			classifyAgentEnd({ finishReason: "max_iterations" }, undefined, false),
		).toMatchObject({ state: "failed", reason: "iteration_cap" });
	});

	it("names who cancelled it", () => {
		expect(
			classifyAgentEnd({ finishReason: "aborted" }, "lead", false),
		).toMatchObject({ state: "cancelled", reason: "cancelled_by_lead" });
		expect(
			classifyAgentEnd({ finishReason: "aborted" }, "user", false),
		).toMatchObject({ state: "cancelled", reason: "cancelled_by_user" });
		expect(
			classifyAgentEnd(
				{ thrown: new DOMException("aborted", "AbortError") },
				undefined,
				true,
			),
		).toMatchObject({ state: "cancelled", reason: "cancelled_by_session" });
	});

	// Swarm 0926: 9 agents stopped by the loop guard read as cancelled.
	it("calls its own guard's stop a failure, not a cancel", () => {
		expect(
			classifyAgentEnd(
				{ error: "Aborted by the repeated-call loop guard" },
				undefined,
				false,
			),
		).toMatchObject({ state: "failed", reason: "mistake_limit" });
		expect(
			classifyAgentEnd({ finishReason: "aborted", text: "" }, undefined, false),
		).toMatchObject({ state: "failed", reason: "mistake_limit" });
	});

	it("tells a context overflow from an engine error and from its own failure", () => {
		expect(
			classifyAgentEnd(
				{
					finishReason: "error",
					text: "prompt is too long: exceeds the maximum context length",
				},
				undefined,
				false,
			),
		).toMatchObject({ state: "failed", reason: "context_overflow" });
		expect(
			classifyAgentEnd(
				{ finishReason: "error", text: "502 Bad Gateway" },
				undefined,
				false,
			),
		).toMatchObject({ state: "failed", reason: "engine_error" });
		expect(
			classifyAgentEnd(
				{ finishReason: "error", text: "Tool editor failed: bad input" },
				undefined,
				false,
			),
		).toMatchObject({ state: "failed", reason: "task_error" });
	});
});

describe("a round persisted with the session", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("comes back after a reload, running agents as interrupted", async () => {
		dir = mkdtempSync(join(tmpdir(), "rounds-"));
		const path = join(dir, "s1.rounds.json");
		const before = new AgentRounds("s1");
		before.attachStore(path);
		const handle = before.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: false,
			shared: { knowledge: { files: ["a.js"] } },
			agents: [
				{ name: "done-one", task: "first" },
				{ name: "running-one", task: "second" },
			],
		});
		await handle.run(0, context, async () => ({ finishReason: "completed" }));
		void handle.run(1, context, () => new Promise(() => {}));
		before.flush();
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);

		const after = new AgentRounds("s1");
		after.attachStore(path);
		const round = after.get("r1");
		expect(round?.shared.knowledge?.files).toEqual(["a.js"]);
		expect(round?.agents.map((agent) => [agent.task, agent.state])).toEqual([
			["first", "done"],
			["second", "cancelled"],
		]);
		expect(round?.agents[1]?.stopReason).toBe("interrupted");
		// The next call gets the next id, not a clash.
		const next = after.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: false,
			agents: [{ name: "x", task: "y" }],
		});
		expect(next.id).toBe("r2");
	});

	it("runs a failed agent again from its stored task, after its call is gone", async () => {
		const rounds = roundsFor("s1");
		const tasks: string[] = [];
		rounds.registerRunner("spawn_agent", async ({ task, agent }) => {
			tasks.push(`${agent.id}: ${task}`);
			return { text: "second time lucky", finishReason: "completed" };
		});
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: false,
			agents: [{ name: "a", task: "the original task" }],
		});
		await handle.run(0, context, async () => ({
			finishReason: "error",
			text: "Tool editor failed",
		}));
		handle.delivered();
		handle.close();
		expect(handle.record.agents[0]?.state).toBe("failed");

		const started = rounds.rerun("r1", 0, context, {
			instructions: "Use the formatter.",
		});
		expect(started.started).toBe(true);
		await rounds.waitFor(["r1"]);
		expect(tasks).toEqual([
			"r1-1: the original task\n\n# Revised instructions from the lead\n\nUse the formatter.",
		]);
		expect(rounds.get("r1")?.agents[0]).toMatchObject({
			state: "done",
			attempts: 2,
		});
	});

	it("records who stopped an agent, after its control is gone", async () => {
		const rounds = new AgentRounds("s1");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: false,
			agents: [{ name: "a", task: "t" }],
		});
		await handle.run(0, context, async (ctx) => {
			const control = registerSubagentCancellation("s1::call", undefined, "a");
			ctx.emitUpdate?.({ cancelId: "s1::call" });
			subagentCancellation.cancel("s1::call", "lead");
			control.release();
			return { finishReason: "aborted" };
		});
		expect(handle.agent(0)?.stopReason).toBe("cancelled_by_lead");
	});
});
