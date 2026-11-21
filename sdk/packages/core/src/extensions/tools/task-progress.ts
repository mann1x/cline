/**
 * Reading the checklist a model sent as `task_progress`.
 *
 * The checklist itself is gone: the task graph replaced it in 4.100.292, and
 * no tool carries the parameter and no tool is named for it any more. What is
 * left is reading one, for two cases the graph still has:
 *
 * - a conversation from before the graph, whose last checklist is imported
 *   onto the board when it is resumed (`findLatestTaskProgress`);
 * - a model that still sends `task_progress` out of habit (a model trained on
 *   the old shape, or a stale user template): the graph's capture reads it off
 *   the raw input and maps it onto the board, never advertising it.
 *
 * The readers are as lenient as they were when the checklist was live: a third
 * of the payloads arrived as an array, nested in themselves, or without boxes.
 */

/** The field's wire name. */
export const TASK_PROGRESS_PARAM = "task_progress";

export interface TaskProgressItem {
	text: string;
	done: boolean;
}

/** The checklist as the UI and the reminder consume it. */
export interface TaskProgressState {
	/** The raw markdown exactly as the model sent it. */
	markdown: string;
	items: TaskProgressItem[];
	completed: number;
	total: number;
}

/**
 * Normalise one checklist entry to a markdown line, or drop it.
 *
 * Accepts the line as written, and the object form models produce when they
 * treat the checklist as data rather than as text.
 */
function checklistLine(entry: unknown): string | undefined {
	if (typeof entry === "string") {
		// An entry is an item whatever it looks like: `["Inventory", "Report"]`
		// is a two-item list, and kept as bare text it parsed to none (pandorum
		// 4.100.242, deepseek: every list it sent, 0 items, nothing on screen).
		return itemLine(entry);
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return undefined;
	}
	const record = entry as Record<string, unknown>;
	const text = record.text ?? record.item ?? record.title ?? record.task;
	if (typeof text !== "string" || text.trim() === "") {
		return undefined;
	}
	const done =
		record.done === true ||
		record.checked === true ||
		record.completed === true ||
		record.status === "done" ||
		record.status === "completed";
	// An entry that already carries its own marker keeps it: re-marking
	// `- [x] Fix` as `- [ ] - [x] Fix` is how a tolerant reader loses the state
	// it was widened to preserve.
	return /^(?:[-*]\s*)?\[( |x|X)\]/.test(text.trim())
		? itemLine(text)
		: `- [${done ? "x" : " "}] ${text.trim()}`;
}

/**
 * One item as a checklist line. A mark it carries is kept, with or without
 * the leading dash (`[x] Fix`, `- [x] Fix`); a list bullet or number it
 * carries is dropped; anything else is an open item. Nothing is ticked from
 * the wording: "(done)" in the text is the model's note, not a mark.
 */
/**
 * A checklist line with any bullet: `- [x]`, `* [x]`, `+ [x]`, `-[x]`,
 * `1. [x]`, `1) [x]`, or a bare `[x]`. Only `- [x]` was read, so a numbered
 * list came back with every box unticked and a `*` list as no list at all
 * (automaticum audit 2026-11-08, rest M2).
 */
const CHECKBOX_LINE = /^\s*(?:[-*+•]|\d+[.)])?\s*\[( |x|X)\]\s*(.*)$/;

function itemLine(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") {
		return undefined;
	}
	const marked = CHECKBOX_LINE.exec(trimmed);
	if (marked) {
		return marked[2].trim() === ""
			? undefined
			: `- [${marked[1] === " " ? " " : "x"}] ${marked[2].trim()}`;
	}
	const bare = trimmed.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
	return bare === "" ? undefined : `- [ ] ${bare}`;
}

/**
 * Read the checklist off a raw tool input.
 *
 * The field advertises `string`, and two thirds of the time that is what
 * arrives. The rest of the time the items are all present and the container is
 * not: measured across 240 pandorum sessions, of 1,920 tool calls carrying the
 * field **641 -- 33.4% -- were discarded**, as an array (5.8%), as the field
 * nested inside itself (20.5%), or as a string with no `- [ ]` lines (7.1%).
 *
 * That was deliberate once -- "a model that sends the field as an array has not
 * sent a checklist" -- and the measurement says otherwise: the arrays are the
 * parsed form, just not joined with newlines. Nothing here invents an item. A
 * container it cannot read still returns `undefined`, and a checklist with no
 * usable entry is still nothing.
 *
 * The silence is what made this expensive. No error is returned for a dropped
 * payload, so `task_progress` reports a 0% failure rate either way.
 */
