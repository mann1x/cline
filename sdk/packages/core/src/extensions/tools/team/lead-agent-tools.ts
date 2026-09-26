/**
 * The lead's controls over its delegated agents (spec C).
 *
 * - `requeue_agent`: stop an agent at its next boundary and put it back in
 *   the placement queue with its transcript. The harness picks the node; a
 *   reason of `slow` or `malfunction` sends it anywhere but where it was.
 * - `restart_agent`: start it over from its task, in its place in the round,
 *   with its check, its sampler (a random seed drawn again) and its cap.
 * - `resume_agent`: carry on an agent held at its iteration cap.
 * - `retry_failed`: run a round's failed and cancelled agents again from the
 *   tasks they were given.
 * - `message_agents` / `stop_agents`: what the side turn could already do,
 *   now from the lead's own turn too, by id or by name.
 *
 * Every control takes an agent's id (`r3-2`) or its name, and every one works
 * for every delegated path that opens a round -- `spawn_agent` single and
 * batch, configured agents, swarm workers -- because they all go through the
 * round registry and the stop registry. Teammates are not rounds: they are
 * stopped and messaged through the `team_*` tools.
 *
 * None of these routes an agent by hand. Infrastructure trouble is the
 * harness's to retry (ruling 1); these are for an agent whose *work* the lead
 * wants handled differently.
 */

import type { AgentTool, AgentToolContext } from "@cline/shared";
import {
	type AgentRounds,
	LIVE_STATES,
	type RoundAgentRecord,
	type RoundRecord,
	roundsFor,
} from "./agent-rounds";
import { subagentCancellation } from "./subagent-cancellation";

export const REQUEUE_AGENT_TOOL_NAME = "requeue_agent";
export const RESTART_AGENT_TOOL_NAME = "restart_agent";
export const RESUME_AGENT_TOOL_NAME = "resume_agent";
export const RETRY_FAILED_TOOL_NAME = "retry_failed";
export const MESSAGE_AGENTS_TOOL_NAME = "message_agents";
export const STOP_AGENTS_TOOL_NAME = "stop_agents";

/**
 * The tools that act on agents, as opposed to looking at them. An
 * escalation's expert gets none of them (spec: status only).
 */
export const LEAD_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
	REQUEUE_AGENT_TOOL_NAME,
	RESTART_AGENT_TOOL_NAME,
	RESUME_AGENT_TOOL_NAME,
	RETRY_FAILED_TOOL_NAME,
	MESSAGE_AGENTS_TOOL_NAME,
	STOP_AGENTS_TOOL_NAME,
]);

/** Reasons for a requeue that say the node, not the task, was the trouble. */
const NODE_REASONS = /\b(slow|malfunction\w*|stuck|hung|broken)\b/i;

/** An agent the lead named, resolved. */
export interface ResolvedAgent {
	ref: string;
	round?: RoundRecord;
	agent?: RoundAgentRecord;
	/** Its live control, while it runs. */
	cancelId?: string;
	label: string;
}

/**
 * Resolve an agent by id or name: a round's agent first, then any agent
 * running for the session under that name (a path with no round).
 */
export function resolveAgent(
	sessionId: string,
	ref: string,
	rounds: AgentRounds = roundsFor(sessionId),
): ResolvedAgent | undefined {
	const wanted = ref.trim();
	if (!wanted) {
		return undefined;
	}
	const found = rounds.findAgent(wanted);
	if (found) {
		return {
			ref: wanted,
			round: found.round,
			agent: found.agent,
			cancelId: rounds.cancelIdOf(found.round.id, found.agent.index),
			label: `${found.agent.id} ${found.agent.name}`,
		};
	}
	const running = subagentCancellation
		.runningIn(sessionId)
		.find(
			(entry) =>
				entry.id === wanted ||
				entry.label.toLowerCase() === wanted.toLowerCase(),
		);
	return running
		? { ref: wanted, cancelId: running.id, label: running.label }
		: undefined;
}

/**
 * The agents a message or a stop goes to: those named (by id or name), or
 * every agent running for the session.
 */
