import { describe, expect, it } from "vitest"
import {
	addAgentNode,
	agentNodeLabels,
	DEFAULT_AGENT_NODE_PRIORITY,
	MAX_AGENT_NODES,
	nextAgentNodeId,
	PRIMARY_AGENT_NODE_ID,
	parseAgentNodes,
	removeAgentNode,
	serializeAgentNodes,
	setAgentNodePriority,
	setAgentNodeSnapshot,
} from "./agent-nodes"

describe("agent nodes", () => {
	// Every install that predates nodes has no `agentNodes` at all, and its
	// Agents tab is exactly Node1: nothing to migrate, because Node1's
	// configuration never moved out of `agentsModeApiConfiguration`.
	it("reads an unset list as Node1 alone, at priority 1", () => {
		expect(parseAgentNodes("")).toEqual([{ id: PRIMARY_AGENT_NODE_ID, priority: DEFAULT_AGENT_NODE_PRIORITY }])
		expect(parseAgentNodes(undefined)).toEqual([{ id: PRIMARY_AGENT_NODE_ID, priority: 1 }])
		expect(parseAgentNodes("not json")).toEqual([{ id: PRIMARY_AGENT_NODE_ID, priority: 1 }])
	})

	it("always leads with Node1, even when the stored list does not", () => {
		const stored = JSON.stringify([{ id: "n-b", priority: 2, snapshot: "{}" }])
		expect(parseAgentNodes(stored).map((node) => node.id)).toEqual([PRIMARY_AGENT_NODE_ID, "n-b"])
	})

	it("round-trips", () => {
		const nodes = setAgentNodeSnapshot(addAgentNode(parseAgentNodes(""), "n-b"), "n-b", '{"global":{}}')
		expect(parseAgentNodes(serializeAgentNodes(nodes))).toEqual(nodes)
	})

	it("adds a node at priority 1 with an empty configuration", () => {
		const nodes = addAgentNode(parseAgentNodes(""), "n-b")
		expect(nodes.at(-1)).toEqual({ id: "n-b", priority: 1, snapshot: "" })
	})

	it("stops at ten", () => {
		let nodes = parseAgentNodes("")
		for (let index = 0; index < 20; index += 1) {
			nodes = addAgentNode(nodes, `n-${index}`)
		}
		expect(nodes).toHaveLength(MAX_AGENT_NODES)
	})

	// The id is the identity; the label is only where it sits. Removing Node4
	// of six makes Node5 and Node6 read Node4 and Node5 without either one's
	// configuration moving.
	it("renumbers labels on removal while ids stay put", () => {
		let nodes = parseAgentNodes("")
		for (const id of ["b", "c", "d", "e", "f"]) {
			nodes = addAgentNode(nodes, id)
		}
		const after = removeAgentNode(nodes, "d")
		expect(after.map((node) => node.id)).toEqual([PRIMARY_AGENT_NODE_ID, "b", "c", "e", "f"])
		expect(agentNodeLabels(after)).toEqual({
			[PRIMARY_AGENT_NODE_ID]: "Node1",
			b: "Node2",
			c: "Node3",
			e: "Node4",
			f: "Node5",
		})
	})

	it("never removes Node1", () => {
		const nodes = addAgentNode(parseAgentNodes(""), "b")
		expect(removeAgentNode(nodes, PRIMARY_AGENT_NODE_ID)).toEqual(nodes)
	})

	// Priority 0 is the lead's own PolyKV session, never a node.
	it("keeps a priority between 1 and 10", () => {
		const nodes = parseAgentNodes("")
		expect(setAgentNodePriority(nodes, PRIMARY_AGENT_NODE_ID, 0)[0].priority).toBe(1)
		expect(setAgentNodePriority(nodes, PRIMARY_AGENT_NODE_ID, 42)[0].priority).toBe(10)
		expect(setAgentNodePriority(nodes, PRIMARY_AGENT_NODE_ID, 3.7)[0].priority).toBe(3)
		const stored = JSON.stringify([{ id: PRIMARY_AGENT_NODE_ID, priority: "7" }])
		expect(parseAgentNodes(stored)[0].priority).toBe(7)
	})

	// Node1's configuration lives in its own key; a snapshot written against it
	// here would be a second copy that one of the two readers ignores.
	it("does not store a snapshot on Node1", () => {
		const nodes = setAgentNodeSnapshot(parseAgentNodes(""), PRIMARY_AGENT_NODE_ID, '{"global":{}}')
		expect(nodes[0]).toEqual({ id: PRIMARY_AGENT_NODE_ID, priority: 1 })
		const stored = JSON.stringify([{ id: PRIMARY_AGENT_NODE_ID, priority: 1, snapshot: "{}" }])
		expect(parseAgentNodes(stored)[0]).toEqual({ id: PRIMARY_AGENT_NODE_ID, priority: 1 })
	})

	it("drops duplicate and malformed entries", () => {
		const stored = JSON.stringify([
			{ id: PRIMARY_AGENT_NODE_ID, priority: 1 },
			{ id: "b", priority: 2, snapshot: "" },
			{ id: "b", priority: 3, snapshot: "" },
			{ priority: 1 },
			"nope",
		])
		expect(parseAgentNodes(stored).map((node) => node.id)).toEqual([PRIMARY_AGENT_NODE_ID, "b"])
	})
})

describe("minting an id", () => {
	// The clock is the source so that a node added after one was removed cannot
	// reuse a departed node's id and inherit its stored profile. Two adds in the
	// same millisecond are the case that breaks it, and the failure is silent:
	// addAgentNode returns the list unchanged and no tab appears.
	it("does not collide when two nodes are added in the same millisecond", () => {
		let nodes = parseAgentNodes(undefined)
		const first = nextAgentNodeId(nodes, 1_700_000_000_000)
		nodes = addAgentNode(nodes, first)
		const second = nextAgentNodeId(nodes, 1_700_000_000_000)

		expect(second).not.toBe(first)
		nodes = addAgentNode(nodes, second)
		expect(nodes).toHaveLength(3)
		expect(new Set(nodes.map((node) => node.id)).size).toBe(3)
	})

	it("keeps going past a second collision", () => {
		let nodes = parseAgentNodes(undefined)
		for (let i = 0; i < 4; i++) {
			nodes = addAgentNode(nodes, nextAgentNodeId(nodes, 1_700_000_000_000))
		}
		expect(new Set(nodes.map((node) => node.id)).size).toBe(5)
	})
})
