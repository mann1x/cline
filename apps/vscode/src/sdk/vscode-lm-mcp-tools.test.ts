import type { AgentTool } from "@cline/shared"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { buildVscodeMcpServerEntry, createVscodeLmMcpTools } from "./vscode-lm-mcp-tools"

type StubTool = { name: string; description: string; inputSchema?: unknown; tags: readonly string[] }

const lm = vscode.lm as unknown as {
	tools: StubTool[]
	invokeTool: (name: string, options: { input: unknown }, token?: unknown) => Promise<{ content: unknown[] }>
}

const originalInvoke = lm.invokeTool

function offer(tools: StubTool[]): void {
	lm.tools = tools
}

/** The tool VS Code registers for an MCP server, as `lm.tools` reports it. */
const figmaGetCode: StubTool = {
	name: "mcp_figma_get_code",
	description: "Return the code for the selected Figma node",
	inputSchema: { type: "object", properties: { nodeId: { type: "string" } } },
	tags: ["mcp"],
}

function byName(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((candidate) => candidate.name === name)
	if (!tool) {
		throw new Error(`no tool named ${name}; got ${tools.map((candidate) => candidate.name).join(", ")}`)
	}
	return tool
}

describe("createVscodeLmMcpTools", () => {
	afterEach(() => {
		lm.tools = []
		lm.invokeTool = originalInvoke
	})

	it("adopts only the tools VS Code tagged as MCP", async () => {
		offer([
			figmaGetCode,
			// Contributed by some other extension. `lm.tools` hands every
			// extension the whole workbench list, so the tag is the filter and
			// not a nicety.
			{ name: "copilot_searchCodebase", description: "Search", inputSchema: {}, tags: ["search"] },
		])

		const tools = await createVscodeLmMcpTools()

		expect(tools.map((tool) => tool.name)).toEqual(["vscode__figma_get_code"])
	})

	it("takes nothing when VS Code offers no MCP tools", async () => {
		offer([{ name: "copilot_searchCodebase", description: "Search", inputSchema: {}, tags: [] }])
		expect(await createVscodeLmMcpTools()).toEqual([])
	})

	it("invokes with VS Code's own id, not the name the model was given", async () => {
		offer([figmaGetCode])
		const invoke = vi.fn(async (_name: string, _options: { input: unknown }, _token?: unknown) => ({
			content: [new vscode.LanguageModelTextPart("const Button = () => {}")],
		}))
		lm.invokeTool = invoke as unknown as typeof lm.invokeTool

		const tools = await createVscodeLmMcpTools()
		const result = await byName(tools, "vscode__figma_get_code").execute({ nodeId: "1:23" }, {} as never)

		// The model sees `vscode__figma_get_code`; VS Code only answers to
		// `mcp_figma_get_code`.
		expect(invoke.mock.calls[0]?.[0]).toBe("mcp_figma_get_code")
		expect(invoke.mock.calls[0]?.[1]).toMatchObject({ input: { nodeId: "1:23" } })
		// The token is passed as undefined rather than left out: it belongs to
		// a chat request this extension does not have, and the API documents
		// undefined as the value for an invocation outside one.
		expect(invoke.mock.calls[0]?.[1]).toHaveProperty("toolInvocationToken", undefined)

		expect(result).toEqual({ content: [{ type: "text", text: "const Button = () => {}" }] })
	})

	it("keeps a part it cannot render rather than dropping it", async () => {
		offer([figmaGetCode])
		lm.invokeTool = (async () => ({
			content: [new vscode.LanguageModelTextPart("first"), new vscode.LanguageModelPromptTsxPart({ node: "x" })],
		})) as unknown as typeof lm.invokeTool

		const tools = await createVscodeLmMcpTools()
		const result = (await byName(tools, "vscode__figma_get_code").execute({}, {} as never)) as {
			content: { text: string }[]
		}

		expect(result.content[0]?.text).toContain("first")
		expect(result.content[0]?.text).toContain('"node":"x"')
	})

	it("offers nothing when the setting is off", async () => {
		offer([figmaGetCode])
		const configuration = vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({ get: () => false } as never)
		try {
			expect(await createVscodeLmMcpTools()).toEqual([])
		} finally {
			configuration.mockRestore()
		}
	})
})

describe("buildVscodeMcpServerEntry", () => {
	afterEach(() => {
		lm.tools = []
	})

	it("presents the borrowed tools as a server the panel can draw", async () => {
		offer([figmaGetCode])
		const entry = buildVscodeMcpServerEntry()

		expect(entry?.name).toBe("vscode")
		expect(entry?.disabled).toBe(false)
		// The tool name here is the one `isToolAutoApproved` recovers by
		// splitting `vscode__figma_get_code`, so it must not carry the prefix.
		expect(entry?.tools?.map((tool) => tool.name)).toEqual(["figma_get_code"])
		expect(entry?.tools?.[0]?.autoApprove).toBe(false)
	})

	it("marks the tools the user ticked", () => {
		offer([figmaGetCode])
		const configuration = vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (key: string) => (key === "vscodeMcpAutoApprove" ? ["figma_get_code"] : undefined),
		} as never)
		try {
			expect(buildVscodeMcpServerEntry()?.tools?.[0]?.autoApprove).toBe(true)
		} finally {
			configuration.mockRestore()
		}
	})

	it("is nothing at all when VS Code has no MCP servers", () => {
		offer([])
		expect(buildVscodeMcpServerEntry()).toBeUndefined()
	})

	it("still describes itself when switched off, so the tick box can be drawn", () => {
		offer([figmaGetCode])
		const configuration = vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (key: string) => (key === "vscodeMcpTools" ? false : undefined),
		} as never)
		try {
			const entry = buildVscodeMcpServerEntry()
			expect(entry?.disabled).toBe(true)
			expect(entry?.tools).toHaveLength(1)
		} finally {
			configuration.mockRestore()
		}
	})
})
