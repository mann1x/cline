/**
 * Checking a pipeline before it is saved or run: its shape, its node types,
 * what each node is after, cycles, and every expression. All the problems
 * are returned at once, each naming the node and field, so a model can fix
 * the file in one edit rather than one refusal at a time.
 */

import { createHash } from "node:crypto";
import { expressionErrors } from "./expr";
import {
	isBranching,
	LOOP_BODY_TYPES,
	MERGE_MODES,
	NODE_TYPES,
	type NodeType,
	nodePorts,
	ON_ERROR,
	type PipelineDefinition,
	type PipelineNode,
	parseRef,
	RUNNABLE_NODE_TYPES,
} from "./model";

export interface PipelineValidation {
	ok: boolean;
	errors: string[];
	pipeline?: PipelineDefinition;
}

const ID = /^[A-Za-z][\w-]{0,63}$/;

const REQUIRED: Partial<Record<NodeType, string[]>> = {
	tool: ["tool"],
	command: ["command"],
	if: ["when"],
	switch: ["on", "cases"],
	loop: ["over", "body"],
	wait: ["gate"],
	approval: ["message"],
	agent: ["task"],
	swarm: ["instructions"],
	http: ["url"],
	pipeline: ["pipeline"],
};

const HTTP_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
];

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The fields of one node (or a loop body), as errors. */
function nodeErrors(
	raw: Record<string, unknown>,
	where: string,
	runnable: ReadonlySet<NodeType>,
	inLoop: boolean,
): string[] {
	const errors: string[] = [];
	const type = raw.type as NodeType;
	if (
		typeof raw.type !== "string" ||
		!(NODE_TYPES as readonly string[]).includes(raw.type)
	) {
		errors.push(
			`${where}: type "${String(raw.type)}" is not a node type (${NODE_TYPES.join(", ")})`,
		);
		return errors;
	}
	if (!runnable.has(type)) {
		errors.push(
			`${where}: "${type}" nodes are not available in this version yet`,
		);
		return errors;
	}
	if (inLoop && !LOOP_BODY_TYPES.has(type)) {
		errors.push(
			`${where}: a loop body is one ${[...LOOP_BODY_TYPES].join(", ")} node, not "${type}"`,
		);
	}
	for (const field of REQUIRED[type] ?? []) {
		if (raw[field] === undefined || raw[field] === "") {
			errors.push(`${where}: a ${type} node needs "${field}"`);
		}
	}
	const strings: Record<string, string[]> = {
		tool: ["tool"],
		command: ["command", "cwd"],
		if: ["when"],
		switch: ["on"],
		loop: ["over"],
		wait: ["gate"],
		approval: ["message"],
		check: ["command", "when", "message"],
		set: ["items"],
		agent: ["task", "agent", "instructions"],
		swarm: ["instructions", "task"],
		http: ["url", "method"],
		pipeline: ["pipeline"],
	};
	for (const field of strings[type] ?? []) {
		if (raw[field] !== undefined && typeof raw[field] !== "string") {
			errors.push(`${where}: "${field}" is text`);
		}
	}
	if (type === "switch") {
		const cases = raw.cases;
		if (
			!Array.isArray(cases) ||
			cases.length === 0 ||
			!cases.every((entry) => typeof entry === "string" && ID.test(entry))
		) {
			errors.push(
				`${where}: "cases" is a list of output names (letters, digits, - and _)`,
			);
		} else if (cases.includes("default")) {
			errors.push(
				`${where}: "default" is the switch's own output for no match; name the cases otherwise`,
			);
		}
	}
	if (
		type === "merge" &&
		raw.mode !== undefined &&
		!(MERGE_MODES as readonly string[]).includes(raw.mode as string)
	) {
		errors.push(
			`${where}: mode "${String(raw.mode)}" is not one of ${MERGE_MODES.join(", ")}`,
		);
	}
	if (
		type === "merge" &&
		raw.mode === "by-key" &&
		typeof raw.key !== "string"
	) {
		errors.push(`${where}: a by-key merge needs "key", the field to join on`);
	}
	if (type === "check" && raw.command === undefined && raw.when === undefined) {
		errors.push(`${where}: a check node needs "command" or "when"`);
	}
	if (type === "set" && raw.fields !== undefined && !isObject(raw.fields)) {
		errors.push(`${where}: "fields" is an object of field names and values`);
	}
	if (type === "loop") {
		if (
			raw.parallel !== undefined &&
			!(Number.isInteger(raw.parallel) && (raw.parallel as number) >= 1)
		) {
			errors.push(`${where}: "parallel" is a whole number of at least 1`);
		}
		if (!isObject(raw.body)) {
			if (raw.body !== undefined) errors.push(`${where}: "body" is one node`);
		} else {
			if ("id" in raw.body || "after" in raw.body) {
				errors.push(`${where}.body: a loop body has no "id" or "after"`);
			}
			errors.push(...nodeErrors(raw.body, `${where}.body`, runnable, true));
		}
	}
	if (type === "swarm") {
		const tasks = raw.tasks;
		if (tasks === undefined && raw.task === undefined) {
			errors.push(
				`${where}: a swarm node needs "tasks" (one per worker) or "task" with "count"`,
			);
		} else if (
			tasks !== undefined &&
			typeof tasks !== "string" &&
			!(
				Array.isArray(tasks) &&
				tasks.every((entry) => typeof entry === "string")
			)
		) {
			errors.push(
				`${where}: "tasks" is a list of texts, or an expression giving one`,
			);
		}
		if (
			raw.count !== undefined &&
			!(Number.isInteger(raw.count) && (raw.count as number) >= 1)
		) {
			errors.push(`${where}: "count" is a whole number of at least 1`);
		}
	}
	if (type === "http") {
		if (
			raw.method !== undefined &&
			!HTTP_METHODS.includes(String(raw.method).toUpperCase())
		) {
			errors.push(
				`${where}: method "${String(raw.method)}" is not one of ${HTTP_METHODS.join(", ")}`,
			);
		}
		if (
			raw.headers !== undefined &&
			!(
				isObject(raw.headers) &&
				Object.values(raw.headers).every((value) => typeof value === "string")
			)
		) {
			errors.push(`${where}: "headers" is an object of header names and texts`);
		}
	}
	if (
		type === "pipeline" &&
		raw.inputs !== undefined &&
		!isObject(raw.inputs)
	) {
		errors.push(`${where}: "inputs" is an object of input names and values`);
	}
	if (
		raw.onError !== undefined &&
		!(ON_ERROR as readonly string[]).includes(raw.onError as string)
	) {
		errors.push(
			`${where}: onError "${String(raw.onError)}" is not one of ${ON_ERROR.join(", ")}`,
		);
	}
	if (raw.retry !== undefined) {
		const retry = raw.retry;
		if (
			!isObject(retry) ||
			!(Number.isInteger(retry.max) && (retry.max as number) >= 1) ||
			(retry.wait !== undefined &&
				!(typeof retry.wait === "number" && retry.wait >= 0)) ||
			(retry.backoff !== undefined &&
				!(typeof retry.backoff === "number" && retry.backoff >= 1))
		) {
			errors.push(
				`${where}: "retry" is {max: retries (at least 1), wait?: seconds, backoff?: a factor of at least 1}`,
			);
		}
	}
	if (
		raw.timeout !== undefined &&
		!(typeof raw.timeout === "number" && raw.timeout > 0)
	) {
		errors.push(`${where}: "timeout" is a number of seconds`);
	}
	if (raw.pin !== undefined && !Array.isArray(raw.pin)) {
		errors.push(`${where}: "pin" is a list of items`);
	}
	const { body: _body, ...own } = raw;
	errors.push(...expressionErrors(own, where));
	return errors;
}

