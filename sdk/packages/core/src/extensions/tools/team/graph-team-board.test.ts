import {
	createGraphTeamBoard,
	TaskGraphStore,
	TaskGraphTracker,
	TEAM_PLAN_SENTENCE,
} from "@cline/taskboard";
import { describe, expect, it } from "vitest";
import { AgentTeamsRuntime } from "./multi-agent";

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
			"give a task to one by putting its agentId in `to`",
		);
		const planning = new TaskGraphTracker({ planMode: true });
		planning.attachTeam({ idleReady: () => undefined });
		expect(planDescription(planning)).not.toContain("teammates");
	});

	it("offers `to` only with a team, and says when it names nobody yet", async () => {
		const schemaOf = (tracker: TaskGraphTracker) =>
			JSON.stringify(
				tracker.tools().find((tool) => tool.name === "task_plan")?.inputSchema,
			);
		expect(schemaOf(new TaskGraphTracker())).not.toContain('"to"');
		const team = new TaskGraphTracker();
		team.attachTeam({
			idleReady: () => undefined,
			isTeammate: (agentId) => agentId === "w1",
		});
		expect(schemaOf(team)).toContain('"to"');
		const plan = team.tools().find((tool) => tool.name === "task_plan");
		const [result] = (await plan?.execute(
			{
				tasks: [
					{ title: "A", to: "w1" },
					{ title: "B", to: "w2" },
					{ title: "C" },
				],
			},
			{ agentId: "lead", iteration: 1 } as never,
		)) as { result: string }[];
		const text = JSON.stringify(result);
		expect(text).toContain("T1 A → w1");
		expect(text).toContain(
			'w2 is not a teammate yet: spawn it with team_spawn_teammate (agentId \\"w2\\") and T2 starts on it when ready.',
		);
		expect(text).not.toContain("w1 is not a teammate");
		// The lead's own task is the one started for it.
		expect(team.store.getState().tasks.get("T3")?.status).toBe("active");
		expect(team.store.getState().tasks.get("T1")?.status).toBe("pending");
	});
});

// Phase 6: the plan says who does what; the graph says when.
describe("the plan hands tasks to teammates", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	function team(members: string[] = ["w1", "w2"]) {
		const store = new TaskGraphStore();
		const teammates = new Set(members);
		const runs: { agent: string; task: string; message: string }[] = [];
		const told: string[] = [];
		let refuse: string | undefined;
		const board = createGraphTeamBoard(store, {
			onDispatched: (agent, task, run) =>
				told.push(`start ${task} ${agent} ${run}`),
			onDispatchClosed: (agent, task) =>
				told.push(`closed ${task.id} ${agent} ${task.status}`),
			onDispatchRefused: (agent, task, reason) =>
				told.push(`refused ${task} ${agent} ${reason}`),
			onReleased: (agent, ids) => told.push(`released ${agent} ${ids}`),
		});
		board.attach?.({
			isRunning: () => false,
			notify: () => {},
			leadId: "lead",
			isTeammate: (agent) => teammates.has(agent),
			dispatch: (agent, message, task) => {
				if (refuse) throw new Error(refuse);
				runs.push({ agent, task, message });
				return `run_${runs.length}`;
			},
		});
		return {
			store,
			board,
			teammates,
			runs,
			told,
			refuseWith: (reason: string) => {
				refuse = reason;
			},
		};
	}

	it("starts a task on its teammate when ready, and the next one when what it needs is done", async () => {
		const { store, board, runs, told } = team();
		store.plan({
			tasks: [
				{ title: "Parse the input", to: "w1", acceptance: ["tests pass"] },
				{ title: "Report", to: "w1", depends: ["#1"] },
				{ title: "Docs" },
			],
		});
		await tick();
		expect(runs.map((run) => `${run.agent}:${run.task}`)).toEqual(["w1:T1"]);
		expect(runs[0]?.message).toContain(
			"Task T1 from the lead's plan: Parse the input",
		);
		expect(runs[0]?.message).toContain("Done when:\n- tests pass");
		expect(store.getState().tasks.get("T1")?.claimedBy).toBe("w1");
		expect(store.getState().tasks.get("T3")?.status).toBe("active");
		expect(told).toEqual(["start T1 w1 run_1"]);
		board.complete("T1", "w1", "parser written, 4 tests pass");
		board.agentStopped?.("w1", "its run ended");
		await tick();
		expect(told).toContain("closed T1 w1 done");
		expect(runs.map((run) => run.task)).toEqual(["T1", "T2"]);
		expect(runs[1]?.message).toContain(
			"It builds on: T1 Parse the input (done: parser written, 4 tests pass).",
		);
	});

	it("gives a teammate one task at a time", async () => {
		const { store, board, runs } = team();
		store.plan({
			tasks: [
				{ title: "A", to: "w1" },
				{ title: "B", to: "w1" },
				{ title: "C", to: "w2" },
			],
		});
		await tick();
		expect(runs.map((run) => `${run.agent}:${run.task}`)).toEqual([
			"w1:T1",
			"w2:T3",
		]);
		// Its queued run holds the claim: not taken back while it waits.
		expect(store.getState().tasks.get("T1")?.claimedBy).toBe("w1");
		board.complete("T1", "w1", "done");
		board.agentStopped?.("w1", "its run ended");
		await tick();
		expect(runs.map((run) => `${run.agent}:${run.task}`)).toContain("w1:T2");
	});

	it("waits for a teammate that does not exist yet", async () => {
		const { store, board, runs, teammates } = team([]);
		store.plan({ tasks: [{ title: "A", to: "w9" }] });
		await tick();
		expect(runs).toEqual([]);
		teammates.add("w9");
		board.memberJoined?.("w9");
		await tick();
		expect(runs.map((run) => run.task)).toEqual(["T1"]);
	});

	it("a task its teammate left open goes back to the board and is not started again by itself", async () => {
		const { store, board, runs, told } = team();
		store.plan({ tasks: [{ title: "A", to: "w1" }] });
		await tick();
		board.agentStopped?.("w1", "its run failed");
		await tick();
		expect(told).toContain("released w1 T1");
		expect(store.getState().tasks.get("T1")?.claimedBy).toBeUndefined();
		expect(runs).toHaveLength(1);
	});

	it("a refused start is said, and the claim is let go", async () => {
		const { store, runs, told, refuseWith } = team();
		refuseWith('Teammate "w1" was shut down');
		store.plan({ tasks: [{ title: "A", to: "w1" }] });
		await tick();
		expect(runs).toEqual([]);
		expect(told.some((line) => line.startsWith("refused T1 w1"))).toBe(true);
		expect(store.getState().tasks.get("T1")?.claimedBy).toBeUndefined();
	});

	it("does nothing in plan mode", async () => {
		const store = new TaskGraphStore({ planMode: true });
		const runs: string[] = [];
		const board = createGraphTeamBoard(store);
		board.attach?.({
			isRunning: () => false,
			notify: () => {},
			leadId: "lead",
			isTeammate: () => true,
			dispatch: (_agent, _message, task) => {
				runs.push(task);
				return "run_1";
			},
		});
		store.plan({ tasks: [{ title: "A", to: "w1" }] });
		await tick();
		expect(runs).toEqual([]);
	});
});
