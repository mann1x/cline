/**
 * Task progress — the checklist the model keeps while it works.
 *
 * A run that starts by naming the work and then does it in order behaves very
 * differently from one that discovers the work as it goes. The difference is
 * not that the model is incapable of planning: it plans fine, and then loses
 * the plan, because nothing carries it forward. What comes out the far end is
 * the "wait, I also have to fix..." style of run, where each turn re-derives
 * the goal from whatever is nearest.
 *
 * So this module is two things that have to exist together. A checklist the
 * model can write as a side effect of work it is already doing — an optional
 * `task_progress` parameter on every tool, so keeping the list current never
 * costs a round trip — and a reminder that puts the list back in front of the
 * model every few calls. The list alone is a display feature; the reminder is
 * what changes behaviour.
 *
 * The parameter is added to the JSON schema rather than the zod schema on
 * purpose: several tools validate with `.refine(...)`, which has no `.extend`,
 * and every tool strips unknown keys before `execute` sees them. Capture
 * therefore reads the *raw* input in a decorator that runs before the tool's
 * own validation.
 */

import type { AgentTool } from "@cline/shared";
import { WRITE_CLASS_TOOL_NAMES } from "../../runtime/safety/loop-detection";

/** The wire name of the checklist parameter, shared with the host. */
export const TASK_PROGRESS_PARAM = "task_progress";

/**
 * How often the checklist is put back in front of the model, counted in tool
 * calls. Matches the legacy default (`remindClineInterval`).
 *
 * A reminder is not free — it is re-sent text, and at a large context that is
 * real budget — so the interval trades staleness against cost rather than
 * being set as low as it can go.
 */
export const DEFAULT_TASK_PROGRESS_REMINDER_INTERVAL = 6;

/**
 * The same reminder, counted in calls that changed the workspace.
 *
 * Asked for after a pandorum run that wrote for twenty turns without once
 * re-marking the list. A read does not finish an item; a write usually does, so
 * three of them is where the list has most likely gone stale, and it arrives
 * sooner than the every-six-calls interval in exactly the runs that are doing
 * the most work. Both counters share one reminder and one reset, so a busy run
 * is not reminded twice.
 */
export const DEFAULT_TASK_PROGRESS_WRITE_INTERVAL = 3;

/**
 * The description the model reads.
 *
 * Written to be answerable at the moment of any tool call, because that is
 * when it is read: it says what to send the first time (the whole plan) and
 * what to send afterwards (the same list, re-marked), which is the distinction
 * models get wrong when told only "keep it updated". It also states the format
 * exactly, since the list is parsed.
 */
export const TASK_PROGRESS_PARAM_DESCRIPTION = [
	"Optional. A markdown checklist of the work this task requires, sent along",
	"with the call you are already making — it costs no extra step.",
	"On your first tool call, list every step you expect the task to need.",
	"On later calls, send the same list back with the boxes re-marked, adding",
	"steps you have since discovered. Send the list in full every time; it",
	"replaces the previous one rather than appending to it.",
	'Format: one item per line, "- [ ] pending" or "- [x] done".',
	'As an array, one entry per item, each starting "[ ] " or "[x] ".',
].join(" ");

/** A single parsed checklist line. */
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
 * Add the checklist parameter to a tool's JSON input schema.
 *
 * Returns the schema unchanged when it is not object-shaped, rather than
 * throwing: a tool with an exotic schema should lose the checklist, not fail
 * to register.
 */
