import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRuntimeEvent,
	LoopCutRecord,
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
		expect(model.requests).toHaveLength(2);
		expect(texts(result.messages.at(-1) as never)).toBe("done");
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

	it("cuts a call that writes one script again and again, each copy drifting", async () => {
		// f099u (pandorum, 2026-10-22): 13 copies of a 590-line script in one
		// `editor` call, 265,328 characters, no two copies alike.
		const copy = (c: number) =>
			Array.from({ length: 150 }, (_, i) =>
				i === c
					? `    const value${i} = compute(${i}, state.level, ${c});`
					: `    const value${i} = compute(${i}, state.level);`,
			).join("\n");
		function* looping(): Iterable<AgentModelEvent> {
			yield progress(
				'call:editor{intent:<|"|>Rewrite the script<|"|>,new_text:<|"|>',
			);
			for (let c = 0; c < 13; c++) yield progress(`${copy(c)}\n`);
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

		expect(model.yielded[0]).toBeLessThan(6);
		expect(execute).not.toHaveBeenCalled();
		expect(loopNotices(events)[0]?.message).toContain(
			"The model's call to `editor` kept writing the same lines again",
		);
		const reminder = result.messages[2];
		expect(texts(reminder as never)).toContain(
			"its arguments had come to repeat lines already written twice",
		);
	});

	it("reads a call that arrived whole, with no progress, before it runs", async () => {
		// A provider that streams no progress hands the call over in one piece.
		// Too late to save the tokens; not too late to keep it from running.
		const copy = (c: number) =>
			Array.from({ length: 150 }, (_, i) =>
				i === c
					? `    const value${i} = compute(${i}, state.level, ${c});`
					: `    const value${i} = compute(${i}, state.level);`,
			).join("\n");
		const newText = Array.from({ length: 13 }, (_, c) => copy(c)).join("\n");
		function* whole(): Iterable<AgentModelEvent> {
			yield {
				type: "tool-call-delta",
				toolCallId: "call_1",
				toolName: "editor",
				inputText: JSON.stringify({ path: "a.js", new_text: newText }),
			};
			yield { type: "finish", reason: "tool-calls" };
		}
		execute.mockClear();
		const model = new CountingModel([whole, answer]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model, tools: [editor] });
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(execute).not.toHaveBeenCalled();
		expect(loopNotices(events)).toHaveLength(1);
		const cut = result.messages[1];
		expect(cut?.content.some((part) => part.type === "tool-call")).toBe(false);
		expect(texts(cut as never)).toContain("begun here and cut");
		expect(texts(result.messages.at(-1) as never)).toBe("done");
	});

	it("runs a call that arrived whole when its lines differ", async () => {
		const newText = Array.from(
			{ length: 2000 },
			(_, i) => `    draw${i}(ctx, x + ${i}, y - ${i % 7}, state.level);`,
		).join("\n");
		function* whole(): Iterable<AgentModelEvent> {
			yield {
				type: "tool-call-delta",
				toolCallId: "call_1",
				toolName: "editor",
				inputText: JSON.stringify({ path: "a.js", new_text: newText }),
			};
			yield { type: "finish", reason: "tool-calls" };
		}
		execute.mockClear();
		const runtime = new AgentRuntime({
			model: new CountingModel([whole, answer]),
			tools: [editor],
		});

		await runtime.run("go");

		expect(execute).toHaveBeenCalledTimes(1);
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

	it("hands the cut call's arguments to the host, verbatim", async () => {
		const head = 'call:editor{intent:<|"|>Fix sX<|"|>,new_text:<|"|>';
		function* looping(): Iterable<AgentModelEvent> {
			yield progress(head);
			for (let i = 0; i < 200; i++) yield progress(`${BLOCK}\n`);
			yield { type: "finish", reason: "length" };
		}
		const cuts: LoopCutRecord[] = [];
		const runtime = new AgentRuntime({
			model: new CountingModel([looping, answer]),
			tools: [editor],
			onLoopCut: (cut) => {
				cuts.push(cut);
			},
		});

		await runtime.run("go");
		await vi.waitFor(() => expect(cuts).toHaveLength(1));

		expect(cuts[0]).toMatchObject({
			channel: "tool_arguments",
			cause: "argument_loop",
			toolName: "editor",
			toolCallId: "call_1",
		});
		expect(cuts[0]?.text.startsWith(`${head}${BLOCK}\n`)).toBe(true);
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

describe("a call the output cap cut short", () => {
	it("is not run when it parsed, and the model is told it was cut", async () => {
		// f099u (pandorum, 2026-10-22): xOllama closed an open `editor` call at
		// the cap; the JSON parsed and the half-written edit ran.
		function* capped(): Iterable<AgentModelEvent> {
			yield {
				type: "tool-call-delta",
				toolCallId: "call_1",
				toolName: "editor",
				inputText: JSON.stringify({
					path: "a.js",
					new_text: "const ex = e.x",
				}),
			};
			yield { type: "finish", reason: "max-tokens" };
		}
		execute.mockClear();
		const model = new CountingModel([capped, answer]);
		const runtime = new AgentRuntime({ model, tools: [editor] });

		const result = await runtime.run("go");

		expect(execute).not.toHaveBeenCalled();
		expect(JSON.stringify(model.requests[1]?.messages)).toContain(
			"was cut off by the output budget",
		);
		expect(texts(result.messages.at(-1) as never)).toBe("done");
	});
});

describe("what a turn at the output cap was writing", () => {
	// ol-106: iter 27 on pandorum wrote ~81,000 tokens of one `editor` call;
	// xOllama dropped it at the cap and none of it was kept anywhere.
	it("is kept when the provider dropped the call", async () => {
		const written = 'call:editor{path:<|"|>a.js<|"|>,new_text:<|"|>const ex';
		function* capped(): Iterable<AgentModelEvent> {
			yield progress(written.slice(0, 20));
			yield progress(written.slice(20));
			yield { type: "finish", reason: "max-tokens" };
		}
		const cuts: LoopCutRecord[] = [];
		const model = new CountingModel([capped, answer]);
		const runtime = new AgentRuntime({
			model,
			tools: [editor],
			onLoopCut: (cut) => {
				cuts.push(cut);
			},
		});

		await runtime.run("go");
		await vi.waitFor(() => expect(cuts).toHaveLength(1));

		expect(cuts[0]).toMatchObject({
			channel: "tool_arguments",
			cause: "output_limit",
			toolName: "editor",
			toolCallId: "call_1",
			text: written,
		});
	});

	it("is not kept for a call the turn finished", async () => {
		function* done(): Iterable<AgentModelEvent> {
			yield progress('{"path":"a.js","new_text":"x"}');
			yield {
				type: "tool-call-delta",
				toolCallId: "call_1",
				toolName: "editor",
				inputText: '{"path":"a.js","new_text":"x"}',
			};
			yield { type: "finish", reason: "tool-calls" };
		}
		const cuts: LoopCutRecord[] = [];
		const model = new CountingModel([done, answer]);
		const runtime = new AgentRuntime({
			model,
			tools: [editor],
			onLoopCut: (cut) => {
				cuts.push(cut);
			},
		});

		await runtime.run("go");

		expect(cuts).toEqual([]);
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
		// The cut is not the answer: the run asks again and ends on the next
		// turn, not on the stub.
		expect(model.requests).toHaveLength(2);
		expect(texts(result.messages.at(-1) as never)).toBe("done");
	});

	it("hands the cut reply to the host, verbatim", async () => {
		function* looping(): Iterable<AgentModelEvent> {
			yield { type: "text-delta", text: "I will write the file now.\n" };
			for (let i = 0; i < 200; i++) {
				yield { type: "text-delta", text: `${BLOCK}\n` };
			}
			yield { type: "finish", reason: "stop" };
		}
		const cuts: LoopCutRecord[] = [];
		const runtime = new AgentRuntime({
			model: new CountingModel([looping, answer]),
			onLoopCut: (cut) => {
				cuts.push(cut);
			},
		});

		await runtime.run("go");
		await vi.waitFor(() => expect(cuts).toHaveLength(1));

		expect(cuts[0]).toMatchObject({
			channel: "reply",
			cause: "answer_loop",
			iteration: 1,
			verdict: { kind: "block-cycle", period: 12 },
		});
		expect(cuts[0]?.text.startsWith("I will write the file now.\n")).toBe(true);
		expect(cuts[0]?.text).toContain(`${BLOCK}\n${BLOCK}\n`);
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

describe("the loop guard on the thinking", () => {
	function* looping(): Iterable<AgentModelEvent> {
		yield { type: "reasoning-delta", text: "Let me plan the edit.\n" };
		for (let i = 0; i < 200; i++) {
			yield { type: "reasoning-delta", text: `${BLOCK}\n` };
		}
		yield { type: "finish", reason: "stop" };
	}

	it("tells the model what was cut and asks for the next call", async () => {
		// pandorum, 2026-10-21: after a cut the model was told only that a
		// turn with no tool call was about to end the run.
		const model = new CountingModel([looping, answer]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("go");

		expect(model.requests).toHaveLength(2);
		const reminder = result.messages[2];
		expect(reminder?.role).toBe("user");
		expect(texts(reminder as never)).toContain(
			"Your thinking was cut while you were writing it",
		);
		expect(texts(reminder as never)).toContain("the same 12-line block");
		expect(texts(reminder as never)).not.toContain(
			"Your last message contained no tool calls",
		);
		expect(texts(result.messages.at(-1) as never)).toBe("done");
	});

	it("hands the cut thinking to the host, verbatim", async () => {
		const cuts: LoopCutRecord[] = [];
		const runtime = new AgentRuntime({
			model: new CountingModel([looping, answer]),
			onLoopCut: (cut) => {
				cuts.push(cut);
			},
		});

		const result = await runtime.run("go");
		await vi.waitFor(() => expect(cuts).toHaveLength(1));

		expect(cuts[0]).toMatchObject({
			channel: "reasoning",
			cause: "reasoning_loop",
			iteration: 1,
			verdict: { kind: "block-cycle", period: 12 },
		});
		expect(cuts[0]?.text.startsWith(`Let me plan the edit.\n${BLOCK}\n`)).toBe(
			true,
		);
		// The transcript still holds only the stub.
		expect(JSON.stringify(result.messages)).not.toContain("pop3()");
	});

	it("keeps running when the host cannot keep the cut", async () => {
		const runtime = new AgentRuntime({
			model: new CountingModel([looping, answer]),
			onLoopCut: () => {
				throw new Error("disk full");
			},
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(texts(result.messages.at(-1) as never)).toBe("done");
	});
});
