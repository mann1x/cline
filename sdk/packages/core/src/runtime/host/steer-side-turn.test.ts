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

	// pandorum 2ge0c (4.100.199): the side turn used its own four turns, and the
	// runtime's "Agent runtime exceeded maxIterations (4)" was handed to the
	// lead as its reply. The lead then reported its fixer agents as "cut off at
	// 4 iterations" -- a cap no agent of that round had.
	it("does not pass its own turn cap off as the lead's reply", async () => {
		const result = await runSteerSideTurn({
			sessionId: "lead",
			message: "status?",
			messages: leadMessages,
			createRunner: () => ({
				restore: () => {},
				continue: async () => ({
					text: "Agent runtime exceeded maxIterations (4)",
					finishReason: "max_iterations",
				}),
			}),
		});
		expect(result.reply).not.toContain("exceeded maxIterations");
		expect(result.reply).toContain("side turn");
		const note = describeSideTurnForLead("status?", result);
		expect(note).not.toContain("exceeded maxIterations");
		expect(note).toContain("not the agents'");
		expect(note).toMatch(/^\[SYSTEM MESSAGE\] /);
	});

	it("tells the lead afterwards what was said and done", () => {
		const note = describeSideTurnForLead("stop the fixers", {
			reply: "Stopped them.",
			actions: ["Stopped 2 agent(s): a, b."],
		});
		expect(note).toContain(
			'- user: "stop the fixers" -> you replied: "Stopped them."; did: Stopped 2 agent(s): a, b.',
		);
		expect(note).not.toContain("answer it");
	});

	it("leaves a conversation with nothing open as it is", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
		] as never;
		expect(closeOpenToolCalls(messages, "x")).toHaveLength(1);
	});
});

describe("the agent system's report to the lead", () => {
	it("is put to the lead as a status report, not as the user's words", async () => {
		registerSubagentCancellation("lead::call_1#0", undefined, "stuck-1");
		let asked = "";
		const result = await runSteerSideTurn({
			sessionId: "lead",
			source: "system",
			message:
				'- stuck-1: refused 14 times by Node1: "projected mean tps below floor"',
			messages: leadMessages,
			createRunner: (tools: AgentTool[]) => ({
				restore: () => {},
				continue: async (text) => {
					asked = text;
					await tools
						.find((tool) => tool.name === "stop_agents")
						?.execute({ agents: ["stuck-1"] }, {} as never);
					return { text: "Stopped stuck-1; I will review that file myself." };
				},
			}),
		});

		expect(asked).toContain("status report from the agent system");
		expect(asked).toContain("keep retrying on their own unless you stop them");
		expect(asked).not.toContain("The user has sent you this message");
		expect(result.actions).toEqual(["Stopped 1 agent(s): stuck-1."]);
		const note = describeSideTurnForLead(asked, result, "system");
		expect(note).toContain("- report (stalled:");
		expect(note).not.toContain("- user:");
		expect(note).toContain("Their tasks are yours now");
	});
});

describe("a side turn that did not finish", () => {
	// Swarm 0926: the side turn hit its cap and the lead was told "You replied:
	// Agent runtime exceeded maxIterations (4)", then blamed the fixer agents,
	// which never hit a cap.
	it("never presents the runtime's failure as the lead's reply", async () => {
		const result = await runSteerSideTurn({
			sessionId: "lead",
			message: "how are the fixers doing?",
			messages: leadMessages,
			createRunner: () => ({
				restore: () => {},
				continue: async () => ({
					text: "Agent runtime exceeded maxIterations (4)",
					finishReason: "max_iterations",
				}),
			}),
		});
		expect(result.failed).toBe(true);
		expect(result.reply).not.toContain("maxIterations");
		const note = describeSideTurnForLead("how are the fixers doing?", result);
		expect(note).not.toContain("You replied: Agent runtime exceeded");
		expect(note).toMatch(/side turn used its own \d+ turns, not the agents'/);
		expect(note).toContain("NOT ANSWERED");
	});

	it("says a side turn that errored failed, not what the lead said", async () => {
		const result = await runSteerSideTurn({
			sessionId: "lead",
			message: "status?",
			messages: leadMessages,
			createRunner: () => ({
				restore: () => {},
				continue: async () => ({
					text: "503 Service Unavailable",
					finishReason: "error",
				}),
			}),
		});
		expect(result.failed).toBe(true);
		const note = describeSideTurnForLead("status?", result);
		expect(note).not.toContain("You replied: 503");
	});

	// 4 of 8 side turns in swarm 0926 ran out at 4 iterations. A side turn has
	// to be able to look at the round, act on a few agents, and answer.
	it("has room for a status call, several controls and a reply", async () => {
		const { STEER_SIDE_TURN_MAX_ITERATIONS } = await import(
			"./steer-side-turn"
		);
		expect(STEER_SIDE_TURN_MAX_ITERATIONS).toBeGreaterThanOrEqual(8);
	});
});

// Spec B: the status tool in every mode, the blocking round's side turn
// included -- and nothing else of the lead's.
describe("the side turn's view into the round", () => {
	it("gets agents_status from the lead's tools, and none of the rest", async () => {
		let offered: string[] = [];
		let prompt = "";
		const tool = (name: string) =>
			({
				name,
				description: name,
				inputSchema: {},
				execute: async () => "",
			}) as never;
		await runSteerSideTurn({
			sessionId: "lead",
			message: "how are they doing?",
			messages: leadMessages,
			leadTools: [tool("agents_status"), tool("editor"), tool("spawn_agent")],
			createRunner: (tools: AgentTool[]) => ({
				restore: () => {},
				continue: async (text) => {
					offered = tools.map((entry) => entry.name);
					prompt = text;
					return { text: "fine" };
				},
			}),
		});
		expect(offered).toEqual([
			"message_agents",
			"stop_agents",
			"requeue_agent",
			"restart_agent",
			"resume_agent",
			"retry_failed",
			"agents_status",
		]);
		expect(prompt).toContain("`agents_status` shows what each agent is doing");
		expect(prompt).not.toContain("{LEAD_TOOLS}");
	});
});
