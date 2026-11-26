import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderBoard, renderMermaid, renderTask } from "./board";
import {
	absoluteGate,
	decideCommitGate,
	decideTimerGate,
	humanGatesAnswered,
} from "./gates";
import { foldTaskEvents, isBlocked, isReady, normalizeGate } from "./model";
import { readGates, readLinks, readUpdateInput } from "./readers";
import { isAgentAuthor, TaskGraphStore } from "./store";
import { TaskGraphTracker } from "./tracker";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "task-graph-gates-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const task = (store: TaskGraphStore, id: string) =>
	store.getState().tasks.get(id);

describe("gate readers", () => {
	it("reads gates in kind:value form and reports the rest", () => {
		expect(normalizeGate("Human: approve the schema")).toBe(
			"human:approve the schema",
		);
		expect(normalizeGate("nonsense")).toBeUndefined();
		expect(normalizeGate("human:")).toBeUndefined();
		const read = readGates([
			"timer:+30m",
			{ kind: "run", value: "r-7" },
			"wait for it",
		]);
		expect(read.gates).toEqual(["timer:+30m", "run:r-7"]);
		expect(read.bad).toEqual(["wait for it"]);
	});

	it("turns a duration timer into the time it ends", () => {
		const now = Date.parse("2026-11-26T10:00:00Z");
		expect(absoluteGate("timer:+30m", now)).toBe(
			"timer:2026-11-26T10:30:00.000Z",
		);
		expect(absoluteGate("timer:2h", now)).toBe(
			"timer:2026-11-26T12:00:00.000Z",
		);
		expect(absoluteGate("human:x", now)).toBe("human:x");
	});
});

describe("link readers", () => {
	it("reads typed links, attachments and paths", () => {
		const read = readLinks([
			"supersedes T3",
			"discovered-from: t2",
			{ type: "related", target: "#4" },
			{ "caused-by": "T1" },
			"https://example.com/x",
			"a1b2c3d4",
			"src/x.ts",
			"file README.md",
			"supersedes the old one",
		]);
		expect(read.links).toEqual([
			{ type: "supersedes", target: "T3" },
			{ type: "discovered-from", target: "T2" },
			{ type: "related", target: "T4" },
			{ type: "caused-by", target: "T1" },
			{ type: "url", target: "https://example.com/x" },
			{ type: "commit", target: "a1b2c3d4" },
		]);
		expect(read.files).toEqual(["src/x.ts", "README.md"]);
		expect(read.bad).toEqual(["supersedes the old one"]);
	});

	it("task_update reads gate, gate_remove, link and force", () => {
		const { items, ignored } = readUpdateInput({
			updates: [
				{
					id: "T1",
					gate: ["human:approve"],
					gate_remove: "timer:2026-01-01T00:00:00Z",
					link: ["related T2"],
					force: true,
				},
			],
		});
		expect(ignored).toEqual([]);
		expect(items[0]).toMatchObject({
			gatesAdd: ["human:approve"],
			gatesRemove: ["timer:2026-01-01T00:00:00Z"],
			linksAdd: [{ type: "related", target: "T2" }],
			force: true,
		});
	});
});

