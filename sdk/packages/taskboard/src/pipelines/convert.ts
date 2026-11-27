/**
 * Board and pipeline, both ways (plan section 8).
 *
 * - A board becomes a pipeline: each task an `agent` node with the task as
 *   its prompt, the commands its acceptance names a `check` after it,
 *   `depends` as `after`, and its `human:` gates as `wait` nodes before it.
 *   A plan worked out once becomes a reviewed, repeatable pipeline.
 * - A pipeline becomes a task template: the nodes that do work become tasks
 *   in their layers, for work the model should do rather than run.
 *
 * Both are pure: the caller saves the result, as a proposal or a template.
 */

import type { PipelineDefinition, PipelineNode } from "./model";
import { parseRef } from "./model";

/** A board's task as both the core board and the task panel's snapshot give it. */
export interface BoardTaskLike {
	id: string;
	title: string;
	description?: string;
	status?: string;
	parent?: string;
	acceptance?: readonly (string | { text: string })[];
	depends?: readonly string[];
	gates?: readonly (string | { spec: string })[];
}

export interface BoardConversion {
	definition: PipelineDefinition;
	/** What did not carry over, for the person to read. */
	notes: string[];
}

/** `T1.2` → `t1-2`: a pipeline id (a letter first, then word characters and dashes). */
function nodeIdFor(taskId: string): string {
	const id = taskId
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return /^[a-z]/.test(id) ? id.slice(0, 56) : `t${id}`.slice(0, 56);
}

const textOf = (entry: string | { text: string }) =>
	typeof entry === "string" ? entry : entry.text;
const specOf = (entry: string | { spec: string }) =>
	typeof entry === "string" ? entry : entry.spec;

/**
 * An acceptance item that is a command and nothing else: "`bun test`",
 * "`bun test` passes", "`make lint` exits 0". Anything with more words is
 * the agent's to judge.
 */
