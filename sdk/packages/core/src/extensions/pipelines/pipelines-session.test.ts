import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskGraphStore } from "../tools/task-graph/store";
import { TaskGraphTracker } from "../tools/task-graph/tracker";
import type { PipelineDefinition } from "./model";
import { PipelineSession, type PipelineSessionOptions } from "./session";
import { createPipelineTool } from "./tool";
import {
	approvePipeline,
	findPipeline,
	listPipelines,
	savePipeline,
} from "./workspace";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pipelines-ws-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const echoTool = createTool<unknown, unknown>({
	name: "echo_tool",
	description: "echo",
	inputSchema: { type: "object" },
	execute: async (input) => ({ echoed: input }),
});

function session(extra: Partial<PipelineSessionOptions> = {}) {
	return new PipelineSession({
		workspaceRoot: root,
		sessionId: "s1",
		tools: () => [echoTool as AgentTool],
		pollMs: 5,
		...extra,
	});
}

async function call(
	tool: ReturnType<typeof createPipelineTool>,
	input: Record<string, unknown>,
) {
	const [result] = await tool.execute(input, { agentId: "lead", iteration: 1 });
	return result as { result: string; success: boolean };
}

const until = async (check: () => boolean) => {
	for (let i = 0; i < 400 && !check(); i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
};

const simple: PipelineDefinition = {
	name: "Say hello",
	nodes: [
		{ id: "greet", type: "command", command: "echo hello-{{ $vars.who }}" },
		{
			id: "note",
			type: "tool",
			after: ["greet"],
			tool: "echo_tool",
			input: { line: "{{ trim($node.greet.stdout) }}" },
		},
	],
	inputs: { who: { type: "string", default: "world" } },
};

describe("pipelines in the workspace", () => {
	it("a saved file is a proposal; only an approved version runs; a stale save is refused", async () => {
		const saved = savePipeline(root, simple);
		expect(saved.ok).toBe(true);
		const s = session();
		expect(() => s.run("say hello")).toThrow(/has not been approved/);
		const approved = approvePipeline(root, "Say hello", "manni");
		expect(approved.isApproved).toBe(true);
		const result = await s.run("say-hello").result();
		expect(result.status).toBe("done");
		// A change after approval is a new version: refused until approved again.
		const stale = savePipeline(root, { ...simple, description: "changed" });
		expect(stale.ok).toBe(false);
		const resaved = savePipeline(
			root,
			{ ...simple, description: "changed" },
			approved.hash,
		);
		expect(resaved.ok).toBe(true);
		expect(() => s.run("say hello")).toThrow(
			/changed since the version the person approved/,
		);
		expect(
			listPipelines(root).map((file) => [file.slug, file.isApproved]),
		).toEqual([["say-hello", false]]);
	});

	it("a file that does not validate is listed with its problems and cannot be approved", () => {
		savePipeline(root, simple);
		writeFileSync(
			join(root, ".cerebriline", "pipelines", "broken.pipeline.json"),
			'{"name":"broken","nodes":[{"id":"a","type":"nope"}]}',
		);
		expect(findPipeline(root, "broken")?.valid).toBe(false);
		expect(() => approvePipeline(root, "broken")).toThrow(/does not validate/);
	});
});

describe("the pipeline tool", () => {
	it("catalog, save, validate, list, show, run, status and runs", async () => {
		const s = session();
		const tool = createPipelineTool(s, root);
		expect((await call(tool, { action: "catalog" })).result).toContain(
			"loop: over (a list)",
		);
		const bad = await call(tool, {
			action: "validate",
			pipeline: {
				name: "x",
				nodes: [
					{ id: "a", type: "if", when: "1" },
					{ id: "b", type: "set", after: ["a"] },
				],
			},
		});
		expect(bad.success).toBe(false);
		expect(bad.result).toContain(
			'must name which output: "a.true" or "a.false"',
		);
		const saved = await call(tool, {
			action: "save",
			pipeline: JSON.stringify(simple),
		});
		expect(saved.result).toContain("It is a proposal");
		expect((await call(tool, { action: "list" })).result).toContain(
			"Say hello (say-hello, version",
		);
		expect(
			(await call(tool, { action: "show", name: "say hello" })).result,
		).toContain("note (tool after greet)");
		const refused = await call(tool, { action: "run", name: "say hello" });
		expect(refused.success).toBe(false);
		expect(refused.result).toContain("ask the person to approve it");
		approvePipeline(root, "say hello");
		const started = await call(tool, {
			action: "run",
			name: "say hello",
			inputs: { who: "there" },
		});
		expect(started.result).toContain("Started say-hello-1");
		await s.get("say-hello-1")?.result();
		const status = await call(tool, { action: "status", run: "say-hello-1" });
		expect(status.result).toContain("say-hello-1 (Say hello): done");
		expect((await call(tool, { action: "runs" })).result).toContain(
			"say-hello-1: done",
		);
		expect((await call(tool, { action: "nope" })).success).toBe(false);
	});

	it("test refuses side effects unless pinned, then runs with pins and opens waits at once", async () => {
		const s = session();
		const tool = createPipelineTool(s, root);
		const risky: PipelineDefinition = {
			name: "risky",
			nodes: [
				{ id: "push", type: "command", command: "git push" },
				{ id: "ask", type: "approval", after: ["push"], message: "ok?" },
				{ id: "wait", type: "wait", after: ["ask.approve"], gate: "timer:+1d" },
			],
		};
		const refused = await call(tool, { action: "test", pipeline: risky });
		expect(refused.success).toBe(false);
		expect(refused.result).toContain("push would run for real");
		const pinned = {
			...risky,
			nodes: [
				{ ...risky.nodes[0], pin: [{ exit: 0 }] },
				...risky.nodes.slice(1),
			],
		} as PipelineDefinition;
		const ran = await call(tool, { action: "test", pipeline: pinned });
		expect(ran.success).toBe(true);
		expect(ran.result).toContain("- wait: done");
	});
});

describe("the session host", () => {
	it("a tool switched off is refused; one that needs approval asks, and a no fails the node", async () => {
		savePipeline(root, simple);
		approvePipeline(root, "say hello");
		const off = await session({
			toolPolicies: { echo_tool: { enabled: false } },
		})
			.run("say hello")
			.result();
		expect(off.error).toContain("echo_tool is switched off for this session");
		const asked: string[] = [];
		const denied = await session({
			toolPolicies: { run_commands: { autoApprove: false } },
			requestApproval: async (request) => {
				asked.push(`${request.toolName}:${JSON.stringify(request.input)}`);
				return { approved: false, reason: "not today" };
			},
		})
			.run("say hello")
			.result();
		expect(asked).toEqual(['run_commands:{"commands":["echo hello-world"]}']);
		expect(denied.error).toContain(
			"the person did not approve run_commands: not today",
		);
	});

	it("an approval is a human gate on a task the run makes for it, gone when the run ends: Resolve approves, removing it rejects", async () => {
		const board = new TaskGraphStore();
		savePipeline(root, {
			name: "Gated",
			nodes: [
				{ id: "ask", type: "approval", message: "Ship it?" },
				{
					id: "yes",
					type: "set",
					after: ["ask.approve"],
					fields: { shipped: true },
				},
				{
					id: "no",
					type: "set",
					after: ["ask.reject"],
					fields: { shipped: false },
				},
			],
		});
		approvePipeline(root, "gated");
		for (const answer of ["resolve", "remove"] as const) {
			const s = session({ board });
			const run = s.run("gated");
			const asking = () =>
				[...board.getState().tasks.values()].find((entry) =>
					entry.gates.some((gate) => gate.spec === "human:Ship it?"),
				);
			await until(() => !!asking());
			const task = asking()?.id as string;
			expect(board.getState().tasks.get(task)?.title).toMatch(/^▶ Gated #/);
			expect(board.getState().tasks.get(task)?.status).toBe("waiting");
			board.update(
				{
					updates: [
						{
							id: task,
							...(answer === "resolve"
								? { gate_open: ["human:Ship it?"] }
								: { gate_remove: ["human:Ship it?"] }),
						},
					],
				},
				{ by: "user" },
			);
			await run.result();
			const view = run.view();
			expect(
				view.nodes.find(
					(node) => node.id === (answer === "resolve" ? "yes" : "no"),
				)?.status,
			).toBe("done");
			expect(board.getState().tasks.has(task)).toBe(false);
		}
		expect(board.getState().order).toEqual([]);
	});

	it("an approval in a run for a task asks on that task, which keeps waiting on the run", async () => {
		const board = new TaskGraphStore();
		savePipeline(root, {
			name: "Gated",
			nodes: [{ id: "ask", type: "approval", message: "Ship it?" }],
		});
		approvePipeline(root, "gated");
		board.plan(
			{ tasks: [{ title: "Ship", gate: ["use-pipeline:gated"] }] },
			{ by: "person" },
		);
		const run = session({ board }).run("gated");
		const ship = () => board.getState().tasks.get("T1");
		await until(
			() =>
				ship()?.gates.some((gate) => gate.spec === "human:Ship it?") ?? false,
		);
		expect(board.getState().order).toEqual(["T1"]);
		board.update(
			{ updates: [{ id: "T1", gate_open: ["human:Ship it?"] }] },
			{ by: "user" },
		);
		for (
			let i = 0;
			i < 200 && ship()?.gates.some((g) => g.spec === "human:Ship it?");
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		// The answer came off; the task still waits on the run, not active by the run's hand.
		expect(ship()?.gates.map((gate) => gate.spec)).toEqual([
			`pipeline:${run.id}`,
		]);
		await run.result();
		expect(board.getState().order).toEqual(["T1"]);
		expect(ship()?.claimedBy).toBeUndefined();
	});

	it("run with a task: the task waits on the run, and the model is told when it ends", async () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [{ title: "Busy" }, { title: "Use the result" }],
		});
		savePipeline(root, simple);
		approvePipeline(root, "say hello");
		const s = session({
			board: tracker.store,
			onRunEnded: (_run, lines) => tracker.notePipelineEnded(lines),
		});
		const run = s.run("say hello", {}, "T2");
		expect(tracker.store.getState().tasks.get("T2")?.gates[0]?.spec).toBe(
			"pipeline:say-hello-1",
		);
		await run.result();
		await until(
			() => tracker.store.getState().tasks.get("T2")?.gates[0]?.open === true,
		);
		const told = tracker.takePendingReminder() ?? "";
		expect(told).toContain("A pipeline run ended.");
		expect(told).toContain("T2: pipeline:say-hello-1 opened.");
	});
});

