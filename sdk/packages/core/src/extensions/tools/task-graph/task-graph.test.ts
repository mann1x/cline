import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		// The plan started T1 itself (nothing else was active), on the same call.
		expect(task(rewound, "T1")?.status).toBe("active");
		expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(3);
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
		// The plan started it; the model set it back.
		tracker.store.update({ updates: [{ id: "T1", status: "pending" }] });
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

	it("adds task_done to the tools a task is finished with, and to no other", () => {
		const tracker = new TaskGraphTracker();
		const schema = { type: "object", properties: { path: { type: "string" } } };
		const wrap = (name: string) =>
			withTaskGraphCapture(
				{
					name,
					description: "",
					inputSchema: schema,
					execute: async () => "ok",
				},
				tracker,
			);
		expect(wrap("read_files").inputSchema).toBe(schema);
		const editor = wrap("editor").inputSchema as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(editor.properties)).toEqual(["path", "task_done"]);
		expect(Object.keys(schema.properties)).toEqual(["path"]);
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

describe("nudges (phase 1b)", () => {
	const read = { name: "read_files", input: { files: ["/w/a.py"] } };
	const edit = (path = "/w/a.py") => ({
		name: "editor",
		input: { path, new_text: "x" },
	});
	const ok = [{ query: "q", result: "OK", success: true }];
	const call = (
		tracker: TaskGraphTracker,
		c: { name: string; input: unknown },
		result: unknown = ok,
	) => {
		tracker.recordToolCall(c.input, c.name);
		tracker.recordToolResult(c.input, c.name, result);
	};

	it("S1: asks for a plan by the 4th call, and lets a run that only answers carry on", () => {
		const tracker = new TaskGraphTracker();
		for (let i = 0; i < 3; i++) call(tracker, read);
		expect(tracker.takePendingReminder()).toBeUndefined();
		call(tracker, read);
		const text = tracker.takePendingReminder() ?? "";
		expect(text).toContain("4 calls in and there is no plan yet");
		expect(text).toContain("If it only needs an answer, carry on");
	});

	it("says a situation at most twice, the second time differently, and spaces nudges three calls apart", () => {
		const onNudge = vi.fn();
		const tracker = new TaskGraphTracker({ onNudge });
		call(tracker, edit());
		const first = tracker.takePendingReminder();
		call(tracker, edit());
		call(tracker, edit());
		expect(tracker.takePendingReminder()).toBeUndefined();
		call(tracker, edit());
		const second = tracker.takePendingReminder();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		for (let i = 0; i < 6; i++) call(tracker, edit());
		expect(tracker.takePendingReminder()).toBeUndefined();
		expect(onNudge.mock.calls.map((c) => c[0])).toEqual(["S1", "S1"]);
	});

	it("S3: names the active task after three changes it was not updated for", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "Store cents", start: true }] });
		call(tracker, edit("/w/models.py"));
		call(tracker, edit("/w/storage.py"));
		expect(tracker.takePendingReminder()).toBeUndefined();
		call(tracker, edit("/w/cli.py"));
		const text = tracker.takePendingReminder() ?? "";
		expect(text).toContain("since T1 (Store cents) was last updated");
		expect(text).toContain("`/w/models.py`, `/w/storage.py`, `/w/cli.py`");
		// Touching the task starts a new count.
		tracker.store.update({ updates: [{ id: "T1", note: "half done" }] });
		for (let i = 0; i < 3; i++) call(tracker, read);
		call(tracker, edit());
		expect(tracker.takePendingReminder()).toBeUndefined();
	});

	it("S4: a passing test run while a task is active points at closing it and at the unticked checks", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [
				{ title: "Fix wrap", acceptance: ["last line kept"], start: true },
			],
		});
		call(tracker, {
			name: "run_commands",
			input: { commands: ["cd /w && python3 -m unittest"] },
		});
		const text = tracker.takePendingReminder() ?? "";
		expect(text).toContain(
			"`cd /w && python3 -m unittest` passed while T1 (Fix wrap) is active",
		);
		expect(text).toContain(
			'add `task_done: "T1: cd /w && python3 -m unittest passed"` to your next call',
		);
	});

	it("S4: not for a command that checks nothing, nor for a failing one", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "A", start: true }] });
		call(tracker, { name: "run_commands", input: { commands: ["ls -la"] } });
		call(
			tracker,
			{ name: "run_commands", input: { commands: ["pytest -q"] } },
			[{ query: "q", result: "1 failed", success: false }],
		);
		expect(tracker.takePendingReminder()).toBeUndefined();
	});

	it("S5: a close that unblocks work says what is ready and starts it", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [
				{ title: "A", start: true },
				{ title: "B", depends: ["#1"] },
			],
		});
		const outcome = store.update({
			updates: [{ id: "T1", status: "done", note: "ok" }],
		});
		expect(outcome.lines.join("\n")).toContain("Ready now: T2 B.");
		expect(outcome.lines.join("\n")).toContain(
			"T2 is active now (started for you, since nothing else was)",
		);
		expect(task(store, "T2")?.status).toBe("active");
	});
});

