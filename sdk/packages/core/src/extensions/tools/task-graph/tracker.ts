/**
 * The task graph's half of the harness: watching the run's tool calls and
 * saying something when the board needs attention -- at the moment it does,
 * rather than on a timer. Phase 0 measured the checklist's every-six-calls
 * reminder re-sending an unchanged list most of the time, and the list being
 * written after the work it was meant to plan.
 *
 * The solo nudges (plan section 10):
 *
 * | id | when |
 * |---|---|
 * | S1 plan | no task yet, and the run has changed a file or made its 4th call |
 * | S2 untracked | a file change while tasks exist and none is active |
 * | S3 stale | 3 file changes since the active task was last touched |
 * | S4 verified | a test or build command passes while a task is active |
 * | S5 drift | a command fails after changes, or 8 calls pass, while the active task is not touched |
 * | S5 ready | a close unblocked tasks (said in `task_update`'s own result) |
 * | S6 struggle | the struggle detector fires while a task is active (joined to its message) |
 * | S7 resume | the board, after a compaction or on resume |
 * | S8 close-out | the run ends with active or ready tasks (completion guard) |
 *
 * The team nudges (phase 4), with a team on the board:
 *
 * | id | when | to |
 * |---|---|---|
 * | T1 parallel | a plan's first layer has 2+ tasks nobody holds | lead, with the plan |
 * | T2 claim | a teammate's run starts | teammate, in its run message (team-board.ts) |
 * | T3 report | a teammate's run ends holding an active task | teammate, completion guard |
 * | T4 idle ready | the lead waits on runs while ready tasks have no holder | lead |
 * | T5 unblocked | a close made a held task ready | teammate, team mailbox |
 *
 * Rules shared by all of them:
 * - **Once per situation.** Each has a key (S3's is the task and the event
 *   that last touched it), and a key is said at most twice, the second time
 *   in different words: a nudge repeated verbatim was measured doing nothing.
 * - **One nudge per three tool calls.** A busy run is never nagged twice in a
 *   row. The close-out and the board after a compaction are not counted:
 *   one ends the run, the other replaces calls the model can no longer see.
 * - **Every one names the tool call that answers it**, with its arguments.
 *
 * Nothing is added to any tool's schema.
 */

import type { AgentTool } from "@cline/shared";
import { WRITE_CLASS_TOOL_NAMES } from "../../../runtime/safety/loop-detection";
import { renderBoard, shortTitle } from "./board";
import {
	decideCommitGate,
	decideGitHubGate,
	decideTimerGate,
	humanGatesAnswered,
} from "./gates";
import { isReady, openWork, parseGate, type Task, taskLayers } from "./model";
import { type ExportedTaskBoard, exportTaskEvents } from "./saved-board";
import {
	type GateDecision,
	readTaskDone,
	TASK_DONE_PARAM,
	TASK_DONE_TOOL_NAMES,
	TASK_GRAPH_TOOL_NAMES,
	type TaskGraphSeed,
	TaskGraphStore,
	type TaskGraphStoreOptions,
} from "./store";
import {
	boardToTemplate,
	expandTaskTemplate,
	findTaskTemplate,
	loadTaskTemplates,
	saveTaskTemplate,
	type TaskTemplate,
} from "./templates";
import { createTaskGraphTools } from "./tools";

/** The schema field: optional, short, and the same on every tool that has it. */
const TASK_DONE_PROPERTY = {
	type: "string",
	description:
		'Optional. The task this call completes, as "T3: what was done and how it was checked"; several as "T3, T4: …". It is closed, with its acceptance ticked, only if the call succeeds.',
} as const;

/** `inputSchema` with `task_done` added, when the tool is one that carries it. */
export function withTaskDoneParam(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	const record = schema as { properties?: Record<string, unknown> };
	if (!record.properties || TASK_DONE_PARAM in record.properties) return schema;
	return {
		...record,
		properties: { ...record.properties, [TASK_DONE_PARAM]: TASK_DONE_PROPERTY },
	};
}

export interface TaskGraphTrackerOptions extends TaskGraphStoreOptions {
	/**
	 * Tool calls that must pass after one nudge before the next. Default 3.
	 * (Named for the setting it replaces; the checklist's write interval.)
	 */
	writeInterval?: number;
	/** Called with a nudge's id each time one is queued, for logs and counts. */
	onNudge?: (id: string, key: string) => void;
	/** Where `commit:` and GitHub gates are checked. */
	cwd?: string;
	/**
	 * Where saved plans are read from, the workspace's first (phase 3
	 * templates). The first is where the panel saves one.
	 */
	templateDirs?: string[];
	// `planMode` (from the store options): the plan goes on the board, and
	// nothing asks for work to be done, started or closed (that is act
	// mode's, once the person agrees). Fixed for a session; a switch rebuilds it.
}

/** Calls with no task before S1 asks for a plan anyway. */
const PLAN_BY_CALL = 4;
/** File changes under one active task, untouched, before S3. */
const STALE_WRITES = 3;
const DEFAULT_NUDGE_SPACING = 3;
const MAX_ATTEMPTS = 2;
/** S5: calls under an active task, untouched, before asking whether the plan still holds. */
const DRIFT_CALLS = 8;
const CLOSE_OUT_ATTEMPTS = 2;

function readEditedPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as {
		path?: unknown;
		file_path?: unknown;
		files?: unknown;
	};
	const path =
		record.path ??
		record.file_path ??
		(Array.isArray(record.files) ? record.files[0] : undefined);
	return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

function changesFiles(toolName: string | undefined, input: unknown): boolean {
	if (toolName === undefined || !WRITE_CLASS_TOOL_NAMES.has(toolName))
		return false;
	if (toolName === "awk") return false;
	if (toolName === "sed") {
		return (
			typeof input === "object" &&
			input !== null &&
			(input as { in_place?: unknown }).in_place === true
		);
	}
	return true;
}

function reportsFailure(result: unknown): boolean {
	const failed = (entry: unknown): boolean =>
		typeof entry === "object" &&
		entry !== null &&
		(entry as { success?: unknown }).success === false;
	return Array.isArray(result)
		? result.length > 0 && result.every(failed)
		: failed(result);
}

function reportsSuccess(result: unknown): boolean {
	const ok = (entry: unknown): boolean =>
		typeof entry === "object" &&
		entry !== null &&
		(entry as { success?: unknown }).success === true;
	return Array.isArray(result)
		? result.length > 0 && result.every(ok)
		: ok(result);
}

