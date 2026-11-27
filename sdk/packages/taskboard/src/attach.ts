/**
 * One call that gives an agent loop the task board and pipelines: what
 * `@cline/core`'s session host does for its own sessions, for an application
 * that runs its own loop.
 *
 * The board is not only three tools. It watches every tool call (an edit
 * under no task, a task left untouched while files change), speaks between
 * turns (a gate opened, a teammate's task closed, the person edited the
 * board), and has a say before the run ends (open tasks). Each of those is a
 * point in the host's loop, so `attachTaskBoard` returns them as functions
 * for the host to call at that point, rather than owning the loop:
 *
 *   const board = attachTaskBoard({ sessionId, workspaceRoot, logPath, history })
 *   systemPrompt = board.systemPrompt(systemPrompt)
 *   tools = [...myTools, ...board.tools()].map(board.wrapTool)
 *   board.setTools(() => tools)          // what pipeline `tool` steps may call
 *   // before each run: board.runStartNote()   -> extra context for the model
 *   // after each turn's tools: board.afterToolsReminder() -> a message, if any
 *   // before the run ends: board.completionGuard() -> a reason to go on, if any
 *
 * @cline/core builds its sessions through this too, so an application gets the
 * same behaviour, not a copy of it.
 */

import type {
	AgentTool,
	ToolApprovalRequest,
	ToolApprovalResult,
	ToolPolicy,
} from "@cline/shared";
import type { PipelineRun } from "./pipelines/runner";
import { PipelineSession } from "./pipelines/session";
import { createPipelineTool, withPipelineRules } from "./pipelines/tool";
import { renderBoardListing, renderMermaid } from "./task-graph/board";
import type {
	TaskGraphSeed,
	TaskGraphSnapshot,
	TaskGraphStore,
} from "./task-graph/store";
import { createGraphTeamBoard } from "./task-graph/team-board";
import type { TeamTaskBoard } from "./task-graph/team-types";
import { taskTemplateDirs } from "./task-graph/templates";
import {
	type TaskGraphEdit,
	type TaskGraphEditOutcome,
	TaskGraphTracker,
	withTaskBoardRules,
	withTaskGraphCapture,
} from "./task-graph/tracker";

export interface AttachTaskBoardOptions {
	/** The conversation: names the board's runs and the panel's handle. */
	sessionId: string;
	/**
	 * The project: where pipelines live (`.cerebriline/pipelines/`) and the
	 * workspace's saved plans. Without it there are no pipelines.
	 */
	workspaceRoot?: string;
	/** Where `commit:` and GitHub gates are checked. Default `workspaceRoot`. */
	cwd?: string;
	/**
	 * Where the board's events are appended (one JSON line each), so a
	 * reopened conversation shows its board again. Without it the board lives
	 * in memory and is rebuilt from `history` alone.
	 */
	logPath?: string;
	/** The conversation so far: the board is replayed from its tool calls. */
	history?: readonly unknown[];
	/** A board to start from: the person's draft, a copied board. */
	seed?: TaskGraphSeed;
	/** An older checklist (`task_progress`) to import when there is no board. */
	legacyChecklist?: { text: string; done: boolean }[];
	/** Plan mode: the plan goes on the board and nothing is started or closed. */
	planMode?: boolean;
	/** Saved-plan folders. Default: the workspace's, then the user's. */
	templateDirs?: string[];
	/** Tool calls between two of the board's nudges. Default 3. */
	writeInterval?: number;
	/** The tools that change files. Default `DEFAULT_WRITE_TOOL_NAMES`. */
	writeToolNames?: ReadonlySet<string>;
	/** After every change to the board, for a panel. */
	onChange?: (snapshot: TaskGraphSnapshot) => void;
	/** One line per event worth a log: a nudge, a forced claim, a pipeline step. */
	log?: (line: string) => void;
	/**
	 * A team runtime: its `team_task` reads and writes this board, so a task a
	 * teammate claims is a `T<n>` the lead sees. Only if it can take a board.
	 */
	team?: { useTaskBoard?: (board: TeamTaskBoard) => void };
	/** Pipelines, off unless given (they run commands and tools). */
	pipelines?: {
		/** The session's tools, read when a step runs: what `tool` steps may call. */
		tools?: () => readonly AgentTool[];
		toolPolicies?: Record<string, ToolPolicy>;
		/** How a step's tool call or web request asks the person. */
		requestApproval?: (
			request: ToolApprovalRequest,
		) => ToolApprovalResult | Promise<ToolApprovalResult>;
		env?: Record<string, string>;
		pollMs?: number;
		/** The tool a configured agent is offered as. Default `subagent_<name>`. */
		agentToolName?: (agent: string) => string;
		/** How the person approves a pipeline in this application, for the model. */
		approveHow?: (slug: string) => string;
		/** A run started, changed or ended, for a panel. */
		onRunChange?: (run: PipelineRun) => void;
	};
}