describe("fewer round trips", () => {
	const ok = [{ query: "q", result: "OK", success: true }];
	const failed = [{ query: "q", result: "", error: "no", success: false }];
	const wrapped = (tracker: TaskGraphTracker, name: string, result: unknown) =>
		withTaskGraphCapture(
			{
				name,
				description: "",
				inputSchema: { type: "object", properties: {} },
				execute: async () => result,
			},
			tracker,
		);

	it("a plan starts its first ready task when nothing is active", () => {
		const store = new TaskGraphStore();
		const outcome = store.plan({
			// Ready order is priority first: B (H) goes before A (M).
			tasks: [{ title: "A" }, { title: "B", priority: "H" }],
		});
		expect(task(store, "T2")?.status).toBe("active");
		expect(task(store, "T1")?.status).toBe("pending");
		expect(outcome.lines.join("\n")).toContain("T2 is active now");
	});

	it("a plan with a started task starts nothing else", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }, { title: "B", start: true }] });
		expect(task(store, "T1")?.status).toBe("pending");
		expect(task(store, "T2")?.status).toBe("active");
	});

	it("a close starts nothing while another task is active", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [{ title: "A", start: true }, { title: "B" }, { title: "C" }],
		});
		store.update({ updates: [{ id: "T2", status: "active" }] });
		store.update({ updates: [{ id: "T1", status: "done", note: "ok" }] });
		expect(task(store, "T3")?.status).toBe("pending");
	});

	it("task_done on a working call closes the task, ticks it, and starts the next", async () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [
				{ title: "A", acceptance: ["x", "y"] },
				{ title: "B", depends: ["#1"] },
			],
		});
		const tool = wrapped(tracker, "run_commands", ok);
		await tool.execute(
			{
				commands: ["python3 -m unittest"],
				task_done: "T1: tests pass",
			} as never,
			{ toolCallId: "c9" } as never,
		);
		const t1 = task(tracker.store, "T1");
		expect(t1?.status).toBe("done");
		expect(t1?.outcome).toBe("tests pass");
		expect(t1?.acceptance.every((item) => item.done)).toBe(true);
		expect(task(tracker.store, "T2")?.status).toBe("active");
		const said = tracker.takePendingReminder() ?? "";
		expect(said).toContain("task_done: T1 now done");
		expect(said).toContain("T2 is active now");
		// The passing check on that same call asks for nothing more.
		expect(said).not.toContain("passed while");
		expect(tracker.store.getEvents().some((event) => event.call === "c9")).toBe(
			true,
		);
	});

	it("task_done on a failed call closes nothing and says why", async () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "A" }] });
		await wrapped(tracker, "editor", failed).execute(
			{ path: "/w/a", text: "x", task_done: "T1" } as never,
			{} as never,
		);
		expect(task(tracker.store, "T1")?.status).toBe("active");
		expect(tracker.takePendingReminder()).toContain(
			"T1 was not marked done: the `editor` call that named it failed",
		);
	});

	it("task_done that names no task is reported, not guessed", async () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "A" }] });
		await wrapped(tracker, "editor", ok).execute(
			{ path: "/w/a", text: "x", task_done: "the wrap fix" } as never,
			{} as never,
		);
		expect(task(tracker.store, "T1")?.status).toBe("active");
		expect(tracker.takePendingReminder()).toContain("names no task");
	});

	it("task_done on a tool that does not carry it is ignored", async () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({ tasks: [{ title: "A" }] });
		await wrapped(tracker, "read_files", ok).execute(
			{ files: [], task_done: "T1" } as never,
			{} as never,
		);
		expect(task(tracker.store, "T1")?.status).toBe("active");
	});

	it("a fork replays task_done carried by working calls", () => {
		const store = new TaskGraphStore();
		expect(
			store.reconcile(
				history([
					{
						id: "c1",
						name: "task_plan",
						input: { tasks: [{ title: "A" }, { title: "B" }] },
					},
					{
						id: "c2",
						name: "editor",
						input: { path: "/w/a", text: "x", task_done: "T1: done it" },
					},
				]),
			),
		).toBe("replayed");
		expect(task(store, "T1")?.status).toBe("done");
		expect(task(store, "T1")?.outcome).toBe("done it");
		expect(task(store, "T2")?.status).toBe("active");
	});
});
