import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderBoard } from "./board";
import { readPlanInput, readUpdateInput } from "./readers";
import { TaskGraphStore } from "./store";
import { createTaskGraphTools } from "./tools";
import { TaskGraphTracker, withTaskGraphCapture } from "./tracker";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "task-graph-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ids = (store: TaskGraphStore) => store.getState().order;
const task = (store: TaskGraphStore, id: string) =>
	store.getState().tasks.get(id);

/** A history holding the given tool calls, in the persisted shape. */
function history(
	calls: Array<{ id: string; name: string; input: unknown }>,
	extra: unknown[] = [],
) {
	return [
		{ role: "user", content: [{ type: "text", text: "do it" }] },
		...extra,
		...calls.map((call) => ({
			role: "assistant",
			content: [
				{ type: "tool_use", id: call.id, name: call.name, input: call.input },
			],
		})),
	];
}

describe("task_plan", () => {
	it("creates a whole plan with batch-local refs, in one call", () => {
		const store = new TaskGraphStore();
		const outcome = store.plan({
			tasks: [
				{ title: "Read the code" },
				{
					title: "Store cents",
					depends: ["#1"],
					acceptance: ["old files load"],
				},
				{ title: "Add tags", depends: ["#1"] },
				{ title: "Report", depends: ["#2", "#3"] },
				{ title: "Subtask of report", parent: "#4" },
			],
		});
		expect(ids(store)).toEqual(["T1", "T2", "T3", "T4", "T4.1"]);
		expect(task(store, "T4")?.depends).toEqual(["T2", "T3"]);
		expect(task(store, "T2")?.acceptance).toEqual([
			{ text: "old files load", done: false },
		]);
		expect(outcome.lines.join("\n")).toContain("Order: T1 → T2, T3 → T4, T4.1");
		// The subtask waits on what its parent waits on.
		expect(outcome.readyNow).toEqual(["T1"]);
	});

	it("refuses a forward batch ref, and says so", () => {
		const store = new TaskGraphStore();
		const outcome = store.plan({
			tasks: [{ title: "A", depends: ["#2"] }, { title: "B" }],
		});
		expect(task(store, "T1")?.depends).toEqual([]);
		expect(outcome.lines.join("\n")).toMatch(/"#2" on item 1 ignored/);
	});

	it("does not start a task whose dependency is open", () => {
		const store = new TaskGraphStore();
		const outcome = store.plan({
			tasks: [{ title: "A" }, { title: "B", depends: ["#1"], start: true }],
		});
		expect(task(store, "T2")?.status).toBe("pending");
		expect(outcome.lines.join("\n")).toContain(
			"T2 not started: it is after T1",
		);
	});

	it("never reuses an id, a cancelled task included", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }] });
		store.update({
			updates: [{ id: "T1", status: "cancelled", note: "not needed" }],
		});
		store.plan({ tasks: [{ title: "B" }] });
		expect(ids(store)).toEqual(["T1", "T2"]);
	});
});

describe("task_update", () => {
	it("refuses to start a blocked task and names what it waits on", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }, { title: "B", depends: ["#1"] }] });
		const outcome = store.update({ updates: [{ id: "T2", status: "active" }] });
		expect(task(store, "T2")?.status).toBe("pending");
		expect(outcome.lines.join("\n")).toContain("it is after T1");
	});

	it("reports what a close made ready", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }, { title: "B", depends: ["#1"] }] });
		const outcome = store.update({
			updates: [{ id: "T1", status: "done", note: "read it" }],
		});
		expect(outcome.readyNow).toEqual(["T2"]);
		expect(outcome.lines.join("\n")).toContain("Ready now: T2 B");
		expect(task(store, "T1")?.outcome).toBe("read it");
	});

	it("refuses a dependency that would close a loop", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }, { title: "B", depends: ["#1"] }] });
		const outcome = store.update({
			updates: [{ id: "T1", depends_add: ["T2"] }],
		});
		expect(task(store, "T1")?.depends).toEqual([]);
		expect(outcome.lines.join("\n")).toContain("would be a loop");
	});

	it("asks for an outcome and names unticked acceptance, without refusing", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A", acceptance: ["tests pass", "docs"] }] });
		const outcome = store.update({
			updates: [{ id: "T1", status: "done", check: [1] }],
		});
		expect(task(store, "T1")?.status).toBe("done");
		const text = outcome.lines.join("\n");
		expect(text).toContain("closed without an outcome");
		expect(text).toContain('unticked acceptance: "docs"');
	});

	it("ticks acceptance by number, by text, and all at once", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [{ title: "A", acceptance: ["one", "two", "three"] }],
		});
		store.update({ updates: [{ id: "T1", check: ["two"] }] });
		expect(task(store, "T1")?.acceptance.map((a) => a.done)).toEqual([
			false,
			true,
			false,
		]);
		store.update({ updates: [{ id: "T1", check: true }] });
		expect(task(store, "T1")?.acceptance.every((a) => a.done)).toBe(true);
	});

	it("refuses a subtask waiting on its own parent, which could never open", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [
				{ title: "P" },
				{ title: "child", parent: "#1", depends: ["#1"] },
			],
		});
		expect(task(store, "T1.1")?.depends).toEqual([]);
		const outcome = store.update({
			updates: [{ id: "T1.1", depends_add: ["T1"] }],
		});
		expect(task(store, "T1.1")?.depends).toEqual([]);
		expect(outcome.lines.join("\n")).toContain(
			"cannot wait on a task it is part of",
		);
	});

	it("names an unknown id instead of dropping the update", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }] });
		const outcome = store.update({ updates: [{ id: "T9", status: "done" }] });
		expect(outcome.changed).toBe(false);
		expect(outcome.lines.join("\n")).toContain("T9: no such task (tasks: T1)");
	});
});

