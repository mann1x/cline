import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachTaskBoard } from "./attach";
import { savePipeline } from "./pipelines/workspace";
import { TASK_BOARD_RULES_HEADING } from "./task-graph/tracker";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "attach-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const ctx = { agentId: "lead", iteration: 1 } as never;
const named = (tools: AgentTool[], name: string) => {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`no ${name}`);
	return tool;
};

describe("attachTaskBoard", () => {
	it("gives a loop the board: rules, tools, and a guard on open tasks", async () => {
		const board = attachTaskBoard({ sessionId: "s1", workspaceRoot: root });
		expect(board.systemPrompt("You are a helpful agent.")).toContain(
			TASK_BOARD_RULES_HEADING,
		);
		const tools = board.tools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"task_plan",
			"task_update",
			"task_view",
		]);
		await named(tools, "task_plan").execute(
			{
				tasks: [
					{ title: "Write the parser", acceptance: ["`npm test` passes"] },
					{ title: "Document it", depends: ["#1"] },
				],
			},
			ctx,
		);
		const snapshot = board.control.snapshot();
		expect(snapshot.tasks.map((task) => task.title)).toEqual([
			"Write the parser",
			"Document it",
		]);
		// Open tasks: the run is asked to go on.
		expect(board.completionGuard()()).toBeTruthy();
	});

	it("tells the model what the person changed, at the next run", () => {
		const board = attachTaskBoard({ sessionId: "s1" });
		board.control.edit({
			op: "plan",
			tasks: [{ title: "Added by the person" }],
		});
		expect(board.runStartNote()).toContain("Added by the person");
		// Told once.
		expect(board.runStartNote() ?? "").not.toContain("Added by the person");
	});

	it("keeps the board in its log, so a reopened conversation has it again", async () => {
		const logPath = join(root, "s1.tasks.jsonl");
		const first = attachTaskBoard({ sessionId: "s1", logPath });
		await named(first.tools(), "task_plan").execute(
			{ tasks: [{ title: "Survive a reload" }] },
			ctx,
		);
		const second = attachTaskBoard({ sessionId: "s1", logPath });
		expect(second.control.snapshot().tasks.map((task) => task.title)).toEqual([
			"Survive a reload",
		]);
	});

	it("adds pipelines only when asked, with a workspace, and not in plan mode", async () => {
		expect(
			attachTaskBoard({ sessionId: "s1", workspaceRoot: root }).pipelines,
		).toBeUndefined();
		expect(
			attachTaskBoard({ sessionId: "s1", pipelines: {} }).pipelines,
		).toBeUndefined();
		expect(
			attachTaskBoard({
				sessionId: "s1",
				workspaceRoot: root,
				planMode: true,
				pipelines: {},
			}).pipelines,
		).toBeUndefined();

		const echo = createTool({
			name: "echo_tool",
			description: "echo",
			inputSchema: { type: "object", properties: { line: { type: "string" } } },
			execute: async (input: { line?: string }) => ({ echoed: input.line }),
		}) as AgentTool;
		const board = attachTaskBoard({
			sessionId: "s1",
			workspaceRoot: root,
			pipelines: { pollMs: 5, agentToolName: (agent) => `my_${agent}` },
		});
		board.setTools(() => [echo]);
		expect(board.tools().map((tool) => tool.name)).toContain("pipeline");
		expect(board.systemPrompt("Base.")).not.toBe(
			attachTaskBoard({ sessionId: "s1" }).systemPrompt("Base."),
		);
		savePipeline(root, {
			name: "Say",
			nodes: [
				{ id: "say", type: "tool", tool: "echo_tool", input: { line: "hi" } },
			],
		});
		// A saved pipeline is a proposal: `test` runs it; the tool is the session's.
		const result = (await named(board.tools(), "pipeline").execute(
			{ action: "test", name: "Say", allowSideEffects: true },
			ctx,
		)) as unknown;
		expect(JSON.stringify(result)).toContain("hi");
		expect(board.pipelineControl?.sessionId).toBe("s1");
	});

	it("puts a team runtime's tasks on the board when it can take one", () => {
		let given: unknown;
		const board = attachTaskBoard({
			sessionId: "s1",
			team: {
				useTaskBoard: (teamBoard) => {
					given = teamBoard;
				},
			},
		});
		expect(given).toBeDefined();
		const task = (given as { create(input: unknown): { id: string } }).create({
			title: "A teammate's task",
		});
		expect(board.control.snapshot().tasks.map((entry) => entry.id)).toContain(
			task.id,
		);
	});
});
