import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	ASK_LEAD_TOOL_NAME,
	delegatedAgentTools,
	formatQuestionForLead,
} from "./delegated-tools";

const tool = (name: string, tag = name): AgentTool =>
	({
		name,
		description: tag,
		inputSchema: { type: "object" },
		execute: async () => tag,
	}) as unknown as AgentTool;

describe("delegatedAgentTools", () => {
	// pandorum 2026-09-24 (yglnz): `check_file` was an unavailable tool twice,
	// and the agent then asked the user how to check braces without it.
	it("adds the host's stateless tools and leaves the rest of the host's out", () => {
		const tools = delegatedAgentTools(
			[tool("read_files"), tool("editor")],
			[
				tool("check_file"),
				tool("ask_lsp"),
				tool("list_files"),
				tool("run_commands", "terminal"),
				tool("browser"),
			],
		);
		expect(tools.map((entry) => entry.name).sort()).toEqual([
			"ask_lsp",
			"check_file",
			"editor",
			"list_files",
			"read_files",
		]);
	});

	it("lets a host tool replace the builtin of the same name", () => {
		const tools = delegatedAgentTools(
			[tool("list_files", "builtin")],
			[tool("list_files", "host")],
		);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.description).toBe("host");
	});

	// The same round waited 1,141 s for the user to answer an agent's question.
	it("turns an agent's ask_question into a report to the lead that ends its run", async () => {
		const tools = delegatedAgentTools(
			[tool(ASK_LEAD_TOOL_NAME, "asks the user")],
			[],
		);
		const ask = tools.find((entry) => entry.name === ASK_LEAD_TOOL_NAME);
		expect(ask?.description).not.toBe("asks the user");
		expect(ask?.lifecycle?.completesRun).toBe(true);
		const output = await ask?.execute(
			{
				question: "Which check?",
				options: ["node --check", "eslint (recommended)"],
			},
			{} as never,
		);
		expect(output).toBe(
			formatQuestionForLead("Which check?", [
				"node --check",
				"eslint (recommended)",
			]),
		);
		expect(String(output)).toContain("Nothing was asked of the user");
		expect(String(output)).toContain("- eslint (recommended)");
	});
});
