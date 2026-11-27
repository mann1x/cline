import { listTypesOnItems } from "@cline/shared";
import { TaskGraphTracker } from "@cline/taskboard";
import { describe, expect, it } from "vitest";
import { createBuiltinTools } from "./index";

// The shape, and why it matters: @cline/shared tools/template-safe-schema.ts
// (a list `type` on an array's `items` node fails Gemma 4's canonical
// template under llama.cpp's jinja; mail #2357). The runtime rewrites it on
// every request, MCP tools included; our own tools should not need it.
describe("tool schemas a Gemma 4 template can render", () => {
	it("no array item declares a list type, across every builtin and task-graph tool", () => {
		const tools = [
			...createBuiltinTools({
				cwd: "/w",
				enableReadFiles: true,
				enableSearch: true,
				enableBash: true,
				enableWebFetch: true,
				enableApplyPatch: true,
				enableEditor: true,
				enableGrep: true,
				enableSed: true,
				enableAwk: true,
				enableExtractDocument: true,
				enableSkills: true,
				enableAskQuestion: true,
				enableSubmitAndExit: true,
			}),
			...new TaskGraphTracker().tools(),
			...new TaskGraphTracker({ planMode: true }).tools(),
		];
		expect(tools.map((tool) => tool.name)).toContain("task_update");
		const found = tools.flatMap((tool) =>
			listTypesOnItems(tool.inputSchema, tool.name),
		);
		expect(found).toEqual([]);
	});
});
