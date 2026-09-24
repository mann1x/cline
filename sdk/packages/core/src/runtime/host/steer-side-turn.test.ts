import type { AgentTool } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetSubagentCancellations,
	registerSubagentCancellation,
} from "../../extensions/tools/team/subagent-cancellation";
import {
	closeOpenToolCalls,
	describeSideTurnForLead,
	runSteerSideTurn,
} from "./steer-side-turn";

afterEach(() => __resetSubagentCancellations());

const leadMessages = [
	{ role: "user", content: [{ type: "text", text: "launch the swarm" }] },
	{
		role: "assistant",
		content: [
			{ type: "tool_use", id: "call_1", name: "spawn_agent", input: {} },
		],
	},
] as never;

describe("the lead's side turn", () => {
	// pandorum 2026-09-24: a steer sent 45 minutes into a round was queued for
	// a turn the lead would not take until all 75 agents had finished.
	it("answers now, and can message and stop the round's agents", async () => {
		const verifier = registerSubagentCancellation(
			"lead::call_1#0",
			undefined,
			"verifier-1",
		);
		const fixer = registerSubagentCancellation(
			"lead::call_1#1",
			undefined,
			"brace-fixer-1",
		);
		let seeded: unknown[] = [];
		const result = await runSteerSideTurn({
			sessionId: "lead",
			message: "skip brace verification, stop the fixers",
			messages: leadMessages,
			createRunner: (tools: AgentTool[]) => ({
				restore: (messages) => {
					seeded = [...messages];
				},
				continue: async () => {
					const byName = new Map(tools.map((tool) => [tool.name, tool]));
					await byName
						.get("message_agents")
						?.execute(
							{ text: "Skip brace verification.", agents: ["verifier-1"] },
							{} as never,
						);
					await byName
						.get("stop_agents")
						?.execute({ agents: ["brace-fixer-1"] }, {} as never);
					return { text: "Done: verifiers told, fixers stopped." };
				},
			}),
		});

		expect(result.reply).toBe("Done: verifiers told, fixers stopped.");
		expect(result.actions).toEqual([
			'Sent to 1 agent(s): verifier-1. Message: "Skip brace verification."',
			"Stopped 1 agent(s): brace-fixer-1.",
		]);
		expect(verifier.takeMessage()).toBe("Skip brace verification.");
		expect(fixer.signal?.aborted).toBe(true);
		// The open delegation call is closed in the copy, with the round's state.
		const closing = seeded[seeded.length - 1] as {
			content: Array<Record<string, unknown>>;
		};
		expect(closing.content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "call_1",
		});
		expect(String(closing.content[0]?.content)).toContain("verifier-1");
	});

	it("says it failed, and leaves the message for the lead", async () => {
		const result = await runSteerSideTurn({
			sessionId: "lead",
			message: "status?",
			messages: leadMessages,
			createRunner: () => {
				throw new Error("model unreachable");
			},
		});
		expect(result.failed).toBe(true);
		expect(result.reply).toContain("model unreachable");
	});

	it("tells the lead afterwards what was said and done", () => {
		const note = describeSideTurnForLead("stop the fixers", {
			reply: "Stopped them.",
			actions: ["Stopped 2 agent(s): a, b."],
		});
		expect(note).toContain("The user said: stop the fixers");
		expect(note).toContain("You did: Stopped 2 agent(s): a, b.");
	});

	it("leaves a conversation with nothing open as it is", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
		] as never;
		expect(closeOpenToolCalls(messages, "x")).toHaveLength(1);
	});
});
