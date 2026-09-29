import type { AgentEvent } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import { registerSubagentCancellation } from "./subagent-cancellation";
import {
	SUBAGENT_OUTPUT_STEP_CHARS,
	type SubagentOutputEvent,
	subagentOutput,
} from "./subagent-output";
import { createSubagentProgress } from "./subagent-progress";

const ID = "lead::call-1";

afterEach(() => {
	for (const id of subagentOutput.ids()) {
		subagentOutput.release(id);
	}
});

describe("subagentOutput", () => {
	it("gives a subscriber the step so far, then what follows", () => {
		const writer = subagentOutput.writer(ID);
		writer.append({ kind: "reasoning", text: "Let me " });
		writer.append({ kind: "reasoning", text: "look." });
		const events: SubagentOutputEvent[] = [];
		const { snapshot, unsubscribe } = subagentOutput.subscribe(ID, (event) =>
			events.push(event),
		);
		expect(snapshot).toEqual([{ kind: "reasoning", text: "Let me look." }]);
		writer.append({ kind: "text", text: "Done" });
		writer.step();
		expect(events).toEqual([
			{ type: "append", chunk: { kind: "text", text: "Done" } },
			{ type: "step" },
		]);
		unsubscribe();
	});

	it("keeps two calls to one tool as two stretches", () => {
		const writer = subagentOutput.writer(ID);
		writer.append({
			kind: "tool",
			text: "{",
			toolName: "editor",
			toolCallId: "a",
		});
		writer.append({
			kind: "tool",
			text: "}",
			toolName: "editor",
			toolCallId: "a",
		});
		writer.append({
			kind: "tool",
			text: "{",
			toolName: "editor",
			toolCallId: "b",
		});
		const { snapshot, unsubscribe } = subagentOutput.subscribe(ID, () => {});
		expect(snapshot.map((chunk) => [chunk.toolCallId, chunk.text])).toEqual([
			["a", "{}"],
			["b", "{"],
		]);
		unsubscribe();
	});

	// An editor call carrying a whole file is the long case.
	it("drops the start of a step past its cap", () => {
		const writer = subagentOutput.writer(ID);
		writer.append({ kind: "reasoning", text: "r".repeat(1_000) });
		writer.append({
			kind: "tool",
			text: "x".repeat(SUBAGENT_OUTPUT_STEP_CHARS),
			toolCallId: "a",
		});
		const { snapshot, unsubscribe } = subagentOutput.subscribe(ID, () => {});
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]?.kind).toBe("tool");
		expect(snapshot[0]?.text.length).toBe(SUBAGENT_OUTPUT_STEP_CHARS);
		unsubscribe();
	});

	it("starts empty for an agent that has not written, and fills in", () => {
		const events: SubagentOutputEvent[] = [];
		const { snapshot, unsubscribe } = subagentOutput.subscribe(ID, (event) =>
			events.push(event),
		);
		expect(snapshot).toEqual([]);
		subagentOutput.writer(ID).append({ kind: "text", text: "hi" });
		expect(events).toHaveLength(1);
		unsubscribe();
		// Still live: the agent keeps its step for the next look.
		expect(subagentOutput.ids()).toContain(ID);
	});

	it("goes when the agent's registration is released", () => {
		const registration = registerSubagentCancellation(ID, undefined, "a");
		subagentOutput.writer(ID).append({ kind: "text", text: "hi" });
		registration.release();
		expect(subagentOutput.ids()).not.toContain(ID);
	});

	it("waits for the last viewer before it goes", () => {
		subagentOutput.writer(ID).append({ kind: "text", text: "hi" });
		const { unsubscribe } = subagentOutput.subscribe(ID, () => {});
		subagentOutput.release(ID);
		expect(subagentOutput.ids()).toContain(ID);
		unsubscribe();
		expect(subagentOutput.ids()).not.toContain(ID);
	});
});

describe("createSubagentProgress with an output id", () => {
	const progressOf = (inputText: string): AgentEvent =>
		({
			type: "content_update",
			contentType: "tool",
			toolName: "editor",
			toolCallId: "c1",
			update: {
				kind: "input_progress",
				inputChars: inputText.length,
				deltas: 1,
				inputText,
			},
		}) as AgentEvent;

	// The row's line says "Writing editor call: N characters"; Inspect shows
	// the characters (pandorum swarm, 2026-09-29).
	it("keeps thinking, text and the call being written, in order", () => {
		const progress = createSubagentProgress(() => {}, undefined, Date.now, {
			outputId: ID,
		});
		progress.observe({
			type: "content_start",
			contentType: "reasoning",
			reasoning: "Plan: edit.",
		} as AgentEvent);
		progress.observe({
			type: "content_start",
			contentType: "text",
			text: "Editing.",
		} as AgentEvent);
		progress.observe(progressOf('{"path":'));
		progress.observe(progressOf('"a.html"}'));
		const { snapshot, unsubscribe } = subagentOutput.subscribe(ID, () => {});
		expect(snapshot).toEqual([
			{ kind: "reasoning", text: "Plan: edit." },
			{ kind: "text", text: "Editing." },
			{
				kind: "tool",
				text: '{"path":"a.html"}',
				toolName: "editor",
				toolCallId: "c1",
			},
		]);
		unsubscribe();
	});

	// The call it just wrote stays readable while the tool runs.
	it("keeps the step through the tool, and starts over at the next request", () => {
		const progress = createSubagentProgress(() => {}, undefined, Date.now, {
			outputId: ID,
		});
		progress.observe(progressOf("{}"));
		progress.observe({
			type: "content_start",
			contentType: "tool",
			toolName: "editor",
		} as AgentEvent);
		const during = subagentOutput.subscribe(ID, () => {});
		expect(during.snapshot).toHaveLength(1);
		during.unsubscribe();
		progress.observe({ type: "iteration_start", iteration: 2 } as AgentEvent);
		const { snapshot, unsubscribe } = subagentOutput.subscribe(ID, () => {});
		expect(snapshot).toEqual([]);
		unsubscribe();
	});
});
