/**
 * `task_update` as models really sent it (mann1x/cline#118, DeepSeek v4.1
 * Flash on Ollama Cloud): `task_done` on the tool itself, and fields beside
 * `updates` instead of inside it.
 */
import { describe, expect, it } from "vitest";
import { TaskGraphStore } from "./store";
import { createTaskUpdateTool } from "./tools";

function board(): TaskGraphStore {
	const store = new TaskGraphStore();
	store.plan({
		tasks: [
			{ title: "Build", acceptance: ["tests pass", "lint clean"], start: true },
			{ title: "Ship", depends: ["#1"] },
		],
	});
	return store;
}

const task = (store: TaskGraphStore, id: string) =>
	store.snapshot().tasks.find((entry) => entry.id === id);

describe("task_update as it was sent", () => {
	it("closes what `task_done` names, with its text as the outcome", () => {
		const store = board();
		const out = store.update({
			task_done: "T1: built it; npm test 12/12 pass",
		});
		expect(task(store, "T1")).toMatchObject({
			status: "done",
			outcome: "built it; npm test 12/12 pass",
		});
		expect(task(store, "T1")?.acceptance.every((item) => item.done)).toBe(true);
		expect(out.changed).toBe(true);
		expect(out.lines.join("\n")).not.toMatch(
			/without an outcome|no `id`|Nothing updated/,
		);
	});

	it("moves fields sent beside a single update into it", () => {
		const store = board();
		const out = store.update({
			status: "done",
			note: "built it",
			updates: [{ id: "T1" }],
		});
		expect(task(store, "T1")).toMatchObject({
			status: "done",
			outcome: "built it",
		});
		expect(out.changed).toBe(true);
	});

	it("closes with `task_done` and `status` beside one update: the report's failing shape", () => {
		const store = board();
		const out = store.update({
			status: "done",
			task_done: "T1: DT-507 and DT-506 built, proved and closed out",
			updates: [{ id: "T1" }],
		});
		expect(task(store, "T1")).toMatchObject({
			status: "done",
			outcome: "DT-507 and DT-506 built, proved and closed out",
		});
		expect(out.lines.join("\n")).not.toContain("nothing to change");
	});

	it("keeps an update's own field over one beside it", () => {
		const store = board();
		store.update({
			status: "done",
			updates: [{ id: "T1", status: "cancelled", note: "dropped" }],
		});
		expect(task(store, "T1")?.status).toBe("cancelled");
	});

	it("names fields beside several updates instead of guessing which they were for", () => {
		const store = board();
		const out = store.update({
			status: "done",
			updates: [
				{ id: "T1", note: "a" },
				{ id: "T2", note: "b" },
			],
		});
		expect(task(store, "T1")?.status).toBe("active");
		expect(out.lines.join("\n")).toContain(
			"`status` beside `updates`, which lists 2 tasks: put each inside the update it is for",
		);
	});

	it("reports a `task_done` that names no task", () => {
		const store = board();
		const out = store.update({ task_done: "all finished" });
		expect(out.changed).toBe(false);
		expect(out.lines.join("\n")).toContain("which names no task");
	});

	it("answers to `task_done`, so a call by that name reaches it", () => {
		expect(createTaskUpdateTool(board()).aliases).toEqual(["task_done"]);
	});
});