describe("gates on the board", () => {
	it("a gated task is blocked, and opens when its gate does", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [
				{ title: "Build" },
				{ title: "Deploy", gate: ["human:approve the release"] },
			],
		});
		const deploy = task(store, "T2");
		expect(deploy && isBlocked(store.getState(), deploy)).toBe(true);
		expect(renderBoard(store.getState())).toContain(
			"T2 after human:approve the release",
		);
		const outcome = store.resolveGates((gate) =>
			gate.spec === "human:approve the release" ? { open: true } : undefined,
		);
		expect(outcome.lines.join(" ")).toContain(
			"T2: human:approve the release opened.",
		);
		expect(outcome.readyNow).toEqual(["T2"]);
		expect(isReady(store.getState(), task(store, "T2") as never)).toBe(true);
	});

	it("an active task given a gate waits, and comes back when it opens", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [{ title: "Migrate", start: true }, { title: "Docs" }],
		});
		const outcome = store.update({
			updates: [{ id: "T1", gate: ["timer:2026-01-01T00:00:00Z"] }],
		});
		expect(task(store, "T1")?.status).toBe("waiting");
		expect(outcome.lines.join(" ")).toContain("waits on timer:");
		// The next ready task starts once nothing is active.
		const later = store.resolveGates((gate) =>
			decideTimerGate(gate, Date.parse("2026-02-01T00:00:00Z")),
		);
		expect(task(store, "T1")?.status).not.toBe("waiting");
		expect(later.lines.join(" ")).toContain("T1 no longer waits");
	});

	it("a subtask waits on its parent's gates", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [
				{ title: "Release", gate: ["human:go"] },
				{ title: "Tag", parent: "#1" },
			],
		});
		expect(isBlocked(store.getState(), task(store, "T1.1") as never)).toBe(
			true,
		);
	});

	it("refuses to start a gated task, naming the gate", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "Ship", gate: ["human:sign off"] }] });
		const outcome = store.update({ updates: [{ id: "T1", status: "active" }] });
		expect(task(store, "T1")?.status).toBe("pending");
		expect(outcome.lines.join(" ")).toContain("it is after human:sign off");
	});

	it("only the person opens a gate by hand", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "Ship", gate: ["human:sign off"] }] });
		const byModel = store.update({
			updates: [{ id: "T1", gate_open: ["human:sign off"] }],
		});
		expect(byModel.lines.join(" ")).toContain(
			"gates are not opened by a tool call",
		);
		expect(task(store, "T1")?.gates[0]?.open).toBe(false);
		store.update(
			{ updates: [{ id: "T1", gate_open: ["human:sign off"] }] },
			{ by: "user" },
		);
		expect(task(store, "T1")?.gates[0]?.open).toBe(true);
	});

	it("a failed gate is said once and stays closed", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "Merge", gate: ["gh-pr:o/r#1"] }] });
		const first = store.resolveGates(() => ({ failed: "closed" }));
		const second = store.resolveGates(() => ({ failed: "closed" }));
		expect(first.lines.join(" ")).toContain("can no longer open (closed)");
		expect(second.changed).toBe(false);
		expect(renderTask(store.getState(), task(store, "T1") as never)).toContain(
			"gh-pr:o/r#1 (cannot open: closed)",
		);
	});

	it("gate_remove takes a gate off", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "Ship", gate: ["human:sign off"] }] });
		store.update({ updates: [{ id: "T1", gate_remove: ["human:sign off"] }] });
		expect(isReady(store.getState(), task(store, "T1") as never)).toBe(true);
	});

	it("folds a log written before gates existed", () => {
		const state = foldTaskEvents([
			{
				seq: 1,
				ts: 0,
				by: "model",
				op: "create",
				task: { id: "T1", title: "x" },
			},
			{
				seq: 2,
				ts: 0,
				by: "model",
				op: "update",
				update: { id: "T1", note: "y" },
			},
		]);
		expect(state.tasks.get("T1")?.gates).toEqual([]);
	});
});

describe("gate deciders", () => {
	it("timer", () => {
		const gate = { spec: "timer:2026-01-01T00:00:00Z", open: false };
		expect(
			decideTimerGate(gate, Date.parse("2025-12-31T00:00:00Z")),
		).toBeUndefined();
		expect(decideTimerGate(gate, Date.parse("2026-01-02T00:00:00Z"))).toEqual({
			open: true,
		});
		expect(decideTimerGate({ spec: "timer:soon", open: false }, 0)).toEqual({
			failed: '"soon" is not a time',
		});
	});

	it("commit: open once the branch contains it", () => {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		writeFileSync(join(dir, "a"), "1");
		git("add", "a");
		git("commit", "-qm", "one");
		git("checkout", "-qb", "side");
		writeFileSync(join(dir, "a"), "2");
		git("commit", "-qam", "two");
		const sha = git("rev-parse", "HEAD");
		expect(
			decideCommitGate({ spec: `commit:${sha}@main`, open: false }, dir),
		).toBeUndefined();
		expect(
			decideCommitGate({ spec: `commit:${sha}@side`, open: false }, dir),
		).toEqual({
			open: true,
		});
		expect(
			decideCommitGate({ spec: "commit:deadbeef@main", open: false }, dir),
		).toBeUndefined();
	});

	it("human: the question names the task, or the one waiting gate", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [
				{ title: "A", gate: ["human:pick the schema"] },
				{ title: "B", gate: ["human:approve the budget"] },
			],
		});
		const waiting = store.closedGates();
		expect(
			humanGatesAnswered("Which schema for T1?", waiting).map((e) => e.task.id),
		).toEqual(["T1"]);
		expect(
			humanGatesAnswered("Shall I approve the budget as is?", waiting).map(
				(e) => e.task.id,
			),
		).toEqual(["T2"]);
		expect(humanGatesAnswered("Anything else?", waiting)).toEqual([]);
		expect(
			humanGatesAnswered("Anything else?", waiting.slice(0, 1)).length,
		).toBe(1);
	});
});

