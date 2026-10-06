import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSddTool } from "../../extensions/tools/sdd-tool";
import { SddEngine, SddRuleError } from "./sdd-engine";

const task = (title: string) => ({
	title,
	steps: `Do ${title}.`,
	files: ["src/app.ts"],
	verify: "npm test",
	expect: "all tests pass",
});

describe("the spec-driven engine", () => {
	let root: string;
	let engine: SddEngine;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sdd-engine-"));
		engine = new SddEngine(root);
	});
	afterEach(() => {
		engine.close();
		rmSync(root, { recursive: true, force: true });
	});

	const file = (name: string) => readFileSync(join(root, ".sdd", name), "utf8");

	/** A project up to an approved roadmap of two slices, the second after the first. */
	const toRoadmap = () => {
		engine.setProject({
			name: "Todo",
			description: "A todo list for one person.",
		});
		engine.addRequirement({ title: "Add a todo" });
		engine.addRequirement({ title: "Complete a todo" });
		engine.addMilestone({ title: "First version", context: "CLI only." });
		engine.approve("requirements");
		engine.planMilestone([
			{ title: "Adding", demo: "todo add milk", requirements: ["R001"] },
			{ title: "Completing", depends: ["S01"], requirements: ["R002"] },
		]);
		engine.approve("roadmap");
	};
	const doTask = () => {
		engine.startTask();
		engine.completeTask({ summary: "Done.", evidence: "12 passed" });
	};

	it("starts by asking for the project", () => {
		expect(engine.next()).toMatchObject({
			step: "discuss_project",
			needsUser: true,
		});
		expect(engine.status()).toMatch(/has not been started/);
		expect(existsSync(join(root, ".sdd", "PROJECT.md"))).toBe(false);
	});

	it("walks the whole order, one step at a time", () => {
		engine.setProject({
			name: "Todo",
			description: "A todo list for one person.",
		});
		expect(engine.next().step).toBe("discuss_milestone");
		engine.addRequirement({
			title: "Add a todo",
			description: "From the command line.",
		});
		engine.addRequirement({ title: "Complete a todo" });
		expect(
			engine.addMilestone({ title: "First version", context: "CLI only." }),
		).toBe("M001");

		let next = engine.next();
		expect(next).toMatchObject({
			step: "approve_requirements",
			needsUser: true,
		});
		expect(next.instruction).toContain(
			"R001 Add a todo: From the command line.",
		);
		engine.approve("requirements");

		expect(engine.next()).toMatchObject({
			step: "plan_milestone",
			needsUser: false,
		});
		expect(
			engine.planMilestone([
				{ title: "Adding", demo: "todo add milk", requirements: ["R001"] },
				{ title: "Completing", depends: ["S01"], requirements: ["r2"] },
			]),
		).toEqual(["S01", "S02"]);
		expect(engine.next()).toMatchObject({
			step: "approve_roadmap",
			needsUser: true,
		});
		engine.approve("roadmap");

		next = engine.next();
		expect(next).toMatchObject({ step: "plan_slice", ref: "M001/S01" });
		expect(
			engine.planSlice({ tasks: [task("the store"), task("the command")] }),
		).toEqual(["T01", "T02"]);

		next = engine.next();
		expect(next).toMatchObject({ step: "execute_task", ref: "M001/S01/T01" });
		expect(next.instruction).toContain("Verify: npm test");
		expect(next.instruction).toContain("Expect: all tests pass");
		engine.startTask();
		expect(engine.next()).toMatchObject({
			step: "resume_task",
			ref: "M001/S01/T01",
		});
		engine.completeTask({ summary: "Wrote the store.", evidence: "12 passed" });
		doTask();

		expect(engine.next()).toMatchObject({
			step: "close_slice",
			ref: "M001/S01",
		});
		engine.completeSlice({
			summary: "Adding works.",
			uat: [{ check: "todo add milk", result: "pass" }],
		});
		expect(engine.requirements()[0]).toMatchObject({
			status: "validated",
			owner: "M001/S01",
		});
		expect(engine.requirements()[1].status).toBe("active");

		expect(engine.next()).toMatchObject({
			step: "plan_slice",
			ref: "M001/S02",
		});
		expect(engine.next().instruction).toContain("S01 Adding: Adding works.");
		engine.planSlice({ tasks: [task("done flag")] });
		doTask();
		engine.completeSlice({
			summary: "Completing works.",
			uat: [{ check: "looks right in a terminal", result: "needs_human" }],
		});

		expect(engine.next()).toMatchObject({
			step: "validate_milestone",
			ref: "M001",
		});
		engine.validateMilestone({
			verdict: "pass",
			findings: "Both requirements are met.",
		});
		expect(engine.next().step).toBe("complete_milestone");
		engine.completeMilestone("A todo list that adds and completes.");
		expect(engine.next()).toMatchObject({
			step: "discuss_milestone",
			needsUser: true,
		});
		expect(engine.status()).toContain("M001 First version: complete");
		expect(engine.status()).toContain(
			"Waiting on a person: M001/S02: looks right in a terminal",
		);
	});

	it("refuses each step that is out of turn, and says what comes first", () => {
		expect(() => engine.addMilestone({ title: "x", context: "y" })).toThrow(
			/set_project first/,
		);
		engine.setProject({ name: "Todo", description: "A todo list." });
		engine.addRequirement({ title: "Add a todo" });
		engine.addMilestone({ title: "First version", context: "CLI only." });
		expect(() =>
			engine.addMilestone({ title: "Second", context: "More." }),
		).toThrow(/M001 "First version" is still open/);
		expect(() => engine.planMilestone([{ title: "Adding" }])).toThrow(
			/requirements are not approved/,
		);
		expect(() => engine.approve("roadmap")).toThrow(
			/requirements are not approved yet/,
		);
		engine.approve("requirements");
		expect(() => engine.approve("roadmap")).toThrow(/no roadmap to approve/);
		expect(() => engine.planMilestone([{ title: "Adding" }])).toThrow(
			/No slice owns R001 "Add a todo"/,
		);
		// The refused roadmap left nothing behind.
		expect(engine.slices("M001")).toEqual([]);
		engine.planMilestone([
			{ title: "Adding", requirements: ["R001"] },
			{ title: "More", depends: ["S01"] },
		]);
		expect(() => engine.planSlice({ tasks: [task("a")] })).toThrow(
			/roadmap is not approved/,
		);
		engine.approve("roadmap");
		expect(() => engine.planMilestone([{ title: "Other" }])).toThrow(
			/is approved. It is not replaced/,
		);
		expect(() =>
			engine.planSlice({ slice: "S02", tasks: [task("a")] }),
		).toThrow(/S02 is not the slice that is due; S01 "Adding" is/);
		expect(() => engine.planSlice({ tasks: [] })).toThrow(/at least one task/);
		expect(() =>
			engine.planSlice({ tasks: [{ title: "a", steps: "do", verify: " " }] }),
		).toThrow(/command that proves task "a"/);
		engine.planSlice({ tasks: [task("a"), task("b")] });
		expect(() => engine.completeTask({ summary: "x", evidence: "y" })).toThrow(
			/not started; call start_task/,
		);
		expect(() => engine.startTask("T02")).toThrow(/T01 "a" comes first/);
		engine.startTask();
		expect(() => engine.completeTask({ summary: "x", evidence: "" })).toThrow(
			/output of `npm test` as it ran/,
		);
		expect(() =>
			engine.completeSlice({
				summary: "s",
				uat: [{ check: "c", result: "pass" }],
			}),
		).toThrow(/still has T01 \(in_progress\), T02 \(pending\)/);
		expect(() =>
			engine.validateMilestone({ verdict: "pass", findings: "f" }),
		).toThrow(/audited when every slice is done; S01, S02/);
		expect(() => engine.completeMilestone("s")).toThrow(
			/after its audit passes/,
		);
		expect(() => engine.startTask("T09")).toThrow(
			/no task T09 in M001\/S01. Its tasks: T01, T02/,
		);
	});

	it("a slice can only depend on one listed before it", () => {
		engine.setProject({ name: "Todo", description: "A todo list." });
		engine.addRequirement({ title: "Add", status: "deferred" });
		engine.addRequirement({ title: "List" });
		engine.addMilestone({ title: "M", context: "c" });
		engine.approve("requirements");
		expect(() =>
			engine.planMilestone([
				{ title: "A", depends: ["S02"], requirements: ["R002"] },
				{ title: "B" },
			]),
		).toThrow(/depends on S02, which is not an earlier slice/);
		expect(() =>
			engine.planMilestone([{ title: "A", requirements: ["R009"] }]),
		).toThrow(/R009, which does not exist/);
		// A deferred requirement needs no owner.
		expect(
			engine.planMilestone([{ title: "A", requirements: ["R002"] }]),
		).toEqual(["S01"]);
	});

	it("a new requirement takes back the approval it was not part of", () => {
		toRoadmap();
		expect(engine.activeMilestone()?.requirementsApproved).toBe(true);
		engine.addRequirement({ title: "Delete a todo" });
		expect(engine.next().step).toBe("approve_requirements");
		// One kept for later does not.
		engine.approve("requirements");
		engine.addRequirement({ title: "Sync", status: "deferred" });
		expect(engine.activeMilestone()?.requirementsApproved).toBe(true);
	});

	it("puts a blocker before everything else, and to the user the second time", () => {
		toRoadmap();
		engine.planSlice({ tasks: [task("a"), task("b")] });
		doTask();
		engine.startTask();
		engine.blockTask({ reason: "The API has no such endpoint." });
		let next = engine.next();
		expect(next).toMatchObject({
			step: "replan_slice",
			ref: "M001/S01",
			needsUser: false,
		});
		expect(next.instruction).toContain("The API has no such endpoint.");
		expect(engine.status()).toContain(
			"BLOCKED T02 b: The API has no such endpoint.",
		);

		expect(
			engine.replanSlice({
				reason: "Use the file instead.",
				tasks: [task("c")],
			}),
		).toEqual(["T02"]);
		const tasks = engine.tasks("M001", "S01");
		expect(tasks.map((entry) => [entry.id, entry.title, entry.status])).toEqual(
			[
				["T01", "a", "done"],
				["T02", "c", "pending"],
			],
		);
		engine.startTask();
		engine.blockTask({ reason: "Still no." });
		next = engine.next();
		expect(next).toMatchObject({ step: "replan_slice", needsUser: true });
		expect(next.instruction).toMatch(/already replanned 1 time/);
	});

	it("does not close a slice on a failed check", () => {
		toRoadmap();
		engine.planSlice({ tasks: [task("a")] });
		doTask();
		expect(() => engine.completeSlice({ summary: "s", uat: [] })).toThrow(
			/acceptance checks/,
		);
		expect(() =>
			engine.completeSlice({
				summary: "s",
				uat: [
					{ check: "adds", result: "pass" },
					{ check: "persists", result: "fail" },
				],
			}),
		).toThrow(/1 acceptance check\(s\) failed: persists/);
		expect(engine.slices("M001")[0].status).toBe("pending");
	});

	it("an audit that finds gaps adds the slices that fix them, and is run again", () => {
		toRoadmap();
		for (const _ of [1, 2]) {
			engine.planSlice({ tasks: [task("a")] });
			doTask();
			engine.completeSlice({
				summary: "s",
				uat: [{ check: "c", result: "pass" }],
			});
		}
		expect(() =>
			engine.validateMilestone({
				verdict: "needs_remediation",
				findings: "No help text.",
			}),
		).toThrow(/comes with the slices that fix/);
		expect(
			engine.validateMilestone({
				verdict: "needs_remediation",
				findings: "No help text.",
				remediation: [{ title: "Help text" }],
			}),
		).toEqual(["S03"]);
		expect(engine.next()).toMatchObject({
			step: "plan_slice",
			ref: "M001/S03",
		});
		engine.planSlice({ tasks: [task("help")] });
		doTask();
		engine.completeSlice({
			summary: "s",
			uat: [{ check: "c", result: "pass" }],
		});
		expect(engine.next().step).toBe("validate_milestone");
	});

	it("keeps its place across a restart", () => {
		toRoadmap();
		engine.planSlice({ tasks: [task("a"), task("b")] });
		engine.startTask();
		engine.close();
		engine = new SddEngine(root);
		expect(engine.next()).toMatchObject({
			step: "resume_task",
			ref: "M001/S01/T01",
		});
		expect(engine.journal(3).map((entry) => entry.action)).toEqual([
			"start_task",
			"plan_slice",
			"approve",
		]);
	});

	it("writes the markdown from the database after every change", () => {
		toRoadmap();
		engine.addDecision({
			title: "Storage",
			choice: "A JSON file.",
			why: "One user.",
		});
		engine.addKnowledge("Tests run with npm test.");
		engine.capture("A web UI some day.");
		engine.planSlice({
			research: "Node's fs is enough.",
			tasks: [task("a"), task("b")],
		});
		doTask();
		expect(file("PROJECT.md")).toContain("# Todo");
		expect(file("PROJECT.md")).toContain("## Later\n\n- A web UI some day.");
		expect(file("PROJECT.md")).toMatch(/^<!-- Written from \.sdd\/sdd\.db/);
		expect(file("REQUIREMENTS.md")).toContain(
			"- **R001** Add a todo (M001/S01)",
		);
		expect(file("DECISIONS.md")).toContain(
			"## D001 Storage\n\nA JSON file.\n\nWhy: One user.",
		);
		expect(file("milestones/M001/M001-ROADMAP.md")).toContain(
			"- [ ] **S02** Completing (after S01)",
		);
		expect(file("milestones/M001/slices/S01/S01-PLAN.md")).toContain(
			"- [x] **T01** a\n- [ ] **T02** b",
		);
		expect(file("milestones/M001/slices/S01/S01-RESEARCH.md")).toContain(
			"Node's fs is enough.",
		);
		expect(file("milestones/M001/slices/S01/tasks/T01-SUMMARY.md")).toContain(
			"12 passed",
		);
		expect(file("STATE.md")).toContain("Next: execute_task M001/S01/T02");
		// A replaced plan leaves no file behind.
		engine.replanSlice({ reason: "b is not needed.", tasks: [task("z")] });
		expect(file("milestones/M001/slices/S01/tasks/T02-PLAN.md")).toContain(
			"# T02 z",
		);
		expect(file("milestones/M001/slices/S01/S01-PLAN.md")).toContain(
			"(replanned 1x)",
		);
	});

	it("changes course: the context, and a slice with no work in it", () => {
		toRoadmap();
		engine.updateMilestone({ context: "CLI, and a config file." });
		expect(engine.activeMilestone()).toMatchObject({
			title: "First version",
			context: "CLI, and a config file.",
		});
		expect(() => engine.updateMilestone({})).toThrow(
			/new title or the new context/,
		);
		expect(engine.addSlices([{ title: "Config", depends: ["S02"] }])).toEqual([
			"S03",
		]);
		expect(() => engine.removeSlice({ slice: "S02", reason: "x" })).toThrow(
			/S03 "Config" depends on S02/,
		);
		engine.removeSlice({ slice: "S03", reason: "Not now." });
		expect(() =>
			engine.removeSlice({ slice: "S02", reason: "Not now." }),
		).toThrow(/S02 owns R002\. Defer them/);
		engine.updateRequirement("R002", { status: "deferred" });
		engine.removeSlice({ slice: "S02", reason: "Deferred." });
		expect(engine.slices("M001").map((slice) => slice.id)).toEqual(["S01"]);
		engine.planSlice({ tasks: [task("a")] });
		engine.startTask();
		expect(() => engine.removeSlice({ slice: "S01", reason: "x" })).toThrow(
			/has work in it/,
		);
		expect(() => engine.removeSlice({ slice: "", reason: "x" })).toThrow(
			/Name the slice/,
		);
	});

	it("records a quick change without touching the plan", () => {
		toRoadmap();
		const before = engine.next();
		expect(
			engine.quick({ title: "Fix a typo", summary: "README, checked by eye." }),
		).toBe("Q001");
		expect(engine.next()).toEqual(before);
		expect(file("quick/Q001-SUMMARY.md")).toContain("# Fix a typo");
	});

	it("throws a rule error for a rule, so a refusal can be told from a fault", () => {
		expect(() => engine.approve("requirements")).toThrow(SddRuleError);
	});
});