/** What the person's panel can do to the board (Start, Done, Delete, saved plans). */
export interface TaskBoardControl {
	sessionId: string;
	edit(action: TaskGraphEdit): TaskGraphEditOutcome;
	snapshot(): TaskGraphSnapshot;
	exportBoard(header: { title?: string }): {
		events: unknown[];
		text: string;
		tasks: number;
		open: number;
	};
	templates(): {
		name: string;
		description?: string;
		vars: string[];
		tasks: number;
		source: string;
	}[];
	useTemplate(
		name: string,
		vars?: Record<string, string>,
	): TaskGraphEditOutcome;
	saveTemplate(
		name: string,
		description?: string,
		where?: "workspace" | "user",
	): string | undefined;
	mermaid(): string;
	render(): string;
}

/** What the person can do to a pipeline run (Retry, Skip, Re-run from here, Stop). */
export interface PipelineRunControl {
	sessionId: string;
	act(action: {
		op: "retry" | "skip" | "rerun" | "stop";
		run: string;
		node?: string;
	}): { ok: boolean; lines: string[]; run?: string };
}

export interface AttachedTaskBoard {
	readonly tracker: TaskGraphTracker;
	readonly store: TaskGraphStore;
	/** The pipeline runs, when pipelines are on and there is a workspace. */
	readonly pipelines: PipelineSession | undefined;
	/** How the board came back: `replayed`, `imported`, `seeded`, `fresh`, ... */
	readonly started: string;
	/** The board's rules (and the pipelines'), added to a system prompt once. */
	systemPrompt(base: string | undefined): string | undefined;
	/** `task_plan`, `task_update`, `task_view`, and `pipeline` when on. */
	tools(): AgentTool[];
	/** Every tool the model can call goes through this: the board watches calls. */
	wrapTool<TInput, TOutput>(
		tool: AgentTool<TInput, TOutput>,
	): AgentTool<TInput, TOutput>;
	/** The session's final tool list, for pipeline `tool` steps. */
	setTools(tools: () => readonly AgentTool[]): void;
	/** Before a run: what changed since the model last looked (the person's edits). */
	runStartNote(): string | undefined;
	/** After a turn's tools: a reminder or news to add as a message. */
	afterToolsReminder(): string | undefined;
	/** Before the run ends: a reason to go on (open tasks), or undefined to end. */
	completionGuard(): () => string | undefined;
	/** The host saw the model going in circles: the board's advice, if any. */
	noteStruggle(): string | undefined;
	/** The conversation was compacted: show the board again next turn. */
	noteCompaction(): void;
	/** Pick up this conversation's runs interrupted by a restart. */
	recoverInterruptedRuns(): void;
	/** For the person's panel. */
	readonly control: TaskBoardControl;
	/** For the person's run actions, when there are pipelines. */
	readonly pipelineControl: PipelineRunControl | undefined;
}

