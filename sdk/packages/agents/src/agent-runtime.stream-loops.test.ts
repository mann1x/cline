import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRuntimeEvent,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

// The reasoning guard's detector over the two channels it never watched: the
// reply, and each call's arguments while they stream (pandorum, 2026-10-20:
// ~81,000 tokens inside one `editor` call, read by nothing).

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

/** Twelve lines of a class, the block a looping edit writes out again. */
const BLOCK = Array.from(
	{ length: 12 },
	(_, i) =>
		`    pop${i}() { this.it.push({ x: this.sX(${i}), y: ${i * 2} }); }`,
).join("\n");

const execute = vi.fn(async () => "ok");
const editor = {
	name: "editor",
	description: "edit a file",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string" },
			new_text: { type: "string" },
			intent: { type: "string" },
		},
	},
	execute,
};

function progress(text: string): AgentModelEvent {
	return {
		type: "tool-input-progress",
		toolCallId: "call_1",
		toolName: "editor",
		inputChars: text.length,
		deltas: 1,
		inputText: text,
	};
}

function* answer(): Iterable<AgentModelEvent> {
	yield { type: "text-delta", text: "done" };
	yield { type: "finish", reason: "stop" };
}

function loopNotices(events: AgentRuntimeEvent[]) {
	return events
		.filter((event) => event.type === "status-notice")
		.map(
			(event) =>
				event as { message?: string; metadata?: Record<string, unknown> },
		)
		.filter((event) => event.metadata?.kind === "reasoning_loop");
}

function texts(message: { content: Array<{ type: string; text?: string }> }) {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("the loop guard on a call's arguments", () => {
	it("cuts a call written in the model's notation, and nothing runs", async () => {
		// xOllama's tool_call_progress: gemma4's `call:NAME{key:<|"|>...` with
		// the file's own line breaks in it.
		function* looping(): Iterable<AgentModelEvent> {
			yield progress('call:editor{intent:<|"|>Fix sX<|"|>,new_text:<|"|>');
			for (let i = 0; i < 200; i++) yield progress(`${BLOCK}\n`);
			yield { type: "finish", reason: "length" };
		}
		execute.mockClear();
		const model = new CountingModel([looping, answer]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model, tools: [editor] });
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(model.yielded[0]).toBeLessThan(20);
		expect(execute).not.toHaveBeenCalled();
		const seen = loopNotices(events);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.message).toContain(
			"The model's call to `editor` repeated a 12-line block",
		);
		const [cut, reminder] = result.messages.slice(1, 3);
		expect(cut?.content.some((part) => part.type === "tool-call")).toBe(false);
		expect(texts(cut as never)).toContain("begun here and cut");
		expect(reminder?.role).toBe("user");
		expect(texts(reminder as never)).toContain(
			"its arguments had come to repeat the same 12-line block",
		);
	});

	it("reads JSON arguments with their line breaks decoded", async () => {
		// A provider that streams the arguments as JSON has `\n` for every
		// line break; split nowhere, the block would be one long line.
		function* looping(): Iterable<AgentModelEvent> {
			yield progress('{"path":"a.js","new_text":"');
			const escaped = JSON.stringify(`${BLOCK}\n`).slice(1, -1);
			for (let i = 0; i < 200; i++) {
				// Split mid-escape, the way deltas fall.
				const at = escaped.indexOf("\\n") + 1;
				yield progress(escaped.slice(0, at));
				yield progress(escaped.slice(at));
			}
			yield { type: "finish", reason: "length" };
		}
		const model = new CountingModel([looping, answer]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model, tools: [editor] });
		runtime.subscribe((event) => {
			events.push(event);
		});

		await runtime.run("go");

		expect(model.yielded[0]).toBeLessThan(40);
		expect(loopNotices(events)[0]?.message).toContain("12-line block");
	});

	it("leaves a long call whose lines differ alone", async () => {
		function* healthy(): Iterable<AgentModelEvent> {
			yield progress('call:editor{new_text:<|"|>');
			for (let i = 0; i < 400; i++) {
				yield progress(`    draw${i}(ctx, x + ${i}, y - ${i % 7});\n`);
			}
			yield { type: "finish", reason: "stop" };
		}
		const model = new CountingModel([healthy, answer]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model, tools: [editor] });
		runtime.subscribe((event) => {
			events.push(event);
		});

		await runtime.run("go");

		expect(model.yielded[0]).toBe(402);
		expect(loopNotices(events)).toHaveLength(0);
	});

	it("stays off with the loop detection switch", async () => {
		function* looping(): Iterable<AgentModelEvent> {
			yield progress('call:editor{new_text:<|"|>');
			for (let i = 0; i < 200; i++) yield progress(`${BLOCK}\n`);
			yield { type: "finish", reason: "stop" };
		}
		const model = new CountingModel([looping, answer]);
		const runtime = new AgentRuntime({
			model,
			tools: [editor],
			reasoningLoopDetection: false,
		});

		await runtime.run("go").catch(() => undefined);

		expect(model.yielded[0]).toBe(202);
	});
});

describe("the loop guard on the reply", () => {
	it("cuts a reply that repeats a block, and does not keep it", async () => {
		function* looping(): Iterable<AgentModelEvent> {
			yield { type: "text-delta", text: "I will write the file now.\n" };
			for (let i = 0; i < 200; i++) {
				yield { type: "text-delta", text: `${BLOCK}\n` };
			}
			yield { type: "finish", reason: "stop" };
		}
		const model = new CountingModel([looping, answer]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model });
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(model.yielded[0]).toBeLessThan(20);
		expect(loopNotices(events)[0]?.message).toContain(
			"The model's reply repeated a 12-line block",
		);
		const cut = result.messages[1];
		expect(texts(cut as never)).toContain("The reply here was cut");
		expect(texts(cut as never)).not.toContain("pop3()");
	});

	it("leaves a reply that only talks alone", async () => {
		function* healthy(): Iterable<AgentModelEvent> {
			for (let i = 0; i < 300; i++) {
				yield {
					type: "text-delta",
					text: `Point ${i}: the collider on row ${i * 3} is checked against tile ${i % 17}.\n`,
				};
			}
			yield { type: "finish", reason: "stop" };
		}
		const model = new CountingModel([healthy]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model });
		runtime.subscribe((event) => {
			events.push(event);
		});

		await runtime.run("go");

		expect(model.yielded[0]).toBe(301);
		expect(loopNotices(events)).toHaveLength(0);
	});
});
