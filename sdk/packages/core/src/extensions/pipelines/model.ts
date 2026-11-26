/**
 * Pipelines (plan `docs/protocols/PLAN-n8n-pipelines.md`): a DAG of nodes,
 * kept as JSON in the workspace, run by Cerebriline itself on the task
 * graph. No server, no container.
 *
 * Adapted from n8n (items between nodes, named branch outputs, merge
 * modes, pinned data), Node-RED (wires, subflows, a catch for failures) and
 * the code-first engines (Mastra's foreach and suspend, LangGraph's
 * interrupts, Temporal's rule that only what is safe to repeat is
 * replayed). Designs, not code.
 *
 * A node's `after` lists what it runs after, as the task graph's `depends`
 * does: `"test"` (the node's output) or `"ok.true"` (a branch's named
 * output). A node runs when everything it is after has settled and each
 * named output fired; when one did not (the branch was not taken), it is
 * skipped, and so is what comes after it.
 */

/** Every node type the format knows, as `pipeline catalog` lists them. */
export const NODE_TYPES = [
	"tool",
	"command",
	"set",
	"if",
	"switch",
	"merge",
	"loop",
	"wait",
	"approval",
	"check",
	"agent",
	"swarm",
	"http",
	"pipeline",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * The types this build can run. `agent`, `swarm`, `http` and `pipeline`
 * are the plan's phase 2; a file using one is refused with that said,
 * rather than accepted and failed at run time.
 */
export const RUNNABLE_NODE_TYPES: ReadonlySet<NodeType> = new Set([
	"tool",
	"command",
	"set",
	"if",
	"switch",
	"merge",
	"loop",
	"wait",
	"approval",
	"check",
]);

/** What a loop's body may be: one node that works on one item. */
export const LOOP_BODY_TYPES: ReadonlySet<NodeType> = new Set([
	"tool",
	"command",
	"set",
	"check",
]);

export const MERGE_MODES = ["all", "append", "first", "by-key"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

/** The output a node fires when it has only one. */
export const DEFAULT_PORT = "out";

interface NodeBase {
	id: string;
	type: NodeType;
	/** What it runs after: `"id"` or `"id.port"`. */
	after?: string[];
	/** A label for the board and the viewer; the id when absent. */
	name?: string;
	description?: string;
	/**
	 * Safe to run twice. A node in flight when the run was interrupted is
	 * run again only when this is set; otherwise it fails as interrupted.
	 */
	idempotent?: boolean;
	/** Seconds before the node is stopped and fails. */
	timeout?: number;
	/** Test data: a run with pins on returns these items without running it. */
	pin?: unknown[];
}

export interface ToolNode extends NodeBase {
	type: "tool";
	tool: string;
	input?: unknown;
}

export interface CommandNode extends NodeBase {
	type: "command";
	command: string;
	cwd?: string;
	/** A non-zero exit fails the node unless this is set. */
	allowFailure?: boolean;
}

export interface SetNode extends NodeBase {
	type: "set";
	/** One item per input item (once with no input), with these fields. */
	fields?: Record<string, unknown>;
	/** An expression whose value (a list) is the items. */
	items?: string;
	/** Start each item from the input item, then set the fields. */
	keepInput?: boolean;
}

export interface IfNode extends NodeBase {
	type: "if";
	when: string;
}

export interface SwitchNode extends NodeBase {
	type: "switch";
	on: string;
	/** Output names; the value is compared with each as text. */
	cases: string[];
}

export interface MergeNode extends NodeBase {
	type: "merge";
	mode?: MergeMode;
	/** The field `by-key` joins on. */
	key?: string;
}

export interface LoopNode extends NodeBase {
	type: "loop";
	/** An expression whose value (a list) is iterated. */
	over: string;
	parallel?: number;
	body: LoopBody;
}

type BodyOf<T> = T extends unknown ? Omit<T, "id" | "after"> : never;
/** A loop's body: one tool, command, set or check node, without an id or `after`. */
export type LoopBody = BodyOf<ToolNode | CommandNode | SetNode | CheckNode>;

export interface WaitNode extends NodeBase {
	type: "wait";
	/** A task-graph gate: `timer:+5m`, `human:…`, `commit:…`, `gh-pr:…`, `run:…`. */
	gate: string;
}

export interface ApprovalNode extends NodeBase {
	type: "approval";
	message: string;
}

export interface CheckNode extends NodeBase {
	type: "check";
	/** Passes when it exits 0. */
	command?: string;
	/** Passes when true. */
	when?: string;
	message?: string;
}

/** Phase 2 types: known to the format, refused by this build. */
export interface LaterNode extends NodeBase {
	type: "agent" | "swarm" | "http" | "pipeline";
	[field: string]: unknown;
}

export type PipelineNode =
	| ToolNode
	| CommandNode
	| SetNode
	| IfNode
	| SwitchNode
	| MergeNode
	| LoopNode
	| WaitNode
	| ApprovalNode
	| CheckNode
	| LaterNode;

export interface PipelineInput {
	type?: "string" | "number" | "boolean" | "object" | "array";
	description?: string;
	default?: unknown;
	required?: boolean;
}

export interface PipelineDefinition {
	name: string;
	description?: string;
	inputs?: Record<string, PipelineInput>;
	/** At most this many nodes run at once (4 when absent). */
	maxParallel?: number;
	nodes: PipelineNode[];
}

/** The named outputs a node type fires; a bare ref means `out`. */
export function nodePorts(node: PipelineNode): string[] {
	switch (node.type) {
		case "if":
			return ["true", "false"];
		case "switch":
			return [...(node as SwitchNode).cases, "default"];
		case "approval":
			return ["approve", "reject"];
		default:
			return [DEFAULT_PORT];
	}
}

/** Whether a node type branches, so a ref to it must name the output. */
export function isBranching(node: PipelineNode): boolean {
	return (
		node.type === "if" || node.type === "switch" || node.type === "approval"
	);
}

/** `"ok.true"` → `{node: "ok", port: "true"}`; `"test"` → port `out`. */
export function parseRef(ref: string): { node: string; port: string } {
	const at = ref.indexOf(".");
	return at < 0
		? { node: ref.trim(), port: DEFAULT_PORT }
		: { node: ref.slice(0, at).trim(), port: ref.slice(at + 1).trim() };
}

/** What a node left for the nodes after it and for `$node.<id>`. */
export interface NodeOutput {
	items: unknown[];
	/** The output it fired. */
	port: string;
	exit?: number;
	stdout?: string;
	stderr?: string;
	/** A tool's answer as text. */
	text?: string;
}

export type NodeStatus = "pending" | "running" | "done" | "skipped" | "failed";

export type RunStatus = "running" | "waiting" | "done" | "failed" | "stopped";
