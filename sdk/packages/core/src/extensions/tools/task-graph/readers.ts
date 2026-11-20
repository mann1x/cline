/**
 * Lenient readers for what models send to the task tools.
 *
 * The checklist's reader learned this over the archive: a strict schema
 * silently drops a third of what models send -- a single object where an
 * array was asked for, a list sent as a JSON string, `"completed"` for done,
 * `t3` or `#3` for an id. So the readers take every shape seen and map it,
 * and anything they still cannot use is reported back in the tool's result
 * rather than dropped: a model told "ignored `foo`" can send it again, a
 * model that hears nothing believes it was recorded.
 */

import type { TaskPriority, TaskStatus } from "./model";

export interface PlanItem {
	title: string;
	description?: string;
	acceptance: string[];
	/** Raw refs: `#2` (an earlier item in the same call) or a task id. */
	depends: string[];
	parent?: string;
	priority?: TaskPriority;
	start: boolean;
}

export interface UpdateItem {
	/** As written; resolved by the tool. */
	id: string;
	title?: string;
	description?: string;
	status?: TaskStatus;
	note?: string;
	check: Array<number | string>;
	uncheck: Array<number | string>;
	acceptanceAdd: string[];
	dependsAdd: string[];
	dependsRemove: string[];
	priority?: TaskPriority;
	later?: boolean;
	files: string[];
}

export interface ReadResult<T> {
	items: T[];
	/** What could not be used, in words the model can act on. */
	ignored: string[];
}

/**
 * Why a string that looks like JSON was not read as JSON, or undefined when
 * it parses (or does not look like JSON at all).
 *
 * Not repaired: on a real send (smoke run 0022, an acceptance item closed
 * with `']"`) jsonrepair turned the first task's acceptance into `"start"`,
 * `": true"`, `"priority"` and dropped its fields -- and before this check the
 * reader made one task titled with the whole string. Refusing with where it
 * breaks costs one retry; a plan quietly read wrong costs the run.
 */
export function brokenJsonReason(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return undefined;
	try {
		JSON.parse(trimmed);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const at = /position (\d+)|column (\d+)|char(?:acter)? (\d+)/i.exec(
			message,
		);
		const position = at ? Number(at[1] ?? at[2] ?? at[3]) : undefined;
		const near =
			position !== undefined
				? ` near «${trimmed.slice(Math.max(0, position - 30), position + 10)}»`
				: "";
		return `it is a string of JSON that does not parse (${message.split("\n")[0]}${near})`;
	}
}

/** A JSON string holding an array or object is read as that value. */
function unwrapJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("[") && trimmed.endsWith("]")) ||
		(trimmed.startsWith("{") && trimmed.endsWith("}"))
	) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return value;
		}
	}
	return value;
}

function asList(value: unknown): unknown[] {
	const unwrapped = unwrapJson(value);
	if (unwrapped === undefined || unwrapped === null || unwrapped === "") {
		return [];
	}
	return Array.isArray(unwrapped) ? unwrapped : [unwrapped];
}

function asText(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}
	if (typeof value === "number") return String(value);
	return undefined;
}

/**
 * A list of short strings: an array, a JSON array, or one string with one
 * item per line (a leading `-`, `*`, `[ ]` or number is a list marker).
 */
function asStringList(value: unknown): string[] {
	const unwrapped = unwrapJson(value);
	if (typeof unwrapped === "string") {
		return unwrapped
			.split(/\r?\n/)
			.map((line) =>
				line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\])?\s*/, "").trim(),
			)
			.filter(Boolean);
	}
	return asList(unwrapped)
		.map((entry) =>
			typeof entry === "object" && entry !== null
				? asText((entry as { text?: unknown }).text)
				: asText(entry),
		)
		.filter((entry): entry is string => entry !== undefined);
}

/** Refs as a list: `"T1, T2"` and `["T1","T2"]` alike. */
function asRefList(value: unknown): string[] {
	const unwrapped = unwrapJson(value);
	if (typeof unwrapped === "string") {
		return unwrapped
			.split(/[\s,;]+/)
			.map((part) => part.trim())
			.filter(Boolean);
	}
	if (typeof unwrapped === "number") return [String(unwrapped)];
	return asList(unwrapped)
		.map((entry) => asText(entry))
		.filter((entry): entry is string => entry !== undefined);
}

const STATUS_WORDS: Record<string, TaskStatus> = {
	pending: "pending",
	todo: "pending",
	open: "pending",
	not_started: "pending",
	notstarted: "pending",
	reopen: "pending",
	reopened: "pending",
	active: "active",
	in_progress: "active",
	inprogress: "active",
	started: "active",
	start: "active",
	doing: "active",
	working: "active",
	ongoing: "active",
	claimed: "active",
	waiting: "waiting",
	blocked: "waiting",
	on_hold: "waiting",
	paused: "waiting",
	done: "done",
	complete: "done",
	completed: "done",
	finished: "done",
	finish: "done",
	resolved: "done",
	closed: "done",
	close: "done",
	fixed: "done",
	cancelled: "cancelled",
	canceled: "cancelled",
	cancel: "cancelled",
	dropped: "cancelled",
	skipped: "cancelled",
	skip: "cancelled",
	wontfix: "cancelled",
	abandoned: "cancelled",
};

