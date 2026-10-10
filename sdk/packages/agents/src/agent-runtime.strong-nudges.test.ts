import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

/** A model that says the same thing every turn and never calls a tool. */
class OneNoteModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(private readonly text: string) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const text = this.text;
		return (async function* () {
			yield { type: "text-delta", text } as AgentModelEvent;
		})();
	}
}

/** Talks on the first turn, calls a tool on the second, then talks again. */
class ActsOnceModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];
	private turn = 0;

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const acts = this.turn++ === 0;
		return (async function* () {
			if (acts) {
				yield {
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				} as AgentModelEvent;
				yield { type: "finish", reason: "tool-calls" } as AgentModelEvent;
				return;
			}
			yield {
				type: "text-delta",
				text: "The capital of Italy is Rome.",
			} as AgentModelEvent;
		})();
	}
}

/** Says each line in turn; a line starting with `!` is a tool call instead. */
class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];
	private turn = 0;

	constructor(private readonly script: readonly string[]) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const index = this.turn++;
		const line = this.script[Math.min(index, this.script.length - 1)] ?? "";
		return (async function* () {
			if (line.startsWith("!")) {
				yield {
					type: "tool-call-delta",
					toolCallId: `call_${index}`,
					toolName: "echo",
					inputText: '{"text":"hi"}',
				} as AgentModelEvent;
				yield { type: "finish", reason: "tool-calls" } as AgentModelEvent;
				return;
			}
			yield { type: "text-delta", text: line } as AgentModelEvent;
		})();
	}
}

/** The reminders the model had been sent by its last turn, each counted once. */
function asked(model: { requests: AgentModelRequest[] }): number {
	return nudges({ requests: model.requests.slice(-1) }).length;
}

const ECHO = {
	name: "echo",
	description: "Echo input text",
	inputSchema: { type: "object" },
	async execute(input: { text: string }) {
		return { echoed: input.text };
	},
};

/** Every `[SYSTEM]` reminder the runtime fed back to the model. */
function nudges(model: { requests: AgentModelRequest[] }): string[] {
	const out: string[] = [];
	for (const request of model.requests) {
		for (const message of (request.messages ?? []) as AgentMessage[]) {
			if (message.role !== "user") {
				continue;
			}
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: (content ?? [])
							.map((part: { type?: string; text?: string }) =>
								part.type === "text" ? (part.text ?? "") : "",
							)
							.join("");
			if (text.startsWith("[SYSTEM]")) {
				out.push(text);
			}
		}
	}
	return out;
}

/**
 * The "Strong coding nudges" switch.
 *
 * On -- the default, and what every host shipped before this setting existed --
 * any turn that calls nothing is asked to continue. That is the right reading
 * inside a coding task, where a silent turn is nearly always one that should
 * have acted, and a needless nudge costs one turn against a missed one costing
 * the task.
 *
 * Off, the nudge has to be earned: unstarted work the host can name, a run that
 * has already called something, or a turn that ends on a promise. A plain
 * answer to a plain question is then allowed to end the run, which is what a
 * mostly-conversational session wants -- asked which capital belongs to which
 * country, a model answers, and being told the run "was about to end" and not
 * to describe work without doing it is simply the wrong description of what it
 * just did.
 */
describe("strong coding nudges", () => {
	const ANSWER = "The capital of Italy is Rome.";
	const PROMISE = "Let me open the file and fix the import.";

	it("nudges a plain answer by default", async () => {
		const model = new OneNoteModel(ANSWER);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: { maxNoToolCallNudges: 1 },
		});

		await runtime.run("which capital belongs to Italy?");

		expect(nudges(model)).toHaveLength(1);
	});

	it("lets a plain answer end the run when switched off", async () => {
		const model = new OneNoteModel(ANSWER);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: { maxNoToolCallNudges: 1, strongNudges: false },
		});

		await runtime.run("which capital belongs to Italy?");

		expect(nudges(model)).toEqual([]);
	});

	it("still nudges a turn that ends on a promise when switched off", async () => {
		const model = new OneNoteModel(PROMISE);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: { maxNoToolCallNudges: 1, strongNudges: false },
		});

		await runtime.run("fix the import");

		const seen = nudges(model);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.join("\n")).toContain("called nothing");
	});

	it("still nudges once the run has called something, when switched off", async () => {
		// A run that has already acted is a working run, so a silent turn in it
		// is a stop rather than an answer -- the distinction the flag draws is
		// between a conversation and a task, and one tool call settles it.
		const model = new ActsOnceModel();
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					async execute(input: { text: string }) {
						return { echoed: input.text };
					},
				},
			],
			completionPolicy: { maxNoToolCallNudges: 1, strongNudges: false },
		});

		await runtime.run("do the thing");

		expect(nudges(model)).toHaveLength(1);
	});

	// Session qjzln: a summary, a nudge, a check of the files, "it is complete",
	// a second nudge, another check, a third.
	it("takes one short sentence after a check as the answer to the nudge", async () => {
		const model = new ScriptedModel([
			"Here is a long summary of the page.\n\nIt has several parts.",
			"!check",
			"The web scraping of zentimings.com is complete.",
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [ECHO],
			completionPolicy: { maxNoToolCallNudges: 1 },
		});

		await runtime.run("make a web scraping of zentimings.com");

		expect(asked(model)).toBe(1);
		expect(model.requests).toHaveLength(3);
	});

	it("still asks again when what follows the check is not that sentence", async () => {
		for (const reply of [
			"Let me also write a script for it.",
			"Should I save it somewhere else?",
			"The scrape is complete.\n\nHere is everything that was found, at length.",
		]) {
			const model = new ScriptedModel([
				"Here is a summary.",
				"!check",
				reply,
				"Done.",
			]);
			const runtime = new AgentRuntime({
				model,
				tools: [ECHO],
				completionPolicy: { maxNoToolCallNudges: 1 },
			});

			await runtime.run("make a web scraping of zentimings.com");

			// A promise draws the announced-intent nudge as well.
			expect(asked(model), reply).toBeGreaterThanOrEqual(2);
		}
	});

	it("asks a run that was never asked, however short its last word", async () => {
		const model = new ScriptedModel(["!work", "Done."]);
		const runtime = new AgentRuntime({
			model,
			tools: [ECHO],
			completionPolicy: { maxNoToolCallNudges: 1 },
		});

		await runtime.run("do the thing");

		expect(asked(model)).toBe(1);
		expect(model.requests).toHaveLength(3);
	});

	it("names the unstarted work even when switched off", async () => {
		const model = new OneNoteModel(ANSWER);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				strongNudges: false,
				describeUnstartedWork: () => " TX-01 is open with nothing in it.",
			},
		});

		await runtime.run("fix the import");

		const seen = nudges(model);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("TX-01 is open with nothing in it.");
	});
});
