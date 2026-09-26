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
		"Most iterations (model turns) this agent may take; omit for the default. At the cap it waits for you with its work kept.",
	);

/** The two fields, for a tool schema that offers them. */
export const AgentControlFields = {
	max_iterations: MaxIterationsField,
	check: AgentCheckSchema.optional(),
};

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

/** What a spawn tool's description says about the two controls. */
export const AGENT_CONTROLS_NOTE = `Per agent, or for the whole call (an agent's own wins): \`max_iterations\` caps its model turns (omit for the default); an agent that reaches it is not lost -- it stops and waits for you with its work kept, and \`${RESUME_AGENT_TOOL_NAME}(agent_id, extra_iterations)\` continues it, or \`stop_agents\` takes its work as it is. An agent the loop guard stops for sending the same call again waits for you the same way, reported as looping: resume it with \`instructions\` saying what to do instead, or restart it. \`check: {command, expect, must?}\` is its oracle: when it says it is done, \`command\` runs in its own sandboxed copy of the workspace and must exit 0 with output matching the regex \`expect\` (\`must: "not_match"\`: not matching); on a fail it is shown the output and keeps working. It is told its check up front. Its report gives \`iterations\`/\`maxIterations\`, \`stopReason\` (\`iteration_cap\` or \`loop_guard\`) when either ended it, and \`oracle\` {status, exitCode, output}. `;