export function resolveTargets(
	sessionId: string,
	refs: readonly string[] | undefined,
): { targets: ResolvedAgent[]; unknown: string[] } {
	const named = (refs ?? []).map((ref) => ref.trim()).filter(Boolean);
	if (named.length === 0) {
		const rounds = roundsFor(sessionId);
		const byCancelId = new Map<string, ResolvedAgent>();
		for (const running of subagentCancellation.runningIn(sessionId)) {
			byCancelId.set(running.id, {
				ref: running.label,
				cancelId: running.id,
				label: running.label,
			});
		}
		// Named as their round names them, where they have one.
		for (const round of rounds.list()) {
			for (const agent of round.agents) {
				const cancelId = rounds.cancelIdOf(round.id, agent.index);
				if (cancelId && byCancelId.has(cancelId)) {
					byCancelId.set(cancelId, {
						ref: agent.id,
						round,
						agent,
						cancelId,
						label: `${agent.id} ${agent.name}`,
					});
				}
			}
		}
		return { targets: [...byCancelId.values()], unknown: [] };
	}
	const targets: ResolvedAgent[] = [];
	const unknown: string[] = [];
	for (const ref of named) {
		const resolved = resolveAgent(sessionId, ref);
		if (resolved) {
			targets.push(resolved);
		} else {
			unknown.push(ref);
		}
	}
	return { targets, unknown };
}

function notFound(sessionId: string, ref: string): string {
	const rounds = roundsFor(sessionId).list();
	const recent = rounds
		.slice(-3)
		.flatMap((round) => round.agents.map((agent) => agent.id));
	return `No agent "${ref}" in this session.${
		recent.length > 0
			? ` Agents of the latest rounds: ${recent.slice(-12).join(", ")}; agents_status lists them all.`
			: ""
	}`;
}

function stateOf(target: ResolvedAgent): string {
	if (!target.agent) {
		return "running";
	}
	const control = target.cancelId
		? subagentCancellation.inspect(target.cancelId)
		: undefined;
	return control?.awaitingLead ? "awaiting_lead" : target.agent.state;
}

const agentIdProperty = {
	type: "string",
	description:
		"The agent's id as its round gives it (r3-2), or its name. agents_status lists them.",
};

const agentsProperty = {
	type: "array",
	items: { type: "string" },
	description:
		"The agents, by id (r3-2) or name. Leave it out to mean every agent still running.",
};

export const REQUEUE_AGENT_DESCRIPTION =
	"Stop an agent at its next turn boundary and put it back in the placement queue, keeping its transcript: it continues where it was, it does not start over. The harness picks the node -- you cannot, and never need to: waits on a server are already retried on their own. `reason` is for you and the log; `slow` or `malfunction` also sends it anywhere but its current node when another has room. Use it for an agent crawling on an overloaded node or behaving oddly there; use restart_agent when its work itself went wrong.";

export const RESTART_AGENT_DESCRIPTION =
	"Start an agent over from its original task, discarding its transcript and its workspace changes. It keeps its place in the round, its check, its sampler (a random seed is drawn again) and its iteration cap. `instructions` are added to its task as revised instructions -- say what to do differently. Works on a running agent and on one that has finished, failed or been stopped; a finished agent's new report reaches you when it ends.";

export const RESUME_AGENT_DESCRIPTION =
	"Continue an agent that stopped at its iteration cap and is waiting for you (awaiting_lead), with `extra_iterations` more turns. It carries on from where it stopped, with its transcript and its changes. To take its work as it is instead, stop it (stop_agents); to start it over, restart_agent.";

export const RETRY_FAILED_DESCRIPTION =
	"Run a round's failed and cancelled agents again, each from the task it was originally given (and any revised instructions from a restart), with the same check, sampler and cap. `agent_ids` limits it to some of them. The round reports again when they finish. Infrastructure trouble never fails an agent -- it is retried on its own -- so what this reruns failed on its task: consider restart_agent with instructions for one that will fail the same way again.";

export const MESSAGE_AGENTS_DESCRIPTION =
	"Leave a message for running agents. Each reads it at its next turn, between tool calls, and carries on with it in mind. Use it to pass on a change of plan, a constraint, or an answer.";

export const STOP_AGENTS_DESCRIPTION =
	"Stop running agents. A stopped agent reports as cancelled by you, with the work it had done so far; the rest of its round carries on. An agent waiting at its iteration cap is ended with its work kept.";

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function idsOf(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is string => typeof entry === "string" && !!entry.trim(),
			)
		: [];
}

export interface LeadAgentToolsOptions {
	sessionId: string;
	/** What each tool did, in words: the side turn reports it to the lead. */
	onAction?: (line: string) => void;
}

