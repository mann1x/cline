import type { AgentEvent } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createSubagentProgress,
	reportSubagentPlaced,
	reportSubagentQueued,
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
			genTps: 1,
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

describe("generation speed", () => {
	const text = (chunk: string) =>
		({ type: "content_start", contentType: "text", text: chunk }) as never;

	// A crawling agent and a working one wrote the same tail; only the rate
	// told them apart, and it was nowhere on screen.
	it("is deltas per second over the report window", () => {
		const updates: Array<Record<string, unknown>> = [];
		let clock = 0;
		const progress = createSubagentProgress(
			(update) => updates.push(update as Record<string, unknown>),
			undefined,
			() => clock,
		);
		progress.observe(text("a"));
		expect(updates[0]).not.toHaveProperty("genTps");
		// A delta every 50 ms; the report due at 2 s carries the 40 counted
		// since the first report.
		for (let i = 0; i < 40; i++) {
			clock += 50;
			progress.observe(text("b"));
		}
		expect(updates).toHaveLength(2);
		expect(updates.at(-1)?.genTps).toBe(20);
	});

	// Running a tool is not generating: a window across one would report an
	// agent waiting on a slow command as a slow model.
	it("does not count time spent in a tool", () => {
		const updates: Array<Record<string, unknown>> = [];
		let clock = 0;
		const progress = createSubagentProgress(
			(update) => updates.push(update as Record<string, unknown>),
			undefined,
			() => clock,
		);
		progress.observe(text("a"));
		progress.observe({
			type: "content_start",
			contentType: "tool",
			toolName: "run_commands",
		} as AgentEvent);
		clock = 60_000;
		progress.observe(text("b"));
		clock = 62_000;
		progress.observe(text("c"));
		// One delta in the two seconds since "b" opened the window, and no
		// rate at all before that: the minute in the tool is in neither.
		const rates = updates
			.map((update) => update.genTps)
			.filter((rate) => rate !== undefined);
		expect(rates).toEqual([0.5]);
	});
});

describe("placement", () => {
	// Every agent read as running from the moment it was spawned, so a
	// fan-out of seventy-five on nodes that take three looked like
	// seventy-five at work.
	it("says an agent is queued, then where it runs once placed", () => {
		const emitUpdate = vi.fn();
		reportSubagentQueued(emitUpdate);
		reportSubagentPlaced(emitUpdate, { nodeId: "n2", nodeLabel: "bs2" });
		expect(emitUpdate.mock.calls).toEqual([
			[{ queued: true }],
			[{ queued: false, nodeId: "n2", nodeLabel: "bs2" }],
		]);
	});

	it("still starts the agent when there is no node to name", () => {
		const emitUpdate = vi.fn();
		reportSubagentPlaced(emitUpdate, undefined);
		expect(emitUpdate).toHaveBeenCalledWith({ queued: false });
		expect(() => reportSubagentQueued(undefined)).not.toThrow();
	});
});

describe("reporting what a sub-agent has spent", () => {
	// Every row read "0 tokens" while the agent ran: nothing sent usage.
	it("sends the totals and the context it holds on every turn", () => {
		const emitUpdate = vi.fn();
		const progress = createSubagentProgress(emitUpdate);
		progress.observe({
			type: "usage",
			inputTokens: 6_000,
			outputTokens: 300,
			cacheReadTokens: 0,
			totalInputTokens: 11_000,
			totalOutputTokens: 700,
		} as AgentEvent);
		expect(emitUpdate).toHaveBeenCalledWith({
			inputTokens: 11_000,
			outputTokens: 700,
			contextTokens: 6_300,
		});
	});
});
