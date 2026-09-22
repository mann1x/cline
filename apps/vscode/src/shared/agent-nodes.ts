/**
 * Agent Nodes: the connections delegated agents are placed on.
 *
 * A node is a complete agents configuration -- provider, model, context
 * window, sampler, thinking budget -- plus a priority. Up to ten; 1 is the
 * highest priority, and a lower tier is used only when no node in a higher one
 * has a free slot. Placement itself lives in `@cline/core`
 * (`agent-placement.ts`); this module is only what is stored.
 *
 * **Node1 is the Agents tab as it always was.** Its configuration stays in
 * `agentsModeApiConfiguration`, so an install that predates nodes needs no
 * migration: an unset list reads as Node1 alone. Only Node1's priority is kept
 * here. Every other node carries its configuration in `snapshot`, in the same
 * JSON-string format that key uses, so the tab and the host read both alike.
 *
 * **The id is the identity, the label is only a position.** Removing Node4 of
 * six makes the last two read Node4 and Node5; their ids, and so their
 * configurations and their active profiles, do not move.
 */

export const MAX_AGENT_NODES = 10
export const PRIMARY_AGENT_NODE_ID = "primary"
export const MIN_AGENT_NODE_PRIORITY = 1
export const MAX_AGENT_NODE_PRIORITY = 10
/** New nodes share tier 1 and round-robin with Node1 until told otherwise. */
export const DEFAULT_AGENT_NODE_PRIORITY = 1

export interface AgentNodeRecord {
	id: string
	priority: number
	/** The node's configuration. Absent on Node1, whose lives in its own key. */
	snapshot?: string
}

function clampPriority(value: unknown): number {
	const parsed = typeof value === "string" ? Number(value) : value
	if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
		return DEFAULT_AGENT_NODE_PRIORITY
	}
	return Math.min(MAX_AGENT_NODE_PRIORITY, Math.max(MIN_AGENT_NODE_PRIORITY, Math.floor(parsed)))
}

function primary(priority: unknown = DEFAULT_AGENT_NODE_PRIORITY): AgentNodeRecord {
	return { id: PRIMARY_AGENT_NODE_ID, priority: clampPriority(priority) }
}

/**
 * The stored list, always led by Node1 and never longer than ten.
 *
 * Tolerant on purpose: this is a settings string a user can edit, and the one
 * thing a bad value must not do is take Node1 away with it.
 */
export function parseAgentNodes(raw: string | undefined): AgentNodeRecord[] {
	let parsed: unknown
	try {
		parsed = raw ? JSON.parse(raw) : undefined
	} catch {
		parsed = undefined
	}
	const entries = Array.isArray(parsed) ? parsed : []
	const stored = entries.find(
		(entry): entry is Record<string, unknown> =>
			typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).id === PRIMARY_AGENT_NODE_ID,
	)
	const nodes: AgentNodeRecord[] = [primary(stored?.priority)]
	const seen = new Set([PRIMARY_AGENT_NODE_ID])
	for (const entry of entries) {
		if (nodes.length >= MAX_AGENT_NODES) {
			break
		}
		if (typeof entry !== "object" || entry === null) {
			continue
		}
		const record = entry as Record<string, unknown>
		if (typeof record.id !== "string" || record.id === "" || seen.has(record.id)) {
			continue
		}
		seen.add(record.id)
		nodes.push({
			id: record.id,
			priority: clampPriority(record.priority),
			snapshot: typeof record.snapshot === "string" ? record.snapshot : "",
		})
	}
	return nodes
}

export function serializeAgentNodes(nodes: readonly AgentNodeRecord[]): string {
	return JSON.stringify(nodes)
}

/**
 * An id no node in the list is using.
 *
 * Ids are minted from the clock so that a node added after one was removed can
 * never reuse a departed node's id and inherit its stored profile. Two adds
 * inside the same millisecond would collide though, and a collision is silent:
 * `addAgentNode` returns the list unchanged, so the tab simply does not
 * appear. A suffix is cheaper than explaining that.
 */
export function nextAgentNodeId(nodes: readonly AgentNodeRecord[], now: number = Date.now()): string {
	const base = `node-${now.toString(36)}`
	if (!nodes.some((node) => node.id === base)) {
		return base
	}
	for (let suffix = 1; ; suffix++) {
		const candidate = `${base}-${suffix}`
		if (!nodes.some((node) => node.id === candidate)) {
			return candidate
		}
	}
}

/** A new node at the end, empty, at priority 1. A no-op at ten. */
export function addAgentNode(nodes: readonly AgentNodeRecord[], id: string): AgentNodeRecord[] {
	if (nodes.length >= MAX_AGENT_NODES || nodes.some((node) => node.id === id)) {
		return [...nodes]
	}
	return [...nodes, { id, priority: DEFAULT_AGENT_NODE_PRIORITY, snapshot: "" }]
}

/** Node1 is never removed; it is the Agents tab itself. */
export function removeAgentNode(nodes: readonly AgentNodeRecord[], id: string): AgentNodeRecord[] {
	if (id === PRIMARY_AGENT_NODE_ID) {
		return [...nodes]
	}
	return nodes.filter((node) => node.id !== id)
}

export function setAgentNodePriority(nodes: readonly AgentNodeRecord[], id: string, priority: unknown): AgentNodeRecord[] {
	return nodes.map((node) => (node.id === id ? { ...node, priority: clampPriority(priority) } : node))
}

/** Ignored for Node1, whose configuration is `agentsModeApiConfiguration`. */
export function setAgentNodeSnapshot(nodes: readonly AgentNodeRecord[], id: string, snapshot: string): AgentNodeRecord[] {
	if (id === PRIMARY_AGENT_NODE_ID) {
		return [...nodes]
	}
	return nodes.map((node) => (node.id === id ? { ...node, snapshot } : node))
}

/** "Node1", "Node2", … by position. Display only. */
export function agentNodeLabels(nodes: readonly AgentNodeRecord[]): Record<string, string> {
	return Object.fromEntries(nodes.map((node, index) => [node.id, `Node${index + 1}`]))
}
