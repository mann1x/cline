import {
	describeOpencotiStreamPhase,
	onPolykvNotice,
	onPolykvRoomWait,
	onPolykvStreamPhase,
	releasePolykvAgent,
} from "@cline/llms";
import type { AgentEvent } from "@cline/shared";

/**
 * What a delegated agent is doing, reported on the tool call that started it.
 *
 * A sub-agent's own events are deliberately kept out of the main chat -- one
 * agent's internals are already a conversation, and three at once is a flood.
 * The consequence was that nothing about a running sub-agent reached the user
 * at all: the UI reads `latestToolCall` off the spawn tool's progress, and no
 * spawn path had ever emitted any, so the field was declared, parsed, rendered
 * and always empty.
 *
 * Measured on pandorum 2026-09-22: three configured agents ran for between 80
 * and 148 seconds each, and for all of it the only thing on screen was the
 * lead's last tool call. Whether an agent was working, queued behind the
 * endpoint, or dead was not answerable without the extension log.
 *
 * This closes over one spawn call, so no identity has to be reconstructed --
 * the events it is given are its own agent's, and the update lands on its own
 * tool call.
 */
export interface SubagentProgress {
	/** Feed every event the delegated agent emits. */
	observe(event: AgentEvent): void;
}

/** How much of an agent's latest output the UI is given. */
export const SUBAGENT_OUTPUT_TAIL_CHARS = 400;

/**
 * How often output progress is reported, at most.
 *
 * Deltas arrive per token; fifty agents reporting each one would be thousands
 * of chat updates a second for a tail nobody reads that fast.
 */
export const SUBAGENT_OUTPUT_REPORT_MS = 2_000;

/**
 * The agent is waiting for a node: every node that could take it is full.
 *
 * Without this the UI had no way to tell a queued agent from a working one --
 * every agent was shown running from the moment it was spawned, so a fan-out
 * of seventy-five on nodes that take three looked like seventy-five at work.
 */
export function reportSubagentQueued(
	emitUpdate: ((update: unknown) => void) | undefined,
): void {
	emitUpdate?.({ queued: true });
}

/**
 * The agent has a node and starts now. Sent at placement, not at the end: the
 * node is what explains a slow agent while it is slow.
 */
export function reportSubagentPlaced(
	emitUpdate: ((update: unknown) => void) | undefined,
	placed: { nodeId?: string; nodeLabel?: string } | undefined,
): void {
	emitUpdate?.({
		queued: false,
		...(placed?.nodeId ? { nodeId: placed.nodeId } : {}),
		...(placed?.nodeLabel ? { nodeLabel: placed.nodeLabel } : {}),
	});
}

/**
 * Which model the agent runs on, sent when its attempt is built -- right after
 * placement, next to `queued: false`. The row named the model only from the
 * final result, so while an agent ran (the part where a slow or wrong model is
 * worth knowing about) nothing said which one it was. Re-sent per attempt: a
 * re-placement can land it on a node with a different model.
 */
export function reportSubagentModel(
	emitUpdate: ((update: unknown) => void) | undefined,
	model: { providerId?: string; modelId?: string },
): void {
	if (!model.providerId && !model.modelId) {
		return;
	}
	emitUpdate?.({
		...(model.providerId ? { providerId: model.providerId } : {}),
		...(model.modelId ? { modelId: model.modelId } : {}),
	});
}

/**
 * The agent has ended: its row finishes now, with its result, and not when the
 * whole call does.
 *
 * A batch or a swarm closed every row at the call's end, so an agent that was
 * done sat on a "running" row, its output showing, until the slowest one
 * finished -- sixteen rows running on 2026-09-24 while the server processed
 * one. `report` is the member's own entry of the call's `results`, and an
 * `error` on it is what marks the row failed.
 */
export function reportSubagentFinished(
	emitUpdate: ((update: unknown) => void) | undefined,
	report: object,
): void {
	emitUpdate?.({ finished: report });
}

/**
 * Between a restarted attempt and the next: the row says so, and the engine
 * session the abandoned attempt held goes back -- after a server restart it is
 * still booked there, and the new attempt would be charged to it.
 */
