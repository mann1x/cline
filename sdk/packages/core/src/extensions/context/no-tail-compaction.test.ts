import type * as LlmsProviders from "@cline/llms";
import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { runAgenticCompaction } from "./agentic-compaction";
import {
	buildSummaryMessage,
	dropsTailAtThisCompaction,
	planFullCut,
	resolveRecencyBounds,
} from "./compaction-shared";
import { DEFAULT_FULL_COMPACTION_PROMPT } from "./full-compaction";
import { DEFAULT_REPLAY_COMPACTION_PROMPT } from "./replay-compaction";

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
	reasoningHistoryModeForProvider: () => "all",
}));

const estimateJsonTokens = (message: LlmsProviders.Message): number =>
	JSON.stringify(message).length;

/** Every system prompt and request the stubbed summarizer was handed. */
const calls: Array<{ system: string; request: string }> = [];

function stubSummarizer(
	summary = "## Goal\nThe goal.\n\n## Next\nThe step.",
): void {
	createHandlerMock.mockImplementation(() => ({
		createMessage: (system: string, messages: Array<{ content: string }>) => {
			calls.push({ system, request: messages[0]?.content ?? "" });
			return (async function* () {
				yield { type: "text", text: summary };
				yield { type: "done", success: true };
			})();
		},
	}));
}

function transcript(): MessageWithMetadata[] {
	const messages: MessageWithMetadata[] = [
		{ role: "user", content: "never run the linter on generated files" },
	];
	for (let index = 0; index < 8; index += 1) {
		messages.push({
			role: "assistant",
			content: [
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
					...(index === 3 ? { is_error: true } : {}),
				},
			],
		});
	}
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

async function compact(keepRecentMessages: boolean, summaryPrompt: string) {
	const messages = transcript();
	return {
		messages,
		result: await runAgenticCompaction({
			context: contextFor(messages),
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
				modelInfo: { id: "mock-model", maxInputTokens: 100_000 },
			} as never,
			keepRecentMessages,
			summaryPrompt,
			thinkingSummaryEnabled: false,
			bounds,
			estimateMessageTokens: estimateJsonTokens,
		}),
	};
}

beforeEach(() => {
	calls.length = 0;
	createHandlerMock.mockReset();
	stubSummarizer();
});

describe("planFullCut", () => {
	it("cuts at the end, because there is no tail to find", () => {
		const messages = transcript();
		expect(planFullCut(messages).cutIndex).toBe(messages.length);
	});

	it("pins the typed request that started the turn", () => {
		// The one message whose loss is both unrecoverable and unnoticeable: a
		// summary that drops it leaves a detailed account of work with no stated
		// purpose, which is how a compacted session ends up asking the user what
		// the task was.
		const messages = transcript();
		expect(planFullCut(messages).pinnedIndex).toBe(0);
	});

	it("pins nothing when no typed request is left to pin", () => {
		// A transcript that is a previous summary plus a tool loop has nothing
		// that qualifies, and pinning index 0 there would carry the old summary
		// forward verbatim alongside the new one.
		const messages: MessageWithMetadata[] = [
			buildSummaryMessage({
				summary: "an earlier summary",
				fileOps: { readFiles: [], modifiedFiles: [] },
				tokensBefore: 10,
				userRunSpan: 1,
			}),
			{ role: "assistant", content: "kept working" },
		];
		expect(planFullCut(messages).pinnedIndex).toBe(-1);
	});
});

describe("compacting with no recency tail", () => {
	it("leaves the summary and the pinned request, and nothing else", async () => {
		const { result } = await compact(false, DEFAULT_FULL_COMPACTION_PROMPT);

		expect(result?.messages).toHaveLength(2);
		// Verbatim, not the summary's account of it.
		expect(JSON.stringify(result?.messages)).toContain(
			"never run the linter on generated files",
		);
	});

	it("folds the turn the tail strategy would have kept", async () => {
		const withTail = await compact(true, DEFAULT_REPLAY_COMPACTION_PROMPT);
		const withoutTail = await compact(false, DEFAULT_FULL_COMPACTION_PROMPT);

		expect(withTail.result?.messages.length).toBeGreaterThan(
			withoutTail.result?.messages.length ?? 0,
		);
	});

	it("ignores the recency bounds entirely", async () => {
		// The bound that would keep most of this transcript changes nothing,
		// because the no-tail plan never consults it.
		const messages = transcript();
		const result = await runAgenticCompaction({
			context: contextFor(messages),
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
				modelInfo: { id: "mock-model", maxInputTokens: 100_000 },
			} as never,
			keepRecentMessages: false,
			summaryPrompt: DEFAULT_FULL_COMPACTION_PROMPT,
			thinkingSummaryEnabled: false,
			bounds: resolveRecencyBounds({
				preserveRecentTokens: Number.MAX_SAFE_INTEGER,
				messageTargetTokens: Number.MAX_SAFE_INTEGER,
			}),
			estimateMessageTokens: estimateJsonTokens,
		});

		expect(result?.messages).toHaveLength(2);
	});

	it("tells the summarizer it is writing a state record, not a replay", async () => {
		await compact(false, DEFAULT_FULL_COMPACTION_PROMPT);

		expect(calls[0]?.system.toLowerCase()).toContain("state record");
		expect(calls[0]?.request).toContain("## Retrospective");
	});
});

describe("compacting with a recency tail", () => {
	it("still keeps messages after the summary", async () => {
		const { result } = await compact(true, DEFAULT_REPLAY_COMPACTION_PROMPT);

		expect(result?.messages.length).toBeGreaterThan(2);
	});

	it("tells the summarizer it is re-telling its own work", async () => {
		await compact(true, DEFAULT_REPLAY_COMPACTION_PROMPT);

		expect(calls[0]?.system.toLowerCase()).toContain("your own voice");
		expect(calls[0]?.system.toLowerCase()).not.toContain("hand-over");
	});
});

