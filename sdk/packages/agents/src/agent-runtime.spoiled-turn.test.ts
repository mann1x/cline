import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentTool,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];
	constructor(private readonly steps: AgentModelEvent[][]) {}
	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const step = this.steps.shift();
		if (!step) {
			throw new Error("No scripted step available");
		}
		return (async function* () {
			for (const event of step) {
				yield event;
			}
		})();
	}
}

const Q = '<|"|>';
/** The commonest of the 21 measured on pandorum: a backtick closes the string. */
const UNREADABLE = `<|tool_call>call:editor{end_line:516,new_text:${Q}<script>\nstartGame();\n</script>\n</html>\`,path:${Q}manic_miner.html${Q},start_line:30}<tool_call|>`;

function textOf(message: AgentMessage | undefined): string {
	return (message?.content ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

function reasoningOf(message: AgentMessage | undefined): string {
	return (message?.content ?? [])
		.map((part) =>
			part.type === "reasoning" ? (part as { text: string }).text : "",
		)
		.join("");
}

describe("a turn whose content must not be read back", () => {
	it("keeps a stub, not the unreadable call, and says what was wrong with it", async () => {
		const model = new ScriptedModel([
			[
				{ type: "text-delta", text: UNREADABLE },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text-delta", text: "The task is complete." },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: { maxNoToolCallNudges: 1 },
		});

		const result = await runtime.run("fix it");

		const spoiled = result.messages.find((m) => m.role === "assistant");
		expect(textOf(spoiled)).toContain("could not be read");
		expect(textOf(spoiled)).not.toContain("startGame");
		expect(
			(spoiled?.metadata as { spoiledTurn?: { kinds: string[] } })?.spoiledTurn
				?.kinds,
		).toEqual(["unreadable_tool_call"]);

		// The nudge answers what the turn held, not the stub left in its place.
		const nudge = textOf(
			result.messages.find(
				(m) => m.role === "user" && textOf(m).includes("could not be read"),
			),
		);
		expect(nudge).toContain("`new_text` was never closed");
		expect(nudge).not.toContain("contained no tool calls");

		// And the next request does not carry the call back to the model.
		expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(
			"startGame",
		);
	});

	it("replaces reasoning that repeated itself and keeps the call it ended on", async () => {
		const passage =
			"Wait, I should also check whether the parser thinks the method is outside the class, because that is what the error on this line is telling me.\n\n";
		const noop: AgentTool = {
			name: "read_files",
			description: "read",
			inputSchema: { type: "object", properties: {} },
			execute: async () => "ok",
		};
		const model = new ScriptedModel([
			[
				{ type: "reasoning-delta", text: passage.repeat(40) },
				{
					type: "tool-call-delta",
					toolCallId: "c1",
					toolName: "read_files",
					inputText: "{}",
				} as AgentModelEvent,
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", text: "The task is complete." },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [noop],
			// Off, so the turn runs to its end and the measurement after the
			// fact is what catches it -- the case that kept all of it.
			reasoningLoopDetection: false,
		});

		const result = await runtime.run("fix it");

		const looped = result.messages.find((m) => m.role === "assistant");
		const reasoning = reasoningOf(looped);
		expect(reasoning.startsWith("[SYSTEM] ")).toBe(true);
		expect(reasoning).toContain("repeated one passage");
		expect(reasoning.length).toBeLessThan(300);
		expect(looped?.content.some((part) => part.type === "tool-call")).toBe(
			true,
		);
		// The nudge was worked out before the reasoning went, so it still
		// quotes the passage.
		expect(
			result.messages.some(
				(m) =>
					m.role === "user" && textOf(m).includes("wrote this same passage"),
			),
		).toBe(true);
		expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(
			passage.repeat(3),
		);
	});
});

describe("a reminder the host raises while tools run", () => {
	it("reaches the model after the tool results, once", async () => {
		const noop: AgentTool = {
			name: "editor",
			description: "edit",
			inputSchema: { type: "object", properties: {} },
			execute: async () => ({ success: true }),
		};
		const model = new ScriptedModel([
			[
				{
					type: "tool-call-delta",
					toolCallId: "c1",
					toolName: "editor",
					inputText: "{}",
				} as AgentModelEvent,
				{ type: "finish", reason: "tool-calls" },
			],
			[
				{ type: "text-delta", text: "The task is complete." },
				{ type: "finish", reason: "stop" },
			],
		]);
		const queue = [
			"[SYSTEM] You just changed a file and this task has no checklist.",
		];
		const runtime = new AgentRuntime({
			model,
			tools: [noop],
			completionPolicy: { afterToolsReminder: () => queue.shift() },
		});

		const result = await runtime.run("fix it");

		const roles = result.messages.map((m) =>
			m.content.some((part) => part.type === "tool-result")
				? "tool-result"
				: m.role,
		);
		const at = result.messages.findIndex((m) =>
			textOf(m).includes("has no checklist"),
		);
		expect(roles[at - 1]).toBe("tool-result");
		expect(
			result.messages.filter((m) => textOf(m).includes("has no checklist")),
		).toHaveLength(1);
		expect(JSON.stringify(model.requests[1]?.messages)).toContain(
			"has no checklist",
		);
	});
});
