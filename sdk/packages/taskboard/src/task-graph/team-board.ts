/**
 * `team_task` on the task board (task graph phase 4, plan section 7).
 *
 * The team tool keeps its schema and actions (create, list, claim, complete,
 * block); its runtime methods read and write the conversation's board
 * instead of a list of their own. A task created with `team_task` is a `T<n>`
 * on the board and in the panel; a task planned with `task_plan` can be
 * claimed with `team_task`. One store, so the two can never disagree.
 *
 * | team status | board |
 * |---|---|
 * | pending | pending |
 * | in_progress | active |
 * | blocked | waiting (with the reason as a note) |
 * | completed | done, or cancelled (said in the summary) |
 */

import type {
	CreateTeamTaskInput,
	TeamTask,
	TeamTaskListItem,
	TeamTaskStatus,
} from "@cline/shared";
import { shortTitle } from "./board";
import { taskEventTargets } from "./model";
import { normalizeTaskId } from "./readers";
import type { TaskGraphSnapshot, TaskGraphStore, TaskSnapshot } from "./store";
import type { TeamTaskBoard } from "./team-types";

const STATUS: Record<TaskSnapshot["status"], TeamTaskStatus> = {
	pending: "pending",
	active: "in_progress",
	waiting: "blocked",
	done: "completed",
	cancelled: "completed",
};

export interface GraphTeamBoardOptions {
	/** Called with a team nudge's id and key, for the log. */
	onNudge?: (id: string, key: string) => void;
	/** A teammate's run ended holding these tasks; they are back on the board. */
	onReleased?: (agentId: string, ids: string[], reason: string) => void;
	/** Phase 6: a task the plan gave a teammate was started on it. */
	onDispatched?: (agentId: string, taskId: string, runId: string) => void;
	/** Phase 6: that run ended with the task closed (`done` or `cancelled`). */
	onDispatchClosed?: (agentId: string, task: TaskSnapshot) => void;
	/** Phase 6: the teammate could not take it; it stays on the board. */
	onDispatchRefused?: (agentId: string, taskId: string, reason: string) => void;
}

/**
 * What a teammate is told when the plan's task for it starts: the task, what
 * shows it is done, and what the tasks it builds on came to.
 */
export function dispatchMessage(
	task: TaskSnapshot,
	all: readonly TaskSnapshot[],
): string {
	const parts = [`Task ${task.id} from the lead's plan: ${task.title}`];
	if (task.description) parts.push(task.description);
	if (task.acceptance.length) {
		parts.push(
			`Done when:\n${task.acceptance.map((item) => `- ${item.text}`).join("\n")}`,
		);
	}
	const before = task.depends
		.map((id) => all.find((entry) => entry.id === id))
		.filter((entry): entry is TaskSnapshot => !!entry);
	if (before.length) {
		parts.push(
			`It builds on: ${before
				.map(
					(entry) =>
						`${entry.id} ${shortTitle(entry.title, 60)} (${entry.status}${entry.outcome ? `: ${entry.outcome}` : ""})`,
				)
				.join("; ")}.`,
		);
	}
	parts.push(
		"Do this task only: the lead and other teammates have the rest of the plan.",
	);
	return parts.join("\n\n");
}

/**
 * The board as the team runtime's task store. `author` is how the store
 * writes a member: the lead as the conversation's own model, a teammate by
 * its id (which makes its starts claims).
 */
