/**
 * Tool schemas as every chat template can render them.
 *
 * Gemma 4's canonical chat template renders one shape -- an array's `items`
 * node whose `type` is a list, as `["integer", "string"]` -- with
 * `item_value | map('upper') | list`, and llama.cpp's jinja engine implements
 * `map(attribute=...)` only. A request carrying such a tool fails with HTTP 500
 * "map: filter-mapping not implemented" before anything is generated (opencoti
 * llamafile, backup_models mail #2357, 2026-11-21). The first case was our own
 * `task_update`; an MCP server's tool can carry it just as well, and its schema
 * is not ours to edit, so every tool is rewritten on its way into a request.
 *
 * The rewrite says the same thing in the form that renders: the list becomes
 * `anyOf`, one branch per type. A list type anywhere else renders fine there
 * (the template only stringifies it) and is left alone, as is every schema
 * without the shape -- returned as the same object, so nothing is copied.
 */

type Schema = Record<string, unknown>;

const cache = new WeakMap<object, unknown>();

function isRecord(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An `items` node with a list `type`, said with `anyOf` instead. */
function rewriteItemsNode(node: Schema): Schema {
	const { type, ...rest } = node;
	if (!Array.isArray(type)) return node;
	const branches = type
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => ({ type: entry }));
	if (branches.length === 0) return rest;
	if (branches.length === 1) return { ...rest, type: branches[0]?.type };
	// A node that already has its own anyOf keeps it; both must hold.
	if (Array.isArray(rest.anyOf)) {
		const { anyOf, ...others } = rest;
		return { ...others, allOf: [{ anyOf }, { anyOf: branches }] };
	}
	return { ...rest, anyOf: branches };
}

function walk(node: unknown, isItems: boolean): unknown {
	if (Array.isArray(node)) {
		let changed = false;
		const out = node.map((entry) => {
			// Tuple-form `items: [a, b]`: each entry is an items node.
			const next = walk(entry, isItems);
			if (next !== entry) changed = true;
			return next;
		});
		return changed ? out : node;
	}
	if (!isRecord(node)) return node;
	let changed = false;
	const out: Schema = {};
	for (const [key, value] of Object.entries(node)) {
		const next = walk(value, key === "items");
		if (next !== value) changed = true;
		out[key] = next;
	}
	const base = changed ? out : node;
	if (isItems && Array.isArray(base.type)) return rewriteItemsNode(base);
	return base;
}

/**
 * `schema`, with every `items` node's list `type` said as `anyOf`; the same
 * object when there is none. Cached per schema object.
 */
export function templateSafeToolSchema<T>(schema: T): T {
	if (!isRecord(schema)) return schema;
	const hit = cache.get(schema);
	if (hit !== undefined) return hit as T;
	const safe = walk(schema, false) as T;
	cache.set(schema, safe);
	return safe;
}

/** Every path where an `items` node declares a list `type`: what the rewrite removes. */
export function listTypesOnItems(schema: unknown, path = ""): string[] {
	const out: string[] = [];
	const visit = (node: unknown, at: string, isItems: boolean): void => {
		if (Array.isArray(node)) {
			node.forEach((entry, index) => {
				visit(entry, `${at}[${index}]`, isItems);
			});
			return;
		}
		if (!isRecord(node)) return;
		if (isItems && Array.isArray(node.type)) out.push(`${at}.type`);
		for (const [key, value] of Object.entries(node)) {
			visit(value, at ? `${at}.${key}` : key, key === "items");
		}
	};
	visit(schema, path, false);
	return out;
}
