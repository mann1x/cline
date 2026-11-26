/**
 * A run's journal: `.cerebriline/pipeline-runs/<run>.jsonl`, one event a
 * line, appended as the run goes. It is what a run resumes from and what
 * `pipeline status` and the viewer read. A torn last line (the host died
 * mid-write) is skipped.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	NodeOutput,
	NodeStatus,
	PipelineDefinition,
	RunStatus,
} from "./model";

export const PIPELINE_RUNS_DIR = join(".cerebriline", "pipeline-runs");

export type JournalEvent =
	| {
			t: "run";
			ts: number;
			run: string;
			pipeline: string;
			hash: string;
			inputs: Record<string, unknown>;
			/** The conversation board's task for the run, when it has one. */
			task?: string;
			/** The session that started it: the one that picks it up after a reload. */
			session?: string;
			/** The definition it ran, for a partial re-run to compare nodes against. */
			definition?: PipelineDefinition;
			/** A partial re-run: the run its reused outputs came from. */
			from?: string;
			/** A sub-run: the run whose `pipeline` node started it. */
			parent?: string;
	  }
	| { t: "start"; ts: number; node: string; attempt: number }
	| {
			t: "end";
			ts: number;
			node: string;
			output: NodeOutput;
			pinned?: boolean;
			/** Taken from this earlier run, not run again. */
			reused?: string;
	  }
	| {
			t: "retry";
			ts: number;
			node: string;
			attempt: number;
			error: string;
			wait: number;
	  }
	| { t: "skip"; ts: number; node: string; reason: string }
	| { t: "fail"; ts: number; node: string; error: string }
	| { t: "wait"; ts: number; node: string; on: string }
	| { t: "resume"; ts: number }
	| {
			t: "done";
			ts: number;
			status: Exclude<RunStatus, "running" | "waiting">;
			error?: string;
	  };

export interface NodeState {
	status: NodeStatus;
	attempts: number;
	output?: NodeOutput;
	error?: string;
	reason?: string;
	startedAt?: number;
	endedAt?: number;
	/** What it is waiting on, while it waits. */
	waitingOn?: string;
	/** The last failed attempt's error, while it is retried. */
	lastError?: string;
	/** Its output was taken from this earlier run. */
	reused?: string;
}

export interface JournalFold {
	run?: Extract<JournalEvent, { t: "run" }>;
	nodes: Map<string, NodeState>;
	status: RunStatus;
	error?: string;
	startedAt?: number;
	endedAt?: number;
}

export function readJournal(path: string): JournalEvent[] {
	if (!existsSync(path)) return [];
	const events: JournalEvent[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as JournalEvent);
		} catch {
			// A torn last line: the host stopped mid-write.
		}
	}
	return events;
}

export function appendJournal(path: string, event: JournalEvent): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(event)}\n`);
}

/** The run as its journal tells it. */
export function foldJournal(events: readonly JournalEvent[]): JournalFold {
	const fold: JournalFold = { nodes: new Map(), status: "running" };
	const node = (id: string): NodeState => {
		let state = fold.nodes.get(id);
		if (!state) {
			state = { status: "pending", attempts: 0 };
			fold.nodes.set(id, state);
		}
		return state;
	};
	for (const event of events) {
		switch (event.t) {
			case "run":
				fold.run = event;
				fold.startedAt = event.ts;
				break;
			case "start": {
				const state = node(event.node);
				state.status = "running";
				state.attempts = Math.max(state.attempts, event.attempt);
				state.startedAt = event.ts;
				delete state.waitingOn;
				break;
			}
			case "wait":
				node(event.node).waitingOn = event.on;
				break;
			case "end": {
				const state = node(event.node);
				state.status = "done";
				state.output = event.output;
				state.endedAt = event.ts;
				if (event.reused) state.reused = event.reused;
				delete state.waitingOn;
				break;
			}
			case "retry":
				node(event.node).lastError = event.error;
				break;
			case "skip": {
				const state = node(event.node);
				state.status = "skipped";
				state.reason = event.reason;
				state.endedAt = event.ts;
				break;
			}
			case "fail": {
				const state = node(event.node);
				state.status = "failed";
				state.error = event.error;
				state.endedAt = event.ts;
				delete state.waitingOn;
				break;
			}
			case "resume":
				fold.status = "running";
				delete fold.error;
				break;
			case "done":
				fold.status = event.status;
				if (event.error) fold.error = event.error;
				fold.endedAt = event.ts;
				break;
		}
	}
	if (
		fold.status === "running" &&
		[...fold.nodes.values()].some((state) => state.waitingOn)
	) {
		fold.status = "waiting";
	}
	return fold;
}

/**
 * The next run id for a pipeline: `<name>-<n>`, one more than the highest
 * already in the folder, so the board can say "#4".
 */
export function nextRunId(dir: string, name: string): string {
	const slug =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "pipeline";
	let highest = 0;
	if (existsSync(dir)) {
		for (const file of readdirSync(dir)) {
			const match = new RegExp(`^${slug}-(\\d+)\\.jsonl$`).exec(file);
			if (match) highest = Math.max(highest, Number(match[1]));
		}
	}
	return `${slug}-${highest + 1}`;
}