export function readStatus(value: unknown): TaskStatus | undefined {
	const text = asText(value);
	if (!text) return undefined;
	return STATUS_WORDS[text.toLowerCase().replace(/[\s-]+/g, "_")];
}

export function readPriority(value: unknown): TaskPriority | undefined {
	const text = asText(value)?.toLowerCase();
	if (!text) return undefined;
	if (["h", "high", "p0", "p1", "urgent", "critical", "0", "1"].includes(text))
		return "H";
	if (["m", "medium", "normal", "p2", "2"].includes(text)) return "M";
	if (["l", "low", "p3", "p4", "3", "4"].includes(text)) return "L";
	return undefined;
}

function readBool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	const text = asText(value)?.toLowerCase();
	if (text === "true" || text === "yes" || text === "1") return true;
	if (text === "false" || text === "no" || text === "0") return false;
	return undefined;
}

/**
 * A task id as written -- `T3`, `t3`, `#3`, `3`, `T3.1` -- in the canonical
 * `T3` / `T3.1` form, or undefined when it is not shaped like one.
 */
export function normalizeTaskId(value: unknown): string | undefined {
	const text = asText(value);
	if (!text) return undefined;
	const match = /^(?:task\s*)?[#tT]?\s*(\d+(?:\.\d+)*)$/i.exec(text.trim());
	return match ? `T${match[1]}` : undefined;
}

/** `#2` inside a plan: the second item of the same call. */
export function readBatchRef(value: string): number | undefined {
	const match = /^#(\d+)$/.exec(value.trim());
	return match ? Number(match[1]) : undefined;
}

const PLAN_KEYS = new Set([
	"title",
	"name",
	"task",
	"text",
	"content",
	"summary",
	"description",
	"details",
	"acceptance",
	"acceptance_criteria",
	"criteria",
	"done_when",
	"depends",
	"depends_on",
	"dependsOn",
	"dependencies",
	"after",
	"blocked_by",
	"parent",
	"priority",
	"start",
	"id",
	"status",
	"subtasks",
	"children",
]);

/**
 * `task_plan`'s input. Takes `{tasks: [...]}`, a bare array, one task object,
 * a JSON string of any of those, a list of plain titles, or a markdown
 * checklist. Nested `subtasks` become children of their item.
 */
export function readPlanInput(input: unknown): ReadResult<PlanItem> {
	const ignored: string[] = [];
	const broken =
		brokenJsonReason(input) ??
		(typeof input === "object" && input !== null
			? brokenJsonReason(
					(input as Record<string, unknown>).tasks ??
						(input as Record<string, unknown>).plan ??
						(input as Record<string, unknown>).items ??
						(input as Record<string, unknown>).steps,
				)
			: undefined);
	if (broken) {
		return {
			items: [],
			ignored: [
				`\`tasks\`, because ${broken}. Send \`tasks\` as an array of objects, not as a string`,
			],
		};
	}
	const record = unwrapJson(input);
	let raw: unknown[];
	if (typeof record === "object" && record !== null && !Array.isArray(record)) {
		const obj = record as Record<string, unknown>;
		const list = obj.tasks ?? obj.plan ?? obj.items ?? obj.steps;
		if (list !== undefined) {
			raw =
				typeof unwrapJson(list) === "string"
					? asStringList(list)
					: asList(list);
		} else if (obj.title !== undefined || obj.name !== undefined) {
			raw = [obj];
		} else {
			raw = [];
		}
	} else if (typeof record === "string") {
		raw = asStringList(record);
	} else {
		raw = asList(record);
	}
	const items: PlanItem[] = [];
	const push = (entry: unknown, parentRef?: string): void => {
		if (typeof entry === "string") {
			const title = entry.trim();
			if (title) {
				items.push({
					title,
					acceptance: [],
					depends: [],
					...(parentRef ? { parent: parentRef } : {}),
					start: false,
				});
			}
			return;
		}
		if (typeof entry !== "object" || entry === null) {
			ignored.push(
				`a task that was not text or an object (${JSON.stringify(entry)})`,
			);
			return;
		}
		const obj = entry as Record<string, unknown>;
		const title =
			asText(obj.title) ??
			asText(obj.name) ??
			asText(obj.task) ??
			asText(obj.text) ??
			asText(obj.content) ??
			asText(obj.summary);
		if (!title) {
			ignored.push(
				`a task with no title (${JSON.stringify(entry).slice(0, 80)})`,
			);
			return;
		}
		for (const key of Object.keys(obj)) {
			if (!PLAN_KEYS.has(key)) ignored.push(`\`${key}\` on "${title}"`);
		}
		const status = readStatus(obj.status);
		const parent = asText(obj.parent) ?? parentRef;
		const item: PlanItem = {
			title,
			...((asText(obj.description) ?? asText(obj.details))
				? { description: asText(obj.description) ?? asText(obj.details) }
				: {}),
			acceptance: asStringList(
				obj.acceptance ??
					obj.acceptance_criteria ??
					obj.criteria ??
					obj.done_when,
			),
			depends: asRefList(
				obj.depends ??
					obj.depends_on ??
					obj.dependsOn ??
					obj.dependencies ??
					obj.after ??
					obj.blocked_by,
			),
			...(parent ? { parent } : {}),
			start: readBool(obj.start) === true || status === "active",
		};
		const priority = readPriority(obj.priority);
		if (priority) item.priority = priority;
		else if (obj.priority !== undefined)
			ignored.push(
				`priority ${JSON.stringify(obj.priority)} on "${title}" (use H, M or L)`,
			);
		items.push(item);
		const index = items.length;
		for (const child of asList(obj.subtasks ?? obj.children)) {
			push(child, `#${index}`);
		}
	};
	for (const entry of raw) push(entry);
	return { items, ignored };
}

const UPDATE_KEYS = new Set([
	"id",
	"task",
	"task_id",
	"taskId",
	"title",
	"description",
	"status",
	"state",
	"note",
	"notes",
	"comment",
	"outcome",
	"reason",
	"summary",
	"check",
	"uncheck",
	"acceptance_add",
	"add_acceptance",
	"depends_add",
	"depends_remove",
	"add_depends",
	"remove_depends",
	"priority",
	"later",
	"link",
	"files",
	"file",
]);

/**
 * `task_update`'s input. Takes `{updates: [...]}`, a bare array, one update
 * object, or a JSON string of either. `outcome`, `reason`, `comment` and
 * `summary` are all the note.
 */
export function readUpdateInput(input: unknown): ReadResult<UpdateItem> {
	const ignored: string[] = [];
	const broken =
		brokenJsonReason(input) ??
		(typeof input === "object" && input !== null
			? brokenJsonReason(
					(input as Record<string, unknown>).updates ??
						(input as Record<string, unknown>).tasks ??
						(input as Record<string, unknown>).items,
				)
			: undefined);
	if (broken) {
		return {
			items: [],
			ignored: [
				`\`updates\`, because ${broken}. Send \`updates\` as an array of objects, not as a string`,
			],
		};
	}
	const record = unwrapJson(input);
	let raw: unknown[];
	if (typeof record === "object" && record !== null && !Array.isArray(record)) {
		const obj = record as Record<string, unknown>;
		const list = obj.updates ?? obj.tasks ?? obj.items;
		raw = list !== undefined ? asList(list) : [obj];
	} else {
		raw = asList(record);
	}
	const items: UpdateItem[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) {
			ignored.push(
				`an update that was not an object (${JSON.stringify(entry)})`,
			);
			continue;
		}
		const obj = entry as Record<string, unknown>;
		const id = asText(obj.id ?? obj.task ?? obj.task_id ?? obj.taskId);
		if (!id) {
			ignored.push(
				`an update with no \`id\` (${JSON.stringify(entry).slice(0, 80)})`,
			);
			continue;
		}
		for (const key of Object.keys(obj)) {
			if (!UPDATE_KEYS.has(key)) ignored.push(`\`${key}\` on ${id}`);
		}
		const statusRaw = obj.status ?? obj.state;
		const status = readStatus(statusRaw);
		if (statusRaw !== undefined && !status) {
			ignored.push(
				`status ${JSON.stringify(statusRaw)} on ${id} (use pending, active, waiting, done or cancelled)`,
			);
		}
		const note = asText(
			obj.note ??
				obj.notes ??
				obj.outcome ??
				obj.reason ??
				obj.comment ??
				obj.summary,
		);
		const checks = (value: unknown): Array<number | string> =>
			asList(value)
				.map((entry) => (typeof entry === "number" ? entry : asText(entry)))
				.filter((entry): entry is number | string => entry !== undefined);
		const item: UpdateItem = {
			id,
			...(asText(obj.title) ? { title: asText(obj.title) } : {}),
			...(asText(obj.description)
				? { description: asText(obj.description) }
				: {}),
			...(status ? { status } : {}),
			...(note ? { note } : {}),
			check: obj.check === true ? ["*"] : checks(obj.check),
			uncheck: checks(obj.uncheck),
			acceptanceAdd: asStringList(obj.acceptance_add ?? obj.add_acceptance),
			dependsAdd: asRefList(obj.depends_add ?? obj.add_depends),
			dependsRemove: asRefList(obj.depends_remove ?? obj.remove_depends),
			files: asStringList(obj.files ?? obj.file ?? obj.link),
		};
		const priority = readPriority(obj.priority);
		if (priority) item.priority = priority;
		else if (obj.priority !== undefined)
			ignored.push(
				`priority ${JSON.stringify(obj.priority)} on ${id} (use H, M or L)`,
			);
		const later = readBool(obj.later);
		if (later !== undefined) item.later = later;
		items.push(item);
	}
	return { items, ignored };
}