export function withTaskProgressParam(
	inputSchema: Record<string, unknown>,
): Record<string, unknown> {
	const properties = inputSchema.properties;
	if (!properties || typeof properties !== "object") {
		return inputSchema;
	}
	return {
		...inputSchema,
		properties: {
			...(properties as Record<string, unknown>),
			[TASK_PROGRESS_PARAM]: {
				// Both forms are advertised because both arrive. Declaring only
				// `string` did not stop models sending the array -- it only
				// stopped the array being read.
				type: ["string", "array"],
				items: { type: "string" },
				description: TASK_PROGRESS_PARAM_DESCRIPTION,
			},
		},
	};
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
function itemLine(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") {
		return undefined;
	}
	const marked = /^(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/.exec(trimmed);
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
		if (
			rows.length > 1 &&
			!rows.some((line) => /^\s*[-*]\s*\[( |x|X)\]/.test(line))
		) {
			return rows
				.map(itemLine)
				.filter((line): line is string => line !== undefined)
				.join("\n");
		}
		return trimmed;
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
		const match = /^- \[( |x|X)\]\s*(.*)$/.exec(line);
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
 * Render the reminder appended to a tool result.
 *
 * Sent as the checklist the model itself wrote, not as an instruction about
 * checklists: the model already has the parameter description for that, and
 * repeating advice every few calls trains it to skim the block. What it needs
 * back is the *content* — which of its own steps are still open.
 */
export function buildTaskProgressReminder(state: TaskProgressState): string {
	const remaining = state.total - state.completed;
	const heading =
		remaining > 0
			? `Task progress (${state.completed}/${state.total} done, ${remaining} remaining):`
			: `Task progress (${state.completed}/${state.total} done):`;
	return `\n\n<task_progress>\n${heading}\n${state.markdown}\n</task_progress>`;
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

/**
 * The nudge sent when a run is about to end with checklist items still open.
 *
 * Measured: a 58-minute run set the checklist once, on its 11th message of 137,
 * and never touched it again — finishing with "Fix syntax errors" and "Verify
 * fix with browser" unticked, both of which it had in fact done. The list is
 * written as a side effect of a tool call, so once the model stops passing
 * `task_progress` nothing ever ticks the boxes, and the panel ends the run
 * reading as though the task failed.
 *
 * Two outcomes are acceptable and the message names both, because the checklist
 * being stale and the work being unfinished are genuinely different situations
 * and only the model knows which one it is in.
 */
export function buildTaskProgressCloseOutNudge(
	state: TaskProgressState,
	attempt: 1 | 2 = 1,
): string {
	const open = state.items
		.filter((item) => !item.done)
		.map((item) => `- ${item.text}`)
		.join("\n");
	if (attempt === 1) {
		return [
			"[SYSTEM] Before this run ends, close out your checklist. These items are still unticked:",
			open,
			"",
			"If you have in fact done them, send the list back with those boxes ticked — `task_progress` rides along on any tool call, so one call is enough.",
			"If any is genuinely still open, do it now rather than ending here.",
		].join("\n");
	}
	// The second ask, and it is a different ask.
	//
	// Repeating a reminder verbatim is what the no-tool-call nudge was measured
	// doing to no effect, so this one does not repeat. The first asks; this one
	// narrows to two answers and says what each costs. Measured: the first
	// nudge fired on a finished run and the model ended anyway with
	// "fix syntax error on line 90" and "verify with browser" both unticked,
	// having done both.
	return [
		"[SYSTEM] The checklist is still showing these as not done:",
		open,
		"",
		"This is the last time you will be asked, so answer it directly rather than restating that the task is complete.",
		"Done? Make one more tool call carrying `task_progress` with those boxes ticked — that call is the whole answer.",
		"Not done, and not going to be? Say which items you are leaving open and why, in one sentence, so the list is not left claiming work that nobody did.",
	].join("\n");
}

/**
 * How many times a run may be asked to close out its checklist.
 *
 * Two, and they are different messages. One was the original setting, on the
 * reasoning that a repeated prompt is a trap — true of a prompt repeated
 * verbatim, which is what the no-tool-call nudge does and why its budget is
 * one. Measured since: the first nudge fired on a run that had done both of
 * its two items, and the model ended anyway with both unticked. So the first
 * ask stands, and the second one asks differently — tick them in one call, or
 * name what you are leaving open. A third would be the trap the original
 * comment warned about.
 */
const TASK_PROGRESS_CLOSE_OUT_ATTEMPTS = 2;

/**
 * A `completionPolicy.completionGuard` that will not let a run end quietly on a
 * checklist with open items.
 *
 * Stops as soon as the checklist is closed: the second ask only happens if the
 * first one changed nothing, so a model that ticks the boxes never sees it.
 * After the budget is spent, the ordinary no-tool-call nudge and its own budget
 * take over.
 */
export function createTaskProgressCompletionGuard(
	tracker: TaskProgressTracker,
): () => string | undefined {
	let fired = 0;
	return () => {
		if (fired >= TASK_PROGRESS_CLOSE_OUT_ATTEMPTS) {
			return undefined;
		}
		const state = tracker.getState();
		if (!state || state.total === 0 || state.completed >= state.total) {
			return undefined;
		}
		fired += 1;
		return buildTaskProgressCloseOutNudge(state, fired === 1 ? 1 : 2);
	};
}

/**
 * Marks a tool that already carries the checklist wrapper. A symbol rather than
 * a field: it must not appear in anything that serializes a tool definition.
 */
const TASK_PROGRESS_WRAPPED: unique symbol = Symbol.for(
	"cline.taskProgressWrapped",
);

/** Whether a tool has already been wrapped for checklist capture. */
export function isTaskProgressWrapped(tool: object): boolean {
	return (tool as Record<symbol, unknown>)[TASK_PROGRESS_WRAPPED] === true;
}

export interface TaskProgressTrackerOptions {
	/** Tool calls between reminders. Zero or less disables reminding. */
	reminderInterval?: number;
	/**
	 * Workspace-changing calls between reminders. Zero or less disables that
	 * half, leaving the plain interval above.
	 */
	writeInterval?: number;
	/** Called whenever the model sends a new checklist. */
	onUpdate?: (state: TaskProgressState) => void;
}

/**
 * Holds the current checklist for a session and decides when to remind.
 *
 * The reminder counter advances on every tool call, not only on calls that
 * carried a checklist — a model that has stopped updating the list is exactly
 * the one that needs to see it again.
 */
/**
 * The nudge for a file changed outside the checklist.
 *
 * Two situations, one rule: a call that changes a file is work on a step, so
 * if no step is open the list is wrong. Either there is no list at all, or the
 * list says everything is done and the work has carried on. Measured over 22
 * v9-agentic sessions (pandorum, 2026-10-10): 12 of the 15 that edited never
 * sent a list; one sent a single item at its 5th call, ticked it at its 6th
 * and made 7 of its 10 edits afterwards; another re-sent the same finished
 * one-item list 16 times across five more edits.
 *
 * Reads never trigger it. A run that only looks may simply be finished.
 */
export function buildUntrackedEditNudge(
	kind: "missing" | "finished",
	path: string | undefined,
): string {
	const changed = path ? `\`${path}\`` : "a file";
	if (kind === "missing") {
		return [
			`[SYSTEM] You just changed ${changed} and this task has no checklist.`,
			"Changing a file is work on a step, and that step is not written down anywhere.",
			"On your next tool call, send `task_progress` with every step this task needs: the one you are working on unticked (`- [ ] ...`), the ones already finished ticked (`- [x] ...`).",
			"It rides along on the call you were going to make anyway and costs no extra step.",
		].join(" ");
	}
	return [
		`[SYSTEM] Your checklist says every step is done, and you just changed ${changed}.`,
		"That change is work on a step the list does not have.",
		"On your next tool call, send `task_progress` again with that step added and unticked (`- [ ] ...`). Tick a step only after the work for it has been checked, not when you start it.",
	].join(" ");
}

/** The file a write-class call names, as the nudge quotes it. */
function readEditedPath(input: unknown): string | undefined {
	const path =
		typeof input === "object" && input !== null
			? (input as { path?: unknown }).path
			: undefined;
	return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

export class TaskProgressTracker {
	private state: TaskProgressState | undefined;
	private callsSinceReminder = 0;
	private writesSinceReminder = 0;
	/** Edits made since a list with an open step was last sent. */
	private untrackedEdits = 0;
	/** A reminder waiting for the turn's tool calls to finish. */
	private pending: string | undefined;
	private readonly reminderInterval: number;
	private readonly writeInterval: number;
	private readonly onUpdate: ((state: TaskProgressState) => void) | undefined;

	constructor(options: TaskProgressTrackerOptions = {}) {
		this.reminderInterval =
			options.reminderInterval ?? DEFAULT_TASK_PROGRESS_REMINDER_INTERVAL;
		this.writeInterval =
			options.writeInterval ?? DEFAULT_TASK_PROGRESS_WRITE_INTERVAL;
		this.onUpdate = options.onUpdate;
	}

	/** The checklist as last sent, or undefined if the model never sent one. */
	getState(): TaskProgressState | undefined {
		return this.state;
	}

	/**
	 * Restore the checklist from history without treating it as a fresh update.
	 *
	 * The tracker is per-session memory, so a resumed task would otherwise come
	 * back with an empty list and the model would be reminded of nothing. It
	 * does not need to be persisted separately: every call that carried a
	 * checklist is already in the transcript, so history is the durable copy and
	 * this is a cache being warmed from it. Silent by design — a restore is not
	 * the model saying something new, and firing `onUpdate` would replay a
	 * checklist message the UI already has.
	 *
	 * Only fills an empty tracker; a live checklist is never overwritten by an
	 * older one from history.
	 */
	hydrate(markdown: string | undefined): void {
		if (this.state !== undefined || markdown === undefined) {
			return;
		}
		const restored = buildTaskProgressState(markdown);
		if (restored.total > 0) {
			this.state = restored;
		}
	}

	/**
	 * Record one tool call. Returns the reminder to append to its result, or
	 * undefined.
	 *
	 * A call that carried a checklist never also gets a reminder: the model just
	 * demonstrated it has the list, and echoing it straight back is pure cost.
	 */
	recordToolCall(input: unknown, toolName?: string): string | undefined {
		const markdown = readTaskProgress(input);
		const isWrite =
			toolName !== undefined && WRITE_CLASS_TOOL_NAMES.has(toolName);
		// As the list stood before this call. A call that does a step's work
		// and ticks it in the same breath is the ordinary way a list is
		// finished; a call that edits after the list was already finished is
		// the one that needs saying something about.
		const hadNoList = !this.hasItems();
		const wasFinished = this.isFinished();
		if (markdown !== undefined) {
			const next = buildTaskProgressState(markdown);
			// An unparseable value is still worth storing for display, but it must
			// not silently reset a good list to zero items.
			if (next.total > 0 || this.state === undefined) {
				this.state = next;
				this.onUpdate?.(next);
			}
			this.callsSinceReminder = 0;
			this.writesSinceReminder = 0;
			if (this.hasItems() && !this.isFinished()) {
				this.untrackedEdits = 0;
			} else if (isWrite && wasFinished) {
				this.noteUntrackedEdit("finished", input);
			}
			return undefined;
		}

		this.callsSinceReminder += 1;
		if (isWrite) {
			this.writesSinceReminder += 1;
			if (hadNoList || wasFinished) {
				this.noteUntrackedEdit(hadNoList ? "missing" : "finished", input);
			}
		}
		// Only if it has been already provided: with no list there is nothing to
		// remind anyone of, and a nudge made of nothing reads as a reprimand.
		if (this.state === undefined) {
			return undefined;
		}
		const due =
			(this.reminderInterval > 0 &&
				this.callsSinceReminder >= this.reminderInterval) ||
			(this.writeInterval > 0 &&
				this.writesSinceReminder >= this.writeInterval);
		if (!due) {
			return undefined;
		}
		// One reset for both counters, so a busy run is reminded once rather
		// than twice in consecutive turns.
		this.callsSinceReminder = 0;
		this.writesSinceReminder = 0;
		// Nothing left to chase — reminding would only re-send a finished list,
		// and a list with no items is nothing at all ("Task progress (0/0 done)"
		// in every third library report on pandorum).
		if (this.state.total === 0 || this.state.completed >= this.state.total) {
			return undefined;
		}
		return buildTaskProgressReminder(this.state);
	}

	private hasItems(): boolean {
		return this.state !== undefined && this.state.total > 0;
	}

	private isFinished(): boolean {
		return (
			this.state !== undefined &&
			this.state.total > 0 &&
			this.state.completed >= this.state.total
		);
	}

	/**
	 * Count an edit made with no step open, and queue the nudge when one is due.
	 *
	 * The first such edit, then every `writeInterval` after it: said once it
	 * can be missed, said on every edit it is noise the model learns to skip.
	 */
	private noteUntrackedEdit(
		kind: "missing" | "finished",
		input: unknown,
	): void {
		this.untrackedEdits += 1;
		const interval = Math.max(1, this.writeInterval);
		if ((this.untrackedEdits - 1) % interval !== 0) {
			return;
		}
		this.pending = buildUntrackedEditNudge(kind, readEditedPath(input));
	}

	/**
	 * Take back what {@link recordToolCall} counted for a call that then failed.
	 *
	 * The call is recorded before the tool runs, because that is the only place
	 * its checklist is still visible, so "changed a file" was decided from the
	 * tool's name. An `editor` call refused with "Read before editing ... The
	 * file was not modified" was then followed by "You just changed
	 * `/workspace/answer.txt` and this task has no checklist" (automaticum,
	 * 2026-10-13, SDK 4.100.250): a statement about the file that the result
	 * one line above it contradicts.
	 *
	 * Only the nudge this call queued is withdrawn. One already waiting from an
	 * edit that did land names a path of its own and is kept.
	 */
	retractFailedWrite(input: unknown, toolName?: string): void {
		if (toolName === undefined || !WRITE_CLASS_TOOL_NAMES.has(toolName)) {
			return;
		}
		this.writesSinceReminder = Math.max(0, this.writesSinceReminder - 1);
		if (this.untrackedEdits === 0) {
			return;
		}
		this.untrackedEdits -= 1;
		const path = readEditedPath(input);
		if (
			this.pending === buildUntrackedEditNudge("missing", path) ||
			this.pending === buildUntrackedEditNudge("finished", path)
		) {
			this.pending = undefined;
		}
	}

	/**
	 * Hold a reminder for delivery after the turn's tool calls.
	 *
	 * For the reminders that could not be appended to a result because the
	 * result is not text. An untracked-edit nudge already waiting is kept: it
	 * is the more specific of the two.
	 */
	queueReminder(reminder: string): void {
		if (this.pending === undefined) {
			this.pending = `[SYSTEM] ${reminder.trim()}`;
		}
	}

	/** The reminder waiting to be delivered, cleared by the read. */
	takePendingReminder(): string | undefined {
		const pending = this.pending;
		this.pending = undefined;
		return pending;
	}
}

/**
 * Wrap a tool so its calls feed the tracker and its results carry reminders.
 *
 * The wrapper sits outside the tool's own validation, which is the only place
 * the checklist is still visible: every tool strips keys its schema does not
 * name, so by the time `execute` runs the field is gone.
 *
 * Reminders are only appended to string results. A tool that returns structured
 * output has a shape its caller parses, and appending prose to that would break
 * the consumer to nudge the model — the wrong trade.
 */
export function withTaskProgressCapture<TInput, TOutput>(
	tool: AgentTool<TInput, TOutput>,
	tracker: TaskProgressTracker,
): AgentTool<TInput, TOutput> {
	// Wrapping twice would count one call as two and pull the reminder forward,
	// and the toolset can legitimately be wrapped at more than one layer — the
	// builtin factory takes a tracker, and the host wraps the merged list so
	// its own tools are covered too. Idempotence is what lets both exist.
	if (isTaskProgressWrapped(tool)) {
		return tool;
	}
	const wrapped: AgentTool<TInput, TOutput> = {
		...tool,
		inputSchema: withTaskProgressParam(tool.inputSchema),
		execute: async (input, context) => {
			const reminder = tracker.recordToolCall(input, tool.name);
			let result: TOutput;
			try {
				result = await tool.execute(input, context);
			} catch (error) {
				// A refused or failed edit changed nothing, so nothing may be
				// said about a change.
				tracker.retractFailedWrite(input, tool.name);
				throw error;
			}
			if (reminder === undefined) {
				return result;
			}
			if (typeof result !== "string") {
				// Structured output has a shape its caller parses, so the
				// reminder is not appended to it -- and it used to be dropped
				// here instead, on the editor, the reader and the command
				// runner, which is every tool a working run calls.
				tracker.queueReminder(reminder);
				return result;
			}
			return `${result}${reminder}` as TOutput;
		},
	};
	Object.defineProperty(wrapped, TASK_PROGRESS_WRAPPED, {
		value: true,
		enumerable: false,
	});
	return wrapped;
}
