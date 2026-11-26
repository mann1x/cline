import { describe, expect, it } from "vitest"
import { addNode, connect, freeId, lineDiff, nodePortsOf, removeEdge, removeNodes, replaceNode } from "./edit"
import { pipelineGraph } from "./graph"
import { ask, settleReply, type ViewerPipelineDefinition } from "./model"

const base: ViewerPipelineDefinition = {
	name: "ship",
	nodes: [
		{ id: "test", type: "command", command: "bun test" },
		{ id: "ok", type: "if", when: "{{ $node.test.exit == 0 }}", after: ["test"] },
		{ id: "push", type: "command", command: "git push", after: ["ok.true"] },
		{ id: "fix", type: "agent", task: "Fix it", after: ["ok.false"] },
	],
}

describe("editing a pipeline draft", () => {
	it("adds a node after the picked one, on a branch's first output", () => {
		const { definition, id } = addNode(base, "command", "ok")
		expect(id).toBe("command")
		expect(definition.nodes.at(-1)).toEqual({ id: "command", type: "command", after: ["ok.true"], command: "echo hello" })
		expect(addNode(definition, "command").id).toBe("command-2")
		expect(freeId(base, "test")).toBe("test-2")
	})

	it("wires an output to a node once, and never a node to itself", () => {
		const wired = connect(base, "ok", "false", "push")
		expect(wired.nodes.find((node) => node.id === "push")?.after).toEqual(["ok.true", "ok.false"])
		expect(connect(wired, "ok", "false", "push")).toBe(wired)
		expect(connect(base, "push", undefined, "push")).toBe(base)
		// A plain node's handle is its only output.
		expect(connect(base, "test", undefined, "fix").nodes.find((node) => node.id === "fix")?.after).toEqual([
			"ok.false",
			"test",
		])
	})

	it("removes a node with every reference to it, and one edge by the canvas's id", () => {
		const without = removeNodes(base, ["ok"])
		expect(without.nodes.map((node) => node.id)).toEqual(["test", "push", "fix"])
		expect(without.nodes.find((node) => node.id === "push")).not.toHaveProperty("after")
		const unwired = removeEdge(base, "ok.true->push")
		expect(unwired.nodes.find((node) => node.id === "push")).not.toHaveProperty("after")
		expect(unwired.nodes.find((node) => node.id === "fix")?.after).toEqual(["ok.false"])
	})

	it("replaces a node from its JSON, renaming the references with it", () => {
		const next = replaceNode(base, "ok", JSON.stringify({ id: "green", type: "if", when: "{{ true }}", after: ["test"] }))
		if ("error" in next) throw new Error(next.error)
		expect(next.definition.nodes.map((node) => node.after ?? [])).toEqual([[], ["test"], ["green.true"], ["green.false"]])
		expect(replaceNode(base, "ok", "{")).toMatchObject({ error: expect.stringContaining("Not JSON") })
		expect(replaceNode(base, "ok", JSON.stringify({ id: "push", type: "if" }))).toEqual({
			error: "Another node is already push.",
		})
		expect(replaceNode(base, "ok", JSON.stringify({ id: "9x", type: "if" }))).toMatchObject({
			error: expect.stringContaining("`id`"),
		})
	})

	it("gives a branching node one handle per output on the canvas", () => {
		expect(nodePortsOf({ id: "s", type: "switch", cases: ["a", "b"], onError: "route" })).toEqual([
			"a",
			"b",
			"default",
			"error",
		])
		const graph = pipelineGraph(base)
		expect(graph.nodes.find((node) => node.id === "ok")?.data.ports).toEqual(["true", "false"])
		expect(graph.nodes.find((node) => node.id === "test")?.data.ports).toBeUndefined()
		expect(graph.edges.find((edge) => edge.target === "push")).toMatchObject({ source: "ok", port: "true" })
	})

	it("shows a proposal's change line by line", () => {
		expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "del", text: "b" },
			{ kind: "add", text: "B" },
			{ kind: "same", text: "c" },
			{ kind: "add", text: "d" },
		])
	})
})

describe("requests the extension answers", () => {
	it("settles the request a reply names, and ignores other messages", async () => {
		const sent: { id: number }[] = []
		const answer = ask((request) => sent.push(request as { id: number }), { type: "boardViewer/validate", definition: {} })
		expect(settleReply({ type: "boardViewer/data", data: {} })).toBe(false)
		expect(settleReply({ type: "boardViewer/reply", id: sent[0]?.id, ok: false, errors: ["no nodes"] })).toBe(true)
		await expect(answer).resolves.toEqual({ ok: false, errors: ["no nodes"], lines: [] })
	})
})
