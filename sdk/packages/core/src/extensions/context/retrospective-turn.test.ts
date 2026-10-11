import type * as LlmsProviders from "@cline/llms";
import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { runAgenticCompaction } from "./agentic-compaction";
import {
	isCompactionSummaryMessage,
	isRetrospectiveTurn,
	resolveRecencyBounds,
} from "./compaction-shared";
import { DEFAULT_REPLAY_COMPACTION_PROMPT } from "./replay-compaction";

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
	reasoningHistoryModeForProvider: () => "all",
}));

const RETROSPECTIVE = "What keeps costing me is rewriting the whole file.";

/** Answers the retrospective call with one text and every other call with another. */
function stubSummarizer(): void {
	createHandlerMock.mockImplementation(() => ({
		createMessage: (system: string) =>
			(async function* () {
				yield {
					type: "text",
					text: system.includes("how your work on this task is going")
						? RETROSPECTIVE
						: "I am fixing the game. Let me read the file.",
				};
				yield { type: "done", success: true };
			})(),
	}));
}

function transcript(): MessageWithMetadata[] {
	const messages: MessageWithMetadata[] = [
		{ role: "user", content: "fix the game" },
	];
	for (let index = 0; index < 8; index += 1) {
		messages.push({
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `thinking ${index}. ${"why ".repeat(60)}`,
				},
				{ type: "text", text: `step ${index}. ${"detail ".repeat(200)}` },
				{
					type: "tool_use",
					id: `t${index}`,
					name: "read_files",
					input: { path: `file-${index}.ts` },
				},
			],
		});
		messages.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `t${index}`,
					name: "read_files",
					content: `result ${index}. ${"line ".repeat(200)}`,
				},
			],
		});
	}
	// One reply thrown away at the output limit, as the harness records it.
	messages.splice(9, 0, {
		role: "user",
		content: [{ type: "text", text: "[SYSTEM] Your last reply hit the limit" }],
		metadata: {
			userRunSpan: 0,
			displayRole: "system",
			noticeKind: "max_tokens_turn_recovery",
		},
	});
	return messages;
}

function contextFor(messages: MessageWithMetadata[]): CoreCompactionContext {
	const targetTokens = 100_000;
	return {
		agentId: "agent-1",
		conversationId: "conv-1",
		parentAgentId: null,
		iteration: 1,
		messages,
		model: {
			id: "mock-model",
			provider: "anthropic",
			info: { id: "mock-model", maxInputTokens: targetTokens },
		},
		mode: "auto",
		budget: {
			request: {
				inputTokens: targetTokens * 2,
				maxInputTokens: targetTokens,
				triggerTokens: targetTokens,
				targetTokens,
				overheadTokens: 0,
				thresholdRatio: 1,
				utilizationRatio: 2,
			},
			messages: {
				inputTokens: targetTokens * 2,
				triggerTokens: targetTokens,
				targetTokens,
			},
		},
	} as unknown as CoreCompactionContext;
}

const bounds = resolveRecencyBounds({
	preserveRecentTokens: 2_000,
	preserveRecentMessagesRatio: Number.EPSILON,
	messageTargetTokens: Number.MAX_SAFE_INTEGER,
});

async function compact(keepRecentMessages: boolean) {
	const messages = transcript();
	const result = await runAgenticCompaction({
		context: contextFor(messages),
		providerConfig: {
			providerId: "anthropic",
			modelId: "mock-model",
			modelInfo: { id: "mock-model", maxInputTokens: 100_000 },
		} as never,
		keepRecentMessages,
		summaryPrompt: DEFAULT_REPLAY_COMPACTION_PROMPT,
		thinkingSummaryEnabled: true,
		councilEnabled: false,
		bounds,
		estimateMessageTokens: (message: LlmsProviders.Message) =>
			JSON.stringify(message).length,
	});
	return result?.messages ?? [];
}

const textOf = (message: MessageWithMetadata | undefined): string =>
	Array.isArray(message?.content)
		? message.content
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("")
		: String(message?.content ?? "");

beforeEach(() => {
	createHandlerMock.mockReset();
	stubSummarizer();
});

describe("the retrospective after a compaction that keeps a tail", () => {
	it("is a turn of the model's own, carried as its reasoning, between the summary and the tail", async () => {
		const out = await compact(true);
		const at = out.findIndex(isRetrospectiveTurn);

		expect(isCompactionSummaryMessage(out[0])).toBe(true);
		expect(at).toBeGreaterThan(0);
		expect(out.length).toBeGreaterThan(at + 1);
		const turn = out[at];
		expect(turn.role).toBe("assistant");
		const thinking = (
			turn.content as Array<{ type: string; thinking?: string }>
		)
			.map((block) => block.thinking ?? "")
			.join("");
		expect(thinking).toContain(RETROSPECTIVE);
		// What the harness saw and the model could not, in its own voice.
		expect(thinking).toContain("once my reply runs into the output limit");
		expect(
			(turn.metadata as { pinnedReasoning?: boolean }).pinnedReasoning,
		).toBe(true);
		// Said once: not in the summary as well.
		expect(textOf(out[0])).not.toContain(RETROSPECTIVE);
		expect(textOf(out[0])).not.toContain("Retrospective on the work");
		// Still what the next compaction is handed as the previous one.
		expect(
			(out[0].metadata as { thinkingSummary?: string }).thinkingSummary,
		).toBe(RETROSPECTIVE);
	});

	it("stays in the summary when nothing is kept, since a request cannot end on an assistant turn", async () => {
		const out = await compact(false);
		expect(out.some(isRetrospectiveTurn)).toBe(false);
		expect(out.at(-1)?.role).toBe("user");
		expect(textOf(out[0])).toContain(RETROSPECTIVE);
	});
});