describe("lenient readers: nothing is dropped silently", () => {
	// Shapes models send: single objects for arrays, JSON strings, markdown
	// lists, other spellings of status and id, and keys the schema lacks.
	const planShapes: unknown[] = [
		{ tasks: [{ title: "a" }] },
		{ title: "single object" },
		[{ name: "bare array, name for title" }],
		{ tasks: '[{"title":"json string"}]' },
		{ tasks: "- [ ] markdown one\n- [x] markdown two" },
		"- plain string list\n- second",
		{ tasks: ["plain", "titles"] },
		{ tasks: [{ title: "deps as text", depends: "#1, T1" }] },
		{ tasks: [{ title: "subtasks", subtasks: [{ title: "child" }] }] },
		{ tasks: [{ text: "unknown key", colour: "blue" }] },
		{ tasks: [{ description: "no title at all" }] },
		{ tasks: [42] },
		{ nothing: true },
	];
	for (const shape of planShapes) {
		it(`plan ${JSON.stringify(shape).slice(0, 60)}`, () => {
			const { items, ignored } = readPlanInput(shape);
			const store = new TaskGraphStore();
			const outcome = store.plan(shape);
			// Either something was created or the result says why not.
			expect(items.length > 0 || outcome.lines.length > 0).toBe(true);
			if (items.length === 0) expect(outcome.changed).toBe(false);
			for (const note of ignored) {
				expect(outcome.lines.join("\n")).toContain(note);
			}
		});
	}

	it("refuses a JSON string that does not parse, saying where, instead of misreading it", () => {
		// The real send from smoke run 0022: an acceptance item closed with `']"`.
		const broken = String.raw`[{"title": "Fix slugify", "acceptance": ["returns 'hello-world', not 'hello-world-']", "start": true}, {"title": "Fix truncate", "depends": ["#1"]}]`;
		const store = new TaskGraphStore();
		const outcome = store.plan({ tasks: broken });
		expect(outcome.changed).toBe(false);
		expect(ids(store)).toEqual([]);
		const text = outcome.lines.join("\n");
		expect(text).toContain("string of JSON that does not parse");
		expect(text).toContain("Send `tasks` as an array of objects");
		const update = store.update({ updates: '[{"id": "T1", "status": "done"' });
		expect(update.lines.join("\n")).toContain(
			"Send `updates` as an array of objects",
		);
	});

	it("reads subtasks as children of their item", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [{ title: "parent", subtasks: ["c1", { title: "c2" }] }],
		});
		expect(ids(store)).toEqual(["T1", "T1.1", "T1.2"]);
	});

	const updateShapes: unknown[] = [
		{ updates: [{ id: "T1", status: "completed" }] },
		{ id: "t1", status: "in_progress" },
		[{ id: "#1", state: "done", outcome: "via outcome" }],
		{ updates: '[{"id":"1","status":"Done"}]' },
		{ updates: [{ task_id: "T1", status: "blocked" }] },
		{ updates: [{ id: "T1", status: "sideways" }] },
		{ updates: [{ id: "T1", mood: "happy" }] },
		{ updates: [{ status: "done" }] },
		{ updates: ["T1"] },
	];
	for (const shape of updateShapes) {
		it(`update ${JSON.stringify(shape).slice(0, 60)}`, () => {
			const store = new TaskGraphStore();
			store.plan({ tasks: [{ title: "A" }] });
			const { ignored } = readUpdateInput(shape);
			const outcome = store.update(shape);
			expect(outcome.lines.length).toBeGreaterThan(0);
			for (const note of ignored) {
				expect(outcome.lines.join("\n")).toContain(note);
			}
		});
	}

	it("maps other words for status", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }] });
		store.update({ id: "t1", status: "in_progress" });
		expect(task(store, "T1")?.status).toBe("active");
		store.update([{ id: "#1", state: "completed", outcome: "x" }]);
		expect(task(store, "T1")?.status).toBe("done");
		expect(task(store, "T1")?.outcome).toBe("x");
	});
});

