import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import type { McpHub } from "@/services/mcp/McpHub"
import { isToolAutoApproved } from "./sdk-tool-policies"

describe("isToolAutoApproved", () => {
	it("does not auto-approve command tools by default", () => {
		expect(isToolAutoApproved("run_commands", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(false)
	})

	it("uses executeSafeCommands as the single command approval flag", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				executeSafeCommands: false,
				executeAllCommands: true,
			},
		}

		expect(isToolAutoApproved("run_commands", settings)).toBe(false)
	})

	// `useMcp` is the gate and the per-tool flag is the grant: the toggle alone
	// auto-approving every tool on every server is the behaviour this fork
	// replaced, so both halves are asserted here.
	const mcpSettings = (useMcp: boolean) => ({
		...DEFAULT_AUTO_APPROVAL_SETTINGS,
		actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp },
	})

	const hubWith = (autoApprove: boolean) =>
		({
			getServers: () => [{ name: "firecrawl", tools: [{ name: "scrape", autoApprove }] }],
		}) as unknown as McpHub

	it("auto-approves an MCP tool the user marked auto-approve on its server", () => {
		expect(isToolAutoApproved("firecrawl__scrape", mcpSettings(true), hubWith(true))).toBe(true)
	})

	it("prompts for an MCP tool the user has not marked, even with the toggle on", () => {
		expect(isToolAutoApproved("firecrawl__scrape", mcpSettings(true), hubWith(false))).toBe(false)
	})

	it("prompts for a marked MCP tool once the Use MCP servers toggle is off", () => {
		expect(isToolAutoApproved("firecrawl__scrape", mcpSettings(false), hubWith(true))).toBe(false)
	})

	it("prompts for an MCP tool when no hub is available to consult", () => {
		expect(isToolAutoApproved("firecrawl__scrape", mcpSettings(true))).toBe(false)
	})
})