export async function restarted(
	emitUpdate: ((update: unknown) => void) | undefined,
	engineSessionId: string | undefined,
): Promise<void> {
	emitUpdate?.({
		queued: true,
		latestOutput: "Restarted: starting again from its task",
		latestOutputKind: "text",
		activity: { text: "Restarted: starting again from its task" },
	});
	if (engineSessionId) {
		await releasePolykvAgent(engineSessionId).catch(() => undefined);
	}
}

/**
 * Keep an agent's row honest while its requests wait for room on the engine.
 *
 * A PolyKV worker whose window is full is held inside the opencoti vendor's
 * fetch, re-asking until another agent finishes. Nothing there can reach the
 * agent's row, so it went on saying "running": 75 rows running on 2026-09-24
 * while the server processed 27. The vendor reports each change under the
 * agent's engine session; this turns it into the same `queued` the placement
 * queue sends, with the reason as the row's output line.
 *
 * Returns the unsubscribe; call it when the agent is done, not between
 * re-placements -- the listener belongs to the delegation.
 */
export function watchPolykvRoom(
	engineSessionId: string | undefined,
	emitUpdate: ((update: unknown) => void) | undefined,
	/**
	 * Where a warning also goes, beside the row: a lost priority-0 sub-pool
	 * is a full prefill nobody sees on a row that has scrolled away.
	 */
	logger?: {
		log?: (message: string, metadata?: { severity?: "warn" }) => void;
	},
	/** Told when a wait starts, with its reason: for the lead's report. */
	onWaiting?: (reason: string | undefined) => void,
): () => void {
	if (!engineSessionId || !emitUpdate) {
		return () => {};
	}
	const stopRoom = onPolykvRoomWait(engineSessionId, (state) => {
		if (state.waiting) {
			onWaiting?.(state.reason);
		}
		emitUpdate(
			state.waiting
				? {
						queued: true,
						...(state.reason
							? {
									latestOutput: state.reason,
									latestOutputKind: "text",
									activity: { text: state.reason },
								}
							: {}),
					}
				: { queued: false },
		);
	});
	// What the engine said about its requests: a pool that shared 4 tokens of
	// 5,627 on every turn was a warning in the server log and nowhere a user
	// would look. On the row's activity, with its severity.
	const stopNotices = onPolykvNotice(engineSessionId, (notice) => {
		if (notice.severity === "warn") {
			logger?.log?.(`[PolyKV] ${engineSessionId}: ${notice.text}`, {
				severity: "warn",
			});
		}
		emitUpdate({
			activity: {
				text: notice.text,
				...(notice.severity === "warn" ? { severity: "warn" } : {}),
			},
		});
	});
	// What its request is doing on the server while the stream is silent --
	// queued, prefilling n of N, generating with nothing to show -- from the
	// heartbeat's comments. In place, on the row's current line, not on its
	// activity: it changes every ping, and the activity log is for events.
	// Not a warning either: a long prefill is the server working.
	let phaseShown = false;
	const stopPhase = onPolykvStreamPhase(engineSessionId, (phase) => {
		if (phase) {
			phaseShown = true;
			emitUpdate({
				latestOutput: describeOpencotiStreamPhase(phase),
				latestOutputKind: "text",
			});
		} else if (phaseShown) {
			// The stream produces again: its own output takes the line.
			phaseShown = false;
			emitUpdate({ latestOutput: "" });
		}
	});
	return () => {
		stopRoom();
		stopNotices();
		stopPhase();
	};
}

/**
 * What every delegating tool tells the model about launching many agents.
 *
 * Measured on pandorum 2026-09-23 (sx4bp): asked for 75 reports, the lead
 * spent its planning turn arguing with itself -- "that's 75 tool calls which
 * is a LOT", "I'll do this in waves", "can I really make 75 tool calls at
 * once?" -- five reversals before it launched them all together, which was
 * right all along: placement queues what does not fit. Nothing in any
 * description said so, so the model reasoned as if every call it made
 * started a process on the spot.
 */
export const DELEGATION_PACING_NOTE =
	"Launching many is safe: the harness paces them. Each agent starts when a node has room for it and waits in a queue until then, so asking for more than can run at once overloads nothing -- it only means some start later. A call returns when every agent in it has finished, and your next message is sent only after that -- so ask for the whole job at once: one `spawn_agent` call whose `agents` list holds every agent (a configured agent by `type`, several of one kind with `count`), or every call in the same message.";

