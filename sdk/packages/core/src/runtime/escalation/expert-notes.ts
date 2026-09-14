/**
 * What the base model is told about the expert while the expert is working.
 *
 * The base model is live for the whole escalation now, standing down from
 * edits and watching. Watching costs it a turn every time it is woken, and on
 * a 9B base against an expert that makes a hundred tool calls that is the
 * whole task budget spent on narration. So notes are collected continuously
 * and handed over in batches.
 *
 * THE CLOCK RUNS FROM THE HAND-OVER, NOT FROM THE NOTE. The base is woken at
 * most once per interval, and the interval starts when it last took a batch --
 * so a base that spends four minutes reviewing does not come back to eight
 * batches queued behind it. It comes back to one, holding everything that
 * happened while it was away (user, 2026-09-14: "if it's not done with the
 * previous review gets the next batch when it ends or more than one together
 * or the remaining plus the notification the expert is done").
 *
 * THREE THINGS JUMP THE CLOCK, because waiting on them is worse than the turn
 * they cost: the expert speaking (it may be asking a question), a guard
 * tripping (the expert may be going in circles), and the task reaching a state
 * that is not `working` -- `input-required` owes an answer, and a terminal
 * state means there is nothing left to wait for.
 *
 * THINKING IS NOT A NOTE, and there is deliberately no method that takes it.
 * The expert's reasoning runs to tens of thousands of characters per turn and
 * the base model is the smaller of the two; handing it that is how the
 * supervision budget gets spent on text the base cannot use. Tool calls and
 * messages are what it needs to follow the work.
 *
 * EVERY CHANGED FILE CARRIES THE REVISION IT CAN BE READ AT. A batch describes
 * what happened up to a moment that has already passed -- by the time the base
 * reads "the expert edited manic_miner.html" the expert has edited it twice
 * more, and a base that opens the file on disk is checking a claim against
 * evidence that has moved. The revision number is the fixed point: it names
 * the exact bytes the note is about, and `read_files` with `revision` serves
 * them. That is what makes "I fixed function A and the linter is quiet" a
 * testable statement rather than a claim about a file that no longer exists.
 */

import type { AgentToolDefinition } from "@cline/shared";
import {
	dataPart,
	isTerminal,
	type Part,
	type TaskState,
	textPart,
} from "./a2a";

/** A file the expert wrote, and the revision holding what it wrote. */
export interface ExpertFileTouch {
	path: string;
	/** Its index in the expert's revision log, for `read_files`. */
	revision: number;
}

export interface ExpertNote {
	kind: "tool" | "message" | "guard";
	/** The tool's name, for `kind: "tool"`. */
	tool?: string;
	/** What was said, for `kind: "message"` and `kind: "guard"`. */
	text?: string;
	/** How many identical calls this line stands for. Always at least 1. */
	count: number;
	files: ExpertFileTouch[];
	/** The tool's own failure, where it had one. */
	error?: string;
}

export interface ExpertNoteBatch {
	state: TaskState;
	/** The task has ended: this is the last batch there will be. */
	final: boolean;
	notes: ExpertNote[];
	/** The batch as the base model and the panel each need it. */
	parts: Part[];
}

export interface ExpertNotesOptions {
	/** How long the base is left alone between batches. */
	intervalMs?: number;
	now?: () => number;
}

export interface ExpertNotes {
	noteTool(input: {
		tool: string;
		files?: readonly ExpertFileTouch[];
		error?: string;
	}): void;
	noteMessage(text: string): void;
	noteGuard(text: string): void;
	setState(state: TaskState): void;
	readonly state: TaskState;
	/** Notes waiting to be handed over. */
	readonly pending: number;
	/** Whether the base should be woken now. */
	due(): boolean;
	/** Everything waiting, cleared. Nothing when the base should be left alone. */
	take(): ExpertNoteBatch | undefined;
}

export const DEFAULT_NOTE_INTERVAL_MS = 30_000;

/** States that are worth waking the base for the moment they are reached. */
function statePressing(state: TaskState): boolean {
	return state !== "working" && state !== "submitted";
}

