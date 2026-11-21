import { existsSync, readFileSync } from "node:fs";
import { renderSavedBoard } from "./board";
import { countTasks, foldTaskEvents, type TaskEvent } from "./model";

/** A board as it is saved into a memory. */
export interface ExportedTaskBoard {
	/** The log's events, without the tool call ids that tie them to one conversation. */
	events: TaskEvent[];
	text: string;
	tasks: number;
	open: number;
}

/** The saved form of a board's events. */
export function exportTaskEvents(
	events: readonly TaskEvent[],
	header: { title?: string; sessionId: string },
): ExportedTaskBoard {
	const state = foldTaskEvents(events);
	const counts = countTasks(state);
	return {
		events: events.map(({ call: _call, ...event }) => event as TaskEvent),
		text: renderSavedBoard(state, {
			...header,
			savedAt: new Date().toISOString(),
		}),
		tasks: counts.total,
		open: counts.total - counts.done - counts.cancelled,
	};
}

/**
 * A conversation's board read from its log, for a conversation with no live
 * session (reopened from history and not sent a message yet). Read as
 * written: a cut-back the next resume would apply is not applied here.
 * Undefined when there is no log.
 */
export function exportTaskLog(
	logPath: string,
	header: { title?: string; sessionId: string },
): ExportedTaskBoard | undefined {
	if (!existsSync(logPath)) return undefined;
	const events: TaskEvent[] = [];
	for (const line of readFileSync(logPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as TaskEvent;
			if (event && (event.op === "create" || event.op === "update")) {
				events.push(event);
			}
		} catch {
			// A torn last line is what a crash mid-append leaves; skip it.
		}
	}
	return exportTaskEvents(events, header);
}