export function createGraphTeamBoard(
	store: TaskGraphStore,
	options: GraphTeamBoardOptions = {},
): TeamTaskBoard & {
	/** T4: ready tasks nobody holds, for the lead waiting on runs. */
	idleReady(): string | undefined;
	/** Whether an agentId names a teammate that can take tasks. */
	isTeammate(agentId: string): boolean;
} {
	let leadId = "lead";
	let isRunning: (agentId: string) => boolean = () => false;
	let notify: (to: string, subject: string, body: string) => void = () => {};
	let isTeammate: ((agentId: string) => boolean) | undefined;
	let dispatch:
		| ((agentId: string, message: string, taskId: string) => string)
		| undefined;
	/** Phase 6: tasks started on their teammate, never started again by itself. */
	const dispatched = new Set<string>();
	/** One task at a time per teammate: the task its dispatched run is on. */
	const inFlight = new Map<string, { taskId: string; runId: string }>();
	let pumpDue = false;
	/** T3 is asked once per run: the teammate may know better. */
	const closeOutAsked = new Set<string>();
	const author = (agentId: string) =>
		agentId === leadId || agentId === "lead" ? "model" : agentId;
	const member = (by: string | undefined) =>
		!by || by === "model" ? leadId : by;

	const times = (
		id: string,
	): { createdAt: Date; updatedAt: Date; by: string } => {
		let created: number | undefined;
		let updated = 0;
		let by = "model";
		for (const event of store.getEvents()) {
			if (!taskEventTargets(event).includes(id)) continue;
			if (event.op === "create") {
				created = event.ts;
				by = event.by;
			}
			updated = Math.max(updated, event.ts);
		}
		return {
			createdAt: new Date(created ?? updated),
			updatedAt: new Date(updated || created || 0),
			by,
		};
	};

	const toTeam = (task: TaskSnapshot): TeamTask => {
		const when = times(task.id);
		const summary =
			task.status === "cancelled"
				? `cancelled${task.outcome ? `: ${task.outcome}` : ""}`
				: (task.outcome ?? task.notes.at(-1));
		return {
			id: task.id,
			title: task.title,
			description: task.description ?? "",
			status: STATUS[task.status],
			createdAt: when.createdAt,
			updatedAt: when.updatedAt,
			createdBy: member(when.by),
			...(task.claimedBy
				? { assignee: task.claimedBy }
				: task.status === "active"
					? { assignee: leadId }
					: {}),
			dependsOn: [...task.depends],
			...(summary ? { summary } : {}),
		};
	};

	const snapshot = (): TaskGraphSnapshot => store.snapshot();
	/** Free to take: ready, or the lead's active work nobody holds. */
	const claimable = (task: TaskSnapshot): boolean =>
		!task.claimedBy &&
		(task.ready || (task.status === "active" && task.waitsOn.length === 0));
	const find = (taskId: string): TaskSnapshot => {
		const id = normalizeTaskId(taskId) ?? taskId;
		const task = snapshot().tasks.find((entry) => entry.id === id);
		if (!task) {
			const known = snapshot()
				.tasks.map((entry) => entry.id)
				.slice(-8);
			throw new Error(
				`Task "${taskId}" was not found${known.length ? ` (tasks: ${known.join(", ")})` : ""}`,
			);
		}
		return task;
	};

	/**
	 * T5: a close made tasks ready; a teammate holding or assigned one is
	 * told through the team mailbox.
	 */
	const tellHolders = (readyNow: readonly string[]): void => {
		for (const id of readyNow) {
			const task = snapshot().tasks.find((entry) => entry.id === id);
			if (!task?.claimedBy || task.claimedBy === leadId) continue;
			options.onNudge?.("T5", `unblocked:${id}`);
			notify(
				task.claimedBy,
				`${id} is ready`,
				`${id} (${shortTitle(task.title, 60)}) is ready: what it waited on closed. Start it with team_task claim ${id}.`,
			);
		}
	};

	const change = (
		input: { updates: unknown[] },
		agentId: string,
	): { lines: string[]; readyNow: string[] } => {
		const outcome = store.update(input, { by: author(agentId) });
		tellHolders(outcome.readyNow);
		return outcome;
	};

	/**
	 * Phase 6: start each task the plan gave a teammate, once it is ready and
	 * the teammate is free. The model said who does what when it planned; the
	 * graph says when. Arm D3: told to hand tasks out, qwen36 27B did so in 1
	 * run of 10 -- the decision is taken once, in the plan, not at each step.
	 */
	const pump = (): void => {
		if (!dispatch || !isTeammate || store.planMode) return;
		for (const task of snapshot().tasks) {
			const agentId = task.assignee;
			if (!agentId || dispatched.has(task.id)) continue;
			if (inFlight.has(agentId) || !isTeammate(agentId)) continue;
			// Ready, or the lead started it before the teammate existed.
			const free =
				task.ready ||
				(task.status === "active" &&
					task.waitsOn.length === 0 &&
					(!task.claimedBy || task.claimedBy === agentId));
			if (!free) continue;
			change({ updates: [{ id: task.id, status: "active" }] }, agentId);
			const held = find(task.id);
			if (held.status !== "active" || held.claimedBy !== agentId) continue;
			dispatched.add(task.id);
			try {
				const runId = dispatch(
					agentId,
					dispatchMessage(held, snapshot().tasks),
					task.id,
				);
				inFlight.set(agentId, { taskId: task.id, runId });
				options.onNudge?.("T6", `dispatch:${task.id}:${agentId}`);
				options.onDispatched?.(agentId, task.id, runId);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				store.releaseClaims(agentId, `it could not take the task: ${reason}`);
				options.onDispatchRefused?.(agentId, task.id, reason);
			}
		}
	};
	/** Later, not inside the store's change: pumping changes the store. */
	const schedulePump = (): void => {
		if (pumpDue) return;
		pumpDue = true;
		queueMicrotask(() => {
			pumpDue = false;
			try {
				pump();
			} catch {
				// The board's trouble never stops the team.
			}
		});
	};
	store.watch(schedulePump);

	/** A teammate's run ended: its claims end, and its dispatch with them. */
	const stopped = (agentId: string, reason: string): void => {
		const run = inFlight.get(agentId);
		inFlight.delete(agentId);
		const released = store.releaseClaims(agentId, reason);
		closeOutAsked.delete(agentId);
		if (released.length) options.onReleased?.(agentId, released, reason);
		if (run) {
			const task = snapshot().tasks.find((entry) => entry.id === run.taskId);
			if (task && (task.status === "done" || task.status === "cancelled"))
				options.onDispatchClosed?.(agentId, task);
			schedulePump();
		}
	};

	return {
		attach(team) {
			leadId = team.leadId;
			isRunning = team.isRunning;
			notify = team.notify;
			isTeammate = team.isTeammate;
			dispatch = team.dispatch;
			// A dispatched run is queued before it runs: its claim stands then too.
			store.setHolderLive(
				(holder) =>
					holder === leadId || isRunning(holder) || inFlight.has(holder),
			);
			schedulePump();
		},

		memberJoined(_agentId: string): void {
			schedulePump();
		},

		create(input: CreateTeamTaskInput): TeamTask {
			const outcome = store.plan(
				{
					tasks: [
						{
							title: input.title,
							...(input.description ? { description: input.description } : {}),
							...(input.dependsOn?.length ? { depends: input.dependsOn } : {}),
						},
					],
				},
				{ by: author(input.createdBy) },
				// A team's list starts nothing: the lead hands tasks out.
				{ autoStart: false },
			);
			const id = /Created \d+: (T[\d.]+)/.exec(outcome.lines[0] ?? "")?.[1];
			if (!id) throw new Error(outcome.lines.join(" "));
			// Assigned at creation: held by that teammate, started once it can be.
			if (input.assignee && author(input.assignee) !== "model") {
				store.assign(id, input.assignee, { by: author(input.createdBy) });
				const task = find(id);
				if (task.ready)
					change({ updates: [{ id, status: "active" }] }, input.assignee);
			}
			return toTeam(find(id));
		},

		claim(taskId: string, agentId: string): TeamTask {
			const before = find(taskId);
			if (before.waitsOn.length > 0) {
				throw new Error(
					`Task "${before.id}" is blocked by "${before.waitsOn[0]}"`,
				);
			}
			const outcome = change(
				{ updates: [{ id: before.id, status: "active" }] },
				agentId,
			);
			const after = find(before.id);
			const mine =
				author(agentId) === "model"
					? !after.claimedBy
					: after.claimedBy === agentId;
			if (after.status !== "active" || !mine) {
				throw new Error(
					outcome.lines.join(" ") || `Task "${before.id}" could not be claimed`,
				);
			}
			return toTeam(after);
		},

		block(taskId: string, agentId: string, reason: string): TeamTask {
			const task = find(taskId);
			const outcome = change(
				{ updates: [{ id: task.id, status: "waiting", note: reason }] },
				agentId,
			);
			const after = find(task.id);
			if (after.status !== "waiting") throw new Error(outcome.lines.join(" "));
			return toTeam(after);
		},

		complete(taskId: string, agentId: string, summary: string): TeamTask {
			const task = find(taskId);
			const outcome = change(
				{ updates: [{ id: task.id, status: "done", note: summary }] },
				agentId,
			);
			const after = find(task.id);
			if (after.status !== "done") throw new Error(outcome.lines.join(" "));
			return toTeam(after);
		},

		get(taskId: string): TeamTask | undefined {
			const id = normalizeTaskId(taskId) ?? taskId;
			const task = snapshot().tasks.find((entry) => entry.id === id);
			return task ? toTeam(task) : undefined;
		},

		list(): TeamTaskListItem[] {
			return snapshot().tasks.map((task) => ({
				...toTeam(task),
				blockedBy: [...task.waitsOn],
				isReady: task.ready && !task.claimedBy,
			}));
		},

		runEnded(ids: string[], ok: boolean, reason?: string): void {
			const outcome = store.resolveGates((gate) => {
				const match = /^run:(.+)$/.exec(gate.spec);
				if (!match || !ids.includes((match[1] as string).trim()))
					return undefined;
				return ok ? { open: true } : { failed: reason ?? "the run failed" };
			});
			tellHolders(outcome.readyNow);
			// A dispatched run that ended without its teammate's task end
			// (failed before it started, cancelled in the queue).
			for (const [agentId, run] of [...inFlight]) {
				if (ids.includes(run.runId))
					stopped(agentId, ok ? "its run ended" : (reason ?? "the run failed"));
			}
		},

		agentStopped(agentId: string, reason: string): void {
			stopped(agentId, reason);
		},

		/** T2: a teammate's run opens with the tasks it holds, or the ones it may claim. */
		briefFor(agentId: string): string | undefined {
			const tasks = snapshot().tasks;
			const held = tasks.filter(
				(task) =>
					task.claimedBy === agentId &&
					task.status !== "done" &&
					task.status !== "cancelled",
			);
			if (held.length > 0) {
				options.onNudge?.("T2", `held:${agentId}`);
				return `[Task board] You hold ${held
					.map((task) => `${task.id} (${shortTitle(task.title, 50)})`)
					.join(
						", ",
					)}. When it is done, close it with team_task complete and a summary of what was done and how it was checked; if you cannot finish it, team_task block with the reason.`;
			}
			const ready = tasks.filter(claimable);
			if (ready.length === 0) return undefined;
			options.onNudge?.("T2", `claim:${agentId}`);
			return `[Task board] If this work is one of these tasks, claim it before you start (team_task claim <id>), and close it with team_task complete when done: ${ready
				.slice(0, 6)
				.map((task) => `${task.id} ${shortTitle(task.title, 50)}`)
				.join("; ")}.`;
		},

		closeOutFor(agentId: string): string | undefined {
			if (closeOutAsked.has(agentId)) return undefined;
			const open = snapshot().tasks.filter(
				(task) => task.claimedBy === agentId && task.status === "active",
			);
			if (open.length === 0) return undefined;
			closeOutAsked.add(agentId);
			options.onNudge?.("T3", `report:${agentId}`);
			const ids = open.map((task) => task.id).join(", ");
			return `[SYSTEM] You still hold ${ids} on the task board. Before you finish, close it: team_task complete with a summary of what was done and how it was checked, or team_task block with the reason it cannot be finished. Left as it is, it goes back on the board as not done.`;
		},

		isTeammate(agentId: string): boolean {
			return isTeammate?.(agentId) ?? false;
		},

		idleReady(): string | undefined {
			// A task the plan gave a teammate is not nobody's.
			const ready = snapshot().tasks.filter(
				(task) => task.ready && !task.claimedBy && !task.assignee,
			);
			if (ready.length === 0) return undefined;
			return ready
				.slice(0, 5)
				.map((task) => `${task.id} ${shortTitle(task.title, 50)}`)
				.join("; ");
		},
	};
}