/**
 * Commands that check work: test runners, type checkers, builds, linters.
 * Matched on the command text, so `cd x && python3 -m unittest` counts.
 */
const CHECK_COMMAND =
	/\b(?:pytest|unittest|py\.test|tox|nox|jest|vitest|mocha|ava|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)|tsc\b|mypy|pyright|ruff|eslint|biome|make(?:\s+\S+)*\s+(?:test|check|build)|gradle\w*\s+(?:test|build)|mvn\s+(?:test|verify)|dotnet\s+(?:test|build)|ctest|phpunit|rspec)\b/i;

export function readCheckCommand(
	toolName: string | undefined,
	input: unknown,
): string | undefined {
	if (
		toolName !== "run_commands" ||
		typeof input !== "object" ||
		input === null
	)
		return undefined;
	const commands = (input as { commands?: unknown }).commands;
	const list = Array.isArray(commands) ? commands : [commands];
	for (const entry of list) {
		const text =
			typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null
					? (entry as { command?: unknown }).command
					: undefined;
		if (typeof text === "string" && CHECK_COMMAND.test(text)) {
			return text.length > 80 ? `${text.slice(0, 79)}…` : text;
		}
	}
	return undefined;
}

/** Where `run_commands` appends its own checker output to a command's. */
const CHECKER_SECTION = /\n\n--- the checker/;
const ERROR_LINE =
	/\b(?:[A-Z]\w*(?:Error|Exception)\b|error:|FAIL(?:ED|URE)?\b|failed\b|Traceback\b|panicked\b)/;

function clip(text: string, max = 120): string {
	const line = text.trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What a command run reported going wrong, as one line, or undefined when it
 * reported nothing. A failed run (nonzero exit) counts, and so does output
 * that names a failure: a check that exits 0 and prints `"ok": false` (as
 * run_game.exe does) or an error line.
 */
export function readCommandFailure(
	toolName: string | undefined,
	result: unknown,
): string | undefined {
	if (toolName !== "run_commands") return undefined;
	const entries = Array.isArray(result) ? result : [result];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as {
			success?: unknown;
			result?: unknown;
			error?: unknown;
		};
		const raw =
			typeof record.result === "string"
				? record.result
				: typeof record.error === "string"
					? record.error
					: "";
		const output = raw.split(CHECKER_SECTION)[0] ?? "";
		const firstLine = output.trim().split("\n")[0] ?? "";
		try {
			const parsed = JSON.parse(firstLine) as { ok?: unknown; error?: unknown };
			if (parsed && typeof parsed === "object" && parsed.ok === false) {
				return clip(
					typeof parsed.error === "string" ? parsed.error : firstLine,
				);
			}
		} catch {
			// Not a JSON report: look for an error line.
		}
		const line = output.split("\n").find((text) => ERROR_LINE.test(text));
		if (line) return clip(line);
		if (record.success === false)
			return clip(firstLine || "the command failed");
	}
	return undefined;
}

export type UntrackedKind = "missing" | "idle" | "finished";

const PLAN_EXAMPLE_PLAN_MODE =
	'`task_plan` {"tasks":[{"title":"…","acceptance":["…"]},{"title":"…","depends":["#1"]}]}';
const PLAN_EXAMPLE =
	'`task_plan` {"tasks":[{"title":"…","acceptance":["…"],"start":true},{"title":"…","depends":["#1"]}]}';

/** S1, and S2's two shapes. The first attempt asks; the second narrows. */
/** The heading the system prompt's task-board section opens with. */
export const TASK_BOARD_RULES_HEADING = "# Task board";

/**
 * The task board's rules, for the system prompt of a session with the graph
 * on. Everything else the board says rides on a tool result or a run-start
 * note, and a model can read those as data: on pandorum (yl4ti,
 * gemma4-26b-agentic, 2026-11-21) the model's reasoning never once mentioned
 * the plan after the start note and two asks, and it worked 53 calls with no
 * board. The system prompt is the channel it does follow (the plan-mode rules
 * there were obeyed the same morning), and no template carried a word about
 * the board: the checklist's `task_progress` section went with the checklist.
 */
export function buildTaskBoardRules(planMode = false, team = false): string {
	if (planMode) {
		return [
			TASK_BOARD_RULES_HEADING,
			"",
			"This conversation keeps a task board: the plan as tasks, which the user sees and approves.",
			"- In plan mode the plan goes on the board. Once you know the cause, write it with one `task_plan` call. " +
				PLAN_MODE_TASKS,
			"- Nothing is started in plan mode: the work is done in act mode, once the user agrees.",
		].join("\n");
	}
	return [
		TASK_BOARD_RULES_HEADING,
		"",
		"This conversation keeps a task board: the plan as tasks, which the user sees while you work.",
		'- Before the first file change, write the plan with one `task_plan` call: one task per step the request needs, each with its acceptance (what is true when it is done, and how that is checked), `depends` for the order, and `"start": true` on the first.',
		'- Close a task on the call that finishes it: add `task_done: "T1: what was done and how it was checked"` to that call.',
		"- When the work turns out different from the plan (a new problem, a step it does not have), change the plan: add the task with `task_plan`, or note on the task where it stands with `task_update`.",
		"- A request that only needs an answer needs no plan.",
		...(team
			? [
					"- Your teammates work the same board: `team_task` shows and claims the same `T<n>` tasks. Tasks in the first layer of `task_view graph` can run side by side: hand them out with `team_run_task`, naming the task id in the message; a teammate claims it and closes it with `team_task complete`. A task that needs a teammate's result can wait on it with the gate `run:<teammate id>`.",
				]
			: []),
	].join("\n");
}

/** The system prompt with the task-board rules appended, once. */
export function withTaskBoardRules(
	systemPrompt: string | undefined,
	planMode = false,
	team = false,
): string | undefined {
	if (!systemPrompt?.trim()) return systemPrompt;
	if (systemPrompt.includes(`\n${TASK_BOARD_RULES_HEADING}\n`))
		return systemPrompt;
	return `${systemPrompt}\n\n${buildTaskBoardRules(planMode, team)}`;
}

/** What a plan-mode task says: the plan is what the user approves. */
const PLAN_MODE_TASKS =
	"One task per change: the title says what changes and where (file, function or line), the description why that removes the cause, and the acceptance how it is checked (the command and the result that shows it worked); `depends` gives the order, and the last task checks the whole request.";

/** Plan mode, the run ending with an empty board after looking around. */
export function buildTaskGraphPlanAtEndNudge(): string {
	return [
		"[SYSTEM] The board has no plan yet. Before you present it, put it there in one `task_plan` call.",
		PLAN_MODE_TASKS,
		"If you do not know the cause yet, keep looking with read-only tools first.",
	].join(" ");
}

