import { describe, expect, it, vi } from "vitest"

vi.mock("@/sdk/vscode-lm-mcp-tools", () => ({ VSCODE_MCP_SERVER_NAME: "vscode" }))

import { RESERVED_MCP_SERVER_NAME, stripReservedServerNames } from "./reserved-server-names"

describe("stripReservedServerNames", () => {
	it("leaves a settings object with no reserved name untouched", () => {
		const settings = { mcpServers: { linear: { command: "x" }, lsp: { command: "y" } } }
		const result = stripReservedServerNames(settings)

		expect(result.refused).toEqual([])
		expect(result.settings).toBe(settings)
	})

	// The collision that matters: the panel's switches for this name drive the
	// bridge, and its tools would take the bridge's vscode__* names.
	it("drops a server named vscode and reports it", () => {
		const settings = { mcpServers: { vscode: { command: "mine" }, linear: { command: "x" } } }
		const result = stripReservedServerNames(settings)

		expect(result.refused).toEqual([RESERVED_MCP_SERVER_NAME])
		expect(Object.keys(result.settings.mcpServers)).toEqual(["linear"])
	})

	// A schema error loads nothing; one reserved name must not.
	it("keeps every other server rather than refusing the file", () => {
		const settings = {
			mcpServers: { a: { command: "a" }, vscode: { command: "v" }, b: { command: "b" } },
		}
		const result = stripReservedServerNames(settings)

		expect(Object.keys(result.settings.mcpServers).sort()).toEqual(["a", "b"])
	})

	it("does not mutate the settings it was given", () => {
		const settings = { mcpServers: { vscode: { command: "v" }, a: { command: "a" } } }
		stripReservedServerNames(settings)

		expect(Object.keys(settings.mcpServers).sort()).toEqual(["a", "vscode"])
	})

	it("tolerates settings with no servers at all", () => {
		expect(stripReservedServerNames({}).refused).toEqual([])
		expect(stripReservedServerNames({ mcpServers: {} }).refused).toEqual([])
	})
})