export function acceptanceCommand(text: string): string | undefined {
	const match =
		/^\s*`([^`]+)`\s*(?:(?:passes|succeeds|is green|exits (?:with )?0|returns 0)\s*)?\.?\s*$/i.exec(
			text,
		);
	return match ? (match[1] as string).trim() : undefined;
}

/**
 * A board as a pipeline. Cancelled tasks are left out. A task with subtasks
 * is their container, not work of its own: its subtasks take its
 * dependencies, and what depends on it waits for all of them.
 */
export function boardToPipeline(
	tasks: readonly BoardTaskLike[],
	name: string,
	description?: string,
): BoardConversion {
	const notes: string[] = [];
	const kept = tasks.filter((task) => task.status !== "cancelled");
	const byId = new Map(kept.map((task) => [task.id, task]));
	const children = new Map<string, BoardTaskLike[]>();
	for (const task of kept) {
		if (task.parent && byId.has(task.parent)) {
			const list = children.get(task.parent) ?? [];
			list.push(task);
			children.set(task.parent, list);
		}
	}
	const isContainer = (id: string) => (children.get(id)?.length ?? 0) > 0;
	for (const task of kept) {
		if (isContainer(task.id)) {
			notes.push(
				`${task.id} "${task.title}" has subtasks: they became the nodes, and it did not.`,
			);
		}
	}

	// The node a task ends with, which what depends on it waits for.
	const ends = new Map<string, string[]>();
	const endsOf = (id: string, seen = new Set<string>()): string[] => {
		const known = ends.get(id);
		if (known) return known;
		if (seen.has(id)) return [];
		seen.add(id);
		const task = byId.get(id);
		if (!task) return [];
		const result = isContainer(id)
			? (children.get(id) ?? []).flatMap((child) => endsOf(child.id, seen))
			: [
					task.acceptance?.some((item) => acceptanceCommand(textOf(item)))
						? `${nodeIdFor(id)}-check`
						: nodeIdFor(id),
				];
		ends.set(id, result);
		return result;
	};
	// What a task waits for: its own dependencies and its containers'.
	const dependsOf = (task: BoardTaskLike): string[] => {
		const all = new Set<string>();
		let at: BoardTaskLike | undefined = task;
		const seen = new Set<string>();
		while (at && !seen.has(at.id)) {
			seen.add(at.id);
			for (const dep of at.depends ?? []) {
				if (byId.has(dep)) {
					for (const end of endsOf(dep)) all.add(end);
				} else {
					notes.push(`${at.id} depended on ${dep}, which is not on the board.`);
				}
			}
			at = at.parent ? byId.get(at.parent) : undefined;
		}
		return [...all];
	};

	const nodes: PipelineNode[] = [];
	for (const task of kept) {
		if (isContainer(task.id)) continue;
		const id = nodeIdFor(task.id);
		let after = dependsOf(task);
		const humanGates: string[] = [];
		for (const gate of task.gates ?? []) {
			const spec = specOf(gate);
			if (/^\s*human\s*:/i.test(spec)) humanGates.push(spec.trim());
			else
				notes.push(
					`${task.id}'s gate ${spec} belongs to that conversation and was left out.`,
				);
		}
		humanGates.forEach((gate, index) => {
			const gateId = `${id}-gate${humanGates.length > 1 ? `-${index + 1}` : ""}`;
			nodes.push({
				id: gateId,
				type: "wait",
				name: `Wait: ${task.title}`.slice(0, 80),
				gate,
				...(after.length ? { after } : {}),
			});
			after = [gateId];
		});
		const acceptance = (task.acceptance ?? []).map(textOf);
		const commands = acceptance
			.map(acceptanceCommand)
			.filter((command): command is string => !!command);
		const prompt = [
			task.title,
			task.description?.trim(),
			acceptance.length
				? `Done when:\n${acceptance.map((item) => `- ${item}`).join("\n")}`
				: undefined,
		]
			.filter(Boolean)
			.join("\n\n");
		nodes.push({
			id,
			type: "agent",
			name: task.title.slice(0, 80),
			task: prompt,
			...(after.length ? { after } : {}),
		});
		if (commands.length) {
			nodes.push({
				id: `${id}-check`,
				type: "check",
				name: `Check: ${task.title}`.slice(0, 80),
				command: commands.join(" && "),
				after: [id],
			});
		}
	}
	return {
		definition: {
			name,
			description:
				description ??
				`From a task board: ${kept.length} task${kept.length === 1 ? "" : "s"}.`,
			nodes,
		},
		notes: [...new Set(notes)],
	};
}

export interface PipelineTemplate {
	name: string;
	description?: string;
	tasks: Record<string, unknown>[];
}

/** Nodes that route or reshape data: no work for a task of their own. */
const PASS_THROUGH = new Set(["if", "switch", "merge", "set"]);

/** `{{ $vars.branch }}` → `{{branch}}`, the template's own variable. */
function templateText(text: string): string {
	return text.replace(
		/\{\{\s*\$vars\.([A-Za-z_][\w-]*)\s*\}\}/g,
		(_whole, key: string) => `{{${key}}}`,
	);
}

/** What a node does, in a line, for a task's description. */
function nodeWork(node: PipelineNode): string | undefined {
	const field = (key: string) => {
		const value = (node as unknown as Record<string, unknown>)[key];
		return typeof value === "string" ? value : undefined;
	};
	switch (node.type) {
		case "agent":
			return [field("agent") && `Agent ${field("agent")}:`, field("task")]
				.filter(Boolean)
				.join(" ");
		case "swarm":
			return field("instructions");
		case "command":
			return field("command") && `Run \`${field("command")}\`.`;
		case "tool":
			return field("tool") && `Use the ${field("tool")} tool.`;
		case "http":
			return field("url") && `${field("method") ?? "GET"} ${field("url")}.`;
		case "pipeline":
			return (
				field("pipeline") && `What the ${field("pipeline")} pipeline does.`
			);
		case "loop": {
			const body = (node as unknown as { body?: PipelineNode }).body;
			const inner = body ? nodeWork(body as PipelineNode) : undefined;
			return [field("over") && `For each of ${field("over")}:`, inner]
				.filter(Boolean)
				.join(" ");
		}
		default:
			return field("description");
	}
}