/** Said once at the start of a session with no board yet. */
export function buildTaskGraphStartNote(planMode = false): string {
	if (planMode) {
		return [
			"[SYSTEM] This conversation keeps a task board, and this is plan mode.",
			"Find the cause first; once you can say what is wrong and where, put the plan on the board in one `task_plan` call.",
			PLAN_MODE_TASKS,
			"Nothing is started in plan mode: the work is done in act mode, once the user agrees.",
		].join(" ");
	}
	return [
		"[SYSTEM] This conversation keeps a task board.",
		`If the request needs any file changed, write the plan before the first change, in one call: ${PLAN_EXAMPLE}.`,
		'Every step with what has to be true when it is done, the order between them (`depends`), and `"start": true` on the first.',
		"Close each task as you finish it (`task_done` on the call that finishes it). A request that changes no file needs no plan.",
	].join(" ");
}

export function buildTaskGraphUntrackedNudge(
	kind: UntrackedKind,
	path: string | undefined,
	ready: Task[] = [],
	attempt: 1 | 2 = 1,
): string {
	const changed = path ? `\`${path}\`` : "a file";
	if (kind === "missing") {
		if (attempt === 2) {
			return [
				"[SYSTEM] There is still no plan, and the work has gone on without one.",
				`Write it now, in one call, before the next change: ${PLAN_EXAMPLE}.`,
				"Every step the request needs, each with what has to be true when it is done; mark the one you are on with start.",
			].join(" ");
		}
		return [
			`[SYSTEM] You just changed ${changed}, and this task has no plan.`,
			"Before the next change, write the plan with one `task_plan` call: every step the request needs, each with its acceptance, and the order between them (`depends`).",
			'Mark the step you are on with `"start": true`.',
		].join(" ");
	}
	if (kind === "idle") {
		const next = ready[0];
		const start = next
			? `\`task_update\` {"updates":[{"id":"${next.id}","status":"active"}]}`
			: "`task_update` (status active)";
		if (attempt === 2) {
			return [
				`[SYSTEM] Files are changing while no task is active (${changed} just now).`,
				`Say which task this work is: ${start}, or add it with \`task_plan\` if the plan does not have it.`,
			].join(" ");
		}
		return [
			`[SYSTEM] You just changed ${changed}, and no task is active.`,
			next
				? `If this is work on ${next.id} (${shortTitle(next.title, 50)}), start it: ${start}; if it is a step the plan does not have, add it with \`task_plan\`.`
				: "Start the task this belongs to with `task_update` (status active), or add it with `task_plan` if the plan does not have it.",
		].join(" ");
	}
	return [
		`[SYSTEM] Every task is closed, and you just changed ${changed}.`,
		'That change is work on a step the plan does not have: add it with `task_plan` ("start": true), and close it with what was checked once it is done.',
	].join(" ");
}

/** S1 before any change: the run is several calls in with nothing planned. */
export function buildTaskGraphPlanFirstNudge(
	calls: number,
	planMode = false,
): string {
	if (planMode) {
		return [
			`[SYSTEM] ${calls} calls in and the board has no plan.`,
			`If this request needs changes, put the plan on the board in one call: ${PLAN_EXAMPLE_PLAN_MODE}.`,
			"Every step with its acceptance and the order between them; start none, the work is done in act mode once the user agrees.",
			"If it only needs an answer, carry on: no plan is needed.",
		].join(" ");
	}
	return [
		`[SYSTEM] ${calls} calls in and there is no plan yet.`,
		`If this request needs changes, write the plan before the first one, in one call: ${PLAN_EXAMPLE}.`,
		"Every step with its acceptance and the order between them; start the first.",
		"If it only needs an answer, carry on: no plan is needed.",
	].join(" ");
}

/** S3: the active task has gone untouched across several changes. */
export function buildTaskGraphStaleNudge(
	task: Task,
	files: string[],
	attempt: 1 | 2 = 1,
): string {
	const where = files.length
		? ` (${files
				.slice(0, 3)
				.map((file) => `\`${file}\``)
				.join(", ")}${files.length > 3 ? ", …" : ""})`
		: "";
	if (attempt === 2) {
		return [
			`[SYSTEM] ${task.id} is still the active task after more changes${where}.`,
			`Settle it: add \`task_done: "${task.id}: what was checked"\` to your next call, or send a \`task_update\` note saying what is left.`,
		].join(" ");
	}
	return [
		`[SYSTEM] ${STALE_WRITES} changes${where} since ${task.id} (${shortTitle(task.title, 50)}) was last updated.`,
		`If it is finished, close it with what was done and how it was checked: add \`task_done: "${task.id}: …"\` to your next call.`,
		"If not, add a note saying where it stands.",
	].join(" ");
}

/** S5: the active task has not moved while the work has. */
export function buildTaskGraphDriftNudge(
	task: Task,
	calls: number,
	failure: string | undefined,
	attempt: 1 | 2 = 1,
): string {
	const named = `${task.id} (${shortTitle(task.title, 50)})`;
	const note = `\`task_update\` {"updates":[{"id":"${task.id}","note":"…"}]}`;
	if (attempt === 2) {
		return [
			`[SYSTEM] The board still shows ${named} as the work in progress${failure ? `, and the check still fails: \`${failure}\`` : ""}.`,
			`Bring it up to date in one call: a note on ${task.id} saying what is left, a new task for what you are fixing now (\`task_plan\`), or \`task_done\` if it is finished.`,
			"If it is still the same work, carry on.",
		].join(" ");
	}
	return [
		failure
			? `[SYSTEM] ${named} is still the active task, and the last check failed: \`${failure}\`.`
			: `[SYSTEM] ${calls} calls since ${named} was last updated.`,
		`If the plan has changed (a new problem, a step it does not have), add it with \`task_plan\`, or note on ${task.id} where it stands: ${note}.`,
		`If it is still ${task.id}, carry on.`,
	].join(" ");
}

/** S4: a check passed while a task is active. */
export function buildTaskGraphVerifiedNudge(
	task: Task,
	command: string,
): string {
	// `task_done` ticks the acceptance with the close, so no `check` is asked for.
	return [
		`[SYSTEM] \`${command}\` passed while ${task.id} (${shortTitle(task.title, 50)}) is active.`,
		`If it checks ${task.id}, close it with this as the note: add \`task_done: "${task.id}: ${command.replace(/"/g, "'")} passed"\` to your next call.`,
	].join(" ");
}

