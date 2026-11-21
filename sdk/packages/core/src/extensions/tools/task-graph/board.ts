/**
 * The board: the graph as the model reads it, in one short block.
 *
 * Capped by construction rather than by truncation -- active tasks in full,
 * the top ready ones with what each unblocks, blocked ones as one `after`
 * line, and closed ones decayed to their outcome and then to a count -- so a
 * forty-task conversation costs about what a five-task one does. Phase 0
 * measured the checklist's fixed price at 2,320 tokens a request; this is
 * sent only when something calls for it, and stays near 300.
 */

import {
	countTasks,
	dependentsOf,
	isBlocked,
	isClosed,
	isParked,
	openDependencies,
	readyTasks,
	type Task,
	type TaskGraphState,
	taskLayers,
} from "./model";

const TITLE_MAX = 70;
const READY_SHOWN = 5;
const BLOCKED_SHOWN = 6;
const CLOSED_SHOWN = 4;

export function shortTitle(title: string, max = TITLE_MAX): string {
	const flat = title.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function acceptanceTally(task: Task): string {
	if (task.acceptance.length === 0) return "";
	const done = task.acceptance.filter((item) => item.done).length;
	return ` [${done}/${task.acceptance.length} checks]`;
}

export function boardCounts(state: TaskGraphState): string {
	const c = countTasks(state);
	const closed = c.done + c.cancelled;
	const parts = [`${closed}/${c.total} closed`];
	if (c.active) parts.push(`${c.active} active`);
	if (c.ready) parts.push(`${c.ready} ready`);
	if (c.blocked) parts.push(`${c.blocked} blocked`);
	if (c.waiting) parts.push(`${c.waiting} waiting`);
	return parts.join(" · ");
}

/** The board as text, or undefined when there are no tasks. */
export function renderBoard(state: TaskGraphState): string | undefined {
	if (state.order.length === 0) return undefined;
	const all = state.order.map((id) => state.tasks.get(id) as Task);
	const lines = [`Tasks: ${boardCounts(state)}`];
	const active = all.filter((task) => task.status === "active");
	for (const task of active) {
		lines.push(
			`Active: ${task.id} ${shortTitle(task.title)}${acceptanceTally(task)}`,
		);
	}
	const ready = readyTasks(state);
	if (ready.length > 0) {
		const shown = ready.slice(0, READY_SHOWN).map((task) => {
			const unblocks = dependentsOf(state, task.id).map((dep) => dep.id);
			return `${task.id} ${shortTitle(task.title, 50)}${
				unblocks.length ? ` (unblocks ${unblocks.join(", ")})` : ""
			}`;
		});
		const more = ready.length - shown.length;
		lines.push(
			`Ready: ${shown.join("; ")}${more > 0 ? `; +${more} more` : ""}`,
		);
	}
	const blocked = all.filter(
		(task) => isBlocked(state, task) && task.status !== "active",
	);
	if (blocked.length > 0) {
		const shown = blocked.slice(0, BLOCKED_SHOWN).map((task) => {
			const deps = openDependencies(state, task);
			return deps.length
				? `${task.id} after ${deps.join(", ")}`
				: `${task.id} parked`;
		});
		const more = blocked.length - shown.length;
		lines.push(
			`Blocked: ${shown.join("; ")}${more > 0 ? `; +${more} more` : ""}`,
		);
	}
	const waiting = all.filter((task) => task.status === "waiting");
	if (waiting.length > 0) {
		lines.push(
			`Waiting: ${waiting
				.map((task) => `${task.id} ${shortTitle(task.title, 40)}`)
				.join("; ")}`,
		);
	}
	const closed = all
		.filter((task) => isClosed(task.status))
		.sort((a, b) => b.touchedSeq - a.touchedSeq);
	if (closed.length > 0) {
		const shown = closed.slice(0, CLOSED_SHOWN).map((task) => {
			const word = task.status === "done" ? "done" : "cancelled";
			return task.outcome
				? `${task.id} ${word}: ${shortTitle(task.outcome, 60)}`
				: `${task.id} ${word}`;
		});
		const more = closed.length - shown.length;
		lines.push(
			`Closed: ${shown.join("; ")}${more > 0 ? `; +${more} earlier` : ""}`,
		);
	}
	return lines.join("\n");
}

/** One task in full, for `task_view show`. */
export function renderTask(state: TaskGraphState, task: Task): string {
	const lines = [
		`${task.id} ${task.title}`,
		`status: ${task.status}${isBlocked(state, task) ? " (blocked)" : ""}${
			isParked(state, task) ? " (parked)" : ""
		} · priority ${task.priority}${task.claimedBy ? ` · held by ${task.claimedBy}` : ""}`,
	];
	if (task.parent) lines.push(`parent: ${task.parent}`);
	if (task.depends.length) {
		const open = new Set(openDependencies(state, task));
		lines.push(
			`after: ${task.depends
				.map((id) => (open.has(id) ? `${id} (open)` : `${id} (closed)`))
				.join(", ")}`,
		);
	}
	const unblocks = dependentsOf(state, task.id).map((dep) => dep.id);
	if (unblocks.length) lines.push(`unblocks: ${unblocks.join(", ")}`);
	const children = state.order
		.map((id) => state.tasks.get(id) as Task)
		.filter((child) => child.parent === task.id);
	if (children.length) {
		lines.push(
			`subtasks: ${children.map((child) => `${child.id} ${child.status}`).join(", ")}`,
		);
	}
	if (task.description) lines.push(`description: ${task.description}`);
	if (task.acceptance.length) {
		lines.push("acceptance:");
		task.acceptance.forEach((item, index) => {
			lines.push(`  ${index + 1}. [${item.done ? "x" : " "}] ${item.text}`);
		});
	}
	if (task.files.length) lines.push(`files: ${task.files.join(", ")}`);
	if (task.outcome) lines.push(`outcome: ${task.outcome}`);
	const notes = task.notes.slice(-5);
	if (notes.length) {
		lines.push("notes:");
		for (const note of notes) lines.push(`  - ${note.text}`);
	}
	return lines.join("\n");
}

/** Open tasks by layer, for `task_view graph`. */
export function renderLayers(state: TaskGraphState): string {
	const layers = taskLayers(state);
	if (layers.length === 0) return "No open tasks.";
	return layers
		.map(
			(layer, index) =>
				`Layer ${index}${index === 0 ? " (can start now, side by side)" : ""}: ${layer
					.map((task) => `${task.id} ${shortTitle(task.title, 40)}`)
					.join("; ")}`,
		)
		.join("\n");
}

/**
 * The board as a saved note reads (task graph phase 2, export to memory):
 * a header naming the conversation and the time, the open tasks in full,
 * the closed ones as one line with their outcome.
 */
export function renderSavedBoard(
	state: TaskGraphState,
	header: { title?: string; sessionId: string; savedAt: string },
): string {
	const tasks = state.order.map((id) => state.tasks.get(id) as Task);
	const open = tasks.filter(
		(task) => task.status !== "done" && task.status !== "cancelled",
	);
	const closed = tasks.filter(
		(task) => task.status === "done" || task.status === "cancelled",
	);
	const lines = [
		`Task board${header.title ? `: ${header.title}` : ""}`,
		`Saved ${header.savedAt} from conversation ${header.sessionId}. ${boardCounts(state)}`,
	];
	if (open.length) {
		lines.push("", "Open:");
		for (const task of open) lines.push("", renderTask(state, task));
	}
	if (closed.length) {
		lines.push("", "Closed:");
		for (const task of closed) {
			lines.push(
				`- ${task.id} ${shortTitle(task.title)} (${task.status}${task.outcome ? `: ${task.outcome}` : ""})`,
			);
		}
	}
	return lines.join("\n");
}
