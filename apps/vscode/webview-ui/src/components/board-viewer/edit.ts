import type { TaskGraphPanelSnapshot } from "@/components/chat/task-header/TaskGraphPanel"
import type { ViewerBoardTask, ViewerPipelineDefinition, ViewerPipelineNode } from "./model"

/**
 * Editing a pipeline in the viewer (plan phase 4): the changes the canvas and
 * the inspector make to a draft. Pure, so they are tested without a canvas.
 * A draft may not validate between edits (a new node has placeholder
 * fields); the extension validates it as it changes and saves only a valid
 * one.
 */

/** The node types the palette offers, in the catalog's order. */
export const PALETTE_TYPES = [
	"agent",
	"command",
	"tool",
	"check",
	"if",
	"switch",
	"merge",
	"loop",
	"set",
	"approval",
	"wait",
	"http",
	"swarm",
	"pipeline",
] as const

/** A new node's fields: enough to show what the type needs, edited in the inspector. */
export const NODE_DEFAULTS: Record<string, Record<string, unknown>> = {
	agent: { task: "Describe the task" },
	command: { command: "echo hello" },
	tool: { tool: "read_files", input: {} },
	check: { command: "true" },
	if: { when: "{{ true }}" },
	switch: { on: "{{ $item }}", cases: ["a", "b"] },
	merge: { mode: "all" },
	loop: { over: "{{ [] }}", body: { type: "command", command: "echo {{ $item }}" } },
	set: { fields: {} },
	approval: { message: "Continue?" },
	wait: { gate: "human:Continue?" },
	http: { url: "https://example.com", method: "GET" },
	swarm: { instructions: "What each worker does", tasks: ["first", "second"] },
	pipeline: { pipeline: "" },
}

/** The outputs a node fires, as core's `nodePorts`: a bare ref is `out`. */
export function nodePortsOf(node: ViewerPipelineNode): string[] {
	const error = node.onError === "route" ? ["error"] : []
	switch (node.type) {
		case "if":
			return ["true", "false", ...error]
		case "switch":
			return [...(Array.isArray(node.cases) ? node.cases.map(String) : []), "default", ...error]
		case "approval":
			return ["approve", "reject", ...error]
		default:
			return ["out", ...error]
	}
}

const refNode = (ref: string) => {
	const at = ref.indexOf(".")
	return (at < 0 ? ref : ref.slice(0, at)).trim()
}

const ID = /^[A-Za-z][\w-]{0,63}$/

/** A free id for a node of `type`: the type, then `type-2`, `type-3`. */
export function freeId(definition: ViewerPipelineDefinition, type: string): string {
	const taken = new Set(definition.nodes.map((node) => node.id))
	if (!taken.has(type)) return type
	for (let n = 2; ; n++) {
		if (!taken.has(`${type}-${n}`)) return `${type}-${n}`
	}
}

/** A node of `type`, after `after` when one is given (the card that was selected). */
export function addNode(
	definition: ViewerPipelineDefinition,
	type: string,
	after?: string,
): { definition: ViewerPipelineDefinition; id: string } {
	const id = freeId(definition, type)
	const source = after ? definition.nodes.find((node) => node.id === after) : undefined
	// A branch's first output; a plain node's own.
	const ref = source ? (nodePortsOf(source)[0] === "out" ? source.id : `${source.id}.${nodePortsOf(source)[0]}`) : undefined
	const node: ViewerPipelineNode = {
		id,
		type,
		...(ref ? { after: [ref] } : {}),
		...structuredClone(NODE_DEFAULTS[type] ?? {}),
	}
	return { definition: { ...definition, nodes: [...definition.nodes, node] }, id }
}

/** `target` runs after `source` (its `port`, for a node that has several). */
export function connect(
	definition: ViewerPipelineDefinition,
	source: string,
	port: string | undefined,
	target: string,
): ViewerPipelineDefinition {
	if (source === target) return definition
	const from = definition.nodes.find((node) => node.id === source)
	if (!from || !definition.nodes.some((node) => node.id === target)) return definition
	const ports = nodePortsOf(from)
	const chosen = port && ports.includes(port) ? port : ports[0]
	const ref = chosen === "out" ? source : `${source}.${chosen}`
	const into = definition.nodes.find((node) => node.id === target)
	if (Array.isArray(into?.after) && into.after.includes(ref)) return definition
	return {
		...definition,
		nodes: definition.nodes.map((node) => {
			if (node.id !== target) return node
			const after = Array.isArray(node.after) ? node.after : []
			return { ...node, after: [...after, ref] }
		}),
	}
}