export function readTaskProgress(input: unknown): string | undefined {
	if (!input || typeof input !== "object") {
		return undefined;
	}
	return readChecklistValue(
		(input as Record<string, unknown>)[TASK_PROGRESS_PARAM],
		0,
	);
}

/** One level of unwrapping per call, so a self-nested field cannot loop. */
function readChecklistValue(value: unknown, depth: number): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") {
			return undefined;
		}
		// The array, sent as the JSON text of an array: the shape the same model
		// used on every library tool while sending real arrays to task_progress.
		if (trimmed.startsWith("[") && trimmed.endsWith("]") && depth < 2) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (Array.isArray(parsed)) {
					return readChecklistValue(parsed, depth + 1);
				}
			} catch {
				// A markdown line can start with "[" too: read it as text.
			}
		}
		// Several lines with no boxes at all are a list of open items, one a
		// line. One line with no box is a sentence ("I am working on it"), not
		// a list, and a list with some boxes keeps only those lines (see
		// parseTaskProgress): there the unmarked lines are heading and prose.
		const rows = trimmed.split("\n").filter((line) => line.trim() !== "");
		const boxed = rows.some((line) => CHECKBOX_LINE.test(line));
		if (rows.length > 1 && !boxed) {
			return rows
				.map(itemLine)
				.filter((line): line is string => line !== undefined)
				.join("\n");
		}
		// Boxed lines in one spelling, `- [x]`; the heading and prose around
		// them are kept as they are, and parse to nothing.
		return boxed
			? rows
					.map((line) =>
						CHECKBOX_LINE.test(line) ? (itemLine(line) ?? line) : line,
					)
					.join("\n")
			: trimmed;
	}
	if (Array.isArray(value)) {
		const lines = value
			.map(checklistLine)
			.filter((line): line is string => line !== undefined);
		return lines.length > 0 ? lines.join("\n") : undefined;
	}
	if (!value || typeof value !== "object" || depth >= 2) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	// `{task_progress: [...]}` -- the wrapper sent twice, which is the single
	// most common dropped shape at 20.5% of all payloads carrying the field.
	const nested =
		record[TASK_PROGRESS_PARAM] ?? record.items ?? record.checklist;
	return nested === undefined
		? undefined
		: readChecklistValue(nested, depth + 1);
}

/**
 * Parse a markdown checklist.
 *
 * Only `- [ ]` / `- [x]` lines become items. Models routinely wrap the list in
 * a heading or a sentence, and treating those as unchecked items would report
 * work that does not exist and never complete.
 */
export function parseTaskProgress(markdown: string): TaskProgressItem[] {
	const items: TaskProgressItem[] = [];
	for (const rawLine of markdown.split("\n")) {
		const line = rawLine.trim();
		const match = CHECKBOX_LINE.exec(line);
		if (!match) {
			continue;
		}
		const text = match[2].trim();
		if (text === "") {
			continue;
		}
		items.push({ text, done: match[1] !== " " });
	}
	return items;
}

/** Build the full checklist state from raw markdown. */
export function buildTaskProgressState(markdown: string): TaskProgressState {
	const items = parseTaskProgress(markdown);
	return {
		markdown,
		items,
		completed: items.filter((item) => item.done).length,
		total: items.length,
	};
}

/**
 * Find the most recent checklist in a transcript.
 *
 * Structurally typed rather than importing the message types: this reads one
 * optional field out of tool-call inputs, and every shape it walks is
 * defensively narrowed, so tying it to a concrete Message union would buy
 * nothing but a dependency.
 */
export function findLatestTaskProgress(
	messages: readonly { content?: unknown }[] | undefined,
): string | undefined {
	if (!messages) {
		return undefined;
	}
	let latest: string | undefined;
	for (const message of messages) {
		if (!Array.isArray(message?.content)) {
			continue;
		}
		for (const block of message.content) {
			if (
				!block ||
				typeof block !== "object" ||
				(block as { type?: unknown }).type !== "tool_use"
			) {
				continue;
			}
			const markdown = readTaskProgress((block as { input?: unknown }).input);
			if (markdown !== undefined) {
				// Later wins: the transcript is in order, and the newest checklist
				// the model sent is the one it is working from.
				latest = markdown;
			}
		}
	}
	return latest;
}