describe("pipeline wait", () => {
	// Phase 5's smoke (deepseek-v4.1-flash, pgate): the model gated its task on the
	// run and then waited with `sleep 60` in the shell, the only wait it had.
	const slow = (seconds: number): PipelineDefinition => ({
		name: "Slow",
		nodes: [
			{
				id: "nap",
				type: "command",
				command: `sleep ${seconds} && echo rested`,
			},
		],
	});

	it("returns when the run ends, with how it ended", async () => {
		savePipeline(root, slow(0.3));
		approvePipeline(root, "slow");
		const tool = createPipelineTool(session(), root);
		const started = await call(tool, { action: "run", name: "slow" });
		const runId = /Started (\S+?)[ :]/.exec(started.result)?.[1] as string;
		expect(runId).toBeTruthy();
		const waited = await call(tool, {
			action: "wait",
			run: runId,
			timeout: 20,
		});
		expect(waited.success).toBe(true);
		expect(waited.result).toContain(`${runId} (Slow): done`);
		expect(waited.result).toContain("- nap: done");
	});

	it("gives up after its timeout and says the run is still going", async () => {
		savePipeline(root, slow(3));
		approvePipeline(root, "slow");
		const s = session();
		const tool = createPipelineTool(s, root);
		const started = await call(tool, { action: "run", name: "slow" });
		const runId = /Started (\S+?)[ :]/.exec(started.result)?.[1] as string;
		const at = Date.now();
		const waited = await call(tool, { action: "wait", run: runId, timeout: 1 });
		expect(Date.now() - at).toBeLessThan(2500);
		expect(waited.result).toContain("is still running after 1 s");
		s.stop(runId);
	});

	it("refuses a run it does not know", async () => {
		const tool = createPipelineTool(session(), root);
		const missing = await call(tool, { action: "wait", run: "nope-1" });
		expect(missing.success).toBe(false);
	});
});