describe("a summarizer too small for its own instruction", () => {
	it("skips, and says so at warn rather than in the debug log", async () => {
		// Both built-in prompts are larger than the one they replaced, and the
		// no-tail prompt is a fixed section list that cannot be short. So this
		// stopped being a corner: below the floor the instruction fills the
		// window on its own, no transcript will ever fit, and every compaction
		// from there is a silent no-op while the context keeps growing. The
		// severity is the whole point of the test.
		const log = vi.fn();
		const messages = transcript();
		const result = await runAgenticCompaction({
			context: contextFor(messages),
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
				modelInfo: { id: "mock-model", maxInputTokens: 100_000 },
			} as never,
			summarizer: {
				providerId: "openai",
				modelId: "tiny",
				modelInfo: { id: "tiny", maxInputTokens: 300 },
			} as never,
			keepRecentMessages: false,
			summaryPrompt: DEFAULT_FULL_COMPACTION_PROMPT,
			thinkingSummaryEnabled: false,
			bounds,
			estimateMessageTokens: estimateJsonTokens,
			logger: { log, debug: vi.fn() },
		});

		expect(result).toBeUndefined();
		expect(createHandlerMock).not.toHaveBeenCalled();
		const [message, detail] = (log.mock.calls[0] ?? []) as [
			string,
			{ severity?: string },
		];
		expect(message).toContain("exceeds the summarizer");
		expect(detail?.severity).toBe("warn");
	});
});

describe("the tool ledger the harness appends", () => {
	function summaryText(result: Awaited<ReturnType<typeof compact>>["result"]) {
		return JSON.stringify(result?.messages[0]);
	}

	it("lands on the summary message under both cuts", async () => {
		for (const keep of [true, false]) {
			const { result } = await compact(
				keep,
				keep
					? DEFAULT_REPLAY_COMPACTION_PROMPT
					: DEFAULT_FULL_COMPACTION_PROMPT,
			);

			const text = summaryText(result);
			expect(text).toContain("recorded by the harness");
			expect(text).toContain("read_files");
		}
	});

	it("marks the call that was refused, which the summary is worst at keeping", async () => {
		const { result } = await compact(false, DEFAULT_FULL_COMPACTION_PROMPT);

		expect(summaryText(result)).toContain("FAILED");
	});

	it("stays out of the metadata the next compaction reads back", async () => {
		// A ledger inside `metadata.summary` becomes the next generation's
		// `previousSummary`, gets re-emitted into the summary that replaces it,
		// and every generation then carries every earlier one's calls -- the
		// transcript shrinking while the summary grows.
		const { result } = await compact(false, DEFAULT_FULL_COMPACTION_PROMPT);
		const metadata = (
			result?.messages[0] as { metadata?: { summary?: string } } | undefined
		)?.metadata;

		expect(metadata?.summary).toBeTruthy();
		expect(metadata?.summary).not.toContain("read_files");
	});

	it("says nothing at all for a stretch with no tool calls", async () => {
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "do the thing" },
			...Array.from({ length: 6 }, (_, index) => ({
				role: "assistant" as const,
				content: [
					{
						type: "text" as const,
						text: `prose ${index} ${"x".repeat(2_000)}`,
					},
				],
			})),
		];
		const result = await runAgenticCompaction({
			context: contextFor(messages),
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
				modelInfo: { id: "mock-model", maxInputTokens: 100_000 },
			} as never,
			keepRecentMessages: false,
			summaryPrompt: DEFAULT_FULL_COMPACTION_PROMPT,
			thinkingSummaryEnabled: false,
			bounds,
			estimateMessageTokens: estimateJsonTokens,
		});

		expect(JSON.stringify(result?.messages[0])).not.toContain(
			"recorded by the harness",
		);
	});
});

/**
 * The compaction that stops keeping a tail, and why it is the second one.
 *
 * Measured over 335 harness runs with a verdict. The fix rate falls with every
 * compaction a run has been through -- 85% at none, 63% at one, 50% at two,
 * 25% at three -- and firing at the second picks a population that fails 67% of
 * the time, at a cost of 10.6% of the runs that went on to succeed.
 */
describe("dropping the tail once a run has compacted before", () => {
	function summary(generation: number): MessageWithMetadata {
		return {
			role: "assistant",
			content: "summary",
			metadata: { kind: "compaction_summary", summary: "s", generation },
		} as unknown as MessageWithMetadata;
	}
	const plain = {
		role: "user",
		content: "hi",
	} as unknown as MessageWithMetadata;

	it("keeps the tail on a transcript that has never been compacted", () => {
		expect(dropsTailAtThisCompaction([plain, plain], undefined)).toBe(false);
	});

	it("drops it on the second compaction", () => {
		expect(dropsTailAtThisCompaction([summary(1), plain], undefined)).toBe(
			true,
		);
	});

	// The generation is the ladder's own rung, not a count of the messages that
	// survived: one summary carrying generation 3 means three have happened.
	it("reads the generation rather than counting summaries", () => {
		expect(dropsTailAtThisCompaction([summary(3)], 4)).toBe(true);
		expect(dropsTailAtThisCompaction([summary(2)], 4)).toBe(false);
	});

	it("can be set to the first compaction, or turned off entirely", () => {
		expect(dropsTailAtThisCompaction([plain], 1)).toBe(true);
		expect(dropsTailAtThisCompaction([summary(9)], 0)).toBe(false);
		expect(dropsTailAtThisCompaction([summary(9)], -1)).toBe(false);
	});
});
