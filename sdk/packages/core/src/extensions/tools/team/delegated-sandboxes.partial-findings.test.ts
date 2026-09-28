import { describe, expect, it } from "vitest";
import { partialFindings } from "./delegated-sandboxes";

// pandorum h0o2o (2026-09-28): 18 of 25 agents were stopped by the lead and
// each reported only "ended early without an answer of its own", while their
// transcripts held findings as good as the capped agents' reports.
describe("partialFindings", () => {
	it("quotes the agent's latest message and tallies its tool calls", () => {
		const text = partialFindings([
			{ role: "user", content: [{ type: "text", text: "the task" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "First look." },
					{ type: "tool_use", name: "read_files", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", content: "…" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Line 94 has one more `}` than `{`." },
					{ type: "tool_use", name: "editor", input: {} },
					{ type: "tool_use", name: "editor", input: {} },
				],
			},
		]);
		expect(text).toContain("Line 94 has one more `}` than `{`.");
		expect(text).not.toContain("First look.");
		expect(text).toContain("Tool calls it made: editor ×2, read_files ×1.");
		expect(text).toContain("not a final report");
	});

	it("says so when the agent wrote nothing and called nothing", () => {
		const text = partialFindings([
			{ role: "user", content: [{ type: "text", text: "the task" }] },
		]);
		expect(text).toContain("It had written no message yet.");
		expect(text).toContain("It had made no tool calls.");
	});

	it("cuts a long message short", () => {
		const text = partialFindings([
			{
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(5000) }],
			},
		]);
		expect(text.length).toBeLessThan(3000);
		expect(text).toContain("…");
	});
});
