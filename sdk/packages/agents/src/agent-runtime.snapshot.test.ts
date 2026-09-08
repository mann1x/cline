import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRuntimeEvent,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

class ScriptedModel implements AgentModel {
	constructor(private readonly steps: Array<() => Iterable<AgentModelEvent>>) {}

	async stream(
		_request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		const step = this.steps.shift();
		if (!step) {
			throw new Error("No scripted step available");
		}
		return (async function* () {
			for (const event of step()) {
				yield event;
			}
		})();
	}
}

function* streamingTurn(): Iterable<AgentModelEvent> {
	yield { type: "text-delta", text: "one " };
	yield { type: "text-delta", text: "two " };
	yield { type: "text-delta", text: "three" };
	yield { type: "finish", reason: "stop" };
}

async function deltaSnapshots(): Promise<{
	events: AgentRuntimeEvent[];
	messageCount: number;
}> {
	const events: AgentRuntimeEvent[] = [];
	const runtime = new AgentRuntime({
		model: new ScriptedModel([streamingTurn]),
	});
	runtime.subscribe((event) => {
		events.push(event);
	});
	const result = await runtime.run("go");
	return { events, messageCount: result.messages.length };
}

/**
 * The transcript on a snapshot is copied when it is read rather than when the
 * snapshot is made -- every event carries one and a delta arrives per token, so
 * copying there meant deep-copying the whole conversation thousands of times a
 * turn. These pin the two things that made the copy eager in the first place.
 */
describe("the transcript an event's snapshot carries", () => {
	it("is the transcript as it was when the event was emitted", async () => {
		const { events, messageCount } = await deltaSnapshots();
		const delta = events.find((event) => event.type === "assistant-text-delta");

		// Read only now, after the run appended the assistant message: a
		// transcript copied on read must still be the one this event was emitted
		// with, or every late reader silently sees the future.
		expect(delta?.snapshot.messages.length).toBeLessThan(messageCount);
		expect(
			delta?.snapshot.messages.some((message) => message.role === "assistant"),
		).toBe(false);
	});

	it("is the same array however often it is read", async () => {
		const { events } = await deltaSnapshots();
		const delta = events.find((event) => event.type === "assistant-text-delta");

		expect(delta?.snapshot.messages).toBe(delta?.snapshot.messages);
	});

	// White-box on purpose: the three tests above pass whether the copy is made
	// eagerly or on read, because none of them is allowed to see the difference.
	// This one is what actually changed.
	it("is not copied until somebody asks for it", async () => {
		const runtime = new AgentRuntime({
			model: new ScriptedModel([streamingTurn]),
		});

		expect(
			Object.getOwnPropertyDescriptor(runtime.snapshot(), "messages")?.get,
		).toBeTypeOf("function");
	});

	it("is a copy, so a reader cannot write back into the run", async () => {
		const { events } = await deltaSnapshots();
		const first = events.find((event) => event.type === "assistant-text-delta");
		const last = events.findLast(
			(event) => event.type === "assistant-text-delta",
		);
		first?.snapshot.messages.pop();

		expect(last?.snapshot.messages).not.toHaveLength(0);
	});
});
