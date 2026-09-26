/**
 * A turn for the lead while it waits on its agents.
 *
 * The lead reads a steering message at its next turn boundary, and a lead
 * inside `spawn_agent` has none until every agent in the round has finished:
 * on pandorum 2026-09-24 a message sent 45 minutes into a round of 75 was
 * queued and never read ("Message queued for session", then nothing). The user
 * could not ask the lead anything, nor have it stop what it had started.
 *
 * So a steer that arrives while agents are running is answered here, at once,
 * by a short run of the lead's own model on the lead's own conversation: the
 * delegation call still open is closed in this copy with the round's live
 * state, and the message follows it. The lead may answer, leave a message for
 * some or all of the running agents, or stop them. Then the round carries on,
 * and the lead's real turn later is told what was said and done here, so the
 * two do not disagree about what happened.
 *
 * The run is a copy. Nothing is written to the lead's conversation until that
 * note, because the lead's history has a tool call open that only the
 * delegation's own result may close.
 */

import type * as LlmsProviders from "@cline/llms";
import type { AgentTool } from "@cline/shared";
import {
	createLeadAgentControlTools,
	createLeadAgentMessagingTools,
} from "../../extensions/tools/team/lead-agent-tools";
import { subagentCancellation } from "../../extensions/tools/team/subagent-cancellation";

type Message = LlmsProviders.MessageWithMetadata;

/**
 * Turns the side run may take.
 *
 * Four ran out in 4 of the 8 side turns of swarm 0926: a side turn now reads
 * the round (`agents_status`, sometimes twice -- summary, then an agent's
 * detail), acts on it (`message_agents`, `stop_agents`, `requeue_agent`,
 * `restart_agent`, `resume_agent`, `retry_failed`; a model often issues these
 * one per turn rather than in one batch), and then answers. Status twice,
 * four controls and the reply is seven; ten leaves room for one tool error
 * the model corrects and one more look, and still bounds a side run that
 * loops -- it is a copy of the lead answering one message, not a work turn.
 */
export const STEER_SIDE_TURN_MAX_ITERATIONS = 10;

export interface SteerSideTurnRunner {
	/** Seed the copy of the lead's conversation. */
	restore(messages: readonly Message[]): void;
	/**
	 * Run one user message on it; resolves with the final text, and why the
	 * run ended when it says (a run that hit its cap or failed ends with the
	 * runtime's message as its text, which is not a reply).
	 */
	continue(message: string): Promise<{ text: string; finishReason?: string }>;
}

export interface SteerSideTurnInput {
	sessionId: string;
	/** The steer, as the user wrote it -- or the system's status report. */
	message: string;
	/**
	 * Who is speaking. `system` is the agents' own status report (see
	 * `agent-trouble.ts`): agents stuck for a long time, which the lead may
	 * want to take back. Defaults to the user.
	 */
	source?: "user" | "system";
	/** The lead's conversation as it stands, with its delegation call open. */
	messages: readonly Message[];
	/** Builds the lead's model with exactly these tools. */
	createRunner: (tools: AgentTool[]) => SteerSideTurnRunner;
	/**
	 * The lead's own agent tools the side turn may use besides the two above:
	 * those of {@link SIDE_TURN_LEAD_TOOL_NAMES} the session has.
	 */
	leadTools?: readonly AgentTool[];
}

/**
 * The session's tools a side turn gets as they are: what the lead needs to
 * see into the round it is waiting on (spec B: the status tool in every mode).
 */
export const SIDE_TURN_LEAD_TOOL_NAMES: ReadonlySet<string> = new Set([
	"agents_status",
]);

export interface SteerSideTurnResult {
	/** What the lead said to the user. */
	reply: string;
	/** What it did to the round, in words, for the user and for the lead. */
	actions: string[];
	/** The side turn itself failed; the message still needs the lead. */
	failed?: boolean;
	/**
	 * How it failed: `iteration_cap` when it ran out of turns before it
	 * replied, `error` when its run ended in an error. About the side turn,
	 * never about the agents.
	 */
	failure?: "iteration_cap" | "error";
}

