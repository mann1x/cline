import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

/** A model that plays scripted turns: thinking, and then maybe an answer. */
class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(
		private readonly turns: Array<{ reasoning?: string; text?: string }>,
	) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		const turn = this.turns[this.requests.length] ?? { text: "Done." };
		this.requests.push(request);
		return (async function* () {
			if (turn.reasoning) {
				yield {
					type: "reasoning-delta",
					text: turn.reasoning,
				} as AgentModelEvent;
			}
			if (turn.text) {
				yield { type: "text-delta", text: turn.text } as AgentModelEvent;
			}
		})();
	}
}

function reminders(model: ScriptedModel): string[] {
	const out: string[] = [];
	for (const message of (model.requests.at(-1)?.messages ??
		[]) as AgentMessage[]) {
		if (message.role !== "user") {
			continue;
		}
		const text =
			typeof message.content === "string"
				? message.content
				: (message.content ?? [])
						.map((part: { type?: string; text?: string }) =>
							part.type === "text" ? (part.text ?? "") : "",
						)
						.join("");
		if (text.startsWith("[SYSTEM]")) {
			out.push(text);
		}
	}
	return out;
}

/**
 * A turn that is thinking and nothing else is not an answer.
 *
 * Pandorum, session k3ba1 (2026-10-03, omnimerge-v6 on opencoti): 13 of 15
 * agents ended on a turn whose only part was reasoning. In 11 of the 23 such
 * turns the end of a tool call -- `</parameter></function></tool_call>` -- sat
 * inside the thinking: the model wrote its call before closing the channel, so
 * no call arrived. The message was not empty, so the empty-turn retry did not
 * fire, and with no tool call the run ended there: "this agent ended without
 * an answer of its own".
 */
describe("a turn that is thinking only", () => {
	it("is taken again, and says the call inside the thinking never ran", async () => {
		const model = new ScriptedModel([
			{
				reasoning:
					'I should read the file first.\n{"path": "manic_miner.html"}\n</parameter>\n</function>\n</tool_call>',
			},
			{ reasoning: "Now outside the thinking.", text: "The report." },
		]);
		const runtime = new AgentRuntime({ model, completionPolicy: null });

		const result = await runtime.run("review the file");

		expect(model.requests).toHaveLength(2);
		expect(result.outputText).toBe("The report.");
		const seen = reminders(model);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("inside your thinking");
		expect(seen[0]).toContain("never ran");
	});

	it("is taken again when the thinking simply stopped", async () => {
		const model = new ScriptedModel([
			{ reasoning: "So the Level class is not" },
			{ text: "The report." },
		]);
		const runtime = new AgentRuntime({ model, completionPolicy: null });

		const result = await runtime.run("review the file");

		expect(result.outputText).toBe("The report.");
		expect(reminders(model)[0]).toContain("thinking only");
	});

	it("stops asking after its budget, and ends as it used to", async () => {
		const model = new ScriptedModel(
			Array.from({ length: 10 }, () => ({ reasoning: "Still thinking." })),
		);
		const runtime = new AgentRuntime({ model, completionPolicy: null });

		const result = await runtime.run("review the file");

		// The first turn and three retries.
		expect(model.requests).toHaveLength(4);
		expect(result.outputText).toBe("");
	});

	it("leaves a turn with an answer alone", async () => {
		const model = new ScriptedModel([
			{ reasoning: "Thought about it.", text: "The report." },
		]);
		const runtime = new AgentRuntime({ model, completionPolicy: null });

		await runtime.run("review the file");

		expect(model.requests).toHaveLength(1);
	});
});