describe("the log and the conversation", () => {
	const planCall = {
		id: "c1",
		name: "task_plan",
		input: { tasks: [{ title: "A" }, { title: "B" }] },
	};
	const doneCall = {
		id: "c2",
		name: "task_update",
		input: { updates: [{ id: "T1", status: "done", note: "ok" }] },
	};
	const moreCall = {
		id: "c3",
		name: "task_plan",
		input: { tasks: [{ title: "C" }] },
	};

	function build(logPath: string) {
		const store = new TaskGraphStore({ logPath });
		store.plan(planCall.input, { call: "c1" });
		store.update(doneCall.input, { call: "c2" });
		store.plan(moreCall.input, { call: "c3" });
		return store;
	}

	it("resumes the whole log when the history has every call", () => {
		const logPath = join(dir, "s.tasks.jsonl");
		build(logPath);
		const resumed = new TaskGraphStore({ logPath });
		expect(resumed.reconcile(history([planCall, doneCall, moreCall]))).toBe(
			"resumed",
		);
		expect(ids(resumed)).toEqual(["T1", "T2", "T3"]);
		expect(task(resumed, "T1")?.status).toBe("done");
	});

	it("rewinds to the cut: events from removed calls go, and the file follows", () => {
		const logPath = join(dir, "s.tasks.jsonl");
		build(logPath);
		const rewound = new TaskGraphStore({ logPath });
		expect(rewound.reconcile(history([planCall]))).toBe("rewound");
		expect(ids(rewound)).toEqual(["T1", "T2"]);
		expect(task(rewound, "T1")?.status).toBe("pending");
		expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2);
		// The next plan gets the id the dropped one had: the cut never happened.
		rewound.plan({ tasks: [{ title: "C again" }] });
		expect(ids(rewound)).toEqual(["T1", "T2", "T3"]);
	});

	it("keeps everything after a compaction summarised the calls away", () => {
		const logPath = join(dir, "s.tasks.jsonl");
		build(logPath);
		const compacted = new TaskGraphStore({ logPath });
		const summary = {
			role: "user",
			content: [{ type: "text", text: "summary" }],
			metadata: { kind: "compaction_summary" },
		};
		expect(compacted.reconcile(history([], [summary]))).toBe("resumed");
		expect(ids(compacted)).toEqual(["T1", "T2", "T3"]);
	});

	it("empties the board when the history was cut back to before the plan", () => {
		const logPath = join(dir, "s.tasks.jsonl");
		build(logPath);
		const cut = new TaskGraphStore({ logPath });
		expect(cut.reconcile(history([]))).toBe("rewound");
		expect(ids(cut)).toEqual([]);
	});

	it("replays a forked history into the same board, with the same ids", () => {
		const original = build(join(dir, "a.tasks.jsonl"));
		const forkLog = join(dir, "b.tasks.jsonl");
		const fork = new TaskGraphStore({ logPath: forkLog });
		expect(fork.reconcile(history([planCall, doneCall, moreCall]))).toBe(
			"replayed",
		);
		expect(fork.snapshot()).toEqual(original.snapshot());
		expect(
			readFileSync(forkLog, "utf8").trim().split("\n").length,
		).toBeGreaterThan(0);
	});

	it("imports the last checklist of a conversation from before the graph", () => {
		const store = new TaskGraphStore({ logPath: join(dir, "c.tasks.jsonl") });
		expect(
			store.reconcile(history([]), [
				{ text: "fix the parser", done: true },
				{ text: "add a test", done: false },
			]),
		).toBe("imported");
		expect(ids(store)).toEqual(["T1", "T2"]);
		expect(task(store, "T1")?.status).toBe("done");
		expect(store.getEvents().every((event) => event.by === "import")).toBe(
			true,
		);
	});

	it("survives a torn last line", () => {
		const logPath = join(dir, "s.tasks.jsonl");
		build(logPath);
		const { appendFileSync } = require("node:fs") as typeof import("node:fs");
		appendFileSync(logPath, '{"op":"create","seq":9');
		const resumed = new TaskGraphStore({ logPath });
		resumed.reconcile(history([planCall, doneCall, moreCall]));
		expect(ids(resumed)).toEqual(["T1", "T2", "T3"]);
	});
});