/** Without these nodes, and without every reference to them. */
export function removeNodes(definition: ViewerPipelineDefinition, ids: readonly string[]): ViewerPipelineDefinition {
	const gone = new Set(ids)
	return {
		...definition,
		nodes: definition.nodes
			.filter((node) => !gone.has(node.id))
			.map((node) => {
				if (!Array.isArray(node.after)) return node
				const after = node.after.filter((ref) => !gone.has(refNode(ref)))
				if (after.length === node.after.length) return node
				const { after: _after, ...rest } = node
				return after.length ? { ...rest, after } : rest
			}),
	}
}

/** Without one edge: the canvas's edge id is `<ref>-><target>`. */
export function removeEdge(definition: ViewerPipelineDefinition, edgeId: string): ViewerPipelineDefinition {
	const at = edgeId.lastIndexOf("->")
	if (at < 0) return definition
	const ref = edgeId.slice(0, at)
	const target = edgeId.slice(at + 2)
	return {
		...definition,
		nodes: definition.nodes.map((node) => {
			if (node.id !== target || !Array.isArray(node.after) || !node.after.includes(ref)) return node
			const after = node.after.filter((entry) => entry !== ref)
			const { after: _after, ...rest } = node
			return after.length ? { ...rest, after } : rest
		}),
	}
}

/**
 * A node replaced by the inspector's JSON. A new id renames the node, and
 * every reference to it follows. Refused, with the reason, when the JSON is
 * not a node or its new id is taken.
 */
export function replaceNode(
	definition: ViewerPipelineDefinition,
	id: string,
	json: string,
): { definition: ViewerPipelineDefinition } | { error: string } {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch (error) {
		return { error: `Not JSON: ${error instanceof Error ? error.message : String(error)}` }
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "A node is a JSON object." }
	const node = parsed as ViewerPipelineNode
	if (typeof node.id !== "string" || !ID.test(node.id)) {
		return { error: "`id` is a letter, then letters, digits, `_` or `-` (at most 64)." }
	}
	if (typeof node.type !== "string" || !node.type) return { error: "`type` names the node's type." }
	if (node.id !== id && definition.nodes.some((other) => other.id === node.id)) {
		return { error: `Another node is already ${node.id}.` }
	}
	const rename = (ref: string) => {
		if (node.id === id) return ref
		const at = ref.indexOf(".")
		const head = at < 0 ? ref : ref.slice(0, at)
		return head.trim() === id ? `${node.id}${at < 0 ? "" : ref.slice(at)}` : ref
	}
	return {
		definition: {
			...definition,
			nodes: definition.nodes.map((other) => {
				if (other.id === id) return node
				if (!Array.isArray(other.after) || node.id === id) return other
				return { ...other, after: other.after.map(rename) }
			}),
		},
	}
}

/** The node as the inspector's editor shows it: id, type and after first. */
export function nodeJson(node: ViewerPipelineNode): string {
	const { id, type, after, ...rest } = node
	return JSON.stringify({ id, type, ...(after ? { after } : {}), ...rest }, null, 2)
}

export interface DiffLine {
	kind: "same" | "add" | "del"
	text: string
}

/**
 * The lines of `before` and `after`, as a proposal's change against the
 * approved version: the longest common subsequence, kept, removed, added.
 * Pipelines are small; past 4,000 lines a side it says so instead.
 */
export function lineDiff(before: string, after: string): DiffLine[] | undefined {
	const a = before.replace(/\n$/, "").split("\n")
	const b = after.replace(/\n$/, "").split("\n")
	if (a.length > 4000 || b.length > 4000) return undefined
	const rows = a.length + 1
	const cols = b.length + 1
	const lcs = new Uint32Array(rows * cols)
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i * cols + j] =
				a[i] === b[j] ? lcs[(i + 1) * cols + j + 1] + 1 : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1])
		}
	}
	const out: DiffLine[] = []
	let i = 0
	let j = 0
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] as string })
			i++
			j++
		} else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
			out.push({ kind: "del", text: a[i++] as string })
		} else {
			out.push({ kind: "add", text: b[j++] as string })
		}
	}
	while (i < a.length) out.push({ kind: "del", text: a[i++] as string })
	while (j < b.length) out.push({ kind: "add", text: b[j++] as string })
	return out
}

/** The board's tasks as board → pipeline takes them. */
export function boardTasks(board: TaskGraphPanelSnapshot): ViewerBoardTask[] {
	return board.tasks.map((task) => ({
		id: task.id,
		title: task.title,
		...(task.description ? { description: task.description } : {}),
		status: task.status,
		...(task.parent ? { parent: task.parent } : {}),
		acceptance: task.acceptance.map((item) => item.text),
		depends: task.depends,
		gates: (task.gates ?? []).map((gate) => gate.spec),
	}))
}
