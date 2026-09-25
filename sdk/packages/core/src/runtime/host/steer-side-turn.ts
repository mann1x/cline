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
import { subagentCancellation } from "../../extensions/tools/team/subagent-cancellation";

type Message = LlmsProviders.MessageWithMetadata;

/** Turns the side run may take: one to act, one to answer, one spare. */
export const STEER_SIDE_TURN_MAX_ITERATIONS = 4;

export interface SteerSideTurnRunner {
	/** Seed the copy of the lead's conversation. */
	restore(messages: readonly Message[]): void;
	/** Run one user message on it; resolves with the final text. */
	continue(message: string): Promise<{ text: string }>;
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
}

export interface SteerSideTurnResult {
	/** What the lead said to the user. */
	reply: string;
	/** What it did to the round, in words, for the user and for the lead. */
	actions: string[];
	/** The side turn itself failed; the message still needs the lead. */
	failed?: boolean;
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

function matchAgents(sessionId: string, names: readonly string[] | undefined) {
	const running = subagentCancellation.runningIn(sessionId);
	if (!names || names.length === 0) {
		return running;
	}
	const wanted = new Set(names.map((name) => name.trim().toLowerCase()));
	return running.filter((agent) => wanted.has(agent.label.toLowerCase()));
}

/** The two things the side turn may do to the round. */
export function createSteerRoundTools(
	sessionId: string,
	actions: string[],
): AgentTool[] {
	const agentsProperty = {
		type: "array",
		items: { type: "string" },
		description:
			"Names of the agents, as the round names them. Leave it out to mean every agent still running.",
	};
	return [
		{
			name: "message_agents",
			description:
				"Leave a message for running agents. Each reads it at its next turn, between tool calls, and carries on with it in mind. Use it to pass on a change of plan, a constraint, or an answer.",
			inputSchema: {
				type: "object",
				properties: {
					text: {
						type: "string",
						description: "The message, written to the agent.",
					},
					agents: agentsProperty,
				},
				required: ["text"],
			},
			execute: async (input: unknown) => {
				const { text, agents } = input as { text?: string; agents?: string[] };
				if (!text?.trim()) {
					return "Nothing sent: `text` is empty.";
				}
				const targets = matchAgents(sessionId, agents);
				const reached = targets.filter((agent) =>
					subagentCancellation.message(agent.id, text),
				);
				const line = `Sent to ${reached.length} agent(s): ${
					reached.map((agent) => agent.label).join(", ") || "none"
				}.`;
				actions.push(`${line} Message: "${text.trim()}"`);
				return line;
			},
		} as AgentTool,
		{
			name: "stop_agents",
			description:
				"Stop running agents. A stopped agent reports as stopped and its work so far is lost; the rest of the round carries on.",
			inputSchema: {
				type: "object",
				properties: { agents: agentsProperty },
			},
			execute: async (input: unknown) => {
				const { agents } = (input ?? {}) as { agents?: string[] };
				const targets = matchAgents(sessionId, agents);
				const stopped = targets.filter((agent) =>
					subagentCancellation.cancel(agent.id),
				);
				const line = `Stopped ${stopped.length} agent(s): ${
					stopped.map((agent) => agent.label).join(", ") || "none"
				}.`;
				actions.push(line);
				return line;
			},
		} as AgentTool,
	];
}

const SYSTEM_SIDE_TURN_PREAMBLE = [
	"This is a status report from the agent system, not a message from the user. Your agents are still running; you are reading it now, between their progress, without ending the delegation.",
	"You can reply in plain text, `message_agents` to pass something to running agents, or `stop_agents` to stop some or all of them. Nothing else is available until the round returns.",
	"The agents named below keep retrying on their own unless you stop them. If you decide to stop some, you will do their tasks yourself once the round returns. Answer in one short reply: what you decided, and why.",
	"",
	"The report:",
].join("\n");

const SIDE_TURN_PREAMBLE = [
	"The user has sent you this message while your agents are still running. You are answering it now, between your agents' progress, without ending the delegation.",
	"You can reply in plain text, `message_agents` to pass something to running agents, or `stop_agents` to stop some or all of them. Nothing else is available until the round returns.",
	"Answer the user in one short reply: what you will do, or what you did.",
	"",
	"The user's message:",
].join("\n");

/** Run the side turn. Never throws: a failure is the reply. */
export async function runSteerSideTurn(
	input: SteerSideTurnInput,
): Promise<SteerSideTurnResult> {
	const actions: string[] = [];
	try {
		const runner = input.createRunner(
			createSteerRoundTools(input.sessionId, actions),
		);
		runner.restore(
			closeOpenToolCalls(input.messages, describeRunningRound(input.sessionId)),
		);
		const preamble =
			input.source === "system"
				? SYSTEM_SIDE_TURN_PREAMBLE
				: SIDE_TURN_PREAMBLE;
		const result = await runner.continue(`${preamble}\n${input.message}`);
		return { reply: result.text.trim(), actions };
	} catch (error) {
		return {
			reply: `I could not answer while the agents run: ${
				error instanceof Error ? error.message : String(error)
			}. Your message is queued for when the round returns.`,
			actions,
			failed: true,
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