/** The agents of this session's round, as the lead's side turn is shown them. */
export function describeRunningRound(sessionId: string): string {
	const running = subagentCancellation.runningIn(sessionId);
	if (running.length === 0) {
		return "No agents are running.";
	}
	return [
		`${running.length} agent(s) are still running or queued: ${running
			.map((agent) => agent.label)
			.join(", ")}.`,
		"Their reports arrive when the delegation call returns.",
	].join(" ");
}

/**
 * Close every tool call left open at the end of the lead's conversation, in
 * this copy only, with the round's state as its result. A request with an open
 * tool call is refused by every chat template this runs on.
 */
export function closeOpenToolCalls(
	messages: readonly Message[],
	status: string,
): Message[] {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant" || !Array.isArray(last.content)) {
		return [...messages];
	}
	const open = (
		last.content as unknown as Array<Record<string, unknown>>
	).filter((part) => part.type === "tool_use");
	if (open.length === 0) {
		return [...messages];
	}
	return [
		...messages,
		{
			role: "user",
			content: open.map((part) => ({
				type: "tool_result",
				tool_use_id: String(part.id),
				...(part.name ? { name: String(part.name) } : {}),
				content: `Still running -- this call has not returned. ${status}`,
			})),
		} as unknown as Message,
	];
}

/**
 * What the side turn may do to the round: message and stop its agents, and
 * the controls -- requeue, restart, resume, retry -- the lead has in its own
 * turn. Each records what it did, for the user and for the lead.
 */
export function createSteerRoundTools(
	sessionId: string,
	actions: string[],
): AgentTool[] {
	const onAction = (line: string) => {
		actions.push(line);
	};
	return [
		...createLeadAgentMessagingTools({ sessionId, onAction }),
		...createLeadAgentControlTools({ sessionId, onAction }),
	];
}

const SYSTEM_SIDE_TURN_PREAMBLE = [
	"This is a status report from the agent system, not a message from the user. Your agents are still running; you are reading it now, between their progress, without ending the delegation.",
	"You can reply in plain text, `message_agents` to pass something to running agents, `stop_agents` to stop some or all of them, `requeue_agent` to move one off a node that is slow or misbehaving (keeping its transcript), `restart_agent` to start one over, `resume_agent` to continue one waiting at its iteration cap, or `retry_failed` to run a round's failed agents again.{LEAD_TOOLS} Nothing else is available until the round returns.",
	`There is no waiting here -- no \`await_agents\`, and \`agents_status\` asked again shows the same round. This turn ends only when you write your reply, and it has ${STEER_SIDE_TURN_MAX_ITERATIONS} turns: act, then reply.`,
	"The agents named below keep retrying on their own unless you stop them. If you decide to stop some, you will do their tasks yourself once the round returns. Answer in one short reply: what you decided, and why.",
	"",
	"The report:",
].join("\n");

const SIDE_TURN_PREAMBLE = [
	"The user has sent you this message while your agents are still running. You are answering it now, between your agents' progress, without ending the delegation.",
	"You can reply in plain text, `message_agents` to pass something to running agents, `stop_agents` to stop some or all of them, `requeue_agent` to move one off a node that is slow or misbehaving (keeping its transcript), `restart_agent` to start one over, `resume_agent` to continue one waiting at its iteration cap, or `retry_failed` to run a round's failed agents again.{LEAD_TOOLS} Nothing else is available until the round returns.",
	`There is no waiting here -- no \`await_agents\`, and \`agents_status\` asked again shows the same round. This turn ends only when you write your reply, and it has ${STEER_SIDE_TURN_MAX_ITERATIONS} turns: act, then reply.`,
	"Answer the user in one short reply: what you will do, or what you did.",
	"",
	"The user's message:",
].join("\n");

/**
 * The reply when the side turn used all of its own turns without writing one.
 * Says whose turns they were, so it cannot be read as a report on the agents.
 */
