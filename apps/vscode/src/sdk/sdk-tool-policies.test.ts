import { defaultMcpToolNameTransform } from "@cline/core"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import type { McpHub } from "@/services/mcp/McpHub"
import { buildToolPolicies, isToolAutoApproved } from "./sdk-tool-policies"

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

	// A server name with a space, or one long enough to be truncated, is not
	// registered as `server__tool`: the transform sanitizes it first. Splitting
	// the registered name then yields a server nothing matches, so a tool the
	// user had marked was asked about anyway.
	const awkwardHub = () =>
		({
			getServers: () => [
				{ name: "Microsoft Learn", tools: [{ name: "microsoft_docs_search", autoApprove: true }] },
				{
					name: "github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
					tools: [{ name: "sequentialthinking", autoApprove: true }],
				},
			],
		}) as unknown as McpHub

	it("resolves a marked tool whose server name the transform rewrote", () => {
		const registered = defaultMcpToolNameTransform({
			serverName: "Microsoft Learn",
			toolName: "microsoft_docs_search",
		})
		// The space is what rewrites it, not the length: any sanitizing at all
		// sends the name down the hashed branch, so the registered name is
		// neither the raw pair nor a plain substitution of it.
		expect(registered).not.toBe("Microsoft Learn__microsoft_docs_search")
		expect(registered).toMatch(/^Microsoft_Learn__microsoft_docs_search_[0-9a-f]{8}$/)
		expect(isToolAutoApproved(registered, mcpSettings(true), awkwardHub())).toBe(true)
	})

	it("resolves a marked tool whose registered name was truncated to a hash", () => {
		const registered = defaultMcpToolNameTransform({
			serverName: "github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
			toolName: "sequentialthinking",
		})
		// Long enough that the tool's own name is gone from the registered one,
		// which is exactly why the lookup cannot split it.
		expect(registered).not.toContain("sequentialthinking")
		expect(isToolAutoApproved(registered, mcpSettings(true), awkwardHub())).toBe(true)
	})
})

describe("buildToolPolicies", () => {
	// An unlisted tool is auto-approved by the SDK, so a policy key that never
	// matches a registered tool is not a missing prompt -- it is no gate at
	// all. Both of these servers were running ungated whatever the toggle said.
	it("keys MCP policies by the name the tool is registered under", () => {
		const hub = {
			getServers: () => [
				{ name: "Microsoft Learn", tools: [{ name: "microsoft_docs_search" }] },
				{ name: "firecrawl", tools: [{ name: "scrape" }] },
			],
		} as unknown as McpHub

		const policies = buildToolPolicies(DEFAULT_AUTO_APPROVAL_SETTINGS, hub)

		const registered = defaultMcpToolNameTransform({
			serverName: "Microsoft Learn",
			toolName: "microsoft_docs_search",
		})
		expect(policies[registered]).toEqual({ autoApprove: false })
		expect(policies["Microsoft Learn__microsoft_docs_search"]).toBeUndefined()
		// A name the transform leaves alone still lands where it always did.
		expect(policies["firecrawl__scrape"]).toEqual({ autoApprove: false })
	})
})
