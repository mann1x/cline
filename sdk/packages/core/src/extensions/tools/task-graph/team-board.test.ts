import { describe, expect, it } from "vitest";
import { AgentTeamsRuntime } from "../team/multi-agent";
import { TaskGraphStore } from "./store";
import { createGraphTeamBoard } from "./team-board";
import { TEAM_PLAN_SENTENCE } from "./tools";
import { TaskGraphTracker } from "./tracker";

function setup() {
	const store = new TaskGraphStore();
	const running = new Set<string>();
	const mail: { to: string; subject: string; body: string }[] = [];
	const nudges: string[] = [];
	const released: string[] = [];
	const board = createGraphTeamBoard(store, {
		onNudge: (id) => nudges.push(id),
		onReleased: (agent, ids) => released.push(`${agent}:${ids.join(",")}`),
	});
	board.attach?.({
		isRunning: (agent) => running.has(agent),
		notify: (to, subject, body) => mail.push({ to, subject, body }),
		leadId: "lead",
	});
	return { store, board, running, mail, nudges, released };
}

describe("team_task on the board", () => {
	it("a task created with team_task is a T<n>, and task_plan's can be claimed", () => {
		const { store, board, running } = setup();
		const made = board.create({
			title: "Write tests",
			description: "for x",
			createdBy: "lead",
		});
		expect(made.id).toBe("T1");
		expect(store.getState().tasks.get("T1")?.title).toBe("Write tests");
		store.plan({ tasks: [{ title: "Docs" }] });
		running.add("alice");
		const claimed = board.claim("T2", "alice");
		expect(claimed.status).toBe("in_progress");
		expect(claimed.assignee).toBe("alice");
		expect(store.getState().tasks.get("T2")?.claimedBy).toBe("alice");
	});

	it("statuses map one to one", () => {
		const { board, running } = setup();
		board.create({ title: "A", description: "", createdBy: "lead" });
		board.create({ title: "B", description: "", createdBy: "lead" });
		running.add("bob");
		board.claim("T2", "bob");
		expect(board.block("T2", "bob", "needs a key").status).toBe("blocked");
		const done = board.complete("T1", "lead", "written and run");
		expect(done.status).toBe("completed");
		expect(done.summary).toBe("written and run");
		const listed = board.list();
		expect(listed.find((task) => task.id === "T2")?.summary).toBe(
			"needs a key",
		);
	});

	it("claim refuses a blocked task, as the team list did", () => {
		const { board } = setup();
		board.create({ title: "A", description: "", createdBy: "lead" });
		board.create({
			title: "B",
			description: "",
			createdBy: "lead",
			dependsOn: ["T1"],
		});
		expect(() => board.claim("T2", "alice")).toThrow(
			'Task "T2" is blocked by "T1"',
		);
	});

	it("another live teammate's task is refused", () => {
		const { board, running } = setup();
		board.create({ title: "A", description: "", createdBy: "lead" });
		running.add("alice");
		running.add("bob");
		board.claim("T1", "alice");
		expect(() => board.complete("T1", "bob", "x")).toThrow("held by alice");
	});

	it("T5: a close tells the teammate holding what became ready", () => {
		const { board, mail, nudges } = setup();
		board.create({ title: "A", description: "", createdBy: "lead" });
		board.create({
			title: "B",
			description: "",
			createdBy: "lead",
			dependsOn: ["T1"],
			assignee: "alice",
		});
		board.complete("T1", "lead", "done");
		expect(mail).toEqual([
			expect.objectContaining({ to: "alice", subject: "T2 is ready" }),
		]);
		expect(nudges).toContain("T5");
	});

	it("run: gates open when the run ends, and a stopped agent's claims go back", () => {
		const { store, board, released } = setup();
		store.plan({
			tasks: [{ title: "Merge", gate: ["run:alice"] }, { title: "Fix" }],
		});
		board.claim("T2", "alice");
		board.runEnded?.(["alice"], true);
		expect(store.getState().tasks.get("T1")?.gates[0]?.open).toBe(true);
		board.agentStopped?.("alice", "its run ended");
		expect(store.getState().tasks.get("T2")?.status).toBe("pending");
		expect(released).toEqual(["alice:T2"]);
	});

	it("T2 and T3: a teammate is told what it may claim, and asked once to close what it holds", () => {
		const { board, running } = setup();
		board.create({ title: "A", description: "", createdBy: "lead" });
		expect(board.briefFor?.("alice")).toContain("team_task claim");
		running.add("alice");
		board.claim("T1", "alice");
		expect(board.briefFor?.("alice")).toContain("You hold T1");
		expect(board.closeOutFor?.("alice")).toContain("You still hold T1");
		expect(board.closeOutFor?.("alice")).toBeUndefined();
	});
});