function describeTool(note: ExpertNote): string {
	const times = note.count > 1 ? ` — ${note.count} calls` : "";
	const files = note.files.length
		? ` — ${note.files.map((file) => `${file.path} (#${file.revision})`).join(", ")}`
		: "";
	const failed = note.error ? ` — failed: ${note.error}` : "";
	return `${note.tool ?? "a tool"}${times}${files}${failed}`;
}

function describe(note: ExpertNote): string {
	if (note.kind === "tool") {
		return describeTool(note);
	}
	if (note.kind === "guard") {
		return `[guard] ${note.text ?? ""}`.trimEnd();
	}
	return `The expert said: ${note.text ?? ""}`.trimEnd();
}

export function createExpertNotes(
	options: ExpertNotesOptions = {},
): ExpertNotes {
	const intervalMs = options.intervalMs ?? DEFAULT_NOTE_INTERVAL_MS;
	const now = options.now ?? (() => Date.now());

	const waiting: ExpertNote[] = [];
	let state: TaskState = "submitted";
	let lastHandOver = now();
	/** Set when the terminal state has been handed over, so it is said once. */
	let finalHandedOver = false;
	/** Set when a state worth waking for has not yet been handed over. */
	let statePending = false;

	/**
	 * Adjacent calls of the same tool become one line with a count.
	 *
	 * Only when neither carries a file or an error: two `editor` calls that
	 * wrote different revisions are two different things to check, and
	 * collapsing them would lose exactly the addresses the base needs. A run of
	 * `read_files` is one thing -- the expert is reading -- and four lines
	 * saying so is four lines the base pays for.
	 */
	const coalesces = (note: ExpertNote, tool: string, hasDetail: boolean) =>
		note.kind === "tool" &&
		note.tool === tool &&
		!hasDetail &&
		note.files.length === 0 &&
		note.error === undefined;

	const pressing = () =>
		statePending ||
		waiting.some((note) => note.kind === "message" || note.kind === "guard");

	return {
		noteTool(input) {
			const files = [...(input.files ?? [])];
			const hasDetail = files.length > 0 || input.error !== undefined;
			const last = waiting[waiting.length - 1];
			if (last && coalesces(last, input.tool, hasDetail)) {
				last.count += 1;
				return;
			}
			waiting.push({
				kind: "tool",
				tool: input.tool,
				count: 1,
				files,
				...(input.error !== undefined ? { error: input.error } : {}),
			});
		},
		noteMessage(text) {
			const said = text.trim();
			if (said) {
				waiting.push({ kind: "message", text: said, count: 1, files: [] });
			}
		},
		noteGuard(text) {
			const said = text.trim();
			if (said) {
				waiting.push({ kind: "guard", text: said, count: 1, files: [] });
			}
		},
		setState(next) {
			if (next === state) {
				return;
			}
			state = next;
			if (statePressing(next)) {
				statePending = true;
			}
		},
		get state() {
			return state;
		},
		get pending() {
			return waiting.length;
		},
		due() {
			if (finalHandedOver) {
				return false;
			}
			if (pressing()) {
				return true;
			}
			if (waiting.length === 0) {
				return false;
			}
			return now() - lastHandOver >= intervalMs;
		},
		take() {
			if (!this.due()) {
				return undefined;
			}
			const notes = waiting.splice(0, waiting.length);
			lastHandOver = now();
			statePending = false;
			const final = isTerminal(state);
			if (final) {
				finalHandedOver = true;
			}
			const lines = notes.map(describe);
			const parts: Part[] = [
				textPart(
					lines.length ? lines.join("\n") : `The expert's task is ${state}.`,
				),
				dataPart({
					state,
					final,
					notes: notes.map((note) => ({
						kind: note.kind,
						...(note.tool ? { tool: note.tool } : {}),
						...(note.text ? { text: note.text } : {}),
						count: note.count,
						...(note.files.length ? { files: note.files } : {}),
						...(note.error !== undefined ? { error: note.error } : {}),
					})),
				}),
			];
			return { state, final, notes, parts };
		},
	};
}

export interface ExpertNoteTakerOptions {
	notes: ExpertNotes;
	/**
	 * The highest revision held for each file, read either side of a call.
	 *
	 * A diff rather than a reading of the tool's input, so this needs to know
	 * nothing about what any particular tool's arguments mean -- and so a tool
	 * that writes by a route this code has never heard of still shows up. What
	 * moved is what was written.
	 */
	heads: () => ReadonlyMap<string, number>;
	/** Workspace-relative paths for the note, where the host can give them. */
	relative?: (absolutePath: string) => string;
}

/**
 * Wrap the expert's tools so every call it makes becomes a note.
 *
 * Outside the revision capture, so the heads it reads afterwards already hold
 * what the call wrote. What it cannot see is a tool that reports its own
 * failure in its result rather than by throwing -- an editor that refuses, a
 * command that exits non-zero -- and that is fine: the base model is being
 * given the shape of the work, not a transcript, and a refused call that
 * changed nothing is exactly the kind of detail the batching exists to drop.
 */
export function withExpertNotes<T extends AgentToolDefinition>(
	tools: readonly T[],
	options: ExpertNoteTakerOptions,
): T[] {
	const name = (absolutePath: string) =>
		options.relative?.(absolutePath) ?? absolutePath;
	const wrote = (
		before: ReadonlyMap<string, number>,
		after: ReadonlyMap<string, number>,
	): ExpertFileTouch[] => {
		const touched: ExpertFileTouch[] = [];
		for (const [path, revision] of after) {
			if ((before.get(path) ?? 0) < revision) {
				touched.push({ path: name(path), revision });
			}
		}
		return touched.sort((a, b) => a.path.localeCompare(b.path));
	};
	return tools.map((tool) => {
		const original = tool as unknown as {
			execute?: (input: unknown, context: unknown) => unknown;
		};
		return {
			...tool,
			execute: async (input: unknown, context: unknown) => {
				const before = new Map(options.heads());
				try {
					const result = await original.execute?.(input, context);
					options.notes.noteTool({
						tool: tool.name,
						files: wrote(before, options.heads()),
					});
					return result;
				} catch (error) {
					options.notes.noteTool({
						tool: tool.name,
						files: wrote(before, options.heads()),
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			},
		} as unknown as T;
	});
}
