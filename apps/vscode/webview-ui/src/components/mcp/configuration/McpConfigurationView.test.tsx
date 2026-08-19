import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import McpConfigurationView from "./McpConfigurationView"

const mocks = vi.hoisted(() => ({
	getLatestMcpServers: vi.fn(),
	setMcpServers: vi.fn(),
	remoteConfigSettings: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		remoteConfigSettings: mocks.remoteConfigSettings,
		setMcpServers: mocks.setMcpServers,
		environment: "production",
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	McpServiceClient: {
		getLatestMcpServers: mocks.getLatestMcpServers,
	},
}))

vi.mock("@shared/proto-conversions/mcp/mcp-server-conversion", () => ({
	convertProtoMcpServersToMcpServers: () => [],
}))

vi.mock("./tabs/add-server/AddRemoteServerForm", () => ({
	default: () => <div>Add Remote Server Form</div>,
}))

vi.mock("./tabs/add-server/AddLocalServerForm", () => ({
	default: () => <div>Add Local Server Form</div>,
}))

vi.mock("./tabs/installed/ConfigureServersView", () => ({
	default: () => <div>Configure Servers View</div>,
}))

describe("McpConfigurationView", () => {
	beforeEach(() => {
		mocks.getLatestMcpServers.mockResolvedValue({ mcpServers: [] })
		mocks.setMcpServers.mockReset()
		mocks.getLatestMcpServers.mockClear()
		mocks.remoteConfigSettings = {}
	})

	it("never renders the marketplace tab while keeping remote servers available", async () => {
		mocks.remoteConfigSettings = {
			blockPersonalRemoteMCPServers: false,
		}

		render(<McpConfigurationView onDone={vi.fn()} />)

		expect(screen.queryByRole("button", { name: "Marketplace" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Remote Servers" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Configure" })).toBeInTheDocument()
		expect(screen.getByText("Configure Servers View")).toBeInTheDocument()

		await waitFor(() => expect(mocks.getLatestMcpServers).toHaveBeenCalledTimes(1))
	})

	// A local server was always supported by the settings file and never
	// reachable from the UI — the only way to add one was to open the JSON.
	it("offers local servers alongside remote ones", async () => {
		render(<McpConfigurationView onDone={vi.fn()} />)

		const localTab = screen.getByRole("button", { name: "Local Servers" })
		expect(localTab).toBeInTheDocument()

		localTab.click()

		await waitFor(() => expect(screen.getByText("Add Local Server Form")).toBeInTheDocument())
	})

	it("keeps local servers available when remote ones are blocked", () => {
		// Blocking personal *remote* servers says nothing about a server running
		// on this machine.
		mocks.remoteConfigSettings = {
			blockPersonalRemoteMCPServers: true,
		}

		render(<McpConfigurationView onDone={vi.fn()} />)

		expect(screen.queryByRole("button", { name: "Remote Servers" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Local Servers" })).toBeInTheDocument()
	})

	it("hides remote servers only when personal remote MCP servers are blocked", () => {
		mocks.remoteConfigSettings = {
			blockPersonalRemoteMCPServers: true,
		}

		render(<McpConfigurationView initialTab="addRemote" onDone={vi.fn()} />)

		expect(screen.queryByRole("button", { name: "Marketplace" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Remote Servers" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Configure" })).toBeInTheDocument()
		expect(screen.queryByText("Add Remote Server Form")).not.toBeInTheDocument()
		expect(screen.getByText("Configure Servers View")).toBeInTheDocument()
	})
})