describe("the sdd tool", () => {
	let root: string;
	const CONTEXT = {} as AgentToolContext;
	const call = async (input: unknown) =>
		String(await createSddTool({ cwd: root }).execute(input, CONTEXT));

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sdd-tool-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("answers every call with the step that is due", async () => {
		expect(await call({ action: "next" })).toMatch(
			/^Next step: discuss_project — this one needs the user; stop and ask them\nNothing is recorded yet/,
		);
		const set = await call({
			action: "set_project",
			name: "Todo",
			description: "A todo list.",
		});
		expect(set).toMatch(
			/^The project is recorded\.\n\nNext step: discuss_milestone/,
		);
		expect(
			await call({ action: "add_requirement", title: "Add a todo" }),
		).toMatch(/^Added R001\./);
		expect(
			await call({ action: "add_milestone", title: "V1", context: "CLI." }),
		).toMatch(/^Added M001\.\n\nNext step: approve_requirements \(M001\)/);
	});

	it("turns a refusal into an answer that says what to do instead", async () => {
		await call({
			action: "set_project",
			name: "Todo",
			description: "A todo list.",
		});
		await call({ action: "add_requirement", title: "Add a todo" });
		await call({ action: "add_milestone", title: "V1", context: "CLI." });
		const refused = await call({
			action: "plan_milestone",
			slices: [{ title: "Adding" }],
		});
		expect(refused).toMatch(/^Not done: The requirements are not approved\./);
		expect(refused).toContain("Next step: approve_requirements (M001)");
		expect(await call({ action: "fly" })).toMatch(
			/^Not done: Unknown action "fly"\. Actions: next, status/,
		);
		expect(await call({ action: "approve", what: "everything" })).toMatch(
			/approve needs what/,
		);
	});

	it("takes lists as JSON text and steps as a list, as small models send them", async () => {
		await call({
			action: "set_project",
			name: "Todo",
			description: "A todo list.",
		});
		await call({ action: "add_requirement", title: "Add a todo" });
		await call({ action: "add_milestone", title: "V1", context: "CLI." });
		await call({ action: "approve", what: "requirements" });
		expect(
			await call({
				action: "plan_milestone",
				slices: JSON.stringify([{ title: "Adding", requirements: ["R001"] }]),
			}),
		).toMatch(/^The roadmap has S01\./);
		await call({ action: "approve", what: "roadmap" });
		const planned = await call({
			action: "plan_slice",
			tasks: [
				{ title: "store", steps: ["write it", "test it"], verify: "npm test" },
			],
		});
		expect(planned).toMatch(/^Planned T01\./);
		expect(planned).toContain("Steps: 1. write it\n2. test it");
		const started = await call({ action: "start_task" });
		expect(started).toMatch(/^Started T01 "store"\. Do exactly this task/);
		expect(started).toContain("Verify: npm test");
		// It is the step that is due: nothing calls it a task to resume.
		expect(started).not.toContain("Next step");
		expect(await call({ action: "next" })).toMatch(/^Next step: resume_task/);
		expect(await call({ action: "status" })).toContain(
			"[ ] S01 Adding: 0 of 1 tasks done   <- now",
		);
	});
});
