/**
 * What a sub-agent is generating, in full, for the one row being inspected.
 *
 * The row's own line is a status: "Prefilling 39,050 / 56,042", "Writing
 * editor call: 8,327 characters", or the last 400 characters of its text. That
 * says what it is doing and hides how it is doing it -- a model reasoning in
 * circles, or writing the wrong file, reads the same as one that is fine. The
 * stream itself was never lost, only not kept.
 *
 * So each agent keeps its current step here: everything the model has
 * generated since its latest request began -- thinking, answer text and the
 * arguments of the tool calls it writes, in the order they arrive. A step
 * starts over with the next request, so the call it just wrote stays readable
 * while the tool runs.
 *
 * Nothing is sent anywhere unless someone subscribes: fifty agents streaming
 * kilobytes each to a webview nobody is reading would cost the chat for
 * nothing. The registry is the process's, keyed by the same id as
 * `subagentCancellation`, and an agent's entry goes when its registration is
 * released.
 */

/** What a stretch of the stream is. */
export type SubagentOutputKind = "reasoning" | "text" | "tool";

/** One stretch of the stream: consecutive output of one kind. */
export interface SubagentOutputChunk {
	kind: SubagentOutputKind;
	text: string;
	/** The tool whose arguments these are, for `kind: "tool"`. */
	toolName?: string;
	/** Which call, so two calls to the same tool stay two stretches. */
	toolCallId?: string;
}

/** What a subscriber is told, after the snapshot it started from. */
export type SubagentOutputEvent =
	/** A new step began: what was shown is the previous step's. */
	| { type: "step" }
	/** More of the stream. Joins the last chunk when kind and call match. */
	| { type: "append"; chunk: SubagentOutputChunk };

export type SubagentOutputListener = (event: SubagentOutputEvent) => void;

/**
 * How much of a step is kept. An `editor` call carrying a whole file is the
 * long case; past this the start of the step goes, as a terminal's scrollback
 * would.
 */
export const SUBAGENT_OUTPUT_STEP_CHARS = 64 * 1024;

interface Entry {
	chunks: SubagentOutputChunk[];
	chars: number;
	listeners: Set<SubagentOutputListener>;
	/** A running agent writes here; a subscriber alone does not keep it. */
	live: boolean;
}

const ENTRIES = new Map<string, Entry>();

function entryFor(id: string): Entry {
	let entry = ENTRIES.get(id);
	if (!entry) {
		entry = { chunks: [], chars: 0, listeners: new Set(), live: false };
		ENTRIES.set(id, entry);
	}
	return entry;
}

function notify(entry: Entry, event: SubagentOutputEvent): void {
	for (const listener of entry.listeners) {
		try {
			listener(event);
		} catch {
			// A view that failed is not worth the agent.
		}
	}
}

function sameStretch(
	a: SubagentOutputChunk,
	b: Pick<SubagentOutputChunk, "kind" | "toolCallId">,
): boolean {
	return a.kind === b.kind && a.toolCallId === b.toolCallId;
}

/** Drop from the front of the step until it fits. */
function trim(entry: Entry): void {
	while (entry.chars > SUBAGENT_OUTPUT_STEP_CHARS && entry.chunks.length > 0) {
		const first = entry.chunks[0] as SubagentOutputChunk;
		const over = entry.chars - SUBAGENT_OUTPUT_STEP_CHARS;
		if (first.text.length <= over) {
			entry.chunks.shift();
			entry.chars -= first.text.length;
		} else {
			first.text = first.text.slice(over);
			entry.chars -= over;
		}
	}
}

/** Where one agent's progress writes its stream. */
export interface SubagentOutputWriter {
	append(chunk: SubagentOutputChunk): void;
	/** A new request began: the step so far is over. */
	step(): void;
}

export const subagentOutput = {
	/** The writer for the agent registered under `id`. */
	writer(id: string): SubagentOutputWriter {
		return {
			append(chunk) {
				if (!chunk.text) {
					return;
				}
				const entry = entryFor(id);
				entry.live = true;
				const last = entry.chunks[entry.chunks.length - 1];
				if (last && sameStretch(last, chunk)) {
					last.text += chunk.text;
				} else {
					entry.chunks.push({ ...chunk });
				}
				entry.chars += chunk.text.length;
				trim(entry);
				notify(entry, { type: "append", chunk: { ...chunk } });
			},
			step() {
				const entry = entryFor(id);
				entry.live = true;
				if (entry.chunks.length === 0) {
					return;
				}
				entry.chunks = [];
				entry.chars = 0;
				notify(entry, { type: "step" });
			},
		};
	},

	/**
	 * Watch an agent's stream: the step so far, then what follows. An agent
	 * that has not written yet -- queued, or prefilling -- starts empty and
	 * fills in when it does. Call the returned function to stop.
	 */
	subscribe(
		id: string,
		listener: SubagentOutputListener,
	): { snapshot: SubagentOutputChunk[]; unsubscribe: () => void } {
		const entry = entryFor(id);
		entry.listeners.add(listener);
		return {
			snapshot: entry.chunks.map((chunk) => ({ ...chunk })),
			unsubscribe: () => {
				entry.listeners.delete(listener);
				if (entry.listeners.size === 0 && !entry.live) {
					if (ENTRIES.get(id) === entry) {
						ENTRIES.delete(id);
					}
				}
			},
		};
	},

	/** The agent ended: its stream goes, unless someone is still looking. */
	release(id: string): void {
		const entry = ENTRIES.get(id);
		if (!entry) {
			return;
		}
		entry.live = false;
		if (entry.listeners.size === 0) {
			ENTRIES.delete(id);
		}
	},

	/** Ids with an entry. For tests and diagnostics. */
	ids(): string[] {
		return [...ENTRIES.keys()];
	},
};
