import type { AgentEvent } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createSubagentProgress,
	SUBAGENT_OUTPUT_TAIL_CHARS,
} from "./subagent-progress";

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
	// Text is reported as output (below), never as a tool call.
	it("counts only a tool starting as a tool call", () => {
		const emitUpdate = vi.fn();
		const progress = createSubagentProgress(emitUpdate);

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

describe("the output tail", () => {
	const text = (chunk: string) =>
		({ type: "content_start", contentType: "text", text: chunk }) as never;
	const reasoning = (chunk: string) =>
		({
			type: "content_start",
			contentType: "reasoning",
			reasoning: chunk,
		}) as never;

	// What an agent is writing is what tells a stuck one from a working one.
	it("reports what the agent writes, at most every two seconds", () => {
		const updates: Array<Record<string, unknown>> = [];
		let clock = 10_000;
		const progress = createSubagentProgress(
			(update) => updates.push(update as Record<string, unknown>),
			undefined,
			() => clock,
		);
		progress.observe(text("hello "));
		progress.observe(text("world"));
		expect(updates).toEqual([
			{ latestOutput: "hello", latestOutputKind: "text" },
		]);
		clock += 2_000;
		progress.observe(text("!"));
		expect(updates.at(-1)).toEqual({
			latestOutput: "hello world!",
			latestOutputKind: "text",
		});
	});

	it("says it is thinking when it has written nothing yet", () => {
		const updates: Array<Record<string, unknown>> = [];
		const progress = createSubagentProgress(
			(update) => updates.push(update as Record<string, unknown>),
			undefined,
			() => 0,
		);
		progress.observe(reasoning("the brace on line 90"));
		expect(updates[0]).toEqual({
			latestOutput: "the brace on line 90",
			latestOutputKind: "reasoning",
		});
	});

	it("keeps only the tail, and starts over at each tool call", () => {
		const updates: Array<Record<string, unknown>> = [];
		let clock = 0;
		const progress = createSubagentProgress(
			(update) => updates.push(update as Record<string, unknown>),
			undefined,
			() => clock,
		);
		progress.observe(text("x".repeat(SUBAGENT_OUTPUT_TAIL_CHARS + 50)));
		expect(String(updates[0]?.latestOutput)).toHaveLength(
			SUBAGENT_OUTPUT_TAIL_CHARS,
		);
		progress.observe({
			type: "content_start",
			contentType: "tool",
			toolName: "read_files",
		} as never);
		clock += 5_000;
		progress.observe(text("next step"));
		expect(updates.at(-1)).toEqual({
			latestOutput: "next step",
			latestOutputKind: "text",
		});
	});
});