export function attachTaskBoard(
	options: AttachTaskBoardOptions,
): AttachedTaskBoard {
	const { sessionId } = options;
	const cwd = options.cwd ?? options.workspaceRoot;
	const tracker = new TaskGraphTracker({
		...(options.logPath ? { logPath: options.logPath } : {}),
		planMode: options.planMode === true,
		...(cwd ? { cwd } : {}),
		templateDirs:
			options.templateDirs ?? taskTemplateDirs(options.workspaceRoot),
		...(options.writeInterval !== undefined
			? { writeInterval: options.writeInterval }
			: {}),
		...(options.writeToolNames
			? { writeToolNames: options.writeToolNames }
			: {}),
		onForcedClaim: (id, from, to) =>
			options.log?.(`[task-graph] ${to} took ${id} over from ${from} (forced)`),
		onNudge: (id, key) => options.log?.(`[task-graph] nudge ${id} (${key})`),
		...(options.onChange
			? { onChange: (store) => options.onChange?.(store.snapshot()) }
			: {}),
	});
	const started = String(
		tracker.start(options.history, options.legacyChecklist, options.seed),
	);

	// The team's tasks are the board's. Checked, not assumed: a host may bring
	// a team runtime that keeps its own list.
	const useTaskBoard = options.team?.useTaskBoard;
	const team = typeof useTaskBoard === "function";
	if (team) {
		const board = createGraphTeamBoard(tracker.store, {
			onNudge: (id, key) => options.log?.(`[task-graph] nudge ${id} (${key})`),
			onReleased: (agentId, ids, reason) =>
				tracker.noteReleased(agentId, ids, reason),
			onDispatched: (agentId, taskId, runId) =>
				tracker.noteDispatched(agentId, taskId, runId),
			onDispatchClosed: (agentId, task) =>
				tracker.noteDispatchClosed(agentId, task),
			onDispatchRefused: (agentId, taskId, reason) =>
				tracker.noteDispatchRefused(agentId, taskId, reason),
		});
		useTaskBoard.call(options.team, board);
		tracker.attachTeam(board);
	}

	// Pipelines: not in plan mode, where nothing may write or run.
	let sessionTools: () => readonly AgentTool[] =
		options.pipelines?.tools ?? (() => []);
	const pipelineOptions = options.pipelines;
	const pipelines =
		pipelineOptions && options.workspaceRoot && options.planMode !== true
			? new PipelineSession({
					workspaceRoot: options.workspaceRoot,
					sessionId,
					board: tracker.store,
					tools: () => sessionTools(),
					...(pipelineOptions.toolPolicies
						? { toolPolicies: pipelineOptions.toolPolicies }
						: {}),
					...(pipelineOptions.requestApproval
						? { requestApproval: pipelineOptions.requestApproval }
						: {}),
					...(pipelineOptions.env ? { env: pipelineOptions.env } : {}),
					...(pipelineOptions.pollMs !== undefined
						? { pollMs: pipelineOptions.pollMs }
						: {}),
					...(options.log ? { log: options.log } : {}),
					...(pipelineOptions.agentToolName
						? { agentToolName: pipelineOptions.agentToolName }
						: {}),
					...(pipelineOptions.approveHow
						? { approveHow: pipelineOptions.approveHow }
						: {}),
					...(pipelineOptions.onRunChange
						? { onRunChange: pipelineOptions.onRunChange }
						: {}),
					onRunEnded: (_run, lines) => {
						if (lines.length > 0) tracker.notePipelineEnded(lines);
					},
				})
			: undefined;
	const workspaceRoot = options.workspaceRoot;

	const control: TaskBoardControl = {
		sessionId,
		edit: (action) => tracker.edit(action),
		snapshot: () => tracker.store.snapshot(),
		exportBoard: (header) => tracker.exportBoard({ ...header, sessionId }),
		templates: () =>
			tracker.templates().map((template) => ({
				name: template.name,
				...(template.description ? { description: template.description } : {}),
				vars: template.vars,
				tasks: template.tasks.length,
				source: template.source,
			})),
		useTemplate: (name, vars) => tracker.useTemplate(name, vars),
		saveTemplate: (name, description, where) =>
			tracker.saveTemplate(name, description, where),
		mermaid: () => renderMermaid(tracker.store.getState()),
		render: () => renderBoardListing(tracker.store.getState()),
	};

	const pipelineControl: PipelineRunControl | undefined = pipelines
		? {
				sessionId,
				act: (action) => {
					const outcome = pipelines.act(action);
					if (outcome.tell) tracker.notePipelineNews([outcome.tell]);
					return {
						ok: outcome.ok,
						lines: outcome.lines,
						...(outcome.run ? { run: outcome.run } : {}),
					};
				},
			}
		: undefined;

	return {
		tracker,
		store: tracker.store,
		pipelines,
		started,
		systemPrompt: (base) => {
			const withBoard =
				withTaskBoardRules(base, options.planMode === true, team) ?? base;
			return pipelines
				? (withPipelineRules(withBoard) ?? withBoard)
				: withBoard;
		},
		tools: () => [
			...tracker.tools(),
			...(pipelines && workspaceRoot
				? [createPipelineTool(pipelines, workspaceRoot) as AgentTool]
				: []),
		],
		wrapTool: (tool) => withTaskGraphCapture(tool, tracker),
		setTools: (tools) => {
			sessionTools = tools;
		},
		runStartNote: () => tracker.takeRunStartNote(),
		afterToolsReminder: () => tracker.takePendingReminder(),
		completionGuard: () => tracker.completionGuard(),
		noteStruggle: () => tracker.noteStruggle(),
		noteCompaction: () => tracker.noteCompaction(),
		recoverInterruptedRuns: () => {
			if (!pipelines) return;
			const lines = pipelines.recoverInterrupted();
			if (lines.length > 0) tracker.notePipelineNews(lines);
		},
		control,
		pipelineControl,
	};
}
