import type { AgentEvent } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createSubagentProgress } from "./subagent-progress";

const toolStart = (toolName: string): AgentEvent =>
	({ type: "content_start", contentType: "tool", toolName }) as AgentEvent;

describe("reporting what a sub-agent is doing", () => {
	// The UI has read `latestToolCall` off the spawn tool's progress since the
	// rich row was written, and no spawn path ever emitted any -- so it was
	// declared, parsed, rendered, and always empty. Measured on pandorum
	// 2026-09-22: three agents ran for 80-148 seconds each and the only thing
	// on screen throughout was the lead's last tool call.
	it("names the tool the agent has just started", () => {
		const emitUpdate = vi.fn();
		const progress = createSubagentProgress(emitUpdate);

		progress.observe(toolStart("read_files"));

		expect(emitUpdate).toHaveBeenCalledWith({
			latestToolCall: "read_files",
			toolCalls: 1,
		});
	});

	it("counts them as they go", () => {
		const emitUpdate = vi.fn();
		const progress = createSubagentProgress(emitUpdate);

		progress.observe(toolStart("read_files"));
		progress.observe(toolStart("editor"));

		expect(emitUpdate).toHaveBeenLastCalledWith({
			latestToolCall: "editor",
			toolCalls: 2,
		});
	});

	// An agent between tools is thinking, not still running the last one it
	// finished, so the end of a tool says nothing new.
	it("ignores everything that is not a tool starting", () => {
		const emitUpdate = vi.fn();
		const progress = createSubagentProgress(emitUpdate);

		progress.observe({
			type: "content_start",
			contentType: "text",
			text: "hello",
		} as AgentEvent);
		progress.observe({
			type: "content_end",
			contentType: "tool",
			toolName: "editor",
		} as AgentEvent);
		progress.observe({
			type: "content_start",
			contentType: "tool",
		} as AgentEvent);

		expect(emitUpdate).not.toHaveBeenCalled();
	});

	// The observer replaces the agent's own event callback, so anything it
	// dropped would be lost to every other consumer of those events.
	it("still forwards every event it was given", () => {
		const forward = vi.fn();
		const progress = createSubagentProgress(undefined, forward);
		const text = { type: "content_start", contentType: "text" } as AgentEvent;

		progress.observe(text);
		progress.observe(toolStart("editor"));

		expect(forward).toHaveBeenCalledTimes(2);
		expect(forward).toHaveBeenNthCalledWith(1, text);
	});

	it("is harmless on a host that offers no progress channel", () => {
		const forward = vi.fn();
		const progress = createSubagentProgress(undefined, forward);

		expect(() => progress.observe(toolStart("editor"))).not.toThrow();
		expect(forward).toHaveBeenCalledTimes(1);
	});
});
