import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRuntimeEvent,
} from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";
import { setToolIntentGuardEnabled } from "./tool-intent-guard";

class CountingModel implements AgentModel {
	public readonly yielded: number[] = [];
	public readonly requests: AgentModelRequest[] = [];

	constructor(private readonly steps: Array<() => Iterable<AgentModelEvent>>) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const step = this.steps.shift();
		if (!step) {
			throw new Error("No scripted step available");
		}
		const index = this.yielded.push(0) - 1;
		const self = this;
		return (async function* () {
			for (const event of step()) {
				self.yielded[index] += 1;
				yield event;
			}
		})();
	}
}

/** A call whose `intent` is where the model does its thinking. */
function* overrunningCall(): Iterable<AgentModelEvent> {
	yield {
		type: "tool-input-progress",
		toolCallId: "call_1",
		toolName: "editor",
		inputChars: 40,
		deltas: 1,
		inputText: '{"end_column":386,"intent":"Fix bracket imbalance. ',
	};
	for (let i = 0; i < 4000; i++) {
		const inputText = "Wait, let's re-examine line 110. ";
		yield {
			type: "tool-input-progress",
			toolCallId: "call_1",
			toolName: "editor",
			inputChars: inputText.length,
			deltas: 1,
			inputText,
		};
	}
	yield { type: "finish", reason: "stop" };
}

const editor = {
	name: "editor",
	description: "edit a file",
	inputSchema: {
		type: "object",
		properties: {
			intent: { type: "string" },
			path: { type: "string" },
			new_text: { type: "string" },
			end_column: { type: "number" },
		},
	},
	execute: async () => "ok",
};

function* answer(): Iterable<AgentModelEvent> {
	yield { type: "text-delta", text: "done" };
	yield { type: "finish", reason: "stop" };
}

function notices(events: AgentRuntimeEvent[]): Array<Record<string, unknown>> {
	return events
		.filter((event) => event.type === "status-notice")
		.map(
			(event) =>
				(event as { metadata?: Record<string, unknown> }).metadata ?? {},
		)
		.filter((metadata) => metadata.kind === "tool_intent_overrun");
}

function texts(message: { content: Array<{ type: string; text?: string }> }) {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("the tool intent guard, inside the runtime", () => {
	afterEach(() => {
		setToolIntentGuardEnabled(true);
	});

	it("does nothing once the host has switched it off", async () => {
		setToolIntentGuardEnabled(false);
		const model = new CountingModel([overrunningCall]);
		const events: AgentRuntimeEvent[] = [];
		// No per-runtime setting for this guard: this is how an agent's runtime
		// is built.
		const runtime = new AgentRuntime({
			model,
			tools: [editor],
			// The looping intent is also a phrase loop, which the separate loop
			// guard cuts on its own switch; this test is about this guard's.
			reasoningLoopDetection: false,
		});
		runtime.subscribe((event) => {
			events.push(event);
		});

		await runtime.run("go").catch(() => undefined);

		expect(model.yielded[0]).toBe(4002);
		expect(notices(events)).toHaveLength(0);
	});

	it("cuts the call, says so in the turn, and asks for the call again", async () => {
		const model = new CountingModel([overrunningCall, answer]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model, tools: [editor] });
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		// 2,000 characters at 33 a delta, not the 4,000 deltas that were coming.
		expect(model.yielded[0]).toBeLessThan(100);
		expect(notices(events)).toHaveLength(1);

		const [cut, reminder] = result.messages.slice(1, 3);
		expect(cut?.role).toBe("assistant");
		expect(texts(cut as never)).toContain("begun here and cut");
		expect(cut?.content.some((part) => part.type === "tool-call")).toBe(false);
		expect(reminder?.role).toBe("user");
		expect(texts(reminder as never)).toContain("`intent` is one sentence");
		// One note about the turn, not the cut and a silence nudge on top.
		expect(
			result.messages.filter((message) => message.role === "user"),
		).toHaveLength(2);
		// And the model is asked again, with the note in front of it.
		expect(model.requests).toHaveLength(2);
	});

	it("lets the call stream to its end when the guard is turned off", async () => {
		const model = new CountingModel([overrunningCall]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({
			model,
			tools: [editor],
			toolIntentLimit: false,
			// The looping intent is also a phrase loop, which the separate loop
			// guard cuts on its own switch; this test is about this guard's.
			reasoningLoopDetection: false,
		});
		runtime.subscribe((event) => {
			events.push(event);
		});

		await runtime.run("go").catch(() => undefined);

		expect(model.yielded[0]).toBe(4002);
		expect(notices(events)).toHaveLength(0);
	});

	it("stands down for one request after two cuts running", async () => {
		const model = new CountingModel([
			overrunningCall,
			overrunningCall,
			overrunningCall,
			answer,
		]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({
			model,
			tools: [editor],
			// The looping intent is also a phrase loop, which the separate loop
			// guard cuts on its own switch; this test is about this guard's.
			reasoningLoopDetection: false,
		});
		runtime.subscribe((event) => {
			events.push(event);
		});

		await runtime.run("go").catch(() => undefined);

		expect(model.yielded[0]).toBeLessThan(100);
		expect(model.yielded[1]).toBeLessThan(100);
		// The third is let through whole: a payload that looks like a runaway
		// must not be cut for ever.
		expect(model.yielded[2]).toBe(4002);
		expect(notices(events)).toHaveLength(2);
	});
});
