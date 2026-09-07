/**
 * Hooks a caller attaches to one delegated run, carried on the tool context.
 *
 * A configured agent is reached through a tool, and a tool's only channel to
 * its implementation is the input and the context. The input belongs to the
 * model -- it is in the schema the model writes against -- so hooks that exist
 * for one call and one call only travel on `context.metadata`, which the host
 * already uses to say `delegatedByUser`.
 *
 * A function through a metadata bag is not pretty. The alternative is a
 * registry threaded through `createConfiguredAgentTools` at session build time,
 * which would mean the tool factory knowing about background runs, and a
 * background run is a thing a user starts long after the tools were built.
 * Reading and writing it live in this one file so the two ends cannot drift.
 */

import type { AgentHooks } from "@cline/shared";

/** Deliberately prefixed: `metadata` is a bag several layers write into. */
const DELEGATION_HOOKS_KEY = "clineDelegationHooks";

export function withDelegationHooks(
	metadata: Record<string, unknown> | undefined,
	hooks: AgentHooks | undefined,
): Record<string, unknown> | undefined {
	if (!hooks) {
		return metadata;
	}
	return { ...(metadata ?? {}), [DELEGATION_HOOKS_KEY]: hooks };
}

export function readDelegationHooks(
	metadata: Record<string, unknown> | undefined,
): AgentHooks | undefined {
	const value = metadata?.[DELEGATION_HOOKS_KEY];
	// Shape-checked rather than trusted: this arrives through an untyped bag,
	// and a wrong value here would be a crash inside the agent loop rather than
	// at the call that put it there.
	return value && typeof value === "object" ? (value as AgentHooks) : undefined;
}
