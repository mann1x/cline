import type * as LlmsProviders from "@cline/llms";
import { noteContextOverflow, resetTokenCalibration } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";

/**
 * Whose overflow a compaction acts on.
 *
 * A delegated agent carries the lead's `sessionId` for telemetry. The gateway
 * filed its measurements under that id, so on pandorum 2026-09-26 an agent's
 * overflow (62,553 estimated tokens of a 65,536 window) was consumed by the
 * lead, at 35,073 of 128,000, which compacted its transcript as if it were
 * full. The agent's measurements now go under its own engine session.
 */

const LEAD = "1790412260538_q92j7";
const AGENT = `${LEAD}~agent-mui5m1casf9gvl`;

function pipeline(engineSessionId?: string) {
	const compact = vi.fn(async () => ({
		messages: [{ role: "user", content: "summary" }],
	}));
	const prepareTurn = createContextCompactionPrepareTurn({
		providerId: "ollama",
		modelId: "m",
		sessionId: LEAD,
		providerConfig: {
			providerId: "ollama",
			modelId: "m",
			...(engineSessionId ? { engineSessionId } : {}),
		} as unknown as LlmsProviders.ProviderConfig,
		compaction: { enabled: true, strategy: "basic", compact } as never,
	});
	const run = async (contextWindow: number) => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "a short task" },
			{ role: "assistant", content: "working on it" },
			{ role: "user", content: "continue" },
		];
		await prepareTurn?.({
			agentId: engineSessionId ? "agent_worker" : "agent_lead",
			conversationId: LEAD,
			parentAgentId: engineSessionId ? "agent_lead" : null,
			iteration: 2,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "m",
				provider: "ollama",
				info: { id: "m", contextWindow, maxTokens: 8_192 },
			},
		} as never);
	};
	return { compact, run };
}

const agentOverflow = {
	contextWindow: 65_536,
	estimatedInputTokens: 62_553,
	reserveTokens: 7_507,
	remainingContext: -4_524,
	minOutputTokens: 1_024,
};

afterEach(() => {
	resetTokenCalibration();
});

describe("an agent's context overflow", () => {
	it("does not compact the lead it runs for", async () => {
		noteContextOverflow(agentOverflow, AGENT);
		const lead = pipeline();
		await lead.run(128_000);
		expect(lead.compact).not.toHaveBeenCalled();
	});

	it("compacts the agent it happened to", async () => {
		noteContextOverflow(agentOverflow, AGENT);
		const agent = pipeline(AGENT);
		await agent.run(65_536);
		expect(agent.compact).toHaveBeenCalledTimes(1);
	});
});