describe("links", () => {
	it("supersedes cancels the old task and moves its dependents", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [{ title: "Old approach" }, { title: "Test", depends: ["#1"] }],
		});
		const outcome = store.plan({
			tasks: [{ title: "New approach", link: ["supersedes T1"] }],
		});
		expect(task(store, "T1")?.status).toBe("cancelled");
		expect(task(store, "T1")?.outcome).toBe("superseded by T3");
		expect(task(store, "T2")?.depends).toContain("T3");
		expect(isBlocked(store.getState(), task(store, "T2") as never)).toBe(true);
		expect(outcome.lines.join(" ")).toContain(
			"T2 now waits on T3 in place of T1",
		);
	});

	it("duplicate-of cancels this task", () => {
		const store = new TaskGraphStore();
		store.plan({
			tasks: [{ title: "Fix login" }, { title: "Fix the login bug" }],
		});
		store.update({ updates: [{ id: "T2", link: ["duplicate-of T1"] }] });
		expect(task(store, "T2")?.status).toBe("cancelled");
		expect(task(store, "T2")?.outcome).toBe("duplicate of T1");
		expect(task(store, "T2")?.links).toEqual([
			{ type: "duplicate-of", target: "T1" },
		]);
	});

	it("refuses a link to a missing task or to itself", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }] });
		const outcome = store.update({
			updates: [{ id: "T1", link: ["related T9", "related T1"] }],
		});
		expect(outcome.lines.join(" ")).toContain(
			"related T9 ignored: no such task",
		);
		expect(outcome.lines.join(" ")).toContain("cannot link to itself");
		expect(task(store, "T1")?.links).toEqual([]);
	});

	it("records the call that created a task", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }] }, { call: "call_7" });
		expect(store.snapshot().tasks[0]?.createdCall).toBe("call_7");
	});
});

