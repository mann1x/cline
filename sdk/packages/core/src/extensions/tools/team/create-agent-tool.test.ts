import { describe, expect, it } from "vitest";
import { createCreateAgentTool } from "./create-agent-tool";

describe("create_agent", () => {
	it("names the argument that is missing instead of failing inside the writer", async () => {
		// Measured on pandorum, 2026-10-11: called with a name and a system
		// prompt and no description, the tool answered "Cannot read properties
		// of undefined (reading 'trim')".
		const tool = createCreateAgentTool({ workspaceRoot: "/nowhere" });
		const run = tool.execute as (input: unknown, context: unknown) => unknown;

		await expect(
			(async () =>
				run(
					{ name: "js-inspector", systemPrompt: "Inspect JavaScript." },
					{},
				))(),
		).rejects.toThrow(/description/);
	});
});