describe("the board", () => {
	it("stays short however many tasks there are", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: Array.from({ length: 40 }, (_, i) => ({
				title: `A fairly long task title number ${i} describing some piece of work in detail`,
				...(i > 0 ? { depends: [`#${i}`] } : {}),
			})),
		});
		for (let i = 1; i <= 20; i++) {
			store.update({
				updates: [
					{
						id: `T${i}`,
						status: "done",
						note: `finished part ${i} and checked it`,
					},
				],
			});
		}
		const board = renderBoard(store.getState()) ?? "";
		// About 300 tokens at ~4 characters each.
		expect(board.length).toBeLessThan(1400);
		expect(board).toContain("Tasks: 20/40 closed");
		expect(board).toContain("+16 earlier");
	});
});

describe("tracker", () => {
	const edit = { name: "editor", input: { path: "/w/a.py", new_text: "x" } };

	it("asks for a plan on the first edit made with none", () => {
		const tracker = new TaskGraphTracker();
		tracker.recordToolCall(edit.input, edit.name);
		expect(tracker.takePendingReminder()).toContain("this task has no plan");
	});

	it("names the ready task when an edit lands with nothing active", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "Fix slugify" }] });
		tracker.recordToolCall(edit.input, edit.name);
		expect(tracker.takePendingReminder()).toContain("work on T1 (Fix slugify)");
	});

	it("says nothing while a task is active", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "A", start: true }] });
		tracker.recordToolCall(edit.input, edit.name);
		expect(tracker.takePendingReminder()).toBeUndefined();
	});

	it("withdraws the nudge when the edit failed", async () => {
		const tracker = new TaskGraphTracker();
		const tool = withTaskGraphCapture(
			{
				name: "editor",
				description: "",
				inputSchema: { type: "object" },
				execute: async () => [{ query: "q", result: "", success: false }],
			},
			tracker,
		);
		await tool.execute(edit.input, { agentId: "a", iteration: 1 });
		expect(tracker.takePendingReminder()).toBeUndefined();
	});

	it("does not touch the tool's schema", () => {
		const tracker = new TaskGraphTracker();
		const schema = { type: "object", properties: { path: { type: "string" } } };
		const tool = withTaskGraphCapture(
			{
				name: "editor",
				description: "",
				inputSchema: schema,
				execute: async () => "ok",
			},
			tracker,
		);
		expect(tool.inputSchema).toBe(schema);
	});

	it("asks twice, differently, to close open work, then stops", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [{ title: "A", start: true }, { title: "B" }],
		});
		const guard = tracker.completionGuard();
		const first = guard();
		const second = guard();
		expect(first).toContain("close out the task board");
		expect(second).toContain("last time");
		expect(first).not.toBe(second);
		expect(guard()).toBeUndefined();
	});

	it("puts the board back after a compaction", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "A" }] });
		tracker.noteCompaction();
		expect(tracker.takePendingReminder()).toContain(
			"The task board, as it stands",
		);
		expect(tracker.takePendingReminder()).toBeUndefined();
	});

	it("runs through the tools with the call id as the anchor", async () => {
		const tracker = new TaskGraphTracker({
			logPath: join(dir, "t.tasks.jsonl"),
		});
		const [plan] = createTaskGraphTools(tracker.store);
		const result = await plan?.execute(
			{ tasks: [{ title: "A" }] },
			{ agentId: "a", iteration: 1, toolCallId: "call_9" },
		);
		expect(result?.[0]?.success).toBe(true);
		expect(tracker.store.getEvents()[0]?.call).toBe("call_9");
	});
});