export function buildTaskGraphCloseOutNudge(
	open: Task[],
	attempt: 1 | 2,
): string {
	const list = open
		.map(
			(task) =>
				`- ${task.id} ${task.title} (${task.status === "active" ? "active" : "ready"})`,
		)
		.join("\n");
	if (attempt === 1) {
		return [
			"[SYSTEM] Before this run ends, close out the task board. These are still open:",
			list,
			"",
			"Done? Close each with `task_update` (status done) and a `note` saying what was done and how it was checked; several fit in one call.",
			"Not needed? Cancel it with the reason. Still to do? Do it now rather than ending here.",
		].join("\n");
	}
	return [
		"[SYSTEM] The board still shows these as open:",
		list,
		"",
		"This is the last time you will be asked. Answer with one `task_update` call that closes or cancels them,",
		"or say in one sentence which you are leaving open and why, so the board does not claim work nobody did.",
	].join("\n");
}

const TASK_GRAPH_WRAPPED: unique symbol = Symbol.for("cline.taskGraphWrapped");

interface QueuedNudge {
	id: string;
	key: string;
	text: string;
	/** The calls that queued it, so a call that then failed can take it back. */
	from: Set<unknown>;
}

/** A change from the task panel: `task_update`'s or `task_plan`'s input, as the person's. */
export type TaskGraphEdit =
	| { op: "update"; updates: unknown[] }
	| { op: "plan"; tasks: unknown[] };

export interface TaskGraphEditOutcome {
	lines: string[];
	changed: boolean;
}

export class TaskGraphTracker {
	readonly store: TaskGraphStore;
	private readonly spacing: number;
	private readonly onNudge: ((id: string, key: string) => void) | undefined;
	private readonly planMode: boolean;
	private readonly cwd: string | undefined;
	private readonly templateDirs: string[];
	/** The team, once there is one: T1 and T4 speak only then. */
	private team: { idleReady: () => string | undefined } | undefined;
	private calls = 0;
	/** S5: the active task as last touched, and what has happened under it since. */
	private drift:
		| {
				id: string;
				seq: number;
				calls: number;
				writes: number;
				failure?: string;
		  }
		| undefined;
	/** File-changing calls so far: the first one with no plan is said at once. */
	private changes = 0;
	/** Calls since the last nudge was queued; starts open. */
	private callsSinceNudge = Number.POSITIVE_INFINITY;
	private readonly attempts = new Map<string, number>();
	private queued: QueuedNudge | undefined;
	/** What a working call's `task_done` did, said with the next reminder. */
	private doneNotes: string[] = [];
	private boardDue = false;
	private closeOutFired = 0;
	/** Plan mode: the board was asked for its plan as the run ended. */
	private planAskedAtEnd = false;
	/** The last call outside the graph: a close right after it could have ridden on it. */
	private lastWork:
		| { tool: string; succeeded: boolean; carriedDone: boolean }
		| undefined;
	private taskDoneHintGiven = false;
	/** What the person changed from the panel, for the model's next look. */
	private userNotes: string[] = [];
	/** Changes made under the active task since it was last touched. */
	private staleFor:
		| { id: string; seq: number; writes: number; files: string[] }
		| undefined;

	constructor(options: TaskGraphTrackerOptions = {}) {
		this.store = new TaskGraphStore(options);
		this.spacing = Math.max(1, options.writeInterval ?? DEFAULT_NUDGE_SPACING);
		this.onNudge = options.onNudge;
		this.cwd = options.cwd;
		this.templateDirs = options.templateDirs ?? [];
		this.planMode = this.store.planMode;
	}

	/** The three tools, writing to this tracker's store. */
	tools(author?: () => string): AgentTool<unknown, unknown>[] {
		return createTaskGraphTools(
			this.store,
			author,
			{ beforeView: () => this.checkRemoteGates() },
			() => this.templates(),
		) as AgentTool<unknown, unknown>[];
	}

	// -------------------------------------------------------------------------
	// Templates (phase 3)
	// -------------------------------------------------------------------------

	/** The saved plans this session can use, read fresh each time. */
	templates(): TaskTemplate[] {
		return loadTaskTemplates(this.templateDirs);
	}

	/** The person starts from a saved plan, from the panel. */
	useTemplate(
		name: string,
		vars: Record<string, string> = {},
	): TaskGraphEditOutcome {
		const template = findTaskTemplate(this.templates(), name);
		if (!template) {
			return { lines: [`No saved plan named "${name}".`], changed: false };
		}
		const { tasks, missing } = expandTaskTemplate(template, vars);
		const outcome = this.edit({ op: "plan", tasks });
		return {
			lines: [
				...outcome.lines,
				...(missing.length
					? [`Not filled: ${missing.map((key) => `{{${key}}}`).join(", ")}.`]
					: []),
			],
			changed: outcome.changed,
		};
	}

	/**
	 * The board saved as a plan to repeat, into the workspace's template
	 * folder (or the user's, `where: "user"`). Returns the file.
	 */
	saveTemplate(
		name: string,
		description?: string,
		where: "workspace" | "user" = "workspace",
	): string | undefined {
		if (this.store.isEmpty()) return undefined;
		const dir =
			where === "user"
				? this.templateDirs[this.templateDirs.length - 1]
				: this.templateDirs[0];
		if (!dir) return undefined;
		return saveTaskTemplate(
			dir,
			boardToTemplate(this.store.getState(), name, description),
		);
	}

	/**
	 * S6: the struggle detector found the run stuck while a task is active.
	 * Returns the sentence that goes with the detector's own message (joined
	 * to it, not sent apart), or undefined when there is no active task or
	 * this task's two asks are spent.
	 */
	noteStruggle(): string | undefined {
		if (this.planMode) return undefined;
		const active = this.activeTask();
		if (!active) return undefined;
		const key = `struggle:${active.id}`;
		const made = this.attempts.get(key) ?? 0;
		if (made >= MAX_ATTEMPTS) return undefined;
		this.attempts.set(key, made + 1);
		this.onNudge?.("S6", key);
		const named = `${active.id} (${shortTitle(active.title, 50)})`;
		if (made === 0) {
			return `On the task board this is ${named}. Write down what failed on it (\`task_update\` with a \`note\`), then split it into smaller tasks with \`task_plan\` (parent "${active.id}"), or, if you are stuck on something only the person can settle, park it with a gate: \`"gate": ["human:<what you need decided>"]\`.`;
		}
		return `${named} is still where the run is stuck. Note on it what you have tried and what failed, and either split it (\`task_plan\`, parent "${active.id}") or give it a \`human:\` gate saying what you need decided.`;
	}

