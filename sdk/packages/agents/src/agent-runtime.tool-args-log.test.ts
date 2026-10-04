import { describe, expect, it } from "vitest";
import {
	describeToolArguments,
	TOOL_ARGUMENTS_LOG_CHARS,
} from "./agent-runtime";

/**
 * The log named a tool call and never its arguments, so what a model sent
 * could not be told from what the harness made of it (pandorum xs8kv).
 */
describe("the log line for a tool call's arguments", () => {
	it("carries the arguments as sent, on one line", () => {
		const line = describeToolArguments(
			3,
			"spawn_agent",
			"call_1",
			'{"agents":[\n{"name":"a","count":3}]}',
			{},
		);
		expect(line).toBe(
			'[tool-args] iter=3 spawn_agent id=call_1 raw chars=37 {"agents":[\\n{"name":"a","count":3}]}',
		);
	});

	it("falls back to the parsed input when no text was streamed", () => {
		const line = describeToolArguments(1, "read_files", "c", "", { path: "a" });
		expect(line).toContain('parsed chars=12 {"path":"a"}');
	});

	it("keeps the head and tail of very long arguments and says how long they were", () => {
		const text = `HEAD${"x".repeat(TOOL_ARGUMENTS_LOG_CHARS * 2)}TAIL`;
		const line = describeToolArguments(1, "editor", "c", text, {});
		expect(line).toContain(`chars=${text.length}`);
		expect(line).toContain("HEADx");
		expect(line.endsWith("xTAIL")).toBe(true);
		expect(line).toContain("characters not logged");
		expect(line.length).toBeLessThan(TOOL_ARGUMENTS_LOG_CHARS + 200);
	});
});