describe("the team runtime on a board", () => {
	it("team_task's runtime methods read and write the board", () => {
		const store = new TaskGraphStore();
		const runtime = new AgentTeamsRuntime({
			teamName: "t",
			leadAgentId: "lead",
		});
		runtime.useTaskBoard(createGraphTeamBoard(store));
		const task = runtime.createTask({
			title: "A",
			description: "d",
			createdBy: "lead",
		});
		expect(task.id).toBe("T1");
		expect(runtime.listTaskItems().map((item) => item.id)).toEqual(["T1"]);
		store.plan({ tasks: [{ title: "B" }] });
		expect(runtime.listTaskItems().map((item) => item.id)).toEqual([
			"T1",
			"T2",
		]);
		runtime.completeTask("T2", "lead", "ok");
		expect(store.getState().tasks.get("T2")?.status).toBe("done");
		expect(runtime.exportState().tasks).toEqual([]);
		expect(runtime.getSnapshot().taskCounts.completed).toBe(1);
	});

	it("a list the runtime held before is moved onto the board once", () => {
		const store = new TaskGraphStore();
		const runtime = new AgentTeamsRuntime({
			teamName: "t",
			leadAgentId: "lead",
		});
		runtime.createTask({ title: "Old", description: "", createdBy: "lead" });
		runtime.useTaskBoard(createGraphTeamBoard(store));
		expect(store.getState().tasks.get("T1")?.title).toBe("Old");
		expect(runtime.exportState().tasks).toEqual([]);
	});
});

describe("team nudges on the lead", () => {
	it("T1: a plan with two tasks that can run side by side", () => {
		const tracker = new TaskGraphTracker();
		tracker.attachTeam({ idleReady: () => undefined });
		const input = {
			tasks: [{ title: "A" }, { title: "B" }, { title: "C", depends: ["#1"] }],
		};
		tracker.store.plan(input);
		tracker.recordToolResult(input, "task_plan", [{ success: true }]);
		const said = tracker.takePendingReminder() ?? "";
		expect(said).toContain("can run side by side");
	});

	it("T4: waiting on runs with ready work nobody holds", () => {
		const tracker = new TaskGraphTracker();
		tracker.attachTeam({ idleReady: () => "T3 Docs" });
		tracker.recordToolResult({}, "team_await_runs", { success: true });
		expect(tracker.takePendingReminder() ?? "").toContain("T3 Docs");
	});

	it("a delegated agent's answer opens its run: gate; a background start does not", () => {
		const tracker = new TaskGraphTracker();
		tracker.store.plan({
			tasks: [{ title: "Use the review", gate: ["run:reviewer"] }],
		});
		tracker.recordToolResult({ name: "reviewer", wait: false }, "spawn_agent", {
			background: true,
		});
		expect(tracker.store.getState().tasks.get("T1")?.gates[0]?.open).toBe(
			false,
		);
		tracker.recordToolResult({ name: "reviewer" }, "spawn_agent", {
			text: "looks fine",
		});
		expect(tracker.store.getState().tasks.get("T1")?.gates[0]?.open).toBe(true);
	});
});

describe("task_plan with teammates", () => {
	const planDescription = (tracker: TaskGraphTracker) =>
		tracker.tools().find((tool) => tool.name === "task_plan")?.description ??
		"";

	it("says to hand independent tasks out only when a team is attached, and not in plan mode", () => {
		const solo = new TaskGraphTracker();
		expect(planDescription(solo)).not.toContain(TEAM_PLAN_SENTENCE.trim());
		const team = new TaskGraphTracker();
		team.attachTeam({ idleReady: () => undefined });
		expect(planDescription(team)).toContain(
			"hand each task that does not depend on another to a teammate",
		);
		const planning = new TaskGraphTracker({ planMode: true });
		planning.attachTeam({ idleReady: () => undefined });
		expect(planDescription(planning)).not.toContain("team_run_task");
	});
});