/** requeue_agent, restart_agent, resume_agent, retry_failed. */
export function createLeadAgentControlTools(
	options: LeadAgentToolsOptions,
): AgentTool[] {
	const { sessionId } = options;
	const note = (line: string) => {
		options.onAction?.(line);
		return line;
	};
	return [
		{
			name: REQUEUE_AGENT_TOOL_NAME,
			description: REQUEUE_AGENT_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: {
					agent_id: agentIdProperty,
					reason: {
						type: "string",
						description:
							"Why: `slow`, `malfunction`, or your own words. `slow` and `malfunction` avoid its current node.",
					},
				},
				required: ["agent_id"],
			},
			execute: async (input: unknown) => {
				const record = (input ?? {}) as Record<string, unknown>;
				const ref = textOf(record.agent_id) ?? "";
				const target = resolveAgent(sessionId, ref);
				if (!target) {
					return notFound(sessionId, ref);
				}
				const state = stateOf(target);
				if (!target.cancelId || !LIVE_STATES.has(state as never)) {
					return `${target.label} is ${state}, not running: nothing to requeue. restart_agent or retry_failed runs it again.`;
				}
				if (state === "awaiting_lead") {
					return `${target.label} is waiting for you at its iteration cap: resume_agent continues it where it is.`;
				}
				const reason = textOf(record.reason);
				const avoidNodeId =
					reason && NODE_REASONS.test(reason)
						? target.agent?.nodeId
						: undefined;
				if (
					!subagentCancellation.requeue(target.cancelId, {
						...(reason ? { reason } : {}),
						...(avoidNodeId ? { avoidNodeId } : {}),
					})
				) {
					return `${target.label} cannot be requeued: it is not running inside a queue that could take it back (or it is ending). stop_agents or restart_agent instead.`;
				}
				const where = target.agent?.nodeLabel ?? target.agent?.nodeId;
				return note(
					`Requeued ${target.label}${reason ? ` (${reason})` : ""}: it stops at its next turn boundary and goes back in the queue with its transcript${
						avoidNodeId && where
							? `, placed anywhere but ${where} when another node has room`
							: ""
					}.`,
				);
			},
		} as AgentTool,
		{
			name: RESTART_AGENT_TOOL_NAME,
			description: RESTART_AGENT_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: {
					agent_id: agentIdProperty,
					instructions: {
						type: "string",
						description:
							"What to do differently, added to its task as revised instructions.",
					},
				},
				required: ["agent_id"],
			},
			execute: async (input: unknown, context: AgentToolContext) => {
				const record = (input ?? {}) as Record<string, unknown>;
				const ref = textOf(record.agent_id) ?? "";
				const instructions = textOf(record.instructions);
				const target = resolveAgent(sessionId, ref);
				if (!target) {
					return notFound(sessionId, ref);
				}
				const said = instructions ? " with your revised instructions" : "";
				if (target.cancelId && subagentCancellation.inspect(target.cancelId)) {
					if (target.agent && instructions) {
						target.agent.revisedInstructions = instructions;
					}
					subagentCancellation.restart(target.cancelId, {
						...(instructions ? { instructions } : {}),
					});
					return note(
						`Restarted ${target.label}${said}: it starts over from its task in a fresh workspace.`,
					);
				}
				if (!target.round || !target.agent) {
					return `${target.label} is not running and has no round to run it again from.`;
				}
				const started = roundsFor(sessionId).rerun(
					target.round.id,
					target.agent.index,
					context,
					instructions ? { instructions } : undefined,
				);
				if (!started.started) {
					return `${target.label} cannot be restarted: ${started.why}.`;
				}
				return note(
					`Restarted ${target.label}${said}: it runs again from its task; round ${target.round.id} reports again when it ends.`,
				);
			},
		} as AgentTool,
		{
			name: RESUME_AGENT_TOOL_NAME,
			description: RESUME_AGENT_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: {
					agent_id: agentIdProperty,
					extra_iterations: {
						type: "integer",
						minimum: 1,
						description: "How many more turns it may take.",
					},
				},
				required: ["agent_id", "extra_iterations"],
			},
			execute: async (input: unknown) => {
				const record = (input ?? {}) as Record<string, unknown>;
				const ref = textOf(record.agent_id) ?? "";
				const extra = Math.floor(Number(record.extra_iterations));
				if (!Number.isFinite(extra) || extra < 1) {
					return `extra_iterations must be a whole number of at least 1 (got ${JSON.stringify(record.extra_iterations)}).`;
				}
				const target = resolveAgent(sessionId, ref);
				if (!target) {
					return notFound(sessionId, ref);
				}
				if (
					!target.cancelId ||
					!subagentCancellation.resumeSuspended(target.cancelId, extra)
				) {
					return `${target.label} is ${stateOf(target)}, not waiting at its iteration cap: there is nothing to resume.`;
				}
				const cap =
					target.agent?.maxIterations !== undefined
						? ` (cap now ${target.agent.maxIterations + extra})`
						: "";
				if (target.agent?.maxIterations !== undefined) {
					target.agent.maxIterations += extra;
				}
				return note(
					`Resumed ${target.label} with ${extra} more iteration${extra === 1 ? "" : "s"}${cap}.`,
				);
			},
		} as AgentTool,
		{
			name: RETRY_FAILED_TOOL_NAME,
			description: RETRY_FAILED_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: {
					round_id: {
						type: "string",
						description: "The round (r3), as its call's result gives it.",
					},
					agent_ids: {
						type: "array",
						items: { type: "string" },
						description:
							"Only these of its failed or cancelled agents, by id or name.",
					},
				},
				required: ["round_id"],
			},
			execute: async (input: unknown, context: AgentToolContext) => {
				const record = (input ?? {}) as Record<string, unknown>;
				const rounds = roundsFor(sessionId);
				const roundId = textOf(record.round_id) ?? "";
				const round = rounds.get(roundId);
				if (!round) {
					const known = rounds
						.list()
						.map((entry) => entry.id)
						.slice(-10);
					return `No round ${roundId}.${known.length > 0 ? ` Rounds: ${known.join(", ")}.` : ""}`;
				}
				const only = idsOf(record.agent_ids).map((ref) => ref.toLowerCase());
				const picked = round.agents.filter(
					(agent) =>
						(agent.state === "failed" || agent.state === "cancelled") &&
						(only.length === 0 ||
							only.includes(agent.id.toLowerCase()) ||
							only.includes(agent.name.toLowerCase())),
				);
				if (picked.length === 0) {
					return `Round ${round.id} has no ${only.length > 0 ? "such " : ""}failed or cancelled agents to run again.`;
				}
				const started: string[] = [];
				const refused: string[] = [];
				for (const agent of picked) {
					const result = rounds.rerun(round.id, agent.index, context);
					if (result.started) {
						started.push(`${agent.id} ${agent.name}`);
					} else {
						refused.push(`${agent.id} ${agent.name} (${result.why})`);
					}
				}
				return note(
					[
						started.length > 0
							? `Running again from their tasks: ${started.join(", ")}. Round ${round.id} reports again when they finish.`
							: "",
						refused.length > 0 ? `Not run: ${refused.join(", ")}.` : "",
					]
						.filter(Boolean)
						.join(" "),
				);
			},
		} as AgentTool,
	];
}

