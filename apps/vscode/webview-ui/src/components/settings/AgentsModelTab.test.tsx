import { PRIMARY_AGENT_NODE_ID, parseAgentNodes } from "@shared/agent-nodes"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	state: { agentsModeApiConfiguration: "", agentNodes: "" } as Record<string, string>,
	updateSettings: vi.fn(async () => {}),
	scopedProps: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({ StateServiceClient: { updateSettings: mocks.updateSettings } }))
vi.mock("@shared/proto/cline/state", () => ({ UpdateSettingsRequest: { create: (patch: unknown) => patch } }))
// The real one renders the whole provider form; what this suite asks is which
// snapshot it was handed and where its writes go.
vi.mock("./ScopedModelTab", () => ({
	default: (props: Record<string, unknown>) => {
		mocks.scopedProps.push(props)
		return <div data-testid="scoped-panel" />
	},
}))
vi.mock("../mcp/configuration/McpConfigurationView", () => ({
	TabButton: ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
}))

import AgentsModelTab from "./AgentsModelTab"

const lastNodesWritten = () => {
	const calls = mocks.updateSettings.mock.calls as unknown as Array<[{ agentNodes?: string }]>
	return parseAgentNodes(calls[calls.length - 1][0].agentNodes)
}

describe("the Agents tab with nodes", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.scopedProps.length = 0
		mocks.state = { agentsModeApiConfiguration: '{"global":{"act":{}}}', agentNodes: "" }
	})

	// An install that predates nodes stores nothing, and must still show the
	// Agents tab exactly as it was: one node, its configuration in the key it
	// has always been in.
	it("shows Node1 alone reading the original agents configuration", () => {
		render(<AgentsModelTab />)

		expect(screen.getByText("Node1")).toBeTruthy()
		const props = mocks.scopedProps[mocks.scopedProps.length - 1]
		expect(props.storedSnapshot).toBe('{"global":{"act":{}}}')
		// No override: Node1 still writes to agentsModeApiConfiguration.
		expect(props.writeSnapshot).toBeUndefined()
	})

	it("adds a node at priority 1 and selects it", async () => {
		render(<AgentsModelTab />)

		fireEvent.click(screen.getByText("+"))
		await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled())

		const nodes = lastNodesWritten()
		expect(nodes).toHaveLength(2)
		expect(nodes[1].priority).toBe(1)
	})

	// Two nodes on one provider are two configurations. Sharing a sampler key
	// makes the second silently overwrite the first.
	it("gives a second node its own storage and its own sampler key", async () => {
		mocks.state = {
			agentsModeApiConfiguration: '{"global":{"act":{}}}',
			agentNodes: JSON.stringify([
				{ id: PRIMARY_AGENT_NODE_ID, priority: 1 },
				{ id: "b", priority: 2, snapshot: '{"global":{"act":{"x":1}}}' },
			]),
		}
		render(<AgentsModelTab />)

		fireEvent.click(screen.getByText("Node2"))

		const props = mocks.scopedProps[mocks.scopedProps.length - 1]
		expect(props.storedSnapshot).toBe('{"global":{"act":{"x":1}}}')
		expect(typeof props.writeSnapshot).toBe("function")
		expect(props.scopeKey).toBe("agentsModeApiConfiguration::b")

		// And that write lands in the node, not in the shared key.
		await (props.writeSnapshot as (json: string) => Promise<void>)('{"global":{"act":{"x":2}}}')
		expect(lastNodesWritten()[1].snapshot).toBe('{"global":{"act":{"x":2}}}')
	})

	it("writes the priority typed on the selected node", async () => {
		mocks.state = {
			agentsModeApiConfiguration: "",
			agentNodes: JSON.stringify([
				{ id: PRIMARY_AGENT_NODE_ID, priority: 1 },
				{ id: "b", priority: 1, snapshot: "" },
			]),
		}
		render(<AgentsModelTab />)

		fireEvent.click(screen.getByText("Node2"))
		fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "3" } })
		await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled())

		const nodes = lastNodesWritten()
		expect(nodes.find((node) => node.id === "b")?.priority).toBe(3)
		expect(nodes[0].priority).toBe(1)
	})

	it("removes the shown node and goes back to Node1", async () => {
		mocks.state = {
			agentsModeApiConfiguration: '{"global":{"act":{}}}',
			agentNodes: JSON.stringify([
				{ id: PRIMARY_AGENT_NODE_ID, priority: 1 },
				{ id: "b", priority: 1, snapshot: '{"global":{"act":{"x":1}}}' },
			]),
		}
		render(<AgentsModelTab />)

		fireEvent.click(screen.getByText("Node2"))
		expect(mocks.scopedProps[mocks.scopedProps.length - 1].storedSnapshot).toBe('{"global":{"act":{"x":1}}}')

		fireEvent.click(screen.getByLabelText("Remove Node2"))
		await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled())

		expect(lastNodesWritten()).toHaveLength(1)
		expect(mocks.scopedProps[mocks.scopedProps.length - 1].writeSnapshot).toBeUndefined()
	})

	// The settings this reads are shared state: another window, or a profile
	// load, can take the selected node away without this panel doing anything.
	// Rendering a node that is no longer in the list would show -- and write --
	// a configuration that has nowhere to go.
	it("falls back to Node1 when the selected node disappears from under it", () => {
		mocks.state = {
			agentsModeApiConfiguration: '{"global":{"act":{}}}',
			agentNodes: JSON.stringify([
				{ id: PRIMARY_AGENT_NODE_ID, priority: 1 },
				{ id: "b", priority: 1, snapshot: '{"global":{"act":{"x":1}}}' },
			]),
		}
		const { rerender } = render(<AgentsModelTab />)
		fireEvent.click(screen.getByText("Node2"))

		mocks.state = { agentsModeApiConfiguration: '{"global":{"act":{}}}', agentNodes: "" }
		rerender(<AgentsModelTab />)

		expect(screen.queryByText("Node2")).toBeNull()
		const props = mocks.scopedProps[mocks.scopedProps.length - 1]
		expect(props.storedSnapshot).toBe('{"global":{"act":{}}}')
		expect(props.writeSnapshot).toBeUndefined()
	})
})
