/**
 * The two per-agent controls every spawn tool offers the lead:
 * `max_iterations` (see `agent-iteration-cap.ts`) and `check` (see
 * `agent-check.ts`). Stated once here so that `spawn_agent`, its batch
 * entries, configured agents and `spawn_swarm` read them -- and describe them
 * -- the same way.
 */

import { z } from "zod";
import { AgentCheckSchema } from "./agent-check";
import { RESUME_AGENT_TOOL_NAME } from "./agent-iteration-cap";

/** Highest cap accepted; anything above is a typo, not a plan. */
export const MAX_ITERATIONS_CEILING = 100_000;

export const MaxIterationsField = z
	.union([z.number(), z.string()])
	.optional()
	.describe(
		"Most iterations (model turns) this agent may take; omit for no cap. At the cap it waits for you with its work kept.",
	);

/**
 * The controls a spawn tool offers the lead: its check.
 *
 * `max_iterations` is not offered (user ruling, 2026-09-28). No agent the lead
 * launches is capped by default, and a lead given the field set one anyway --
 * 25 on every agent of pandorum's h0o2o swarm -- and then reported "7 agents
 * reached their 25-iteration caps before completing" as a flaw of the harness.
 * What watches a long run instead is the lead being told every
 * {@link LEAD_ITERATION_NUDGE_EVERY} iterations to look at it. A cap the user
 * wrote into an agent file still applies, and a model that sends the field
 * anyway is ignored rather than refused (see {@link controlFields}).
 */
export const AgentControlFields = {
	check: AgentCheckSchema.optional(),
};

/** Iterations between the notes that ask the lead to look at a long-running agent. */
export const LEAD_ITERATION_NUDGE_EVERY = 60;

/**
 * `max_iterations` as a number, or `undefined` for the default.
 *
 * Tolerant of what models send: a numeric string, a float (floored), the
 * camel-cased name. What cannot be a cap -- zero, a negative, words -- is
 * refused with the reason rather than read as "no cap", which is the one
 * reading that turns a typo into an unbounded agent.
 */
export function readMaxIterations(raw: unknown): number | undefined {
	if (raw === undefined || raw === null || raw === "") {
		return undefined;
	}
	const value =
		typeof raw === "string" ? Number(raw.trim()) : (raw as number | unknown);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(
			`\`max_iterations\` is ${JSON.stringify(raw)}; it is a whole number of model turns, at least 1.`,
		);
	}
	const whole = Math.floor(value);
	if (whole < 1) {
		throw new Error(
			`\`max_iterations\` is ${JSON.stringify(raw)}; it is at least 1. Omit it for the default.`,
		);
	}
	return Math.min(whole, MAX_ITERATIONS_CEILING);
}

/** The field under either name a model uses for it. */
export function maxIterationsOf(input: unknown): number | undefined {
	if (!input || typeof input !== "object") {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	return readMaxIterations(record.max_iterations ?? record.maxIterations);
}

/**
 * How the system works and what the lead's part in it is. Swarm 2026-09-27:
 * the lead told 50 agents "DO NOT modify any file" for fear of concurrent
 * edits, gave review-only agents a check they could never pass, and never
 * applied a single revision -- it did not know that was its job.
 */
export const AGENT_SANDBOX_ROLE_NOTE =
	"How agents work: each runs in its own sandboxed copy of the workspace, so any number may read and edit the same files at once -- there is no concurrency problem to avoid, and no reason to forbid edits. Your files stay unchanged: each agent's edits come back to you as revisions. You are the synthesizer, and nothing merges on its own: read each report, inspect its revisions (`read_files` with `revision`), apply what is right (`restore_file`), reconcile agents that disagree, and verify the result yourself. ";

/** What a spawn tool's description says about the two controls. */
export const AGENT_CONTROLS_NOTE = `Agents run without an iteration cap; you are told every ${LEAD_ITERATION_NUDGE_EVERY} iterations of a long-running one, so you can check on it with \`agents_status\`. A configured agent whose file sets a cap stops at it and waits for you with its work kept: \`${RESUME_AGENT_TOOL_NAME}(agent_ids?)\` continues it, or \`stop_agents\` takes its work as it is. An agent the loop guard stops for sending the same call again waits for you the same way, reported as looping with the call it repeated: resume it with \`instructions\` saying what to do instead, or restart it. Per agent, or for the whole call (an agent's own wins): \`check: {command, expect, must?}\` is its oracle, and it is deterministic: when it says it is done, \`command\` runs in its own sandboxed copy of the workspace and must exit 0 with output matching the regex \`expect\` (\`must: "not_match"\`: not matching); on a fail it is shown the output and keeps working. It judges only that agent's own copy -- not the merged result, which is yours to check -- and a call-level check applies to every agent of the call: give it per agent to those whose edits it measures, never to review or analysis agents, which cannot pass it. It is told its check up front. Its report gives \`iterations\`/\`maxIterations\`, \`stopReason\` (\`iteration_cap\` or \`loop_guard\`) when either ended it, and \`oracle\` {status, exitCode, output}. `;