	// -------------------------------------------------------------------------
	// Teams (phase 4)
	// -------------------------------------------------------------------------

	/** The conversation has a team: its tasks are on this board. */
	attachTeam(team: { idleReady: () => string | undefined }): void {
		this.team = team;
	}

	/** A teammate's run ended holding tasks; they are back on the board. */
	noteReleased(agentId: string, ids: readonly string[], reason: string): void {
		if (ids.length === 0) return;
		this.doneNotes.push(
			`[SYSTEM] ${agentId}'s run ended (${reason}) with ${ids.join(", ")} still open. ${ids.length === 1 ? "It is" : "They are"} back on the board, unheld: hand ${ids.length === 1 ? "it" : "them"} out again (team_run_task) or take ${ids.length === 1 ? "it" : "them"} yourself.`,
		);
		this.boardDue = true;
	}

	/** T1: a plan whose first layer has two or more tasks, with a team to run them. */
	private nudgeParallel(input: unknown): void {
		if (!this.team || this.planMode) return;
		const state = this.store.getState();
		// The lead's own active task counts: it is as free to hand out.
		const first = (taskLayers(state)[0] ?? []).filter(
			(task) =>
				!task.claimedBy && (isReady(state, task) || task.status === "active"),
		);
		if (first.length < 2) return;
		const ids = first.map((task) => task.id);
		this.nudge(
			"T1",
			`parallel:${ids.join(",")}`,
			() =>
				`[SYSTEM] ${ids.slice(0, -1).join(", ")} and ${ids.at(-1)} can run side by side: nothing orders them. Hand them to teammates (team_run_task, naming the task id in the message) rather than doing them one after another.`,
			input,
			true,
		);
	}

	/** T4: the lead waits on runs while ready tasks have nobody on them. */
	private nudgeIdleReady(input: unknown): void {
		const idle = this.team?.idleReady();
		if (!idle) return;
		this.nudge(
			"T4",
			`idle:${idle}`,
			() =>
				`[SYSTEM] While you wait, these tasks are ready and nobody holds them: ${idle}. Hand them to an idle teammate (team_run_task) or take one yourself.`,
			input,
			true,
		);
	}

	// -------------------------------------------------------------------------
	// Gates
	// -------------------------------------------------------------------------

	/**
	 * Timer and commit gates, checked before each request: a clock read and a
	 * `git merge-base`, only when such a gate is waiting. What opened is said
	 * with the next reminder.
	 */
	checkLocalGates(now = Date.now()): void {
		const waiting = this.store.closedGates();
		if (waiting.length === 0) return;
		const outcome = this.store.resolveGates((gate) => {
			const kind = parseGate(gate.spec)?.kind;
			if (kind === "timer") return decideTimerGate(gate, now);
			if (kind === "commit") return decideCommitGate(gate, this.cwd);
			return undefined;
		});
		this.sayGates(outcome.lines);
	}

	/** GitHub gates, checked when the board is looked at: a network call. */
	async checkRemoteGates(): Promise<string[]> {
		const waiting = this.store.closedGates().filter(({ gate }) => {
			const kind = parseGate(gate.spec)?.kind;
			return kind === "gh-pr" || kind === "gh-run";
		});
		if (waiting.length === 0) return [];
		const decided = new Map<string, GateDecision>();
		for (const { gate } of waiting) {
			if (!decided.has(gate.spec)) {
				decided.set(gate.spec, await decideGitHubGate(gate, this.cwd));
			}
		}
		return this.store.resolveGates((gate) => decided.get(gate.spec)).lines;
	}

	/**
	 * A teammate run or delegated agent ended: its `run:` gates open, or fail
	 * when it did not finish its work. Its claims end with it.
	 */
	noteRunEnded(ids: readonly string[], ok: boolean, reason?: string): void {
		const names = new Set(ids.filter(Boolean));
		if (names.size === 0) return;
		const outcome = this.store.resolveGates((gate) => {
			const parsed = parseGate(gate.spec);
			if (parsed?.kind !== "run" || !names.has(parsed.value)) return undefined;
			return ok ? { open: true } : { failed: reason ?? "the run failed" };
		});
		this.sayGates(outcome.lines);
	}

