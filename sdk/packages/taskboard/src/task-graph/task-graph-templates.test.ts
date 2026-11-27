import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskGraphStore } from "./store";
import {
	boardPlanFromEvents,
	boardToTemplate,
	expandTaskTemplate,
	loadTaskTemplates,
	saveTaskTemplate,
	templateSlug,
} from "./templates";
import { TaskGraphTracker } from "./tracker";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "task-templates-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const release = {
	name: "Release",
	description: "Cut a release",
	tasks: [
		{ title: "Bump to {{version}}" },
		{ title: "Notes for {{version}}", depends: ["#1"] },
		{
			title: "Tag v{{version}}",
			depends: ["#2"],
			gate: ["human:go for {{version}}"],
		},
	],
};

function write(where: string, name: string, body: unknown): void {
	mkdirSync(where, { recursive: true });
	writeFileSync(join(where, `${name}.json`), JSON.stringify(body));
}

describe("task templates", () => {
	it("loads templates, the first folder winning a name, and finds their vars", () => {
		const workspace = join(dir, "ws");
		const user = join(dir, "user");
		write(workspace, "release", release);
		write(user, "release", { name: "Release", tasks: [{ title: "other" }] });
		write(user, "broken", { tasks: [] });
		write(user, "bugfix", {
			tasks: [{ title: "Reproduce" }, { title: "Fix", depends: ["#1"] }],
		});
		const templates = loadTaskTemplates([workspace, user]);
		expect(templates.map((t) => t.name)).toEqual(["Release", "bugfix"]);
		expect(templates[0]?.vars).toEqual(["version"]);
		expect(templates[0]?.tasks).toHaveLength(3);
	});

	it("expands with vars and shifts its #n refs past tasks before it", () => {
		const [template] = loadTaskTemplates([
			(() => {
				write(dir, "r", release);
				return dir;
			})(),
		]);
		const { tasks, missing } = expandTaskTemplate(
			template as never,
			{ version: "1.2" },
			2,
		);
		expect(tasks[0]?.title).toBe("Bump to 1.2");
		expect(tasks[2]?.depends).toEqual(["#4"]);
		expect(tasks[2]?.gate).toEqual(["human:go for 1.2"]);
		expect(missing).toEqual([]);
		expect(expandTaskTemplate(template as never, {}).missing).toEqual([
			"version",
		]);
	});

	it("task_plan takes a template, and offers it only when one exists", async () => {
		const empty = new TaskGraphTracker({ templateDirs: [join(dir, "none")] });
		const plain = empty.tools().find((tool) => tool.name === "task_plan");
		expect(JSON.stringify(plain?.inputSchema)).not.toContain("template");
		write(dir, "release", release);
		const tracker = new TaskGraphTracker({ templateDirs: [dir] });
		const plan = tracker.tools().find((tool) => tool.name === "task_plan");
		expect(plan?.description).toContain("Release (version)");
		const out = (await plan?.execute(
			{
				template: "release",
				vars: { version: "2.0" },
				tasks: [{ title: "Read the changelog" }],
			},
			{} as never,
		)) as { result: string; success: boolean }[];
		expect(out[0]?.result).toContain('From the saved plan "Release": 3 tasks.');
		const state = tracker.store.getState();
		expect(state.order).toEqual(["T1", "T2", "T3", "T4"]);
		expect(state.tasks.get("T3")?.depends).toEqual(["T2"]);
		expect(state.tasks.get("T4")?.gates[0]?.spec).toBe("human:go for 2.0");
		const missing = (await plan?.execute(
			{ template: "deploy" },
			{} as never,
		)) as {
			result: string;
			success: boolean;
		}[];
		expect(missing[0]?.success).toBe(false);
		expect(missing[0]?.result).toContain("Saved plans: Release");
	});

	it("saves a board as a template and uses it again from the panel", () => {
		const tracker = new TaskGraphTracker({ templateDirs: [dir] });
		tracker.store.plan({
			tasks: [
				{ title: "Spec", acceptance: ["reviewed"] },
				{
					title: "Build",
					depends: ["#1"],
					gate: ["human:approve spec", "timer:+1h"],
				},
				{ title: "Step", parent: "#2" },
				{ title: "Dropped" },
			],
		});
		tracker.store.update({
			updates: [{ id: "T3", status: "cancelled", note: "no" }],
		});
		const file = tracker.saveTemplate("Feature flow", "spec then build");
		expect(file).toBe(join(dir, "feature-flow.json"));
		const saved = JSON.parse(readFileSync(file as string, "utf8"));
		expect(saved.tasks).toEqual([
			{ title: "Spec", acceptance: ["reviewed"] },
			{ title: "Build", depends: ["#1"], gate: ["human:approve spec"] },
			{ title: "Step", parent: "#2" },
		]);
		const fresh = new TaskGraphTracker({ templateDirs: [dir] });
		const outcome = fresh.useTemplate("feature flow");
		expect(outcome.changed).toBe(true);
		expect(fresh.store.getState().order).toEqual(["T1", "T2", "T2.1"]);
		expect(fresh.takePendingReminder() ?? "").toContain(
			"The person changed the task board",
		);
	});

	it("copies a board with every wait: what a task waits on comes first, and pipeline runs stay behind", () => {
		// pandorum, 2026-11-27: T9 "Verify" waited on fixes T10-T15; the copy
		// listed it first, and its six dependencies were ignored.
		const store = new TaskGraphStore();
		store.plan(
			{ tasks: [{ title: "Verify" }, { title: "Fix A" }, { title: "Fix B" }] },
			{},
			{ autoStart: false },
		);
		store.update({ updates: [{ id: "T1", depends_add: ["T2", "T3"] }] });
		const holder = "pipeline:check-3";
		store.plan(
			{
				tasks: [
					{
						title: "▶ check #3",
						description: "Pipeline run check-3. It is waiting for the person.",
					},
				],
			},
			{ by: holder },
			{ autoStart: false },
		);
		store.update({ updates: [{ id: "T4", status: "active" }] }, { by: holder });

		const tasks = boardPlanFromEvents(store.getEvents());
		expect(tasks).toEqual([
			{ title: "Fix A" },
			{ title: "Fix B" },
			{ title: "Verify", depends: ["#1", "#2"] },
		]);
		const copy = new TaskGraphStore({ planMode: true });
		const outcome = copy.plan(
			{ tasks },
			{ by: "person" },
			{ autoStart: false },
		);
		expect(outcome.lines.join("\n")).not.toMatch(/ignored|Plan mode/);
		const verify = [...copy.getState().tasks.values()].find(
			(task) => task.title === "Verify",
		);
		expect(verify?.depends).toHaveLength(2);
		// The model still hears about plan mode.
		expect(
			new TaskGraphStore({ planMode: true })
				.plan({ tasks: [{ title: "x" }] })
				.lines.join("\n"),
		).toContain("Plan mode");
	});

	it("names files by slug", () => {
		expect(templateSlug("My Release: v2!")).toBe("my-release-v2");
		expect(
			saveTaskTemplate(
				dir,
				boardToTemplate(new TaskGraphTracker().store.getState(), "x"),
			),
		).toBe(join(dir, "x.json"));
	});
});
