import { describe, expect, it } from "vitest";
import { createBuiltinTools } from "./index";
import { TaskGraphTracker } from "./task-graph/tracker";

/**
 * Every path inside a tool schema where an array's `items` node itself
 * declares a list `type` (as `["integer", "string"]`).
 *
 * Gemma 4's canonical chat template renders that one shape with
 * `item_value | map('upper') | list`, and llama.cpp's jinja engine implements
 * `map(attribute=...)` only: every request carrying such a tool fails with HTTP
 * 500 "map: filter-mapping not implemented" before generation (opencoti
 * llamafile, backup_models mail #2357, 2026-11-21, from task_update's
 * check/uncheck). A list type anywhere else renders fine there, measured: on a
 * plain property (skills.args) and on a property of an object inside `items`
 * (read_files files[].line_numbers), which the template only stringifies; and
 * `anyOf` on the `items` node does too.
 */
function listTypesInItems(
	node: unknown,
	path: string,
	isItems: boolean,
	out: string[],
): void {
	if (Array.isArray(node)) {
		node.forEach((entry, index) => {
			listTypesInItems(entry, `${path}[${index}]`, false, out);
		});
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const record = node as Record<string, unknown>;
	if (isItems && Array.isArray(record.type)) out.push(`${path}.type`);
	for (const [key, value] of Object.entries(record)) {
		listTypesInItems(value, `${path}.${key}`, key === "items", out);
	}
}

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
		const found: string[] = [];
		for (const tool of tools)
			listTypesInItems(tool.inputSchema, tool.name, false, found);
		expect(found).toEqual([]);
	});

	it("catches the shape it guards against", () => {
		const found: string[] = [];
		listTypesInItems(
			{
				properties: {
					check: { type: "array", items: { type: ["integer", "string"] } },
					plain: { type: ["string", "null"] },
					files: {
						type: "array",
						items: {
							type: "object",
							properties: { n: { type: ["boolean", "null"] } },
						},
					},
				},
			},
			"t",
			false,
			found,
		);
		expect(found).toEqual(["t.properties.check.items.type"]);
	});
});
