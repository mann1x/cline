import type { AgentMessage, AgentToolDefinition } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { type PlanSource, withPlanCapture } from "./plan-capture";

const PLAN = `Plan (TX-01):
1. **WHERE**: Line 90, \`dDec\` method
   **WHAT**: Add the missing \`{\`
   **WHY**: The linter reports "Declaration or statement expected"`;

function tools(calls: string[]): AgentToolDefinition[] {
	return ["editor", "read_files"].map(
		(name) =>
			({
				name,
				description: name,
				inputSchema: { type: "object", properties: {} },
				execute: async () => {
					calls.push(name);
					return `${name} ran`;
				},
			}) as unknown as AgentToolDefinition,
	);
}

/** A turn as the runtime has it when the turn's own tool calls execute. */
function turn(parts: { text?: string; reasoning?: string }): AgentMessage {
	const content = [
		...(parts.reasoning ? [{ type: "reasoning", text: parts.reasoning }] : []),
		...(parts.text ? [{ type: "text", text: parts.text }] : []),
	];
	return { role: "assistant", content } as unknown as AgentMessage;
}

function context(messages: AgentMessage[]) {
	return { agentId: "a", iteration: 1, snapshot: { messages } } as never;
}

function harness(source: { transaction: number }) {
	const calls: string[] = [];
	const seen: { plan: string; from: PlanSource }[] = [];
	const wrapped = new Map(
		withPlanCapture(tools(calls), {
			get transaction() {
				return source.transaction;
			},
			onPlan: (plan, from) => seen.push({ plan, from }),
		}).map((tool) => [tool.name, tool]),
	);
	const run = (name: string, messages: AgentMessage[]) =>
		(
			wrapped.get(name) as never as {
				execute: (i: unknown, c: unknown) => Promise<unknown>;
			}
		).execute({}, context(messages));
	return { calls, seen, run };
}

describe("withPlanCapture", () => {
	// The measured case: the plan is in the reasoning and the reply is empty.
	it("reports a plan the model put only in its reasoning", async () => {
		const { seen, run } = harness({ transaction: 1 });

		await run("editor", [turn({ reasoning: `I see the file.\n\n${PLAN}` })]);

		expect(seen).toHaveLength(1);
		expect(seen[0].from).toBe("reasoning");
		expect(seen[0].plan).toContain("Line 90");
	});

	// A plan in the reply is already on screen. It is still recorded, so the
	// transaction carries it, but the source says not to show it again.
	it("prefers the reply and says so", async () => {
		const { seen, run } = harness({ transaction: 1 });

		await run("editor", [turn({ text: PLAN, reasoning: "some other plan" })]);

		expect(seen).toHaveLength(1);
		expect(seen[0].from).toBe("reply");
	});

	it("reports once per transaction, not once per tool call", async () => {
		const { seen, run } = harness({ transaction: 1 });
		const messages = [turn({ reasoning: PLAN })];

		await run("editor", messages);
		await run("read_files", messages);
		await run("editor", messages);

		expect(seen).toHaveLength(1);
	});

	it("reports again for the next transaction", async () => {
		const source = { transaction: 1 };
		const { seen, run } = harness(source);
		const messages = [turn({ reasoning: PLAN })];

		await run("editor", messages);
		source.transaction = 2;
		await run("editor", messages);

		expect(seen).toHaveLength(2);
	});

	// Every tool, not just the editing ones: a turn that plans and then reads
	// is planning just as much as one that plans and then edits.
	it("watches tools that are not edits", async () => {
		const { seen, run } = harness({ transaction: 1 });

		await run("read_files", [turn({ reasoning: PLAN })]);

		expect(seen).toHaveLength(1);
	});

	it("stays quiet when there is no plan", async () => {
		const { seen, run } = harness({ transaction: 1 });

		await run("editor", [turn({ reasoning: "Let me look at line 90 again." })]);

		expect(seen).toHaveLength(0);
	});

	// The tool is the point; the plan is a bonus. Nothing here may cost a call.
	it("runs the tool regardless", async () => {
		const { calls, run } = harness({ transaction: 1 });

		await run("editor", [turn({ reasoning: PLAN })]);
		await run("editor", []);
		await run("editor", [{ role: "assistant" } as unknown as AgentMessage]);

		expect(calls).toEqual(["editor", "editor", "editor"]);
	});
});