export const SIDE_TURN_OUT_OF_TURNS = `(No reply: this side turn used all ${STEER_SIDE_TURN_MAX_ITERATIONS} of its own turns before answering. That limit is the side turn's own, not the agents' -- it says nothing about how far they got.)`;

/** Run the side turn. Never throws: a failure is the reply. */
export async function runSteerSideTurn(
	input: SteerSideTurnInput,
): Promise<SteerSideTurnResult> {
	const actions: string[] = [];
	try {
		const leadTools = (input.leadTools ?? []).filter((tool) =>
			SIDE_TURN_LEAD_TOOL_NAMES.has(tool.name),
		);
		const runner = input.createRunner([
			...createSteerRoundTools(input.sessionId, actions),
			...leadTools,
		]);
		runner.restore(
			closeOpenToolCalls(input.messages, describeRunningRound(input.sessionId)),
		);
		const preamble =
			input.source === "system"
				? SYSTEM_SIDE_TURN_PREAMBLE
				: SIDE_TURN_PREAMBLE;
		const toolsLine = leadTools.some((tool) => tool.name === "agents_status")
			? " `agents_status` shows what each agent is doing and why."
			: "";
		const result = await runner.continue(
			`${preamble.replace("{LEAD_TOOLS}", toolsLine)}\n${input.message}`,
		);
		// The side turn's own cap is the side turn's, never the round's. Its
		// "exceeded maxIterations (4)" handed on as the reply was read by the lead
		// as a cap on its agents (pandorum 2ge0c) -- a cap none of them had. A
		// run that ended in an error likewise ends with the runtime's message
		// as its text, which is not what the lead said.
		if (result.finishReason === "max_iterations") {
			return {
				reply: SIDE_TURN_OUT_OF_TURNS,
				actions,
				failed: true,
				failure: "iteration_cap",
			};
		}
		if (result.finishReason === "error") {
			return {
				reply:
					"My reply between the agents' progress failed before I could answer. Your message is queued for my next turn.",
				actions,
				failed: true,
				failure: "error",
			};
		}
		return { reply: result.text.trim(), actions };
	} catch (error) {
		return {
			reply: `I could not answer while the agents run: ${
				error instanceof Error ? error.message : String(error)
			}. Your message is queued for when the round returns.`,
			actions,
			failed: true,
			failure: "error",
		};
	}
}

/**
 * What the lead's real turn is told, once the round returns: the exchange it
 * had in the side turn, which is not in its history.
 */
export function describeSideTurnForLead(
	message: string,
	result: SteerSideTurnResult,
	source: "user" | "system" = "user",
): string {
	if (result.failed) {
		const what =
			result.failure === "iteration_cap"
				? `the side turn ran out of its ${STEER_SIDE_TURN_MAX_ITERATIONS} iterations before it replied`
				: "the side turn failed before it replied";
		return [
			`While your agents were running, ${
				source === "system"
					? "the agent system reported agents stuck for a long time"
					: "the user sent a message"
			}, and a side turn was started to answer it, but ${what}. This is about that side turn, not about your agents: none of them hit a limit because of it.`,
			`${source === "system" ? "The report said" : "The user said"}: ${message.trim()}`,
			`What was shown in place of a reply: ${result.reply}`,
			result.actions.length > 0
				? `Before it stopped, you did: ${result.actions.join(" ")}`
				: "It did nothing to the round.",
			"It still needs your answer.",
		].join("\n");
	}
	return [
		source === "system"
			? "While your agents were running, the agent system reported agents stuck for a long time, and you answered it in a side turn. This already happened; do not repeat it. If you stopped agents, their tasks are yours to do now."
			: "While your agents were running, the user sent a message and you answered it in a side turn. This already happened; do not repeat it.",
		`${source === "system" ? "The report said" : "The user said"}: ${message.trim()}`,
		`You replied: ${result.reply || "(no reply)"}`,
		result.actions.length > 0
			? `You did: ${result.actions.join(" ")}`
			: "You did nothing to the round.",
	].join("\n");
}
