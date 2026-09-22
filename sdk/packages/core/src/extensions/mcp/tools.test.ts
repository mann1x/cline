import { describe, expect, it } from "vitest";

import { createMcpTools } from "./tools";

function provider(tools: Array<{ name: string; description?: string }>) {
	return {
		listTools: async () =>
			tools.map((t) => ({
				...t,
				inputSchema: { type: "object" as const, properties: {} },
			})),
		callTool: async () => ({ content: [] }),
	};
}

describe("createMcpTools", () => {
	// A provider takes a flat tool list, so the server survives only as a name
	// prefix -- and nothing tells the model the prefix denotes a server. Asked
	// to "use the MCP LSP server" it cannot connect that to lsp__* tools.
	it("names the server even when the tool has its own description", async () => {
		const [tool] = await createMcpTools({
			serverName: "lsp",
			// biome-ignore lint/suspicious/noExplicitAny: a stub provider, not the real transport
			provider: provider([
				{ name: "find_definition", description: "Jump to a symbol." },
			]) as any,
		});

		expect(tool.description).toContain("Jump to a symbol.");
		expect(tool.description).toContain('From the "lsp" MCP server.');
	});

	it("still names the server when the tool has no description", async () => {
		const [tool] = await createMcpTools({
			serverName: "lsp",
			// biome-ignore lint/suspicious/noExplicitAny: a stub provider, not the real transport
			provider: provider([{ name: "find_definition" }]) as any,
		});

		expect(tool.description).toContain("find_definition");
		expect(tool.description).toContain('From the "lsp" MCP server.');
	});

	// The editor bridge routes through this same builder under the synthetic
	// server name, so bridged tools say where they came from too.
	it("names the bridge for tools borrowed from VS Code", async () => {
		const [tool] = await createMcpTools({
			serverName: "vscode",
			// biome-ignore lint/suspicious/noExplicitAny: a stub provider, not the real transport
			provider: provider([
				{ name: "search", description: "Search the workspace." },
			]) as any,
		});

		expect(tool.description).toContain('From the "vscode" MCP server.');
	});

	// The name is load-bearing: isToolAutoApproved resolves a tool by splitting
	// on "__" and looking the server up, so this must not drift.
	it("keeps the serverName__toolName form the auto-approve lookup parses", async () => {
		const [tool] = await createMcpTools({
			serverName: "lsp",
			// biome-ignore lint/suspicious/noExplicitAny: a stub provider, not the real transport
			provider: provider([
				{ name: "find_definition", description: "x" },
			]) as any,
		});

		expect(tool.name).toBe("lsp__find_definition");
		expect(tool.source).toBe("mcp");
	});
});