	/**
	 * A delegated agent's answer came back (`spawn_agent`, a configured
	 * `subagent_*` tool, `await_agents`): `run:` gates naming it open. A call
	 * that only started agents in the background opens nothing; their report,
	 * or `await_agents`, does.
	 */
	private noteDelegationResult(
		input: unknown,
		toolName: string | undefined,
		result: unknown,
	): void {
		if (!toolName) return;
		const delegation =
			toolName === "spawn_agent" ||
			toolName === "spawn_swarm" ||
			toolName === "await_agents" ||
			toolName.startsWith("subagent_");
		if (!delegation) return;
		let text = "";
		try {
			text = typeof result === "string" ? result : JSON.stringify(result);
		} catch {
			return;
		}
		if (/"background"\s*:\s*true/.test(text)) return;
		const names = new Set<string>();
		if (toolName.startsWith("subagent_")) names.add(toolName.slice(9));
		const read = (value: unknown): void => {
			if (!value || typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			for (const key of ["name", "agent", "round_id", "roundId", "id"]) {
				const field = record[key];
				if (typeof field === "string" && field.trim()) names.add(field.trim());
			}
		};
		read(input);
		const agents = (input as { agents?: unknown } | undefined)?.agents;
		if (Array.isArray(agents)) agents.forEach(read);
		this.noteRunEnded([...names], true);
	}

	/** A background command exited: its `command:` gates open, or fail on a nonzero exit. */
	noteCommandEnded(id: string, exitCode: number | undefined): void {
		const outcome = this.store.resolveGates((gate) => {
			const parsed = parseGate(gate.spec);
			if (parsed?.kind !== "command" || parsed.value !== id) return undefined;
			return exitCode === 0 || exitCode === undefined
				? { open: true }
				: { failed: `it exited with ${exitCode}` };
		});
		this.sayGates(outcome.lines);
	}

	/**
	 * The person answered a question: the `human:` gates it was about open,
	 * and the answer is noted on their tasks.
	 */
	noteHumanAnswer(question: string, answer: string): void {
		const answered = humanGatesAnswered(question, this.store.closedGates());
		if (answered.length === 0) return;
		const specs = new Set(answered.map(({ gate }) => gate.spec));
		const tasks = new Set(answered.map(({ task }) => task.id));
		const short = answer.replace(/\s+/g, " ").trim().slice(0, 200);
		this.store.update(
			{
				updates: [...tasks].map((id) => ({
					id,
					note: `the person answered: ${short}`,
				})),
			},
			{ by: "user" },
			{ silent: true },
		);
		const outcome = this.store.resolveGates(
			(gate, task) =>
				specs.has(gate.spec) && tasks.has(task.id) ? { open: true } : undefined,
			{ by: "user" },
		);
		this.sayGates(outcome.lines);
	}

	private sayGates(lines: readonly string[]): void {
		if (lines.length > 0) {
			this.doneNotes.push(`[SYSTEM] Task gates: ${lines.join(" ")}`);
		}
	}

	/**
	 * Bring the board in line with the history the session starts from (see
	 * `TaskGraphStore.reconcile`). A board that comes back non-empty is shown
	 * to the model with its next tool results (S7).
	 */
	start(
		history: readonly unknown[] | undefined,
		legacyChecklist?: { text: string; done: boolean }[],
		seed?: TaskGraphSeed,
	): ReturnType<TaskGraphStore["reconcile"]> {
		const result = this.store.reconcile(history, legacyChecklist, seed);
		if (!this.store.isEmpty() && (history?.length ?? 0) > 0) {
			this.boardDue = true;
		}
		// No board yet: say at the start of the first run, right after the
		// system prompt, that this conversation plans on a board. Every nudge
		// comes after a call, and a model that has the fix by its 4th call is
		// editing by then: on pandorum (gemma4-26b-agentic, 2026-11-21) 3 of 4
		// runs edited at call 4-5 and never planned, and the asks that came
		// with or after the edit were read as background.
		if (result === "empty") {
			this.userNotes.push(buildTaskGraphStartNote(this.planMode));
		}
		// A board the person brought in from Memory. The model has not seen it,
		// and no tool loads it: it is told at the start of the first run, right
		// after the system prompt, what the board is and where it came from.
		if (result === "seeded") {
			this.boardDue = false;
			const board = renderBoard(this.store.getState());
			this.userNotes.push(
				[
					`[SYSTEM] This conversation starts from a task board the person saved earlier${
						seed?.about ? ` (${seed.about})` : ""
					}. Its tasks keep their ids, notes and outcomes; the ones closed were closed in the conversation it came from. Work from it as from any board: start, update and close tasks as you go.`,
					board ? `The board, as it stands:\n${board}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		}
		return result;
	}

	/** The board as saved into a memory: its events, its text, and counts. */
	exportBoard(header: {
		title?: string;
		sessionId: string;
	}): ExportedTaskBoard {
		return exportTaskEvents(this.store.getEvents(), header);
	}

	/** A compaction landed: the calls that built the board are gone (S7). */
	noteCompaction(): void {
		if (!this.store.isEmpty()) this.boardDue = true;
	}

	private activeTask(): Task | undefined {
		const state = this.store.getState();
		return state.order
			.map((id) => state.tasks.get(id) as Task)
			.find((task) => task.status === "active");
	}

	/**
	 * Queue a nudge if its situation has attempts left and the spacing allows.
	 * Returns whether it was queued.
	 */
	private nudge(
		id: string,
		key: string,
		text: (attempt: 1 | 2) => string,
		input: unknown,
		/** Said now, whatever the spacing: a moment that will not come again. */
		urgent = false,
	): boolean {
		const made = this.attempts.get(key) ?? 0;
		if (made >= MAX_ATTEMPTS) return false;
		if (this.queued?.key === key) {
			this.queued.from.add(input);
			return true;
		}
		if (!urgent && this.callsSinceNudge < this.spacing) return false;
		// A more specific nudge for the same call replaces a waiting one; the
		// replaced one keeps its attempt, since it was never read.
		if (this.queued) {
			this.attempts.set(
				this.queued.key,
				(this.attempts.get(this.queued.key) ?? 1) - 1,
			);
		}
		const attempt = (made + 1) as 1 | 2;
		this.attempts.set(key, attempt);
		this.queued = { id, key, text: text(attempt), from: new Set([input]) };
		this.callsSinceNudge = 0;
		this.onNudge?.(id, key);
		return true;
	}

	/** Record one call, before it runs. */
	recordToolCall(input: unknown, toolName?: string): void {
		this.calls += 1;
		this.callsSinceNudge += 1;
		if (toolName && TASK_GRAPH_TOOL_NAMES.has(toolName)) {
			return;
		}
		const queued = this.queued;
		this.nudgeForCall(input, toolName);
		if (this.planMode) return;
		this.advanceDrift(
			input,
			toolName,
			changesFiles(toolName, input),
			this.queued !== queued,
		);
	}

	/**
	 * S5: the plan may have gone stale while the work moved on: a check
	 * failing after changes, or a long stretch of calls, under an active task
	 * nobody touched. Pandorum 2026-11-21 (ek3es, gemma4-26b-agentic): T1
	 * "Rewrite Level class" stayed active while the check failed with a new
	 * ReferenceError and the model read and searched for six calls; S3 counts
	 * changes and S4 passing checks, so the board went quiet.
	 */
	private advanceDrift(
		input: unknown,
		toolName: string | undefined,
		writes: boolean,
		nudgedNow: boolean,
	): void {
		const active = this.activeTask();
		if (!active) {
			this.drift = undefined;
			return;
		}
		if (
			!this.drift ||
			this.drift.id !== active.id ||
			this.drift.seq !== active.touchedSeq
		) {
			this.drift = {
				id: active.id,
				seq: active.touchedSeq,
				calls: 0,
				writes: 0,
			};
		}
		const drift = this.drift;
		drift.calls += 1;
		if (writes) drift.writes += 1;
		if (nudgedNow) return;
		// A command run about to report decides for itself: its result
		// replaces the failure an earlier run left.
		const failed =
			drift.failure !== undefined &&
			drift.writes > 0 &&
			toolName !== "run_commands";
		if (!failed && drift.calls < DRIFT_CALLS) return;
		const calls = drift.calls;
		const failure = failed ? drift.failure : undefined;
		const made = this.nudge(
			"S5",
			`drift:${active.id}:${active.touchedSeq}`,
			(attempt) => buildTaskGraphDriftNudge(active, calls, failure, attempt),
			input,
		);
		if (made && this.queued?.id === "S5") {
			drift.calls = 0;
			drift.failure = undefined;
		}
	}

	private nudgeForCall(input: unknown, toolName: string | undefined): void {
		const snapshot = this.store.snapshot();
		const writes = changesFiles(toolName, input);
		if (!writes) {
			// S1 by call count: planning is cheapest before the first change.
			// Not in plan mode, where looking is the work: asked at call 4 there,
			// the model wrote the plan from a guess while its own reasoning was
			// still unsure of the cause (sgwez, 2026-11-21). The completion
			// guard asks for it there, as the run is about to end.
			if (
				!this.planMode &&
				snapshot.counts.total === 0 &&
				this.calls >= PLAN_BY_CALL
			) {
				this.nudge(
					"S1",
					"plan",
					(attempt) =>
						attempt === 1 || this.planMode
							? buildTaskGraphPlanFirstNudge(this.calls, this.planMode)
							: buildTaskGraphUntrackedNudge("missing", undefined, [], 2),
					input,
				);
			}
			return;
		}
		// Plan mode changes nothing, so nothing here is work to track (a write
		// tried there is refused by the mode).
		if (this.planMode) return;
		const path = readEditedPath(input);
		const firstChange = this.changes === 0;
		this.changes += 1;
		const active = this.activeTask();
		if (active) {
			// S3: count changes under the active task since it was last touched.
			if (
				!this.staleFor ||
				this.staleFor.id !== active.id ||
				this.staleFor.seq !== active.touchedSeq
			) {
				this.staleFor = {
					id: active.id,
					seq: active.touchedSeq,
					writes: 0,
					files: [],
				};
			}
			this.staleFor.writes += 1;
			if (path && !this.staleFor.files.includes(path))
				this.staleFor.files.push(path);
			if (this.staleFor.writes >= STALE_WRITES) {
				const files = [...this.staleFor.files];
				this.nudge(
					"S3",
					`stale:${active.id}:${active.touchedSeq}`,
					(attempt) => buildTaskGraphStaleNudge(active, files, attempt),
					input,
				);
			}
			return;
		}
		const state = this.store.getState();
		if (snapshot.counts.total === 0) {
			// The first change with no plan is the moment a plan is for; the
			// spacing held it back when the call-count ask had just gone out
			// (pandorum 2026-11-21, gemma4-26b: asked at call 4, edited at
			// call 5, and nothing said again for the rest of the fix).
			this.nudge(
				"S1",
				"plan",
				(attempt) => buildTaskGraphUntrackedNudge("missing", path, [], attempt),
				input,
				firstChange,
			);
			return;
		}
		const ready = snapshot.tasks
			.filter((task) => task.ready)
			.map((task) => state.tasks.get(task.id) as Task);
		const finished = snapshot.counts.closed === snapshot.counts.total;
		const kind: UntrackedKind = finished ? "finished" : "idle";
		this.nudge(
			"S2",
			finished
				? `finished:${snapshot.counts.total}`
				: `idle:${ready.map((task) => task.id).join(",")}`,
			(attempt) => buildTaskGraphUntrackedNudge(kind, path, ready, attempt),
			input,
		);
	}

	/** Record a call's result: S4 on a passing check, and failed writes taken back. */
	recordToolResult(
		input: unknown,
		toolName: string | undefined,
		result: unknown,
		closedATask = false,
	): void {
		if (toolName === "run_commands" && this.drift) {
			// The latest run decides: a later clean run clears an earlier failure.
			this.drift.failure = readCommandFailure(toolName, result);
		}
		if (reportsFailure(result)) {
			if (this.drift && changesFiles(toolName, input) && this.drift.writes > 0)
				this.drift.writes -= 1;
			this.retractFailedWrite(input, toolName);
			return;
		}
		this.noteDelegationResult(input, toolName, result);
		if (toolName === "task_plan") this.nudgeParallel(input);
		if (toolName === "team_await_runs") this.nudgeIdleReady(input);
		if (toolName === "ask_question" && typeof result === "string") {
			const question =
				typeof input === "object" && input !== null
					? (input as { question?: unknown }).question
					: undefined;
			if (typeof question === "string" && result.trim()) {
				this.noteHumanAnswer(question, result);
			}
		}
		// The call said which task it finished; a check passing on it is that.
		if (closedATask || this.planMode) return;
		const command = readCheckCommand(toolName, input);
		if (!command || !reportsSuccess(result)) return;
		const active = this.activeTask();
		if (!active) return;
		this.nudge(
			"S4",
			`verified:${active.id}:${active.touchedSeq}`,
			() => buildTaskGraphVerifiedNudge(active, command),
			input,
		);
	}

	/**
	 * A working call carried `task_done`. Closed only when the call worked;
	 * either way the model is told, with the next reminder.
	 */
	recordTaskDone(
		value: unknown,
		toolName: string,
		result: unknown,
		call?: string,
		author = "model",
	): void {
		if (reportsFailure(result)) {
			const named = readTaskDone(value)
				.map((entry) => entry.id || entry.raw)
				.join(", ");
			this.doneNotes.push(
				`[SYSTEM] ${named || "The task"} was not marked done: the \`${toolName}\` call that named it failed. Send \`task_done\` again on the call that works.`,
			);
			return;
		}
		const outcome = this.store.finish(value, {
			by: author,
			...(call ? { call } : {}),
		});
		if (outcome.lines.length > 0) {
			this.doneNotes.push(`[SYSTEM] task_done: ${outcome.lines.join(" ")}`);
		}
	}

	/** A call outside the graph finished: what a close right after it could have ridden on. */
	noteWorkingCall(
		toolName: string,
		result: unknown,
		carriedDone: boolean,
	): void {
		this.lastWork = {
			tool: toolName,
			succeeded: !reportsFailure(result),
			carriedDone,
		};
	}

	/** Ids done now, to compare across a graph call. */
	doneIds(): Set<string> {
		const state = this.store.getState();
		return new Set(
			state.order.filter((id) => state.tasks.get(id)?.status === "done"),
		);
	}

	/**
	 * A graph call closed tasks right after a working call that could have
	 * carried `task_done`: say so once, with the reply already going out.
	 * In tg-bench arm C3 (2026-11-21) 3 of 5 textkit runs alternated an edit
	 * and a `task_update` close and never used `task_done`; each close was a
	 * request of its own.
	 */
	noteGraphCall(doneBefore: Set<string>): void {
		if (this.taskDoneHintGiven) return;
		const work = this.lastWork;
		if (!work?.succeeded || work.carriedDone) return;
		if (!TASK_DONE_TOOL_NAMES.has(work.tool)) return;
		const closed = [...this.doneIds()].filter((id) => !doneBefore.has(id));
		if (closed.length === 0) return;
		this.taskDoneHintGiven = true;
		this.onNudge?.("S9", "task-done-hint");
		const ids = closed.join(", ");
		this.doneNotes.push(
			`[SYSTEM] ${ids} took a request of its own to close. Next time, put \`task_done\` (as "${closed[0]}: what was done") on the \`${work.tool}\` call that finishes the work: the task closes when that call succeeds, with no extra request.`,
		);
	}

	/** Take back what a call that then failed was counted for. */
	retractFailedWrite(input: unknown, toolName?: string): void {
		if (!changesFiles(toolName, input)) return;
		if (this.staleFor && this.staleFor.writes > 0) this.staleFor.writes -= 1;
		const queued = this.queued;
		if (queued?.from.delete(input) && queued.from.size === 0) {
			this.attempts.set(queued.key, (this.attempts.get(queued.key) ?? 1) - 1);
			this.queued = undefined;
			this.callsSinceNudge = Number.POSITIVE_INFINITY;
		}
	}

	/**
	 * A change the person made from the task panel: applied as theirs
	 * (`by: "user"`) and told to the model, with the next tool results when a
	 * run is under way, or at the start of the next run when it is not. The
	 * model does not have to ask; it is told what changed and by whom.
	 */
	edit(action: TaskGraphEdit): TaskGraphEditOutcome {
		const origin = { by: "user" };
		let outcome: { lines: string[]; changed: boolean };
		if (action.op === "update") {
			outcome = this.store.update({ updates: action.updates }, origin);
		} else if (action.op === "plan") {
			outcome = this.store.plan({ tasks: action.tasks }, origin);
		} else {
			return {
				lines: [`Unknown change: ${String((action as { op?: unknown }).op)}.`],
				changed: false,
			};
		}
		if (outcome.changed) {
			this.userNotes.push(
				`[SYSTEM] The person changed the task board: ${outcome.lines.join(" ")}`,
			);
		}
		return { lines: outcome.lines, changed: outcome.changed };
	}

	/** The person's changes not yet told, for the start of a run; cleared by the read. */
	takeRunStartNote(): string | undefined {
		this.checkLocalGates();
		const notes = [...this.userNotes, ...this.doneNotes];
		this.userNotes = [];
		this.doneNotes = [];
		if (notes.length === 0) return undefined;
		return notes.join("\n\n");
	}

	/** What to say after the turn's tool calls, cleared by the read. */
	takePendingReminder(): string | undefined {
		this.checkLocalGates();
		const parts: string[] = [...this.userNotes, ...this.doneNotes];
		this.userNotes = [];
		this.doneNotes = [];
		if (this.queued) parts.push(this.queued.text);
		if (this.boardDue) {
			const board = renderBoard(this.store.getState());
			if (board) parts.push(`[SYSTEM] The task board, as it stands:\n${board}`);
		}
		this.queued = undefined;
		this.boardDue = false;
		return parts.length ? parts.join("\n\n") : undefined;
	}

	/** S8, the completion guard: at most two different asks per session. */
	completionGuard(): () => string | undefined {
		return () => {
			// Plan mode ends on the plan, its tasks open: they are act mode's to
			// do. Asking to close them there read as "do it now", and the model
			// switched to act mode on its own (ojbur, 2026-11-21).
			if (this.planMode) {
				// Once, and only for a run that looked at something and is
				// ending with an empty board: the plan belongs there.
				if (this.planAskedAtEnd || this.calls < PLAN_BY_CALL) return undefined;
				if (this.store.snapshot().counts.total > 0) return undefined;
				this.planAskedAtEnd = true;
				this.onNudge?.("S1", "plan-at-end");
				return buildTaskGraphPlanAtEndNudge();
			}
			if (this.closeOutFired >= CLOSE_OUT_ATTEMPTS) return undefined;
			const open = openWork(this.store.getState());
			if (open.length === 0) return undefined;
			this.closeOutFired += 1;
			this.onNudge?.("S8", `close-out:${this.closeOutFired}`);
			return buildTaskGraphCloseOutNudge(
				open,
				this.closeOutFired === 1 ? 1 : 2,
			);
		};
	}
}

export function isTaskGraphWrapped(tool: object): boolean {
	return (tool as Record<symbol, unknown>)[TASK_GRAPH_WRAPPED] === true;
}

/**
 * Wrap a tool so its calls feed the tracker. The schema is left alone: the
 * graph adds nothing to any tool, which is the point of replacing the
 * checklist parameter.
 */
export function withTaskGraphCapture<TInput, TOutput>(
	tool: AgentTool<TInput, TOutput>,
	tracker: TaskGraphTracker,
): AgentTool<TInput, TOutput> {
	if (isTaskGraphWrapped(tool)) return tool;
	const carries = TASK_DONE_TOOL_NAMES.has(tool.name);
	const wrapped: AgentTool<TInput, TOutput> = {
		...tool,
		...(carries
			? {
					inputSchema: withTaskDoneParam(
						tool.inputSchema,
					) as typeof tool.inputSchema,
				}
			: {}),
		execute: async (input, context) => {
			// Read before the tool runs: its own validation strips keys its
			// schema does not name.
			const done =
				carries && input && typeof input === "object"
					? (input as Record<string, unknown>)[TASK_DONE_PARAM]
					: undefined;
			tracker.recordToolCall(input, tool.name);
			const graphCall = TASK_GRAPH_TOOL_NAMES.has(tool.name);
			const doneBefore = graphCall ? tracker.doneIds() : undefined;
			let result: TOutput;
			try {
				result = await tool.execute(input, context);
			} catch (error) {
				if (!graphCall)
					tracker.noteWorkingCall(tool.name, { success: false }, false);
				tracker.retractFailedWrite(input, tool.name);
				if (done !== undefined) {
					tracker.recordTaskDone(done, tool.name, { success: false });
				}
				throw error;
			}
			if (done !== undefined) {
				// Closed first, so S4 below sees the board as it now is and
				// does not ask to close what this call just closed.
				tracker.recordTaskDone(done, tool.name, result, context?.toolCallId);
			}
			tracker.recordToolResult(input, tool.name, result, done !== undefined);
			if (doneBefore) tracker.noteGraphCall(doneBefore);
			else tracker.noteWorkingCall(tool.name, result, done !== undefined);
			return result;
		},
	};
	Object.defineProperty(wrapped, TASK_GRAPH_WRAPPED, {
		value: true,
		enumerable: false,
	});
	return wrapped;
}
