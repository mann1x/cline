import { describe, expect, it } from "vitest";
import { toolResultForModel } from "../agent";
import {
	renderToolOutputForModel,
	renderToolResultText,
	TOOL_RESULT_SERIALIZED_JSON,
} from "./tool-result-text";

const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// The shapes are the ones the tools declare, not ones lifted from a run: a
// list of entries (read_files, run_commands, search_codebase), a single entry
// (editor, grep, list_files), a plain object (the team tools, a sub-agent's
// report), an MCP result, and text.
const SOURCE = 'def total(lines):\n    return round(sum(lines), 2)  # "net"\n';

describe("a tool result rendered as text", () => {
	it("writes a file the way the file reads, with no escapes in it", () => {
		const text = renderToolResultText([
			{ query: "/abs/src/invoice.py", result: SOURCE, success: true },
		]);
		expect(text).toBe(`/abs/src/invoice.py\n→ ${SOURCE}`);
		expect(text).not.toContain("\\n");
		expect(text).not.toContain('\\"');
	});

	it("lays entries out the way the compaction record does", () => {
		expect(
			renderToolResultText([
				{ query: "pytest -q", result: "3 passed", success: true },
				{ query: "ls missing", error: "No such file", success: false },
				{ query: "grep -n total", result: "", success: true },
				{ query: "make lint", success: false },
			]),
		).toBe(
			[
				"pytest -q",
				"→ 3 passed",
				"ls missing",
				"→ failed: No such file",
				"grep -n total",
				"→ (no output)",
				"make lint",
				"→ failed",
			].join("\n"),
		);
	});

	it("renders a single entry like one entry of a list", () => {
		const entry = {
			query: "Replaced line 12",
			result: "12 | return round(sum(lines), 2)",
			success: true,
		};
		expect(renderToolResultText(entry)).toBe(renderToolResultText([entry]));
	});

	it("writes any other object as key: value lines, its text as written", () => {
		const report = "Found the rounding.\n  Indented line kept as is.";
		expect(
			renderToolResultText({
				text: report,
				iterations: 4,
				finishReason: "completed",
				usage: { inputTokens: 1200, outputTokens: 300 },
			}),
		).toBe(
			[
				"text:",
				report,
				"iterations: 4",
				"finishReason: completed",
				"usage:",
				"  inputTokens: 1200",
				"  outputTokens: 300",
			].join("\n"),
		);
	});

	it("reads an MCP result as its text blocks", () => {
		expect(
			renderToolResultText({
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
				isError: false,
			}),
		).toBe("first\nsecond");
	});

	it("leaves text alone", () => {
		expect(renderToolResultText('{"a": 1}\n')).toBe('{"a": 1}\n');
	});
});

describe("a tool output as the model is sent it under text", () => {
	it("parses back a string the codec wrote from an object", () => {
		const entry = {
			query: "/abs/src/invoice.py",
			result: SOURCE,
			success: true,
		};
		expect(
			renderToolOutputForModel(JSON.stringify(entry), {
				serialized: TOOL_RESULT_SERIALIZED_JSON,
			}),
		).toBe(`/abs/src/invoice.py\n→ ${SOURCE}`);
	});

	it("never parses a string the tool itself returned", () => {
		const printed = '{"ok": true, "rows": 2}';
		expect(renderToolOutputForModel(printed)).toBe(printed);
	});

	it("sends a marked string that no longer parses as it stands", () => {
		const cut = '{"query":"a","result":"b… [truncated]';
		expect(
			renderToolOutputForModel(cut, {
				serialized: TOOL_RESULT_SERIALIZED_JSON,
			}),
		).toBe(cut);
	});

	it("lifts images out and keeps their place in the text", () => {
		const image = { type: "image", data: PNG_1X1, mediaType: "image/png" };
		const output = renderToolOutputForModel([
			{ query: "/abs/chart.png", result: [image], success: true },
		]);
		expect(output).toEqual([
			{ type: "text", text: "/abs/chart.png\n→ [image:image/png]" },
			image,
		]);
	});
});

describe("toolResultForModel", () => {
	const entry = [{ query: "pytest -q", result: "3 passed", success: true }];

	it("returns json's output untouched", () => {
		expect(toolResultForModel(entry, undefined)).toBe(entry);
		expect(toolResultForModel(entry, undefined, { format: "json" })).toBe(
			entry,
		);
	});

	it("renders under text and puts the note after it", () => {
		expect(toolResultForModel(entry, "[SYSTEM] note", { format: "text" })).toBe(
			"pytest -q\n→ 3 passed\n\n[SYSTEM] note",
		);
	});
});
