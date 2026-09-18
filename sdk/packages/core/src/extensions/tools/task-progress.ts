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
		const trimmed = entry.trim();
		return trimmed === "" ? undefined : trimmed;
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
	return /^- \[( |x|X)\]/.test(text.trim())
		? text.trim()
		: `- [${done ? "x" : " "}] ${text.trim()}`;
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
		return trimmed === "" ? undefined : trimmed;
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
export class TaskProgressTracker {
	private state: TaskProgressState | undefined;
	private callsSinceReminder = 0;
	private writesSinceReminder = 0;
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
			return undefined;
		}

		this.callsSinceReminder += 1;
		if (toolName !== undefined && WRITE_CLASS_TOOL_NAMES.has(toolName)) {
			this.writesSinceReminder += 1;
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
		// Nothing left to chase — reminding would only re-send a finished list.
		if (this.state.total > 0 && this.state.completed >= this.state.total) {
			return undefined;
		}
		return buildTaskProgressReminder(this.state);
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
			const result = await tool.execute(input, context);
			if (reminder === undefined || typeof result !== "string") {
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