export function createSubagentProgress(
	emitUpdate: ((update: unknown) => void) | undefined,
	forward?: (event: AgentEvent) => void,
	now: () => number = Date.now,
): SubagentProgress {
	let toolCalls = 0;
	// Tools that have started and not yet ended. The row's "doing" is the
	// running tool, and once none is running the agent is thinking again.
	let toolsRunning = 0;
	// The tail of what it is writing, and separately of what it is thinking:
	// an agent deep in reasoning has written nothing, and "nothing" is not what
	// it is doing.
	let text = "";
	let reasoning = "";
	let lastReport = Number.NEGATIVE_INFINITY;
	// Generation speed, measured over each report window. A streamed delta is
	// one token as the engines here send them (llama.cpp and ollama stream per
	// token), so deltas per second is tokens per second, near enough to tell a
	// crawling agent from a working one -- which is what it is shown for.
	let deltas = 0;
	let windowStart = Number.NaN;
	let genTps: number | undefined;
	const tail = (value: string) =>
		value.length > SUBAGENT_OUTPUT_TAIL_CHARS
			? value.slice(value.length - SUBAGENT_OUTPUT_TAIL_CHARS)
			: value;
	const reportOutput = (force: boolean) => {
		const at = now();
		if (!force && at - lastReport < SUBAGENT_OUTPUT_REPORT_MS) {
			return;
		}
		lastReport = at;
		if (deltas > 0 && at > windowStart) {
			genTps = Math.round((deltas / ((at - windowStart) / 1000)) * 10) / 10;
		}
		deltas = 0;
		// A forced report ends a block: whatever comes next starts after a model
		// round trip, which is not generation time.
		windowStart = force ? Number.NaN : at;
		const latestOutput = text.trim() ? text : reasoning;
		if (latestOutput.trim()) {
			emitUpdate?.({
				latestOutput: latestOutput.trim(),
				latestOutputKind: text.trim() ? "text" : "reasoning",
				...(genTps !== undefined ? { genTps } : {}),
			});
		}
	};
	const countDelta = () => {
		if (Number.isNaN(windowStart)) {
			windowStart = now();
		}
		deltas += 1;
	};
	return {
		observe(event: AgentEvent): void {
			forward?.(event);
			if (!emitUpdate) {
				return;
			}
			// What it has spent, every turn. Nothing reported usage while an
			// agent ran, so every row read "0 tokens" until -- and, since the row
			// counts the context, also after -- it finished.
			if (event.type === "usage") {
				emitUpdate({
					inputTokens: event.totalInputTokens,
					outputTokens: event.totalOutputTokens,
					// The window it is using now: what this turn sent, and what
					// it wrote on top.
					contextTokens:
						event.inputTokens +
						(event.cacheReadTokens ?? 0) +
						event.outputTokens,
					...(event.totalCost !== undefined
						? { totalCost: event.totalCost }
						: {}),
				});
				return;
			}
			if (event.type === "content_start" && event.contentType === "text") {
				countDelta();
				text = tail(text + (event.text ?? ""));
				reportOutput(false);
				return;
			}
			if (event.type === "content_start" && event.contentType === "reasoning") {
				countDelta();
				reasoning = tail(reasoning + (event.reasoning ?? event.text ?? ""));
				reportOutput(false);
				return;
			}
			if (
				event.type === "content_end" &&
				(event.contentType === "text" || event.contentType === "reasoning")
			) {
				reportOutput(true);
				return;
			}
			// A tool ended: a sub-agent between tools is thinking rather than
			// running the last one it finished, so the row stops naming it
			// (`null` clears it). Only for a tool this observer saw start, and
			// only once the last of a parallel batch is done (#77).
			if (event.type === "content_end" && event.contentType === "tool") {
				if (toolsRunning > 0) {
					toolsRunning -= 1;
					if (toolsRunning === 0) {
						emitUpdate({ latestToolCall: null });
					}
				}
				return;
			}
			// Only the start of a tool counts as a tool call.
			if (
				event.type !== "content_start" ||
				event.contentType !== "tool" ||
				!event.toolName
			) {
				return;
			}
			toolCalls += 1;
			toolsRunning += 1;
			// A new step: what it wrote before is the previous step's. So is the
			// speed window: time spent running a tool is not generation.
			text = "";
			reasoning = "";
			deltas = 0;
			windowStart = Number.NaN;
			emitUpdate({ latestToolCall: event.toolName, toolCalls });
		},
	};
}