/** message_agents and stop_agents, by id or name, from any turn of the lead. */
export function createLeadAgentMessagingTools(
	options: LeadAgentToolsOptions,
): AgentTool[] {
	const { sessionId } = options;
	const note = (line: string) => {
		options.onAction?.(line);
		return line;
	};
	return [
		{
			name: MESSAGE_AGENTS_TOOL_NAME,
			description: MESSAGE_AGENTS_DESCRIPTION,
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
				const { text, agents } = (input ?? {}) as {
					text?: string;
					agents?: string[];
				};
				if (!text?.trim()) {
					return "Nothing sent: `text` is empty.";
				}
				const { targets, unknown } = resolveTargets(sessionId, agents);
				const reached = targets.filter(
					(agent) =>
						agent.cancelId &&
						subagentCancellation.message(agent.cancelId, text),
				);
				const missed = [
					...unknown,
					...targets
						.filter((agent) => !reached.includes(agent))
						.map((agent) => `${agent.label} (not running)`),
				];
				const line = `Sent to ${reached.length} agent(s): ${
					reached.map((agent) => agent.label).join(", ") || "none"
				}.${missed.length > 0 ? ` Not reached: ${missed.join(", ")}.` : ""}`;
				options.onAction?.(`${line} Message: "${text.trim()}"`);
				return line;
			},
		} as AgentTool,
		{
			name: STOP_AGENTS_TOOL_NAME,
			description: STOP_AGENTS_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: { agents: agentsProperty },
			},
			execute: async (input: unknown) => {
				const { agents } = (input ?? {}) as { agents?: string[] };
				const { targets, unknown } = resolveTargets(sessionId, agents);
				const stopped = targets.filter(
					(agent) =>
						agent.cancelId &&
						subagentCancellation.cancel(agent.cancelId, "lead"),
				);
				const missed = [
					...unknown,
					...targets
						.filter((agent) => !stopped.includes(agent))
						.map((agent) => `${agent.label} (not running)`),
				];
				return note(
					`Stopped ${stopped.length} agent(s): ${
						stopped.map((agent) => agent.label).join(", ") || "none"
					}.${missed.length > 0 ? ` Not stopped: ${missed.join(", ")}.` : ""}`,
				);
			},
		} as AgentTool,
	];
}

/** All six, for the lead's own turn. */
export function createLeadAgentTools(
	options: LeadAgentToolsOptions,
): AgentTool[] {
	return [
		...createLeadAgentControlTools(options),
		...createLeadAgentMessagingTools(options),
	];
}