describe("claims", () => {
	it("a teammate's start claims the task; another's is refused while it runs", () => {
		const live = new Set(["alice"]);
		const store = new TaskGraphStore({ isHolderLive: (who) => live.has(who) });
		store.plan({ tasks: [{ title: "A" }, { title: "B" }] });
		store.update(
			{ updates: [{ id: "T2", status: "active" }] },
			{ by: "alice" },
		);
		expect(task(store, "T2")?.claimedBy).toBe("alice");
		const refused = store.update(
			{ updates: [{ id: "T2", status: "done", note: "x" }] },
			{ by: "bob" },
		);
		expect(task(store, "T2")?.status).toBe("active");
		expect(refused.lines.join(" ")).toContain("held by alice");
		live.delete("alice");
		store.update(
			{ updates: [{ id: "T2", status: "done", note: "x" }] },
			{ by: "bob" },
		);
		expect(task(store, "T2")?.status).toBe("done");
	});

	it("force takes it over, and says so", () => {
		const forced: string[] = [];
		const store = new TaskGraphStore({
			isHolderLive: () => true,
			onForcedClaim: (id, from, to) => forced.push(`${id}:${from}->${to}`),
		});
		store.plan({ tasks: [{ title: "A" }] });
		store.update(
			{ updates: [{ id: "T1", status: "active" }] },
			{ by: "alice" },
		);
		store.update(
			{ updates: [{ id: "T1", status: "done", note: "did it", force: true }] },
			{ by: "model" },
		);
		expect(task(store, "T1")?.status).toBe("done");
		expect(forced).toEqual(["T1:alice->model"]);
	});

	it("the person is never refused", () => {
		const store = new TaskGraphStore({ isHolderLive: () => true });
		store.plan({ tasks: [{ title: "A" }] });
		store.update(
			{ updates: [{ id: "T1", status: "active" }] },
			{ by: "alice" },
		);
		store.update(
			{ updates: [{ id: "T1", status: "cancelled", note: "no" }] },
			{ by: "user" },
		);
		expect(task(store, "T1")?.status).toBe("cancelled");
	});

	it("a claim ends with its run", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }] });
		store.update(
			{ updates: [{ id: "T1", status: "active" }] },
			{ by: "alice" },
		);
		expect(store.releaseClaims("alice", "its run ended")).toEqual(["T1"]);
		expect(task(store, "T1")?.status).toBe("pending");
		expect(task(store, "T1")?.claimedBy).toBeUndefined();
	});

	it("nothing is auto-started for a teammate", () => {
		const store = new TaskGraphStore();
		store.plan({ tasks: [{ title: "A" }, { title: "B" }] });
		store.update(
			{ updates: [{ id: "T1", status: "active" }] },
			{ by: "alice" },
		);
		store.update({ updates: [{ id: "T2", status: "pending" }] });
		// The lead's T2 is untouched by alice's close.
		store.update(
			{ updates: [{ id: "T1", status: "done", note: "x" }] },
			{ by: "alice" },
		);
		expect(task(store, "T2")?.status).toBe("pending");
		expect(isAgentAuthor("alice")).toBe(true);
		expect(isAgentAuthor("model")).toBe(false);
		expect(isAgentAuthor("memory:m1")).toBe(false);
	});
});

describe("tracker gates", () => {
	it("run: gates open when the run ends, and fail when it failed", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [
				{ title: "Review", gate: ["run:reviewer"] },
				{ title: "Audit", gate: ["run:auditor"] },
			],
		});
		tracker.noteRunEnded(["reviewer"], true);
		tracker.noteRunEnded(["auditor"], false, "it hit its iteration cap");
		const said = tracker.takePendingReminder() ?? "";
		expect(said).toContain("T1: run:reviewer opened");
		expect(said).toContain(
			"run:auditor can no longer open (it hit its iteration cap)",
		);
	});

	it("an answered question opens the human gate it named, with the answer noted", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [{ title: "Ship", gate: ["human:go or no-go"] }],
		});
		tracker.recordToolResult(
			{ question: "Ship T1 now?" },
			"ask_question",
			"yes, ship it",
		);
		expect(tracker.store.getState().tasks.get("T1")?.gates[0]?.open).toBe(true);
		expect(
			tracker.store.getState().tasks.get("T1")?.notes.at(-1)?.text,
		).toContain("the person answered: yes, ship it");
	});

	it("timer gates are checked before each request", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [{ title: "Retry", gate: ["timer:2000-01-01T00:00:00Z"] }],
		});
		const said = tracker.takePendingReminder() ?? "";
		expect(said).toContain("T1: timer:2000-01-01T00:00:00Z opened");
	});

	it("task_view mermaid draws the board", async () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [
				{ title: "A" },
				{ title: "B", depends: ["#1"], gate: ["human:ok"] },
				{ title: "B1", parent: "#2" },
			],
		});
		const view = tracker.tools().find((tool) => tool.name === "task_view");
		const out = (await view?.execute({ view: "mermaid" }, {} as never)) as {
			result: string;
		}[];
		expect(out[0]?.result).toContain("flowchart TD");
		expect(out[0]?.result).toContain("T1 --> T2");
		expect(out[0]?.result).toContain("subgraph T2_group");
		expect(out[0]?.result).toContain('{{"human:ok"}}');
		expect(renderMermaid(tracker.store.getState())).toContain("T2_1");
	});
});
