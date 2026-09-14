/**
 * The A2A vocabulary, and only the vocabulary.
 *
 * Agent2Agent is a wire protocol for agents that do not share a process: three
 * transports, an AgentCard served over HTTPS for discovery, push-notification
 * webhooks, security schemes. Our base model and our expert are two
 * `SessionRuntime` instances in one process editing one workspace, so none of
 * that is ours to run and the official SDK would ship a client, a server and
 * three transports we would never call.
 *
 * What is worth having is the nouns. They are the part of the spec that had to
 * be argued about, and adopting them costs nothing and settles questions we
 * would otherwise settle badly one at a time:
 *
 *   TaskState    escalation had no state machine at all -- everything was
 *                prose. `input-required` is the expert asking the base a
 *                question; `canceled` is the base telling a circling expert to
 *                stop; `rejected` is the expert refusing the brief. Each of
 *                those is a thing we now have to have an answer for, which is
 *                the point of borrowing the enum rather than inventing three
 *                booleans later.
 *   Message      one shape for both directions, carrying structure and prose
 *                side by side rather than forcing notes through a string.
 *   Part         the reason a note can be read by a 9B model and by the panel
 *                at the same time: the text part is for the model, the data
 *                part is for everything else.
 *   Artifact     the expert's delivery as a thing with an identity, instead of
 *                a paragraph the base has to parse by reading.
 *
 * Deliberately absent: AgentCard (discovery between hosts that cannot see each
 * other -- here "you can message each other" is two sentences of prompt),
 * every transport, push-notification config, and the SDK.
 *
 * Field names follow the spec exactly, including the camelCase and including
 * `messageId` rather than `id`, so that a reader who knows A2A recognises
 * these and a reader who does not can look them up.
 *
 * Spec: https://a2a-protocol.org/latest/specification/
 */

/**
 * Where a task is, in the spec's own words.
 *
 * The three interrupted/terminal distinctions are the load-bearing part:
 * `working` and `input-required` both mean the expert is alive, but only one
 * of them means the base owes it an answer.
 */
export type TaskState =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "failed"
	| "canceled"
	| "rejected";

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
	"completed",
	"failed",
	"canceled",
	"rejected",
]);

export function isTerminal(state: TaskState): boolean {
	return TERMINAL_TASK_STATES.has(state);
}

/** Who sent a message. The spec has no third role, and neither do we. */
export type Role = "user" | "agent";

/** Text meant to be read by a model. */
export interface TextPart {
	kind: "text";
	text: string;
}

/**
 * Structure meant to be read by code.
 *
 * This is what keeps the informational notes honest. The panel needs the tool
 * name and the revision number; the base model needs a sentence. Putting both
 * in one part would mean one of them is parsed out of the other, and the
 * parser would be the thing that breaks.
 */
export interface DataPart {
	kind: "data";
	data: Record<string, unknown>;
}

export type Part = TextPart | DataPart;

/** One thing said, in either direction. */
export interface Message {
	messageId: string;
	role: Role;
	parts: Part[];
	taskId?: string;
	contextId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Something the task produced.
 *
 * For us that is the expert's delivery: what it changed and what it ran, with
 * the files it touched named in a data part rather than described in the prose.
 */
export interface Artifact {
	artifactId: string;
	parts: Part[];
	name?: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskStatus {
	state: TaskState;
	message?: Message;
	/** Milliseconds since the epoch. The spec says timestamp; this is ours. */
	timestamp?: number;
}

export interface Task {
	id: string;
	status: TaskStatus;
	contextId?: string;
	artifacts?: Artifact[];
	history?: Message[];
	metadata?: Record<string, unknown>;
}

export function textPart(text: string): TextPart {
	return { kind: "text", text };
}

export function dataPart(data: Record<string, unknown>): DataPart {
	return { kind: "data", data };
}

/** Every text part, joined. Data parts are not prose and are not included. */
export function textOf(parts: readonly Part[]): string {
	return parts
		.filter((part): part is TextPart => part.kind === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}