/**
 * Check a pipeline. `raw` is the parsed JSON (or its text). `runnable`
 * narrows the node types further, for tests.
 */
export function validatePipeline(
	raw: unknown,
	runnable: ReadonlySet<NodeType> = RUNNABLE_NODE_TYPES,
): PipelineValidation {
	let value = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch (error) {
			return { ok: false, errors: [`not JSON: ${(error as Error).message}`] };
		}
	}
	if (!isObject(value)) {
		return {
			ok: false,
			errors: ['a pipeline is an object with "name" and "nodes"'],
		};
	}
	const errors: string[] = [];
	if (typeof value.name !== "string" || !value.name.trim()) {
		errors.push('"name" is required');
	}
	if (value.inputs !== undefined && !isObject(value.inputs)) {
		errors.push('"inputs" is an object of input names');
	}
	if (
		value.maxParallel !== undefined &&
		!(Number.isInteger(value.maxParallel) && (value.maxParallel as number) >= 1)
	) {
		errors.push('"maxParallel" is a whole number of at least 1');
	}
	if (
		value.onFailure !== undefined &&
		(typeof value.onFailure !== "string" || !value.onFailure.trim())
	) {
		errors.push(
			'"onFailure" is the name of a pipeline to run when a run fails',
		);
	} else if (
		typeof value.onFailure === "string" &&
		typeof value.name === "string" &&
		value.onFailure.trim().toLowerCase() === value.name.trim().toLowerCase()
	) {
		errors.push('"onFailure" names this pipeline itself');
	}
	if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
		errors.push('"nodes" is a list with at least one node');
		return { ok: false, errors };
	}
	const nodes = value.nodes as unknown[];
	const byId = new Map<string, PipelineNode>();
	nodes.forEach((entry, index) => {
		if (!isObject(entry)) {
			errors.push(`nodes[${index}]: a node is an object`);
			return;
		}
		const id = entry.id;
		const where = typeof id === "string" ? `node "${id}"` : `nodes[${index}]`;
		if (typeof id !== "string" || !ID.test(id)) {
			errors.push(
				`${where}: "id" is required: a letter, then letters, digits, - or _`,
			);
		} else if (byId.has(id)) {
			errors.push(`${where}: the id is used twice`);
		} else {
			byId.set(id, entry as unknown as PipelineNode);
		}
		if (
			entry.after !== undefined &&
			!(
				Array.isArray(entry.after) &&
				entry.after.every((ref) => typeof ref === "string")
			)
		) {
			errors.push(
				`${where}: "after" is a list of node ids ("test", or "ok.true" for a branch)`,
			);
		}
		errors.push(...nodeErrors(entry, where, runnable, false));
		const sub = (
			entry.type === "loop" && isObject(entry.body) ? entry.body : entry
		) as Record<string, unknown>;
		if (
			sub.type === "pipeline" &&
			typeof sub.pipeline === "string" &&
			typeof value.name === "string" &&
			sub.pipeline.trim().toLowerCase() === value.name.trim().toLowerCase()
		) {
			errors.push(`${where}: a pipeline does not run itself`);
		}
	});
	// What each node is after: known nodes, real outputs, no loops.
	for (const node of byId.values()) {
		for (const ref of node.after ?? []) {
			const { node: source, port } = parseRef(ref);
			const from = byId.get(source);
			const where = `node "${node.id}"`;
			if (!from) {
				errors.push(
					`${where}: after "${ref}", which is no node of this pipeline`,
				);
				continue;
			}
			if (source === node.id) {
				errors.push(`${where}: it cannot run after itself`);
				continue;
			}
			if (isBranching(from) && !ref.includes(".")) {
				errors.push(
					`${where}: after "${ref}" must name which output: ${nodePorts(from)
						.map((name) => `"${source}.${name}"`)
						.join(" or ")}`,
				);
			} else if (!nodePorts(from).includes(port)) {
				errors.push(
					`${where}: "${source}" has no output "${port}" (it has ${nodePorts(from).join(", ")})`,
				);
			}
		}
	}
	const cycle = findCycle(byId);
	if (cycle) errors.push(`the nodes run in a circle: ${cycle.join(" → ")}`);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		errors: [],
		pipeline: value as unknown as PipelineDefinition,
	};
}

function findCycle(byId: Map<string, PipelineNode>): string[] | undefined {
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];
	const visit = (id: string): string[] | undefined => {
		if (state.get(id) === "done") return undefined;
		if (state.get(id) === "visiting")
			return [...path.slice(path.indexOf(id)), id];
		state.set(id, "visiting");
		path.push(id);
		for (const ref of byId.get(id)?.after ?? []) {
			const source = parseRef(ref).node;
			if (!byId.has(source)) continue;
			const found = visit(source);
			if (found) return found;
		}
		path.pop();
		state.set(id, "done");
		return undefined;
	};
	for (const id of byId.keys()) {
		const found = visit(id);
		if (found) return found.reverse();
	}
	return undefined;
}

/** A pipeline file's version: the hash of its text, for approval and journals. */
export function pipelineHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
