import { addAgentNode, PRIMARY_AGENT_NODE_ID, parseAgentNodes, removeAgentNode } from "@shared/agent-nodes"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import AgentNodeTabs from "./AgentNodeTabs"

vi.mock("../mcp/configuration/McpConfigurationView", () => ({
	TabButton: ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
}))

const nodesOf = (...ids: string[]) => ids.reduce((acc, id) => addAgentNode(acc, id), parseAgentNodes(undefined))

describe("the agent node tabs", () => {
	it("shows Node1 even with nothing stored, and offers no way to remove it", () => {
		render(
			<AgentNodeTabs
				nodes={parseAgentNodes(undefined)}
				onAdd={() => {}}
				onRemove={() => {}}
				onSelect={() => {}}
				selectedId={PRIMARY_AGENT_NODE_ID}
			/>,
		)

		expect(screen.getByText("Node1")).toBeTruthy()
		expect(screen.queryByLabelText("Remove Node1")).toBeNull()
	})

	// The number is a position, not a name. Removing the fourth of six has to
	// leave the last two reading Node4 and Node5 -- but their ids, which are
	// what their configurations are stored under, must not move with the label.
	it("renumbers the labels after a removal while the ids stay put", () => {
		const six = nodesOf("b", "c", "d", "e", "f")
		const five = removeAgentNode(six, "d")

		render(
			<AgentNodeTabs
				nodes={five}
				onAdd={() => {}}
				onRemove={() => {}}
				onSelect={() => {}}
				selectedId={PRIMARY_AGENT_NODE_ID}
			/>,
		)

		expect(screen.getByText("Node4")).toBeTruthy()
		expect(screen.getByText("Node5")).toBeTruthy()
		expect(screen.queryByText("Node6")).toBeNull()
		expect(five.map((node) => node.id)).toEqual([PRIMARY_AGENT_NODE_ID, "b", "c", "e", "f"])
	})

	// The trash sits inside the tab button, so without stopPropagation the
	// click selects the node on its way to removing it -- leaving the panel
	// briefly showing a node that is gone.
	it("removes without selecting when the trash is clicked", () => {
		const onRemove = vi.fn()
		const onSelect = vi.fn()
		render(
			<AgentNodeTabs
				nodes={nodesOf("b")}
				onAdd={() => {}}
				onRemove={onRemove}
				onSelect={onSelect}
				selectedId={PRIMARY_AGENT_NODE_ID}
			/>,
		)

		fireEvent.click(screen.getByLabelText("Remove Node2"))

		expect(onRemove).toHaveBeenCalledWith("b")
		expect(onSelect).not.toHaveBeenCalled()
	})

	it("stops offering + at ten nodes", () => {
		const ten = nodesOf("b", "c", "d", "e", "f", "g", "h", "i", "j")
		const onAdd = vi.fn()
		render(
			<AgentNodeTabs
				nodes={ten}
				onAdd={onAdd}
				onRemove={() => {}}
				onSelect={() => {}}
				selectedId={PRIMARY_AGENT_NODE_ID}
			/>,
		)

		expect(ten).toHaveLength(10)
		expect(screen.getByText("Node10")).toBeTruthy()
		const plus = screen.getByText("+").closest("button")
		expect(plus?.disabled).toBe(true)
	})
})
