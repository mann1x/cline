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
	openGates,
	readyTasks,
	type Task,
	type TaskGraphState,
	taskLayers,
	waitsOn,
} from "./model";

// Measured on pandorum's boards (129 transcripts, 4.100.292-298, replayed
// call by call on 2026-11-26): at most 17 tasks and 11 closed; the board
// text p90 440 characters, largest 726 (~200 tokens). More than four tasks
// were closed in 15 transcripts, and of the 5 times the model named a closed
// task in task_update or task_view, every one was among the four shown: none
// reached for one the decay had hidden. The caps stay as they are.
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
			`Active: ${task.id} ${shortTitle(task.title)}${acceptanceTally(task)}${
				task.claimedBy ? ` [${task.claimedBy}]` : ""
			}`,
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
			const deps = waitsOn(state, task);
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
				.map((task) => {
					const gates = openGates(state, task);
					return `${task.id} ${shortTitle(task.title, 40)}${
						gates.length ? ` (on ${gates.join(", ")})` : ""
					}${task.claimedBy ? ` [${task.claimedBy}]` : ""}`;
				})
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
	if ((task.gates ?? []).length) {
		lines.push(
			`gates: ${task.gates
				.map(
					(gate) =>
						`${gate.spec} (${gate.open ? "open" : gate.failed ? `cannot open: ${gate.failed}` : "waiting"})`,
				)
				.join(", ")}`,
		);
	}
	if ((task.links ?? []).length) {
		lines.push(
			`links: ${task.links.map((link) => `${link.type} ${link.target}`).join(", ")}`,
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

/**
 * Every task, one line each, subtasks indented under their parent: what the
 * CLI's `/tasks` prints. Status, who holds it, and what it waits on.
 */
export function renderBoardListing(state: TaskGraphState): string {
	if (state.order.length === 0) return "No tasks on the board yet.";
	const tasks = state.order.map((id) => state.tasks.get(id) as Task);
	const lines = [`Tasks: ${boardCounts(state)}`];
	const mark: Record<Task["status"], string> = {
		pending: "○",
		active: "▶",
		waiting: "⏸",
		done: "✓",
		cancelled: "✕",
	};
	const emit = (task: Task, depth: number): void => {
		const wait = waitsOn(state, task);
		const extra = [
			task.claimedBy ? `held by ${task.claimedBy}` : "",
			!isClosed(task.status) && wait.length ? `after ${wait.join(", ")}` : "",
			task.outcome ? task.outcome : "",
		].filter(Boolean);
		lines.push(
			`${"  ".repeat(depth)}${mark[task.status]} ${task.id} ${shortTitle(task.title)}${
				extra.length ? ` (${extra.join("; ")})` : ""
			}`,
		);
		for (const child of tasks.filter((entry) => entry.parent === task.id)) {
			emit(child, depth + 1);
		}
	};
	for (const task of tasks) {
		if (!task.parent || !state.tasks.has(task.parent)) emit(task, 0);
	}
	return lines.join("\n");
}

/** A Mermaid label: quotes and brackets would end it early. */
function mermaidLabel(text: string): string {
	return text
		.replace(/["[\]{}()<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The board as a Mermaid flowchart, for `task_view mermaid` and the panel's
 * drawing: one node per task, an edge per dependency (and a dotted one per
 * task link), subtasks inside their parent, gates as their own nodes.
 */
export function renderMermaid(state: TaskGraphState): string {
	const node = (id: string) => id.replace(/\./g, "_");
	const lines = ["flowchart TD"];
	const tasks = state.order.map((id) => state.tasks.get(id) as Task);
	const childrenOf = new Map<string, Task[]>();
	for (const task of tasks) {
		if (!task.parent) continue;
		const list = childrenOf.get(task.parent) ?? [];
		list.push(task);
		childrenOf.set(task.parent, list);
	}
	const label = (task: Task) =>
		`${node(task.id)}["${task.id} ${mermaidLabel(shortTitle(task.title, 40))}"]:::${task.status}`;
	const emit = (task: Task, indent: string): void => {
		const kids = childrenOf.get(task.id);
		if (kids?.length) {
			lines.push(
				`${indent}subgraph ${node(task.id)}_group["${task.id} ${mermaidLabel(shortTitle(task.title, 40))}"]`,
			);
			lines.push(`${indent}  ${label(task)}`);
			for (const kid of kids) emit(kid, `${indent}  `);
			lines.push(`${indent}end`);
		} else {
			lines.push(`${indent}${label(task)}`);
		}
	};
	for (const task of tasks) if (!task.parent) emit(task, "  ");
	let gateCount = 0;
	for (const task of tasks) {
		for (const dep of task.depends) {
			if (state.tasks.has(dep))
				lines.push(`  ${node(dep)} --> ${node(task.id)}`);
		}
		for (const link of task.links ?? []) {
			if (state.tasks.has(link.target))
				lines.push(
					`  ${node(link.target)} -. ${link.type} .-> ${node(task.id)}`,
				);
		}
		for (const gate of task.gates ?? []) {
			gateCount += 1;
			lines.push(
				`  G${gateCount}{{"${mermaidLabel(gate.spec)}"}}:::${gate.open ? "gateopen" : "gate"} --> ${node(task.id)}`,
			);
		}
	}
	lines.push(
		"  classDef done fill:#2e7d32,color:#fff",
		"  classDef cancelled fill:#757575,color:#fff",
		"  classDef active fill:#1565c0,color:#fff",
		"  classDef waiting fill:#ef6c00,color:#fff",
		"  classDef pending fill:#fff,color:#000,stroke:#999",
		"  classDef gate fill:#fff3e0,color:#000,stroke:#ef6c00",
		"  classDef gateopen fill:#e8f5e9,color:#000,stroke:#2e7d32",
	);
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
