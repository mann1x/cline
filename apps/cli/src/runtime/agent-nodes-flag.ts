/**
 * `--agent-node`, the CLI's way of naming where delegated agents run.
 *
 * The extension has a tab per node; here a node is one `key=value` string, and
 * the flag repeats. `model` is the only required part, because a node on the
 * session's own provider and endpoint is the ordinary case -- what makes it a
 * node is that agents run there under a capacity of its own.
 *
 *     --agent-node model=small,capacity=8
 *     --agent-node model=big,url=http://other:8240/v1,priority=2,capacity=2
 *
 * Priority 1 is highest and a lower tier is used only when no node above it
 * has room; within a tier, round-robin. When every node is full the next agent
 * waits rather than failing.
 */
import type { CoreSessionConfig } from "@cline/core";

type AgentNodeConfig = NonNullable<CoreSessionConfig["agentNodes"]>[number];

const clamp = (
	value: string | undefined,
	min: number,
	max: number,
	fallback: number,
): number => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(parsed)));
};

export function parseAgentNodeFlags(
	values: readonly string[] | undefined,
): AgentNodeConfig[] {
	if (!values || values.length === 0) {
		return [];
	}
	return values.map((entry, index) => {
		const fields = new Map<string, string>();
		for (const part of entry.split(",")) {
			const at = part.indexOf("=");
			if (at > 0) {
				fields.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
			}
		}
		const modelId = fields.get("model");
		if (!modelId) {
			throw new Error(
				`--agent-node "${entry}" names no model. Expected model=<id>[,url=<baseUrl>][,provider=<id>][,priority=1-10][,capacity=<n>].`,
			);
		}
		const providerId = fields.get("provider");
		const baseUrl = fields.get("url");
		return {
			id: `node${index + 1}`,
			priority: clamp(fields.get("priority"), 1, 10, 1),
			// 1, as everywhere else a count is missing: it is what one slot
			// gives you, and the number under which nothing queues unseen.
			capacity: clamp(fields.get("capacity"), 1, Number.MAX_SAFE_INTEGER, 1),
			connection: {
				...(providerId ? { providerId } : {}),
				modelId,
				...(baseUrl ? { baseUrl } : {}),
			},
		} as AgentNodeConfig;
	});
}