/**
 * A pipeline as a task template. Nodes that do work become tasks;
 * `if`, `switch`, `merge` and `set` pass their dependencies through; a
 * `check` becomes an acceptance item of the tasks before it; an `approval`
 * or a `human:` wait becomes a `human:` gate on the tasks after it, and
 * other waits pass through. `{{ $vars.x }}` becomes the template's `{{x}}`.
 */
export function pipelineToTemplate(
	definition: PipelineDefinition,
	name = definition.name,
): PipelineTemplate {
	const nodes = definition.nodes;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const isTask = (node: PipelineNode) =>
		!PASS_THROUGH.has(node.type) &&
		node.type !== "check" &&
		node.type !== "wait" &&
		node.type !== "approval";
	const humanGate = (node: PipelineNode): string | undefined => {
		if (node.type === "approval") {
			return `human:${templateText((node as { message: string }).message)}`;
		}
		if (node.type === "wait") {
			const gate = (node as { gate: string }).gate;
			return /^\s*human\s*:/i.test(gate)
				? templateText(gate.trim())
				: undefined;
		}
		return undefined;
	};

	// The task nodes a node waits on, and the gates on the way.
	const memo = new Map<string, { tasks: string[]; gates: string[] }>();
	const upstream = (
		id: string,
		seen = new Set<string>(),
	): { tasks: string[]; gates: string[] } => {
		const known = memo.get(id);
		if (known) return known;
		const tasks = new Set<string>();
		const gates = new Set<string>();
		if (!seen.has(id)) {
			seen.add(id);
			for (const ref of byId.get(id)?.after ?? []) {
				const source = byId.get(parseRef(ref).node);
				if (!source) continue;
				if (isTask(source)) {
					tasks.add(source.id);
					continue;
				}
				const gate = humanGate(source);
				if (gate) gates.add(gate);
				// Through a node that is not a task: its tasks and gates are this
				// one's too. A task stops the walk, so a gate before a task stays
				// that task's.
				const further = upstream(source.id, seen);
				for (const task of further.tasks) tasks.add(task);
				for (const entry of further.gates) gates.add(entry);
			}
		}
		const result = { tasks: [...tasks], gates: [...gates] };
		memo.set(id, result);
		return result;
	};

	const taskNodes = nodes.filter(isTask);
	const position = new Map(
		taskNodes.map((node, index) => [node.id, index + 1]),
	);
	const acceptance = new Map<string, string[]>();
	for (const node of nodes) {
		if (node.type !== "check") continue;
		const check = node as { command?: string; when?: string; message?: string };
		const item = templateText(
			check.message ??
				(check.command
					? `\`${check.command}\` passes`
					: `${check.when ?? ""} holds`),
		);
		for (const task of upstream(node.id).tasks) {
			const list = acceptance.get(task) ?? [];
			list.push(item);
			acceptance.set(task, list);
		}
	}
	return {
		name,
		...(definition.description
			? { description: templateText(definition.description) }
			: {}),
		tasks: taskNodes.map((node) => {
			const { tasks: before, gates } = upstream(node.id);
			const depends = before
				.map((id) => position.get(id))
				.filter((at): at is number => at !== undefined)
				.map((at) => `#${at}`);
			const work = nodeWork(node);
			const items = acceptance.get(node.id) ?? [];
			return {
				title: templateText(node.name ?? `${node.type} ${node.id}`),
				...(work ? { description: templateText(work) } : {}),
				...(items.length ? { acceptance: items } : {}),
				...(depends.length ? { depends } : {}),
				...(gates.length ? { gate: gates } : {}),
			};
		}),
	};
}
