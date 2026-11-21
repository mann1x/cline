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

/** The harness notes riding on a message's tool results. */
function notesOf(message: AgentMessage | undefined): string {
	return (message?.content ?? [])
		.map((part) => (part.type === "tool-result" ? (part.note ?? "") : ""))
		.join("");
}

const tool = (name: string): AgentTool => ({
	name,
	description: name,
	inputSchema: { type: "object", properties: {} },
	execute: async () => "ok",
});

const PRESENTED =
	"I have analyzed the error: an extra closing brace at line 98. The plan:\n1. Remove it.\n2. Run the check.\n\nPlease let me know if you approve this plan so I can proceed.";

function planModeRun(tools: AgentTool[]) {
	const model = new ScriptedModel([
		[
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "read_files",
				inputText: "{}",
			} as AgentModelEvent,
			{ type: "finish", reason: "tool-calls" },
		],
		[
			{ type: "text-delta", text: PRESENTED },
			{ type: "finish", reason: "stop" },
		],
		[
			{ type: "text-delta", text: PRESENTED },
			{ type: "finish", reason: "stop" },
		],
	]);
	const runtime = new AgentRuntime({
		model,
		tools,
		completionPolicy: { maxNoToolCallNudges: 2 },
	});
	return { model, runtime };
}

const systemNotes = (messages: AgentMessage[]) =>
	messages
		.filter((m) => m.role === "user" && textOf(m).startsWith("[SYSTEM]"))
		.map(textOf);

/**
 * Pandorum 2026-11-21 (ojbur, gemma4-26b-agentic): in plan mode the model
 * presented its plan and asked for approval, the act-mode nudges told it to
 * emit the tool call now, and it called `switch_to_act_mode` itself.
 */
describe("a plan-mode run that ends on its plan", () => {
	it("is asked to put the choice to the user, not to act", async () => {
		const { runtime } = planModeRun([
			tool("read_files"),
			tool("ask_question"),
			tool("switch_to_act_mode"),
		]);
		const result = await runtime.run("inspect it");
		const notes = systemNotes(result.messages);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("You are in plan mode");
		expect(notes[0]).toContain("one `ask_question` call");
		expect(notes[0]).toContain('"Switch to act mode and carry out the plan"');
		expect(notes[0]).toContain('"Discuss the plan further"');
		expect(notes[0]).toContain('"Stop here and wait for instructions"');
		expect(notes[0]).toContain("Do not call `switch_to_act_mode`");
		expect(notes.join(" ")).not.toContain("contained no tool calls");
		expect(notes.join(" ")).not.toContain("You wrote");
	});

	it("without ask_question, asks for the choice in the reply", async () => {
		const { runtime } = planModeRun([
			tool("read_files"),
			tool("switch_to_act_mode"),
		]);
		const notes = systemNotes((await runtime.run("inspect it")).messages);
		expect(notes[0]).toContain("end by asking the user how to proceed");
	});

	it("act mode keeps the act-mode nudge", async () => {
		const { runtime } = planModeRun([tool("read_files")]);
		const notes = systemNotes((await runtime.run("inspect it")).messages);
		expect(notes[0]).toContain("contained no tool calls");
		expect(notes.join(" ")).not.toContain("plan mode");
	});
});
