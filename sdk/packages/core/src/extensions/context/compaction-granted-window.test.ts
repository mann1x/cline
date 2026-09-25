import type * as LlmsProviders from "@cline/llms";
import { recordPolykvGrantedWindow, resetPolykvSessions } from "@cline/llms";
import { afterEach, describe, expect, it } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";

/**
 * A conversation negotiated down to 32k of a configured 128k holds 32k for its
 * life. Every compaction threshold computed against 128k fires after the real
 * window has already run out, so compaction sizes against the grant.
 */
describe("compaction on a negotiated-down window", () => {
	afterEach(resetPolykvSessions);

	async function measuredMaxInput(sessionId: string, providerId: string) {
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId,
			modelId: "m",
			sessionId,
			providerConfig: {
				providerId,
				modelId: "m",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic" },
			logger: undefined,
		});
		const notices: Array<Record<string, unknown>> = [];
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "start" },
		];
		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: sessionId,
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "m",
				provider: providerId,
				info: { id: "m", contextWindow: 131_072, maxTokens: 8_192 },
			},
			emitStatusNotice: (
				_message: string,
				metadata?: Record<string, unknown>,
			) => {
				if (metadata) {
					notices.push(metadata);
				}
			},
		} as never);
		return notices.find((notice) => notice.kind === "context_breakdown")
			?.maxInputTokens as number | undefined;
	}

	it("sizes against the granted window when it is smaller", async () => {
		recordPolykvGrantedWindow("conv-granted", 32_768, { asked: 131_072 });
		const granted = await measuredMaxInput("conv-granted", "opencoti");
		expect(granted).toBeLessThanOrEqual(32_768);
	});

	it("sizes against the configured window when nothing smaller was granted", async () => {
		const configured = await measuredMaxInput("conv-free", "opencoti");
		expect(configured).toBeGreaterThan(32_768);
	});
});
