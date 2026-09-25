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
 *     --agent-node model=big,url=http://other:8240/v1,capacity=auto
 *     --agent-node model=small,capacity=8,window-share=30
 *
 * `capacity=auto` places without a ceiling of our own and lets the endpoint's
 * admission control do the refusing -- the right answer for an elastic server.
 * `capacity=0` is refused rather than read as either one: in the tab it means
 * the node is off, which is not something you say by passing a flag that adds
 * a node, and on a command line it usually means "no limit", which is `auto`.
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
				`--agent-node "${entry}" names no model. Expected model=<id>[,url=<baseUrl>][,provider=<id>][,priority=1-10][,capacity=<n>][,window-share=0-100].`,
			);
		}
		const capacity = fields.get("capacity");
		if (capacity !== undefined && Number(capacity) === 0) {
			throw new Error(
				`--agent-node "${entry}" has capacity=0. A node placed on runs at least one agent: write capacity=auto to let the endpoint decide, or drop the flag to leave the node out.`,
			);
		}
		// "Agent window": the floor an opencoti agent's session accepts, as a
		// share between the minimum one turn needs (0) and the node's window
		// (100). Refused rather than clamped when it is not a percentage: a
		// typo here silently changes how much of a server every agent books.
		const windowShareText = fields.get("window-share");
		let windowShare: number | undefined;
		if (windowShareText !== undefined) {
			const parsed = Number(windowShareText.replace(/%$/, ""));
			if (
				windowShareText === "" ||
				!Number.isFinite(parsed) ||
				parsed < 0 ||
				parsed > 100
			) {
				throw new Error(
					`--agent-node "${entry}" has window-share=${windowShareText}. It is a percentage from 0 (the minimum a turn needs) to 100 (the node's whole window).`,
				);
			}
			windowShare = Math.round(parsed);
		}
		const providerId = fields.get("provider");
		const baseUrl = fields.get("url");
		return {
			id: `node${index + 1}`,
			priority: clamp(fields.get("priority"), 1, 10, 1),
			// 1, as everywhere else a count is missing: it is what one slot
			// gives you, and the number under which nothing queues unseen.
			// `auto` is the elastic endpoint, whose count we do not know and
			// must not guess at -- infinity here is "we impose no ceiling",
			// and the endpoint still refuses what it cannot take.
			capacity:
				capacity === "auto"
					? Number.POSITIVE_INFINITY
					: clamp(capacity, 1, Number.MAX_SAFE_INTEGER, 1),
			...(windowShare !== undefined ? { windowShare } : {}),
			connection: {
				...(providerId ? { providerId } : {}),
				modelId,
				...(baseUrl ? { baseUrl } : {}),
			},
		} as AgentNodeConfig;
	});
}
