import type { AgentResult } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { withExpertTranscript } from "./expert-transcript";

function expertThat(run: (prompt: string) => Promise<AgentResult>) {
	const messages: AgentResult["messages"] = [];
	return {
		run: vi.fn(async (prompt: string) => {
			messages.push({ role: "user", content: prompt } as never);
			return run(prompt);
		}),
		shutdown: vi.fn(async () => {}),
		getAgentId: () => "expert-agent",
		getConversationId: () => "expert-conv",
		getMessages: () => messages,
	};
}

describe("withExpertTranscript", () => {
	it("files the sub-session once, with the brief, and saves after every ask", async () => {
		const expert = expertThat(
			async () =>
				({ text: "done", finishReason: "completed", messages: [] }) as never,
		);
		const start = vi.fn();
		const end = vi.fn();
		const runtime = withExpertTranscript(expert, { start, end });

		await runtime.run("the brief");
		await runtime.run("a follow-up");

		expect(start).toHaveBeenCalledTimes(1);
		expect(start.mock.calls[0]?.[0]).toMatchObject({
			subAgentId: "expert-agent",
			conversationId: "expert-conv",
			input: { name: "expert", task: "the brief" },
		});
		expect(end).toHaveBeenCalledTimes(2);
		expect(end.mock.calls[1]?.[0].input.task).toBe("the brief");
	});

	it("saves what the expert had when its run throws, and rethrows", async () => {
		const expert = expertThat(async () => {
			throw new Error("usage limit");
		});
		const end = vi.fn();
		const runtime = withExpertTranscript(expert, { start: vi.fn(), end });

		await expect(runtime.run("the brief")).rejects.toThrow("usage limit");

		const context = end.mock.calls[0]?.[0];
		expect(context.error.message).toBe("usage limit");
		expect(context.agentResult.messages).toHaveLength(1);
	});

	it("does not let a failing sink cost the escalation", async () => {
		const expert = expertThat(
			async () => ({ text: "done", finishReason: "completed" }) as never,
		);
		const runtime = withExpertTranscript(expert, {
			start: () => {
				throw new Error("store down");
			},
			end: async () => {
				throw new Error("store down");
			},
		});

		await expect(runtime.run("the brief")).resolves.toMatchObject({
			text: "done",
		});
		await runtime.shutdown?.("done");
		expect(expert.shutdown).toHaveBeenCalledWith("done");
	});
});
