import type * as LlmsProviders from "@cline/llms";
import {
	estimateRequestInputTokens,
	type MessageWithMetadata,
	observeRequestTokens,
	resetTokenCalibration,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSessionCompactionState,
	projectSessionCompactionState,
} from "../../session/models/session-compaction";
import type { CoreCompactionContext } from "../../types/config";
import { buildAgenticSummaryInputBudget } from "./agentic-compaction";
import { runBasicCompaction } from "./basic-compaction";
import {
	createCompactionStateAwarePrepareTurn,
	createContextCompactionPrepareTurn,
} from "./compaction";
import {
	createTokenEstimator,
	estimateTokens,
	findCutPlan,
	buildSummaryMessage,
	buildThinkingSummaryRequest,
	getCompactionSummaryMetadata,
	resolveCompactionOutputBudgets,
	resolveEffectiveMaxInputTokens,
	resolvePreserveRecentTokens,
	resolveRecencyBounds,
	resolveSummarizerConfig,
	resolveThinkingSummaryMaxTokens,
	serializeMessage,
	serializeReasoningWithOutcomes,
	TOOL_RESULT_CHAR_LIMIT,
} from "./compaction-shared";

type FakeChunk = Record<string, unknown>;

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", () => ({
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
	// The estimator has to measure what the provider will send, so compaction
	// asks which reasoning the provider keeps. These tests use a stub provider,
	// which keeps all of it.
	reasoningHistoryModeForProvider: () => "all",
}));

async function* streamChunks(chunks: FakeChunk[]): AsyncGenerator<FakeChunk> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

const estimateJsonTokens = (message: LlmsProviders.Message): number =>
	JSON.stringify(message).length;

function totalJsonTokens(messages: LlmsProviders.Message[]): number {
	return messages.reduce(
		(total, message) => total + estimateJsonTokens(message),
		0,
	);
}

/**
 * Recency bounds for the token-only cases these tests were written against:
 * no count floor, and a ceiling that never binds.
 */
function bounds(
	preserveRecentTokens: number,
	overrides: {
		messagesRatio?: number;
		messageTargetTokens?: number;
		lastTurnCeiling?: number;
	} = {},
) {
	return resolveRecencyBounds({
		preserveRecentTokens,
		preserveRecentMessagesRatio: overrides.messagesRatio ?? Number.EPSILON,
		messageTargetTokens:
			overrides.messageTargetTokens ?? Number.MAX_SAFE_INTEGER,
		lastTurnCeiling: overrides.lastTurnCeiling,
	});
}

/** Multi-turn transcript with prunable tool output for basic-compaction tests. */
/**
 * A transcript with enough history behind it for summarising to be worth doing.
 *
 * The short fixture below cannot show it: on five small messages a summary plus
 * the recent turns is larger than the recent turns alone, so recovery correctly
 * keeps the dropped version. Recovery happens on transcripts that overflowed a
 * context window, where the proportions are the other way around.
 */
function longOverflowRecoveryTranscript(): MessageWithMetadata[] {
	const older: MessageWithMetadata[] = [];
	for (let index = 0; index < 12; index += 1) {
		older.push({
			role: "assistant",
			content: [
				{ type: "text", text: `Older assistant explanation ${index}. ${"detail ".repeat(200)}` },
			],
		});
		older.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `tool-${index}`,
					name: "tool",
					content: `tool output ${index}. ${"line ".repeat(200)}`,
				},
			],
		});
	}
	return [
		{ role: "user", content: "Initial request that should survive" },
		...older,
		{ role: "user", content: "Most recent user turn" },
		{
			role: "assistant",
			content: [{ type: "text", text: "Most recent assistant reply" }],
		},
	];
}

function overflowRecoveryTranscript(): MessageWithMetadata[] {
	return [
		{ role: "user", content: "Initial request that should survive" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Older assistant explanation" },
				{
					type: "tool_use",
					id: "tool-1",
					name: "read_files",
					input: { file_paths: ["/tmp/example.ts"] },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tool-1",
					name: "tool",
					content: "tool output that should be removed",
				},
			],
		},
		{ role: "user", content: "Most recent user turn" },
		{
			role: "assistant",
			content: [{ type: "text", text: "Most recent assistant reply" }],
		},
	];
}

/** The compaction produced messages and pruned the marked tool output. */
function assertBasicCompactionResult(
	result: { messages: MessageWithMetadata[] } | undefined,
): void {
	expect(result?.messages).toBeDefined();
	expect(result?.messages.length).toBeGreaterThan(0);
	for (const message of result?.messages ?? []) {
		if (typeof message.content === "string") {
			expect(message.content).not.toContain(
				"tool output that should be removed",
			);
		} else {
			for (const block of message.content) {
				if (block.type === "text") {
					expect(block.text).not.toContain(
						"tool output that should be removed",
					);
				}
			}
		}
	}
}

describe("createTokenEstimator", () => {
	it("does not treat cumulative request metrics as per-message token counts", () => {
		const estimateMessageTokens = createTokenEstimator();
		const message: MessageWithMetadata = {
			role: "assistant",
			content: "short",
			metrics: {
				inputTokens: 100,
				cacheReadTokens: 80,
				outputTokens: 7,
			},
		};

		expect(estimateMessageTokens(message)).toBe(
			Math.ceil(JSON.stringify(message).length / 3),
		);
	});

	it("falls back to serialized character estimation when metrics are incomplete", () => {
		const estimateMessageTokens = createTokenEstimator();
		const message: MessageWithMetadata = {
			role: "assistant",
			content: "short",
			metrics: {
				inputTokens: 12,
			},
		};

		expect(estimateMessageTokens(message)).toBe(
			Math.ceil(JSON.stringify(message).length / 3),
		);
	});
});

describe("resolveEffectiveMaxInputTokens", () => {
	it("uses maxInputTokens when it differs from contextWindow", () => {
		expect(
			resolveEffectiveMaxInputTokens({
				maxInputTokens: 200_000,
				contextWindow: 400_000,
			}),
		).toBe(200_000);
	});

	it("caps maxInputTokens at contextWindow", () => {
		expect(
			resolveEffectiveMaxInputTokens({
				maxInputTokens: 500_000,
				contextWindow: 400_000,
			}),
		).toBe(400_000);
	});

	it("keeps maxInputTokens authoritative when it equals contextWindow", () => {
		expect(
			resolveEffectiveMaxInputTokens({
				maxInputTokens: 400_000,
				contextWindow: 400_000,
			}),
		).toBe(400_000);
	});

	it("uses 90 percent of contextWindow when maxTokens is unavailable", () => {
		expect(
			resolveEffectiveMaxInputTokens({
				contextWindow: 400_000,
			}),
		).toBe(360_000);
	});

	it("does not reserve catalog maxTokens when only contextWindow is available", () => {
		const modelInfo = {
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
		expect(resolveEffectiveMaxInputTokens(modelInfo)).toBe(360_000);
	});

	it("keeps maxInputTokens when maxTokens would leave no input budget", () => {
		const modelInfo = {
			maxInputTokens: 200_000,
			contextWindow: 200_000,
			maxTokens: 200_000,
		};
		expect(resolveEffectiveMaxInputTokens(modelInfo)).toBe(200_000);
	});
});

function runForcedBasicCompaction(
	messages: LlmsProviders.Message[],
	targetTokens: number,
): LlmsProviders.Message[] {
	const result = runBasicCompaction({
		context: {
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
			mode: "manual",
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
		},
		estimateMessageTokens: estimateJsonTokens,
	});
	return result?.messages ?? messages;
}

function assistantToolUseMessage(
	id: string,
	extraContent: LlmsProviders.ContentBlock[] = [],
): LlmsProviders.Message {
	return {
		role: "assistant",
		content: [
			...extraContent,
			{
				type: "tool_use",
				id,
				name: "read_files",
				input: { file_paths: [`/tmp/${id}.ts`] },
			},
		],
	};
}

function assistantMultiToolUseMessage(ids: string[]): LlmsProviders.Message {
	return {
		role: "assistant",
		content: ids.map((id) => ({
			type: "tool_use",
			id,
			name: "read_files",
			input: { file_paths: [`/tmp/${id}.ts`] },
		})),
	};
}

function toolResultMessage(
	id: string,
	content = "tool result",
): LlmsProviders.Message {
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: id,
				name: "read_files",
				content,
			},
		],
	};
}

function collectToolPairPresence(messages: LlmsProviders.Message[]): Map<
	string,
	{
		hasResult: boolean;
		hasUse: boolean;
	}
> {
	const presence = new Map<string, { hasResult: boolean; hasUse: boolean }>();
	const ensure = (id: string) => {
		const existing = presence.get(id);
		if (existing) {
			return existing;
		}
		const next = { hasResult: false, hasUse: false };
		presence.set(id, next);
		return next;
	};
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use") {
				ensure(block.id).hasUse = true;
			} else if (block.type === "tool_result") {
				ensure(block.tool_use_id).hasResult = true;
			}
		}
	}
	return presence;
}

function expectNoOrphanedToolPairs(messages: LlmsProviders.Message[]): void {
	for (const [id, presence] of collectToolPairPresence(messages)) {
		expect(presence, `tool pair ${id}`).toEqual({
			hasResult: presence.hasUse,
			hasUse: presence.hasResult,
		});
	}
}

describe("createContextCompactionPrepareTurn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("truncates text-block tool results when serializing compaction input", () => {
		const longToolOutput = "x".repeat(TOOL_RESULT_CHAR_LIMIT + 100);

		const serializedStringResult = serializeMessage({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tool-1",
					name: "tool",
					content: longToolOutput,
				},
			],
		});
		const serializedTextBlockResult = serializeMessage({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tool-1",
					name: "tool",
					content: [{ type: "text", text: longToolOutput }],
				},
			],
		});

		expect(serializedTextBlockResult).toBe(serializedStringResult);
		expect(serializedTextBlockResult).toContain(`...[truncated 100 chars]`);
		expect(serializedTextBlockResult.length).toBeLessThan(
			longToolOutput.length,
		);
	});

	it("returns no result when the transcript has no typed user prompt", () => {
		// The whole-history fold anchors on typed user prompts; a transcript
		// of pure tool traffic has nothing to fold around.
		const omittedTail = "TAIL_SHOULD_NOT_SURVIVE_BASIC_COMPACTION";
		const longToolOutput =
			"x".repeat(TOOL_RESULT_CHAR_LIMIT + 5_000) + omittedTail;
		const result = runBasicCompaction({
			context: {
				agentId: "agent-1",
				conversationId: "conv-1",
				parentAgentId: null,
				iteration: 1,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool-custom",
								name: "custom_reporter",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-custom",
								name: "tool",
								content: [{ type: "text", text: longToolOutput }],
							},
						],
					},
				],
				model: {
					id: "mock-model",
					provider: "anthropic",
					info: { id: "mock-model", maxInputTokens: 100_000 },
				},
				mode: "manual",
				budget: {
					request: {
						inputTokens: 10_000,
						maxInputTokens: 100_000,
						triggerTokens: 100_000,
						targetTokens: 100_000,
						overheadTokens: 0,
						thresholdRatio: 1,
						utilizationRatio: 0.1,
					},
					messages: {
						inputTokens: 10_000,
						triggerTokens: 100_000,
						targetTokens: 100_000,
					},
				},
			},
			estimateMessageTokens: createTokenEstimator(),
		});

		expect(result).toBeUndefined();
	});

	it("drops the latest turn's tool pair atomically when over budget", () => {
		// The whole history is compactable — there is no protected latest
		// turn. A fresh tool pair that does not fit the budget is removed
		// with both halves together, never split.
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Read the file" },
			assistantToolUseMessage("tool-a"),
			toolResultMessage("tool-a", "a".repeat(1_000)),
		];
		const targetTokens =
			totalJsonTokens(messages) - estimateJsonTokens(messages[2]) + 10;

		const compacted = runForcedBasicCompaction(messages, targetTokens);

		expectNoOrphanedToolPairs(compacted);
		expect(collectToolPairPresence(compacted).get("tool-a")).toBeUndefined();
		expect(compacted).toEqual([
			{
				role: "user",
				content: "Read the file",
				metadata: {
					kind: "compaction",
					reason: "manual_compaction",
					displayRole: "system",
					messagesRemoved: 2,
					userRunSpan: 1,
				},
			},
		]);
	});

	it("removes older tool pairs atomically while preserving a newer pair", () => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Read the files" },
			assistantToolUseMessage("tool-a"),
			toolResultMessage("tool-a", "a".repeat(1_000)),
			{ role: "user", content: "Read the latest file" },
			assistantToolUseMessage("tool-b"),
			toolResultMessage("tool-b", "latest result"),
		];
		const targetTokens =
			totalJsonTokens(messages) -
			estimateJsonTokens(messages[1]) -
			estimateJsonTokens(messages[2]) +
			10;

		const compacted = runForcedBasicCompaction(messages, targetTokens);
		const pairs = collectToolPairPresence(compacted);

		expectNoOrphanedToolPairs(compacted);
		expect(pairs.get("tool-a")).toBeUndefined();
		expect(JSON.stringify(compacted)).toContain("Read the latest file");
	});

	it("may drop the latest completed tool pair under aggressive basic compaction", () => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Read the files" },
			assistantToolUseMessage("tool-a"),
			toolResultMessage("tool-a", "a".repeat(1_000)),
			{ role: "user", content: "Read the latest file" },
			assistantToolUseMessage("tool-b"),
			toolResultMessage("tool-b", "b".repeat(1_000)),
		];

		const compacted = runForcedBasicCompaction(messages, 1);
		const pairs = collectToolPairPresence(compacted);

		expectNoOrphanedToolPairs(compacted);
		expect(pairs.get("tool-a")).toBeUndefined();
		expect(pairs.get("tool-b")).toBeUndefined();
		expect(JSON.stringify(compacted)).toContain("Read the latest file");
	});

	it("treats multi-tool assistant turns as one atomic group in basic compaction", () => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Read both old files" },
			assistantMultiToolUseMessage(["tool-a", "tool-b"]),
			toolResultMessage("tool-a", "a".repeat(1_000)),
			toolResultMessage("tool-b", "b".repeat(1_000)),
			{ role: "user", content: "Now continue" },
		];
		const targetTokens =
			totalJsonTokens(messages) - estimateJsonTokens(messages[2]) + 10;

		const compacted = runForcedBasicCompaction(messages, targetTokens);

		expectNoOrphanedToolPairs(compacted);
		expect(collectToolPairPresence(compacted).size).toBe(0);
	});

	it("removes matching tool results when basic compaction removes an assistant tool use", () => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Read and continue" },
			assistantToolUseMessage("tool-a", [
				{ type: "text", text: "large assistant context ".repeat(100) },
			]),
			toolResultMessage("tool-a", "short result"),
			{ role: "user", content: "Latest user turn" },
			{ role: "assistant", content: "latest assistant response" },
		];
		const targetTokens =
			totalJsonTokens(messages) - estimateJsonTokens(messages[1]) + 10;

		const compacted = runForcedBasicCompaction(messages, targetTokens);

		expectNoOrphanedToolPairs(compacted);
		expect(collectToolPairPresence(compacted).get("tool-a")).toBeUndefined();
	});

	it("preserves the latest typed user prompt without requiring completed tool work", () => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Old request" },
			{ role: "assistant", content: "Old answer that can be compacted" },
			{ role: "user", content: "Read the latest file" },
			assistantToolUseMessage("tool-a"),
			toolResultMessage("tool-a", "latest result"),
		];

		const compacted = runForcedBasicCompaction(messages, 1);

		// Adjacent typed user messages left behind by the removals merge
		// into a single user message carrying the compaction metadata.
		expect(compacted).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Old request" },
					{ type: "text", text: "Read the latest file" },
				],
				metadata: {
					kind: "compaction",
					reason: "manual_compaction",
					displayRole: "system",
					messagesRemoved: 4,
					userRunSpan: 2,
				},
			},
		]);
		expectNoOrphanedToolPairs(compacted);
	});

	it("bridges merged user turns with dropped-work summaries and drops stale metrics", () => {
		const grepCommand =
			'grep -rn "sidebarItem\\|sidebarText\\|sidebar:\\|variant" /repo/webview/components/ui/button.tsx --include "*.tsx" --color=never';
		const editorDiff = JSON.stringify({
			query: "edit:/repo/webview/components/agent-sidebar.tsx",
			result:
				"Edited /repo/webview/components/agent-sidebar.tsx\n```diff\n-467: \told\n+467: \tnew\n-479: \tolder\n+479: \tnewer\n```",
		});
		const messages: MessageWithMetadata[] = [
			{
				id: "u1",
				role: "user",
				content: [
					{ type: "text", text: "request one" },
					{
						type: "file",
						path: "/repo/webview/components/agent-sidebar.tsx",
						content: "x".repeat(5_000),
					},
				],
			},
			{
				id: "a1",
				role: "assistant",
				metrics: { inputTokens: 100, outputTokens: 10, cost: 0.25 },
				content: [
					{
						type: "tool_use",
						id: "tool-edit",
						name: "editor",
						input: {
							path: "/repo/webview/components/agent-sidebar.tsx",
							old_text: "a",
							new_text: "b",
						},
					},
				],
			},
			{
				id: "t1",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-edit",
						name: "editor",
						content: editorDiff,
					},
				],
			},
			{
				id: "a2",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-read",
						name: "read_files",
						input: {
							files: [
								{
									path: "/repo/webview/components/agent-sidebar.tsx",
									start_line: 462,
									end_line: 480,
								},
							],
						},
					},
				],
			},
			{
				id: "t2",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-read",
						name: "read_files",
						content: "462 | ...",
					},
				],
			},
			{ id: "a3", role: "assistant", content: "Done with the first request." },
			{
				id: "u2",
				role: "user",
				content: [{ type: "text", text: "request two" }],
			},
			{
				id: "a4",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-grep",
						name: "run_commands",
						input: { commands: [grepCommand] },
					},
				],
			},
			{
				id: "t3",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-grep",
						name: "run_commands",
						content: "button.tsx:12: ...",
					},
				],
			},
			{ id: "a5", role: "assistant", content: "Done with the second request." },
			{
				id: "u3",
				role: "user",
				content: [{ type: "text", text: "request three" }],
			},
			{
				id: "a6",
				role: "assistant",
				metrics: {
					inputTokens: 500,
					outputTokens: 20,
					cacheReadTokens: 400,
					cacheWriteTokens: 0,
					cost: 0.5,
				},
				content: "Final answer for request three.",
			},
		];
		// Roomy budget: typed prompts, each turn's concluding assistant
		// answer, and the latest turn's messages all fit.
		const targetTokens =
			estimateJsonTokens(messages[0]) +
			estimateJsonTokens(messages[6]) +
			estimateJsonTokens(messages[10]) +
			estimateJsonTokens(messages[5]) +
			estimateJsonTokens(messages[9]) +
			estimateJsonTokens(messages[11]) +
			200;

		const compacted = runForcedBasicCompaction(
			messages,
			targetTokens,
		) as MessageWithMetadata[];

		// Typed prompts survive; each older turn keeps its concluding
		// assistant answer as a real message; the latest turn's tail (the
		// final answer) is preserved verbatim.
		expect(compacted.map((message) => message.id)).toEqual([
			"u1",
			"a3",
			"u2",
			"a5",
			"u3",
			"a6",
		]);
		const first = compacted[0];
		expect(first.role).toBe("user");
		const texts = (Array.isArray(first.content) ? first.content : []).map(
			(block) => (block.type === "text" ? block.text : `[${block.type}]`),
		);
		// request text plus the dropped-work summary for its turn's tool work
		expect(texts).toHaveLength(2);
		expect(texts[0]).toBe("request one");
		expect(texts[1]).toContain("<SYSTEM_NOTICE>");
		expect(texts[1]).toContain(
			"Files read:\n/repo/webview/components/agent-sidebar.tsx:462-480",
		);
		expect(texts[1]).toContain(
			"Files edited:\n/repo/webview/components/agent-sidebar.tsx:467-479",
		);
		// Kept assistant answers are not duplicated into the summaries.
		expect(JSON.stringify(compacted)).not.toContain("Your recent responses");
		expect(compacted[1].content).toBe("Done with the first request.");
		const secondTexts = (
			Array.isArray(compacted[2].content) ? compacted[2].content : []
		).map((block) => (block.type === "text" ? block.text : `[${block.type}]`));
		expect(secondTexts[0]).toBe("request two");
		expect(secondTexts[1]).toContain("Commands ran:\ngrep -rn");
		// Long commands are truncated to 100 chars with a trailing ellipsis.
		expect(secondTexts[1]).not.toContain("--color=never");
		expect(secondTexts[1]).toContain("...");
		expect(compacted[5].content).toBe("Final answer for request three.");
		// Stale attached file contents are dropped from merged turns.
		expect(JSON.stringify(compacted)).not.toContain('"type":"file"');
		// Token metrics no longer add up after compaction and are dropped;
		// the aggregate survives on the compaction message's metadata.
		expect(JSON.stringify(compacted)).not.toContain('"metrics"');
		expect(first.metadata).toEqual({
			kind: "compaction",
			reason: "manual_compaction",
			displayRole: "system",
			messagesRemoved: 6,
			userRunSpan: 1,
			usageBefore: {
				inputTokens: 600,
				outputTokens: 30,
				cacheReadTokens: 400,
				cacheWriteTokens: 0,
				cost: 0.75,
			},
		});
	});

	it("keeps the newest messages of the latest turn and drops only the oldest", () => {
		const bigResult = "x".repeat(3_000);
		const messages: MessageWithMetadata[] = [
			{ id: "u1", role: "user", content: "do the thing" },
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "pair-1",
						name: "read_files",
						input: { file_paths: ["/tmp/one.ts"] },
					},
				],
			},
			{
				id: "t1",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "pair-1",
						name: "read_files",
						content: bigResult,
					},
				],
			},
			{
				id: "a2",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "pair-2",
						name: "read_files",
						input: { file_paths: ["/tmp/two.ts"] },
					},
				],
			},
			{
				id: "t2",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "pair-2",
						name: "read_files",
						content: "small result",
					},
				],
			},
			{ id: "a3", role: "assistant", content: "Done with the thing." },
		];
		// Room for the typed prompt plus the newest pair and final answer,
		// but not the big first pair.
		const targetTokens =
			estimateJsonTokens(messages[0]) +
			estimateJsonTokens(messages[3]) +
			estimateJsonTokens(messages[4]) +
			estimateJsonTokens(messages[5]) +
			150;

		const compacted = runForcedBasicCompaction(
			messages,
			targetTokens,
		) as MessageWithMetadata[];

		expect(compacted.map((message) => message.id)).toEqual([
			"u1",
			"a2",
			"t2",
			"a3",
		]);
		expectNoOrphanedToolPairs(compacted);
		const pairs = collectToolPairPresence(compacted);
		expect(pairs.get("pair-2")).toEqual({ hasResult: true, hasUse: true });
		expect(pairs.get("pair-1")).toBeUndefined();
		// The dropped oldest pair is summarized onto the typed prompt.
		const firstTexts = (
			Array.isArray(compacted[0].content) ? compacted[0].content : []
		).map((block) => (block.type === "text" ? block.text : ""));
		expect(firstTexts[1]).toContain("Files read:\n/tmp/one.ts");
		expect(firstTexts[1]).not.toContain("/tmp/two.ts");

		// Tighter budget cutting inside the newest pair: the kept suffix
		// snaps forward to the next assistant message so the pair is never
		// split.
		const tightTarget =
			estimateJsonTokens(messages[0]) +
			estimateJsonTokens(messages[4]) +
			estimateJsonTokens(messages[5]) +
			100;
		const snapped = runForcedBasicCompaction(
			messages,
			tightTarget,
		) as MessageWithMetadata[];
		expect(snapped.map((message) => message.id)).toEqual(["u1", "a3"]);
		expectNoOrphanedToolPairs(snapped);
	});

	it("does not re-fold the output of an earlier compaction", () => {
		const firstPassMessages: MessageWithMetadata[] = [
			{ id: "u1", role: "user", content: "set up the feature" },
			{
				id: "a1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "pair-a",
						name: "read_files",
						input: { file_paths: ["/tmp/a.ts"] },
					},
				],
			},
			{
				id: "t1",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "pair-a",
						name: "read_files",
						content: "a".repeat(600),
					},
				],
			},
			{
				id: "a2",
				role: "assistant",
				content: "Feature is set up.",
				metrics: { inputTokens: 100, outputTokens: 10, cost: 0.25 },
			},
			{ id: "u2", role: "user", content: "now polish it" },
			{
				id: "a3",
				role: "assistant",
				content: "Polished.",
				metrics: { inputTokens: 200, outputTokens: 20, cost: 0.5 },
			},
		];
		const firstTarget = totalJsonTokens(firstPassMessages) + 300;
		const firstPass = runForcedBasicCompaction(
			firstPassMessages,
			firstTarget,
		) as MessageWithMetadata[];

		expect(firstPass.map((message) => message.id)).toEqual([
			"u1",
			"a2",
			"u2",
			"a3",
		]);
		// Survivors of the fold are frozen for later passes.
		expect(firstPass[1].metadata).toMatchObject({ compaction: "preserved" });
		expect(firstPass[3].metadata).toMatchObject({ compaction: "preserved" });
		expect(firstPass[0].metadata).toMatchObject({
			kind: "compaction",
			messagesRemoved: 2,
			usageBefore: {
				inputTokens: 300,
				outputTokens: 30,
				cost: 0.75,
			},
		});

		// The session continues: a new turn lands after the compacted state.
		const secondPassMessages: MessageWithMetadata[] = [
			...firstPass,
			{ id: "u3", role: "user", content: "add tests" },
			{
				id: "b1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "pair-b",
						name: "read_files",
						input: { file_paths: ["/tmp/b.ts"] },
					},
				],
			},
			{
				id: "t2",
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "pair-b",
						name: "read_files",
						content: "b".repeat(3_000),
					},
				],
			},
			{
				id: "b3",
				role: "assistant",
				content: "Tests added.",
				metrics: { inputTokens: 50, outputTokens: 5, cost: 0.25 },
			},
		];
		// Room for everything except the new turn's big tool pair.
		const secondTarget =
			totalJsonTokens(firstPass as LlmsProviders.Message[]) +
			estimateJsonTokens(secondPassMessages[4]) +
			estimateJsonTokens(secondPassMessages[7]) +
			250;
		const secondPass = runForcedBasicCompaction(
			secondPassMessages,
			secondTarget,
		) as MessageWithMetadata[];

		expect(secondPass.map((message) => message.id)).toEqual([
			"u1",
			"a2",
			"u2",
			"a3",
			"u3",
			"b3",
		]);
		// The earlier compaction's output is untouched: same answers, no
		// stacked summary blocks on the already-folded prompts.
		expect(secondPass[1]).toEqual(firstPass[1]);
		expect(secondPass[3]).toEqual(firstPass[3]);
		expect(secondPass[2]).toEqual(firstPass[2]);
		const firstPromptBlocks = Array.isArray(secondPass[0].content)
			? secondPass[0].content
			: [];
		expect(
			firstPromptBlocks.filter(
				(block) =>
					block.type === "text" && block.text.includes("<SYSTEM_NOTICE>"),
			),
		).toHaveLength(1);
		// Only the new turn was folded; its dropped pair is summarized onto
		// the new prompt.
		const newPromptBlocks = Array.isArray(secondPass[4].content)
			? secondPass[4].content
			: [];
		const newSummary = newPromptBlocks.find(
			(block) =>
				block.type === "text" && block.text.includes("<SYSTEM_NOTICE>"),
		);
		expect(
			newSummary && newSummary.type === "text" ? newSummary.text : "",
		).toContain("Files read:\n/tmp/b.ts");
		expect(secondPass[5].metadata).toMatchObject({ compaction: "preserved" });
		// Stats accumulate across passes instead of being overwritten.
		expect(secondPass[0].metadata).toMatchObject({
			kind: "compaction",
			messagesRemoved: 4,
			usageBefore: {
				inputTokens: 350,
				outputTokens: 35,
				cost: 1.0,
			},
		});
	});

	it("budgets the complete basic compaction output including the latest turn", () => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "original task" },
			{ role: "assistant", content: "old assistant " + "x".repeat(10_000) },
			{ role: "user", content: "latest typed prompt" },
			assistantToolUseMessage("tool-live"),
			toolResultMessage("tool-live", "live result " + "y".repeat(10_000)),
		];

		const compacted = runForcedBasicCompaction(messages, 700);

		expect(totalJsonTokens(compacted)).toBeLessThanOrEqual(700);
		expect(JSON.stringify(compacted)).toContain("latest typed prompt");
		expectNoOrphanedToolPairs(compacted);
	});

	it("does not compact a single typed user message", () => {
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Only current request" },
		];

		const compacted = runForcedBasicCompaction(messages, 1);

		expect(compacted).toBe(messages);
	});

	it("does not truncate a shallow first task prompt below the trigger for high-output models", async () => {
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openrouter",
			modelId: "minimax/minimax-m3",
			providerConfig: {
				providerId: "openrouter",
				modelId: "minimax/minimax-m3",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic",
			},
			logger: undefined,
		});
		const task =
			'<user_input mode="act">Create /app/filter.py that removes JavaScript from HTML files. ' +
			"Keep this task prompt intact. ".repeat(25) +
			"</user_input>";
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: task },
			{ role: "assistant", content: "old assistant context ".repeat(500) },
			{ role: "user", content: "Continue" },
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "minimax/minimax-m3",
				provider: "openrouter",
				info: {
					id: "minimax/minimax-m3",
					maxInputTokens: 1_000,
					maxTokens: 950,
				},
			},
		});

		// The task prompt and the follow-up merge into one user message; the
		// task text itself must survive verbatim, not truncated.
		const firstContent = result?.messages?.[0]?.content;
		const firstText =
			Array.isArray(firstContent) && firstContent[0]?.type === "text"
				? firstContent[0].text
				: firstContent;
		expect(firstText).toBe(task);
		expect(JSON.stringify(result?.messages)).toContain("Create /app/filter.py");
		expect(JSON.stringify(result?.messages)).not.toContain("<user_input\n...");
	});

	describe("what the trigger measures", () => {
		// `apiMessages` is not the provider payload. Live, against a local
		// provider's own request log, it ran ~5x the body that went out --
		// 803,588 characters against 163,772 bytes -- so the estimate read
		// 151,556 tokens for a context that really cost about 40,000, and
		// compaction fired on a transcript that was nowhere near full.
		const bloatedApiMessages: LlmsProviders.Message[] = [
			{ role: "user", content: "start the task" },
			{ role: "assistant", content: "x".repeat(400_000) },
			{ role: "user", content: "continue" },
		];

		function prepare(messages: LlmsProviders.Message[]) {
			const prepareTurn = createContextCompactionPrepareTurn({
				providerId: "ollama",
				modelId: "local-model",
				providerConfig: {
					providerId: "ollama",
					modelId: "local-model",
				} as LlmsProviders.ProviderConfig,
				compaction: { enabled: true, strategy: "basic" },
				logger: undefined,
			});
			return prepareTurn?.({
				agentId: "agent-1",
				conversationId: "conv-1",
				parentAgentId: null,
				iteration: 4,
				abortSignal: new AbortController().signal,
				systemPrompt: "You are helpful.",
				tools: [],
				messages,
				apiMessages: messages,
				model: {
					id: "local-model",
					provider: "ollama",
					info: { id: "local-model", contextWindow: 128_000 },
				},
			});
		}

		beforeEach(() => {
			resetTokenCalibration();
		});

		afterEach(() => {
			resetTokenCalibration();
		});

		it("compacts on the estimate before anything has been counted", async () => {
			const result = await prepare(bloatedApiMessages);
			expect(result?.messages).toBeDefined();
		});

		it("recovers the count from the transcript when the process did not see it", async () => {
			// Repro for every resume compacting. The calibration lives in process
			// memory, so a task resumed after a host restart decides on the raw
			// estimate — measured live at 237,977 and 261,494 tokens against a
			// 115,200 trigger, for a session that had been reporting 108,099 and
			// 72,995 actual tokens minutes earlier. The transcript knew: each
			// assistant turn records what the provider counted for it.
			// 400,000 characters the provider counted as 68,000 tokens: 5.9
			// characters each, and comfortably under the 115,200 trigger. The
			// estimate reads the same transcript as ~133,000 and compacts it.
			const resumed: MessageWithMetadata[] = [
				{ role: "user", content: "start the task" },
				{ role: "assistant", content: "x".repeat(400_000) },
				{ role: "user", content: "continue" },
				{
					role: "assistant",
					content: "on it",
					metrics: { inputTokens: 68_000 },
				},
			];

			const result = await prepare(resumed);
			expect(result?.messages).toBeUndefined();
		});

		it("still compacts a resumed transcript the provider counted as full", async () => {
			const resumed: MessageWithMetadata[] = [
				{ role: "user", content: "start the task" },
				{ role: "assistant", content: "x".repeat(700_000) },
				{ role: "user", content: "continue" },
				{
					role: "assistant",
					content: "on it",
					metrics: { inputTokens: 117_000 },
				},
			];

			const result = await prepare(resumed);
			expect(result?.messages).toBeDefined();
		});

		it("leaves a transcript with no recorded counts on the estimate", async () => {
			// A first run, or a provider that reports no usage: there is nothing
			// to recover, and the estimate is all there ever was.
			const result = await prepare([
				{ role: "user", content: "start the task" },
				{ role: "assistant", content: "x".repeat(400_000), metrics: {} },
				{ role: "user", content: "continue" },
			] as MessageWithMetadata[]);
			expect(result?.messages).toBeDefined();
		});

		it("does not compact when the provider counted a context well under the trigger", async () => {
			// the request that produced those messages really cost 40,000 tokens
			observeRequestTokens(163_772, 40_000);
			const result = await prepare(bloatedApiMessages);
			expect(result?.messages).toBeUndefined();
		});

		it("compacts when the provider counted a context over the trigger", async () => {
			observeRequestTokens(420_000, 117_000);
			const result = await prepare(bloatedApiMessages);
			expect(result?.messages).toBeDefined();
		});

		it("stops compacting once the counted context comes back down", async () => {
			observeRequestTokens(420_000, 117_000);
			expect((await prepare(bloatedApiMessages))?.messages).toBeDefined();
			// after a compaction the next request is genuinely smaller
			observeRequestTokens(80_000, 22_661);
			expect((await prepare(bloatedApiMessages))?.messages).toBeUndefined();
		});
	});

	it("can truncate an oversized first task prompt when it exceeds the trigger", () => {
		const oversizedPrompt = "<user_input>".repeat(500);
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: oversizedPrompt },
			{ role: "assistant", content: "old assistant context ".repeat(500) },
			{ role: "user", content: "current turn" },
		];

		const compacted = runBasicCompaction({
			context: {
				agentId: "agent-1",
				conversationId: "conv-1",
				parentAgentId: null,
				iteration: 1,
				messages,
				model: {
					id: "mock-model",
					provider: "openrouter",
					info: { id: "mock-model", maxInputTokens: 1_000 },
				},
				mode: "manual",
				budget: {
					request: {
						inputTokens: 2_000,
						maxInputTokens: 1_000,
						triggerTokens: 900,
						targetTokens: 100,
						overheadTokens: 0,
						thresholdRatio: 0.9,
						utilizationRatio: 2,
					},
					messages: {
						inputTokens: 2_000,
						triggerTokens: 900,
						targetTokens: 100,
					},
				},
			},
			estimateMessageTokens: estimateJsonTokens,
		});

		expect(compacted?.messages[0]?.content).not.toBe(oversizedPrompt);
		const mergedContent = compacted?.messages[0]?.content;
		const mergedText = Array.isArray(mergedContent)
			? mergedContent
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("\n")
			: String(mergedContent);
		expect(mergedText).toContain("\n...");
	});

	it("does not add unsupported max output tokens to Codex OAuth summarizer requests", () => {
		const codexConfig = resolveSummarizerConfig({
			activeProviderConfig: {
				providerId: "openai-codex",
				modelId: "gpt-5.4",
				maxOutputTokens: 16_000,
			},
		});
		const anthropicConfig = resolveSummarizerConfig({
			activeProviderConfig: {
				providerId: "anthropic",
				modelId: "claude-sonnet",
			},
		});

		expect(codexConfig).not.toHaveProperty("maxOutputTokens");
		expect(codexConfig.thinking).toBe(false);
		expect(anthropicConfig.maxOutputTokens).toBe(1_024);
	});

	it("preserves summarizer modelInfo without a nested providerConfig", () => {
		const resolved = resolveSummarizerConfig({
			activeProviderConfig: {
				providerId: "anthropic",
				modelId: "primary-model",
				modelInfo: { id: "primary-model", maxInputTokens: 100_000 },
			} as LlmsProviders.ProviderConfig,
			summarizer: {
				providerId: "openai",
				modelId: "small-summary",
				modelInfo: { id: "small-summary", maxInputTokens: 600 },
			},
		});

		expect(resolved.modelInfo?.maxInputTokens).toBe(600);
	});

	it("summarizes older messages and keeps recent messages", async () => {
		const emitStatusNotice = vi.fn();
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-1",
						text: "## Goal\nShip the feature\n\n## Next\n- Finish it",
					},
					{ type: "done", id: "summary-1", success: true },
				]),
			),
		});

		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
			},
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			emitStatusNotice,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Old turn to compact" },
				{ role: "assistant", content: "Old answer" },
				{ role: "user", content: "Older follow-up to compact" },
				{ role: "assistant", content: "Older follow-up answer" },
				{ role: "user", content: "Implement the change" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-1",
							name: "read_files",
							input: { file_paths: ["/tmp/example.ts"] },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							name: "tool",
							content: "file contents",
						},
					],
				},
				{ role: "assistant", content: "Recent assistant state" },
			],
			apiMessages: [
				{ role: "user", content: "Old turn to compact" },
				{ role: "assistant", content: "Old answer" },
				{ role: "user", content: "Older follow-up to compact" },
				{ role: "assistant", content: "Older follow-up answer" },
				{ role: "user", content: "Implement the change" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-1",
							name: "read_files",
							input: { file_paths: ["/tmp/example.ts"] },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							name: "tool",
							content: "file contents",
						},
					],
				},
				{ role: "assistant", content: "Recent assistant state" },
			],
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 10 },
			},
		});

		// Two: the summary, then the retrospective over the reasoning being
		// discarded. Both go to the same summarizer.
		expect(createHandlerMock).toHaveBeenCalledTimes(2);
		expect(emitStatusNotice).toHaveBeenCalledWith(
			"auto-compacting",
			expect.objectContaining({
				kind: "auto_compaction",
				reason: "auto_compaction",
				iteration: 1,
			}),
		);
		// Three, not five: this model reports a 10-token input budget and the
		// last turn costs 116, so keeping that turn whole would leave the
		// transcript over the ceiling and the trigger would fire again at once.
		// The turn is cut with its prompt pinned -- what the window cannot afford
		// is the tool traffic under the prompt, not the sentence that asked for
		// it, and the assertions below still hold.
		expect(result?.messages).toHaveLength(3);
		expect(result?.messages[0]).toMatchObject({
			role: "user",
			metadata: expect.objectContaining({
				kind: "compaction_summary",
				displayRole: "system",
				userRunSpan: 2,
				details: {
					// The read is folded now rather than sitting in the preserved
					// tail, so the summary is what carries it -- which is the point
					// of recording file operations in the summary at all.
					readFiles: ["/tmp/example.ts"],
					modifiedFiles: [],
				},
			}),
		});
		// The retrospective leads and the summary follows, both as text. Not as a
		// reasoning block: those are only valid on an assistant message, and a
		// live run died on `AI_TypeValidationError: The messages do not match the
		// ModelMessage[] schema` when this message carried one.
		expect(result?.messages[0]?.content).toEqual([
			expect.objectContaining({ type: "text" }),
			expect.objectContaining({ type: "text" }),
		]);
		expect(JSON.stringify(result?.messages[0])).not.toContain('"thinking"');
		expect(JSON.stringify(result?.messages[0])).not.toContain('"reasoning"');
		const summaryBlock = Array.isArray(result?.messages[0]?.content)
			? result.messages[0].content.find(
					(block) => block.type === "text" && block.text.startsWith("Context summary:"),
				)
			: undefined;
		const summaryContent =
			summaryBlock?.type === "text" ? summaryBlock.text : "";
		expect(summaryContent).toContain("Context summary:");
		expect(summaryContent).toContain("## Files");
		expect(result?.messages[1]).toEqual({
			role: "user",
			content: "Implement the change",
		});
		expect(result?.messages.at(-1)).toEqual({
			role: "assistant",
			content: "Recent assistant state",
		});
	});

	it("falls back to basic compaction when the agentic request fails", async () => {
		const providerError = new Error("temporary summarizer failure");
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() => {
				throw providerError;
			}),
		});
		const log = vi.fn();
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: `Old answer ${"x".repeat(500)}` },
			{ role: "user", content: "Older follow-up" },
			{ role: "assistant", content: "Older response" },
			{ role: "user", content: "Latest request" },
		];
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
			},
			logger: { debug: vi.fn(), log },
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 10 },
			},
		});

		expect(result?.messages).toBeDefined();
		expect(result?.messages[0]?.metadata?.kind).not.toBe("compaction_summary");
		expect(log).toHaveBeenCalledWith(
			"Agentic compaction failed; falling back to basic compaction",
			expect.objectContaining({
				severity: "warn",
				errorMessage: providerError.message,
			}),
		);
	});

	it("does not fall back to basic compaction when agentic compaction is cancelled", async () => {
		const providerError = new Error("request stopped");
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() => {
				throw providerError;
			}),
		});
		const controller = new AbortController();
		controller.abort();
		const log = vi.fn();
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: `Old answer ${"x".repeat(500)}` },
			{ role: "user", content: "Latest request" },
		];
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
			},
			logger: { debug: vi.fn(), log },
		});

		await expect(
			prepareTurn?.({
				agentId: "agent-1",
				conversationId: "conv-1",
				parentAgentId: null,
				iteration: 1,
				abortSignal: controller.signal,
				systemPrompt: "You are helpful.",
				tools: [],
				messages,
				apiMessages: messages,
				model: {
					id: "mock-model",
					provider: "anthropic",
					info: { id: "mock-model", maxInputTokens: 10 },
				},
			}),
		).rejects.toBe(providerError);
		expect(log).not.toHaveBeenCalledWith(
			"Agentic compaction failed; falling back to basic compaction",
			expect.anything(),
		);
	});

	it("sends truncated text-block tool results to the agentic summarizer", async () => {
		const createMessage = vi.fn(() =>
			streamChunks([
				{
					type: "text",
					id: "summary-tool-output",
					text: "## Goal\nSummarized tool output\n\n## Next\nContinue",
				},
				{ type: "done", id: "summary-tool-output", success: true },
			]),
		);
		createHandlerMock.mockReturnValue({ createMessage });
		const omittedTail = "TAIL_SHOULD_NOT_REACH_SUMMARIZER";
		const longToolOutput =
			"x".repeat(TOOL_RESULT_CHAR_LIMIT + 10_000) + omittedTail;
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
			},
			logger: undefined,
		});

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Run a large command" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-large",
							name: "execute_command",
							input: { command: "print-large-output" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-large",
							name: "tool",
							content: [{ type: "text", text: longToolOutput }],
						},
					],
				},
				{ role: "assistant", content: "Observed large output" },
				{ role: "user", content: "Latest request" },
				{ role: "assistant", content: "Latest answer" },
			],
			apiMessages: [
				{ role: "user", content: "Run a large command" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-large",
							name: "execute_command",
							input: { command: "print-large-output" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-large",
							name: "tool",
							content: [{ type: "text", text: longToolOutput }],
						},
					],
				},
				{ role: "assistant", content: "Observed large output" },
				{ role: "user", content: "Latest request" },
				{ role: "assistant", content: "Latest answer" },
			],
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 10 },
			},
		});

		// The summary request, then the retrospective's.
		expect(createMessage).toHaveBeenCalledTimes(2);
		const createMessageCalls = createMessage.mock.calls as unknown as [
			string,
			Array<{ role: string; content: string }>,
		][];
		const summarizerMessages = createMessageCalls[0]?.[1];
		const summarizerPrompt = summarizerMessages?.[0]?.content ?? "";
		expect(summarizerPrompt).toContain("[Tool result]");
		expect(summarizerPrompt).toContain("...[truncated ");
		expect(summarizerPrompt).not.toContain(omittedTail);
		expect(summarizerPrompt.length).toBeLessThan(longToolOutput.length);
	});

	it("budgets agentic summary input before serialization", () => {
		const result = buildAgenticSummaryInputBudget({
			messages: [
				{ role: "user", content: "Run a large command" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-large",
							name: "execute_command",
							input: { command: "print-large-output" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-large",
							name: "execute_command",
							content: "x".repeat(50_000),
						},
					],
				},
				{ role: "user", content: "Latest typed prompt" },
			],
			targetTokens: 400,
			estimateMessageTokens: estimateJsonTokens,
		});

		expect(result.estimatedTokens).toBeLessThanOrEqual(400);
		expect(JSON.stringify(result.messages)).toContain("Latest typed prompt");
		expect(result.actions.length).toBeGreaterThan(0);
	});

	it("never lands the agentic cut in the middle of a tool pair", async () => {
		// Repro for the "No tool call found for function call output" provider
		// error: findCutIndex used to walk back by token budget and could land
		// between an assistant tool_use and its matching user tool_result,
		// leaving the tool_result in the preserved tail while the tool_use was
		// folded into the summary.
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-pair",
						text: "## Goal\nDescribed earlier work\n\n## Next\nContinue",
					},
					{ type: "done", id: "summary-pair", success: true },
				]),
			),
		});

		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				// A tiny preserve budget so findCutIndex's natural candidate
				// would land at the most recent message (the tool_result),
				// splitting the pair before the snap-to-turn-start fix.
				preserveRecentTokens: 1,
			},
			logger: undefined,
		});

		const heavyToolOutput = "x".repeat(1_500);
		const sharedMessages = [
			{ role: "user" as const, content: "Old turn to summarize" },
			{ role: "assistant" as const, content: "Old reply" },
			{ role: "user" as const, content: "Read the file" },
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool_use" as const,
						id: "tool-pair",
						name: "read_files",
						input: { file_paths: ["/tmp/x.ts"] },
					},
				],
			},
			{
				role: "user" as const,
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "tool-pair",
						name: "tool",
						content: heavyToolOutput,
					},
				],
			},
			{ role: "user" as const, content: "Now do the next thing" },
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: sharedMessages,
			apiMessages: sharedMessages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 10 },
			},
		});

		expect(result?.messages).toBeDefined();
		const messages = result?.messages ?? [];
		const toolUseIds = new Set<string>();
		const toolResultIds = new Set<string>();
		for (const msg of messages) {
			if (!Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block.type === "tool_use") toolUseIds.add(block.id);
				if (block.type === "tool_result") toolResultIds.add(block.tool_use_id);
			}
		}
		// Either both halves of the pair are in the preserved tail, or both
		// are folded into the summary. Never one without the other.
		for (const id of toolUseIds) {
			expect(toolResultIds.has(id)).toBe(true);
		}
		for (const id of toolResultIds) {
			expect(toolUseIds.has(id)).toBe(true);
		}
	});

	it("compacts a single-task tool loop by cutting at an assistant boundary", async () => {
		// Repro for agentic auto-compaction permanently skipping in hosts like
		// the VS Code extension: the canonical transcript is one typed task
		// message followed by a long assistant tool_use / user tool_result
		// loop. findCutIndex used to accept only typed-user turn starts as cut
		// boundaries, so the snap always walked back to index 0 and
		// runAgenticCompaction returned undefined ("auto-compaction-skipped")
		// on every turn. Assistant messages are equally safe boundaries: a
		// tool_use keeps its result in the user message that follows it.
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-loop",
						text: "## Goal\nBuild the feature\n\n## Next\nContinue",
					},
					{ type: "done", id: "summary-loop", success: true },
				]),
			),
		});

		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "<task>Build the feature</task>" },
		];
		for (let i = 0; i < 12; i++) {
			messages.push({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: `loop-tool-${i}`,
						name: "read_files",
						input: { file_paths: [`/tmp/f${i}.ts`] },
					},
				],
			});
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `loop-tool-${i}`,
						name: "read_files",
						content: "x".repeat(1_500),
					},
				],
			});
		}
		messages.push({ role: "assistant", content: "working on it" });

		const emitStatusNotice = vi.fn();
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1_000,
			},
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			emitStatusNotice,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 4_000 },
			},
		});

		expect(emitStatusNotice).toHaveBeenCalledWith(
			"auto-compacted",
			expect.objectContaining({ kind: "auto_compaction" }),
		);
		expect(result?.messages[0]).toMatchObject({
			role: "user",
			metadata: expect.objectContaining({ kind: "compaction_summary" }),
		});
		expect(result?.messages.length).toBeLessThan(messages.length);
		// The preserved tail must not orphan either half of a tool pair.
		const toolUseIds2 = new Set<string>();
		const toolResultIds2 = new Set<string>();
		for (const msg of result?.messages ?? []) {
			if (!Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block.type === "tool_use") toolUseIds2.add(block.id);
				if (block.type === "tool_result") {
					toolResultIds2.add(block.tool_use_id);
				}
			}
		}
		for (const id of toolUseIds2) {
			expect(toolResultIds2.has(id)).toBe(true);
		}
		for (const id of toolResultIds2) {
			expect(toolUseIds2.has(id)).toBe(true);
		}
	});

	it("re-compacts a projection that starts with a compaction summary", async () => {
		// After a successful compaction, the state-aware wrapper re-runs the
		// strategy on [summary message, ...preserved tail]. The summary is not
		// a typed turn start, so the old boundary rule made every follow-up
		// auto-compaction skip while the tail kept growing.
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-refold",
						text: "## Goal\nStill building\n\n## Next\nContinue",
					},
					{ type: "done", id: "summary-refold", success: true },
				]),
			),
		});

		const messages: MessageWithMetadata[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Context summary:\n\nearlier work" }],
				metadata: {
					kind: "compaction_summary",
					displayRole: "system",
					userRunSpan: 2,
					summary: "earlier work",
					details: { readFiles: [], modifiedFiles: [] },
					tokensBefore: 100,
					generatedAt: 1,
				},
			},
		];
		for (let i = 0; i < 12; i++) {
			messages.push({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: `refold-tool-${i}`,
						name: "read_files",
						input: { file_paths: [`/tmp/g${i}.ts`] },
					},
				],
			});
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `refold-tool-${i}`,
						name: "read_files",
						content: "y".repeat(1_500),
					},
				],
			});
		}

		const emitStatusNotice = vi.fn();
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1_000,
			},
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 2,
			abortSignal: new AbortController().signal,
			emitStatusNotice,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 4_000 },
			},
		});

		expect(emitStatusNotice).toHaveBeenCalledWith(
			"auto-compacted",
			expect.objectContaining({ kind: "auto_compaction" }),
		);
		expect(result?.messages[0]).toMatchObject({
			role: "user",
			metadata: expect.objectContaining({
				kind: "compaction_summary",
				userRunSpan: 2,
			}),
		});
		expect(result?.messages.length).toBeLessThan(messages.length);
	});

	// Measured live: one typed prompt followed by a long tool loop is a single
	// turn, so clamping the cut to its start dragged the cut back to near the
	// beginning of the transcript. A 250,621-byte request compacted to 226,763 --
	// 9.5% reclaimed -- and the trigger fired again on the very next turn.
	it("cuts into the last turn when keeping it whole would reclaim nothing", () => {
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "first task" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "the one long turn" },
			...Array.from({ length: 6 }, () => ({
				role: "assistant" as const,
				content: "x".repeat(4_000),
			})),
		];
		const lastTurnStart = 2;

		// Without a ceiling the cut cannot pass the start of that turn.
		expect(
			findCutPlan(messages, bounds(1), estimateJsonTokens).cutIndex,
		).toBeLessThanOrEqual(lastTurnStart);

		// With one the turn stops being exempt, so the cut lands past it.
		expect(
			findCutPlan(messages, bounds(1, { lastTurnCeiling: 100 }), estimateJsonTokens)
				.cutIndex,
		).toBeGreaterThan(lastTurnStart);
	});

	it("keeps the last turn whole when it fits inside the ceiling", () => {
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "first task" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "second task" },
			{ role: "assistant", content: "second answer" },
		];
		expect(
			findCutPlan(
				messages,
				bounds(1, { lastTurnCeiling: Number.MAX_SAFE_INTEGER }),
				estimateJsonTokens,
			),
		).toEqual({ cutIndex: 2, pinnedIndex: -1 });
	});

	it("leaves the cut at the latest typed prompt when that still folds work", () => {
		// The ordinary shape: the cap costs nothing, so nothing is pinned.
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "first task" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "second task" },
			{ role: "assistant", content: "second answer" },
		];
		expect(findCutPlan(messages, bounds(1), estimateJsonTokens)).toEqual({
			cutIndex: 2,
			pinnedIndex: -1,
		});
	});

	it("pins the prompt and cuts past it when the cap folds nothing", () => {
		const summary: MessageWithMetadata = {
			role: "user",
			content: [{ type: "text", text: "Context summary:\n\nearlier work" }],
			metadata: {
				kind: "compaction_summary",
				displayRole: "system",
				userRunSpan: 2,
				summary: "earlier work",
				details: { readFiles: [], modifiedFiles: [] },
				tokensBefore: 100,
				generatedAt: 1,
			},
		};
		const messages: MessageWithMetadata[] = [
			summary,
			{ role: "user", content: "the one typed prompt" },
		];
		for (let i = 0; i < 3; i++) {
			messages.push({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: `plan-tool-${i}`,
						name: "read_files",
						input: { file_paths: [`/tmp/p${i}.ts`] },
					},
				],
			});
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `plan-tool-${i}`,
						name: "read_files",
						content: "q".repeat(1_500),
					},
				],
			});
		}

		const plan = findCutPlan(messages, bounds(1), estimateJsonTokens);
		expect(plan.pinnedIndex).toBe(1);
		// Something other than the summary and the prompt has to be folded,
		// or the compaction is the no-op this replaces.
		expect(plan.cutIndex).toBeGreaterThanOrEqual(3);
		// The cut lands where a preserved tail cannot orphan a tool_result.
		expect(messages[plan.cutIndex].role).toBe("assistant");

		const tail = messages.slice(2);
		const tailTokens = totalJsonTokens(tail);
		const largestTailMessage = Math.max(...tail.map(estimateJsonTokens));
		const preservedTailTokens = totalJsonTokens(messages.slice(plan.cutIndex));
		// Half of the tail, plus at most the one message that straddles the
		// halfway mark. A ratio, not a token threshold: the estimator this
		// runs on drifts by multiples, and the bias cancels in a ratio.
		expect(preservedTailTokens).toBeLessThanOrEqual(
			tailTokens / 2 + largestTailMessage,
		);
	});

	it("declines to pin when the recency budget wants the whole tail", () => {
		// Folding is only worth an LLM call when there is something to fold.
		// A recency budget larger than the tail asks to keep all of it, and
		// the answer is no compaction rather than a pointless one.
		const messages: MessageWithMetadata[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Context summary:\n\nearlier work" }],
				metadata: {
					kind: "compaction_summary",
					displayRole: "system",
					userRunSpan: 1,
					summary: "earlier work",
					details: { readFiles: [], modifiedFiles: [] },
					tokensBefore: 100,
					generatedAt: 1,
				},
			},
			{ role: "user", content: "the one typed prompt" },
			{ role: "assistant", content: "short reply" },
			{ role: "assistant", content: "another short reply" },
		];
		expect(
			findCutPlan(messages, bounds(1_000_000), estimateJsonTokens),
		).toEqual({
			cutIndex: 0,
			pinnedIndex: -1,
		});
	});

	it("keeps a share of the messages when the token floor is met too early", () => {
		// Repro for `113 → 7 messages`. Heavy turns satisfy a token floor in a
		// handful of messages, and the floor has nothing to say about that: the
		// tail was within budget and unusable as a conversation. Every message
		// here weighs a quarter of the floor, so tokens alone stop after four.
		const messages: MessageWithMetadata[] = Array.from(
			{ length: 40 },
			(_, index) => ({
				role: index % 2 === 0 ? "user" : "assistant",
				content: `turn ${index} ${"z".repeat(1_000)}`,
			}),
		);

		const tokenOnly = findCutPlan(messages, bounds(4_000), estimateJsonTokens);
		expect(messages.length - tokenOnly.cutIndex).toBeLessThanOrEqual(6);

		const withRatio = findCutPlan(
			messages,
			bounds(4_000, { messagesRatio: 0.25 }),
			estimateJsonTokens,
		);
		expect(messages.length - withRatio.cutIndex).toBeGreaterThanOrEqual(10);
	});

	it("stops at the message budget rather than honour the count floor past it", () => {
		// The count floor asks and the ceiling answers. A quarter of these
		// messages is 10, which would cost ~10,000 tokens against a budget of
		// 3,000 — the compaction would end above the target it exists to reach.
		const messages: MessageWithMetadata[] = Array.from(
			{ length: 40 },
			(_, index) => ({
				role: index % 2 === 0 ? "user" : "assistant",
				content: `turn ${index} ${"z".repeat(1_000)}`,
			}),
		);

		const plan = findCutPlan(
			messages,
			bounds(1_000, { messagesRatio: 0.25, messageTargetTokens: 3_000 }),
			estimateJsonTokens,
		);
		expect(totalJsonTokens(messages.slice(plan.cutIndex))).toBeLessThanOrEqual(
			3_000 + estimateJsonTokens(messages[plan.cutIndex]),
		);
	});

	it("clamps the token floor to a budget smaller than it", () => {
		// A model whose whole message budget is 5,000 tokens cannot preserve
		// 20,000 of them, and a floor it cannot meet reads as "keep everything"
		// — which is how a small context ends up never compacting at all.
		const small = resolveRecencyBounds({
			preserveRecentTokens: 20_000,
			messageTargetTokens: 5_000,
		});
		expect(small).toMatchObject({ tokenFloor: 5_000, tokenCeiling: 5_000 });

		// The case this whole change is about: the floor is a floor and the
		// budget is headroom above it, not a clamp on it.
		const roomy = resolveRecencyBounds({
			preserveRecentTokens: 20_000,
			messageTargetTokens: 73_000,
		});
		expect(roomy).toMatchObject({
			tokenFloor: 20_000,
			tokenCeiling: 73_000,
			messagesRatio: 0.25,
		});
	});

	it("keeps compacting when the typed prompt sits behind a summary", async () => {
		// Repro for auto-compaction becoming a permanent no-op after the first
		// pass. The projection above has no typed prompt, but a real run does:
		// once a summary is prepended the transcript reads
		// [summary, typed prompt, ...tool loop], so the prompt sits at index 1
		// and the prompt-preservation cap pinned the cut there. Everything the
		// cut could fold was the summary itself, `newMessagesToFold` came out
		// empty, and every later turn skipped while the tail grew until the
		// model ran out of room to answer in. Live: seven consecutive skips,
		// 122 -> 134 messages, num_predict 26,538 -> 1,232, turn lost.
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-pinned",
						text: "## Goal\nStill building\n\n## Next\nContinue",
					},
					{ type: "done", id: "summary-pinned", success: true },
				]),
			),
		});

		const typedPrompt: MessageWithMetadata = {
			role: "user",
			content: "<task>Fix the linter errors I pasted</task>",
		};
		const messages: MessageWithMetadata[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Context summary:\n\nearlier work" }],
				metadata: {
					kind: "compaction_summary",
					displayRole: "system",
					userRunSpan: 2,
					summary: "earlier work",
					details: { readFiles: [], modifiedFiles: [] },
					tokensBefore: 100,
					generatedAt: 1,
				},
			},
			typedPrompt,
		];
		for (let i = 0; i < 12; i++) {
			messages.push({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: `pinned-tool-${i}`,
						name: "read_files",
						input: { file_paths: [`/tmp/h${i}.ts`] },
					},
				],
			});
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `pinned-tool-${i}`,
						name: "read_files",
						content: "z".repeat(1_500),
					},
				],
			});
		}
		const tailLength = messages.length - 2;

		const emitStatusNotice = vi.fn();
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1_000,
			},
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 3,
			abortSignal: new AbortController().signal,
			emitStatusNotice,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 4_000 },
			},
		});

		expect(emitStatusNotice).toHaveBeenCalledWith(
			"auto-compacted",
			expect.objectContaining({ kind: "auto_compaction" }),
		);
		const compacted = result?.messages ?? [];
		expect(compacted[0]).toMatchObject({
			role: "user",
			metadata: expect.objectContaining({ kind: "compaction_summary" }),
		});
		// The prompt keeps its place and its text: pinning it out of the fold
		// is what lets the cut move past it, not a licence to summarize it.
		expect(compacted[1]).toEqual(typedPrompt);
		// Progress is the point: at least half of what followed the prompt is
		// gone, so the next turn starts from a transcript that actually shrank.
		expect(compacted.length - 2).toBeLessThanOrEqual(tailLength / 2 + 1);

		const toolUseIds = new Set<string>();
		const toolResultIds = new Set<string>();
		for (const msg of compacted) {
			if (!Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block.type === "tool_use") toolUseIds.add(block.id);
				if (block.type === "tool_result") {
					toolResultIds.add(block.tool_use_id);
				}
			}
		}
		for (const id of toolUseIds) {
			expect(toolResultIds.has(id)).toBe(true);
		}
		for (const id of toolResultIds) {
			expect(toolUseIds.has(id)).toBe(true);
		}
	});

	it("falls back to basic compaction when agentic declines", async () => {
		// The trigger has already decided this transcript has to shrink, so a
		// declined agentic compaction cannot be answered with "skip": that
		// hands the same oversized transcript to the next turn, one turn
		// bigger. Agentic needs a working model request to succeed at exactly
		// the moment the context is fullest — here the summarizer comes back
		// empty. Basic needs no request and cannot decline for that reason.
		const createMessage = vi.fn(() =>
			streamChunks([
				{ type: "text", id: "summary-empty", text: "   " },
				{ type: "done", id: "summary-empty", success: true },
			]),
		);
		createHandlerMock.mockReturnValue({ createMessage });

		const captureCalls: Array<{
			event: string;
			properties?: Record<string, unknown>;
		}> = [];
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "<task>Build the feature</task>" },
		];
		for (let i = 0; i < 12; i++) {
			messages.push({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: `decline-tool-${i}`,
						name: "read_files",
						input: { file_paths: [`/tmp/d${i}.ts`] },
					},
				],
			});
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `decline-tool-${i}`,
						name: "read_files",
						content: "w".repeat(1_500),
					},
				],
			});
		}
		messages.push({ role: "assistant", content: "working on it" });

		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1_000,
			},
			sessionId: "ulid-fallback-1",
			telemetry: {
				capture: (call: {
					event: string;
					properties?: Record<string, unknown>;
				}) => captureCalls.push(call),
				captureRequired: () => {},
				setDistinctId: () => {},
				updateCommonProperties: () => {},
			} as never,
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 4,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 4_000 },
			},
		});

		// Agentic got its chance and gave up.
		expect(createMessage).toHaveBeenCalledTimes(1);
		expect(result?.messages).toBeDefined();
		expect(totalJsonTokens(result?.messages ?? [])).toBeLessThan(
			totalJsonTokens(messages),
		);
		const executed = captureCalls.find(
			(call) => call.event === "task.compaction_executed",
		);
		expect((executed?.properties as Record<string, unknown>)?.strategy).toBe(
			"basic",
		);
	});

	it("uses the configured summarizer model for compaction", async () => {
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{ type: "text", id: "summary-3", text: "## Goal\nSummarized" },
					{ type: "done", id: "summary-3", success: true },
				]),
			),
		});

		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "primary-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "primary-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
				summarizer: {
					providerId: "openai",
					modelId: "gpt-summary",
					maxOutputTokens: 512,
				},
			},
			logger: undefined,
		});

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Old turn" },
				{ role: "assistant", content: "Old answer" },
				{ role: "user", content: "Latest turn" },
				{ role: "assistant", content: "Latest answer" },
			],
			apiMessages: [
				{ role: "user", content: "Old turn" },
				{ role: "assistant", content: "Old answer" },
				{ role: "user", content: "Latest turn" },
				{ role: "assistant", content: "Latest answer" },
			],
			model: {
				id: "primary-model",
				provider: "anthropic",
				info: { id: "primary-model", maxInputTokens: 10 },
			},
		});

		expect(createHandlerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "openai",
				modelId: "gpt-summary",
				maxOutputTokens: 512,
				thinking: false,
			}),
		);
	});

	it("budgets agentic summary input against the configured summarizer context window", async () => {
		let summaryRequest = "";
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(
				(_system: string, messages: LlmsProviders.Message[]) => {
					summaryRequest = String(messages[0]?.content ?? "");
					return streamChunks([
						{ type: "text", id: "summary-small", text: "## Goal\nSummarized" },
						{ type: "done", id: "summary-small", success: true },
					]);
				},
			),
		});

		const summarizerLimit = 600;
		const oversizedAssistant = "assistant details ".repeat(5_000);
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "primary-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "primary-model",
				modelInfo: { id: "primary-model", maxInputTokens: 10_000 },
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 1,
				summarizer: {
					providerId: "openai",
					modelId: "small-summary",
					modelInfo: {
						id: "small-summary",
						maxInputTokens: summarizerLimit,
					},
				},
			},
			logger: undefined,
		});

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Old request" },
				{ role: "assistant", content: oversizedAssistant },
				{ role: "user", content: "Latest turn" },
				{ role: "assistant", content: "Latest answer" },
			],
			apiMessages: [
				{ role: "user", content: "Old request" },
				{ role: "assistant", content: oversizedAssistant },
				{ role: "user", content: "Latest turn" },
				{ role: "assistant", content: "Latest answer" },
			],
			model: {
				id: "primary-model",
				provider: "anthropic",
				info: { id: "primary-model", maxInputTokens: 10_000 },
			},
		});

		expect(createHandlerMock).toHaveBeenCalledTimes(1);
		expect(estimateTokens(summaryRequest.length)).toBeLessThanOrEqual(
			summarizerLimit,
		);
		expect(summaryRequest).not.toContain(oversizedAssistant);
	});

	it("uses basic compaction without calling the summarizer", async () => {
		const emitStatusNotice = vi.fn();
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic",
			},
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			emitStatusNotice,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Initial request that should survive" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal reasoning" },
						{ type: "text", text: "Older assistant explanation" },
						{
							type: "tool_use",
							id: "tool-1",
							name: "read_files",
							input: { file_paths: ["/tmp/example.ts"] },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							name: "tool",
							content: "tool output that should be removed",
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "Most recent user turn" },
						{
							type: "image",
							data: "abc",
							mediaType: "image/png",
						},
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Most recent assistant reply" },
						{
							type: "file",
							path: "/tmp/out.ts",
							content: "export const value = 1;",
						},
					],
				},
			],
			apiMessages: [
				{ role: "user", content: "Initial request that should survive" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal reasoning" },
						{ type: "text", text: "Older assistant explanation" },
						{
							type: "tool_use",
							id: "tool-1",
							name: "read_files",
							input: { file_paths: ["/tmp/example.ts"] },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							name: "tool",
							content: "tool output that should be removed",
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "Most recent user turn" },
						{
							type: "image",
							data: "abc",
							mediaType: "image/png",
						},
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Most recent assistant reply" },
						{
							type: "file",
							path: "/tmp/out.ts",
							content: "export const value = 1;",
						},
					],
				},
			],
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 10 },
			},
		});

		expect(createHandlerMock).not.toHaveBeenCalled();
		expect(emitStatusNotice).toHaveBeenCalledWith(
			"auto-compacting",
			expect.objectContaining({
				kind: "auto_compaction",
				reason: "auto_compaction",
			}),
		);
		assertBasicCompactionResult(result);
	});

	it("compacts on overflow recovery whatever the estimate said, and lands on basic when the summariser cannot run", async () => {
		const emitStatusNotice = vi.fn();
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				// Agentic is configured and is attempted first; recovery must
				// not *depend* on that call succeeding, and here it cannot —
				// the handler mock returns nothing to stream.
				strategy: "agentic",
			},
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			emitStatusNotice,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: overflowRecoveryTranscript(),
			apiMessages: overflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				// Large window: the estimate-based trigger would not fire, yet
				// the provider said otherwise — recovery must compact anyway.
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(createHandlerMock).toHaveBeenCalled();
		expect(emitStatusNotice).toHaveBeenCalledWith(
			"overflow-recovery-compacting",
			expect.objectContaining({
				kind: "overflow_recovery_compaction",
				reason: "overflow_recovery_compaction",
			}),
		);
		expect(emitStatusNotice).toHaveBeenCalledWith(
			"overflow-recovery-compacted",
			expect.objectContaining({
				kind: "overflow_recovery_compaction",
				phase: "completed",
			}),
		);
		assertBasicCompactionResult(result);
	});

	it("recovers by summarising rather than dropping turns when the summariser works", async () => {
		// Basic compaction drops turns whole, and measured on live runs the model
		// does not survive it: the transcript it wakes up in has the work but not
		// the reasons, and every recovery was followed by the run coming apart.
		// So the summariser gets the first attempt, and its transcript is what
		// the retry uses when it fits.
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-1",
						text: "## Goal\nShip the feature\n\n## Next\n- Finish it",
					},
					{ type: "done", id: "summary-1", success: true },
				]),
			),
		});

		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "agentic" },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: longOverflowRecoveryTranscript(),
			apiMessages: longOverflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(createHandlerMock).toHaveBeenCalled();
		expect(JSON.stringify(result?.messages)).toContain("Ship the feature");
	});

	it("skips overflow-recovery compaction when there is nothing to remove", async () => {
		const emitStatusNotice = vi.fn();
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "agentic",
			},
			logger: undefined,
		});

		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "A single oversized first prompt" },
		];
		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			emitStatusNotice,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(result).toBeUndefined();
		expect(createHandlerMock).not.toHaveBeenCalled();
		expect(emitStatusNotice).toHaveBeenCalledWith(
			"overflow-recovery-compaction-skipped",
			expect.objectContaining({
				kind: "overflow_recovery_compaction",
				phase: "skipped",
			}),
		);
	});

	it("uses a successful custom compactor during overflow recovery", async () => {
		const abortSignal = new AbortController().signal;
		const compacted = [{ role: "user" as const, content: "custom fold" }];
		const compact = vi.fn(async (context: CoreCompactionContext) => {
			expect(context.mode).toBe("overflow_recovery");
			// Custom compactors receive the turn's abort signal so a stalled
			// external call can be cancelled instead of blocking recovery.
			expect(context.abortSignal).toBe(abortSignal);
			return { messages: compacted };
		});
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: overflowRecoveryTranscript(),
			apiMessages: overflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		expect(result?.messages).toEqual(compacted);
	});

	it("falls back to basic compaction when a custom compactor fails during overflow recovery", async () => {
		const compact = vi.fn(async () => {
			throw new Error("custom compactor overflowed too");
		});
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: overflowRecoveryTranscript(),
			apiMessages: overflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		// Custom declines, the summariser is tried and cannot run, basic ends it.
		expect(createHandlerMock).toHaveBeenCalled();
		assertBasicCompactionResult(result);
	});

	it("falls back to basic compaction when a custom compactor does not shrink during overflow recovery", async () => {
		// Echoes its input back — "succeeds" without removing anything, which
		// the runtime would reject as a non-shrinking retry.
		const compact = vi.fn(async (context: CoreCompactionContext) => ({
			messages: context.messages,
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: overflowRecoveryTranscript(),
			apiMessages: overflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		assertBasicCompactionResult(result);
	});

	it("falls back to basic compaction when a custom compactor returns an empty transcript", async () => {
		// An empty result is trivially "smaller" and under target, but would
		// erase the very request the retry is supposed to re-send.
		const compact = vi.fn(async () => ({ messages: [] }));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: overflowRecoveryTranscript(),
			apiMessages: overflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		assertBasicCompactionResult(result);
	});

	it("falls back to basic compaction when a custom compactor shrinks but misses the recovery target", async () => {
		// Drops only the short final message — strictly smaller, but far above
		// the ~50% recovery target, so the retry would still not fit.
		const compact = vi.fn(async (context: CoreCompactionContext) => ({
			messages: context.messages.slice(0, -1),
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: overflowRecoveryTranscript(),
			apiMessages: overflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		// Custom declines, the summariser is tried and cannot run, basic ends it.
		expect(createHandlerMock).toHaveBeenCalled();
		assertBasicCompactionResult(result);
	});

	it("falls back to basic compaction when a custom compactor declines during overflow recovery", async () => {
		const compact = vi.fn(async () => undefined);
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			overflowRecovery: true,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: overflowRecoveryTranscript(),
			apiMessages: overflowRecoveryTranscript(),
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 1_000_000 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		assertBasicCompactionResult(result);
	});

	it("triggers compaction when input reaches exactly 90 percent", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted at 90%" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "At the exact compaction boundary" },
		];
		const inputTokens = estimateRequestInputTokens({
			systemPrompt: "You are helpful.",
			messages,
			tools: [],
		});
		const maxInputTokens = inputTokens / 0.9;
		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "openai-codex",
				info: { id: "mock-model", maxInputTokens },
			},
		});

		expect(createHandlerMock).not.toHaveBeenCalled();
		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.triggerTokens).toBe(inputTokens);
		expect(context?.budget.request.thresholdRatio).toBe(0.9);
		expect(result?.messages).toEqual([
			{ role: "user", content: "Compacted at 90%" },
		]);
	});

	it("triggers at 81 percent when only contextWindow is available", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted at 81%" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "At the context fallback boundary" },
		];
		const inputTokens = estimateRequestInputTokens({
			systemPrompt: "You are helpful.",
			messages,
			tools: [],
		});
		const contextWindow = inputTokens / 0.81;

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: {
					id: "mock-model",
					contextWindow,
				},
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.maxInputTokens).toBeCloseTo(
			contextWindow * 0.9,
		);
		// A window of a few dozen tokens is smaller than the default output room,
		// so the quarter ceiling on the reservation decides: three quarters of the
		// window, rather than the negative number the raw subtraction gives.
		expect(context?.budget.request.triggerTokens).toBeCloseTo(
			contextWindow * 0.75,
		);
		expect(result?.messages).toEqual([
			{ role: "user", content: "Compacted at 81%" },
		]);
	});

	it("includes system prompt and tools in the automatic trigger", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted full request" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "small message" },
		];
		const systemPrompt = "s".repeat(3_000);
		const tools = [
			{
				name: "large_tool",
				description: "t".repeat(3_000),
				inputSchema: { type: "object" },
			},
		];

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt,
			tools,
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 2_000 },
			},
		});

		expect(createTokenEstimator()(messages[0])).toBeLessThan(1_800);
		expect(
			estimateRequestInputTokens({ systemPrompt, messages, tools }),
		).toBeGreaterThanOrEqual(1_800);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("translates full-request targets into attainable message budgets", async () => {
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: `old request ${"u".repeat(800)}` },
			{ role: "assistant", content: `old answer ${"a".repeat(800)}` },
			{ role: "user", content: `latest request ${"l".repeat(800)}` },
		];
		const systemPrompt = "s".repeat(4_000);
		const requestInputTokens = estimateRequestInputTokens({
			systemPrompt,
			messages,
			tools: [],
		});
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic" },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt,
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: {
					id: "mock-model",
					maxInputTokens: requestInputTokens / 0.91,
				},
			},
		});

		expect(result?.messages).toBeDefined();
		expect(result?.messages).not.toEqual(messages);
	});

	it("triggers at 90 percent of maxInputTokens", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted by ratio" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "gpt-5.4-mini",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "gpt-5.4-mini",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "x".repeat(365_000) },
				{ role: "assistant", content: "y".repeat(365_000) },
			],
			apiMessages: [
				{ role: "user", content: "x".repeat(365_000) },
				{ role: "assistant", content: "y".repeat(365_000) },
			],
			model: {
				id: "gpt-5.4-mini",
				provider: "openai-codex",
				info: { id: "gpt-5.4-mini", maxInputTokens: 200_000 },
			},
		});

		expect(createHandlerMock).not.toHaveBeenCalled();
		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.triggerTokens).toBe(180_000);
		expect(context?.budget.request.thresholdRatio).toBe(0.9);
		expect(result?.messages).toEqual([
			{ role: "user", content: "Compacted by ratio" },
		]);
	});

	it("does not subtract maxTokens when maxInputTokens differs from contextWindow", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [
				{ role: "user" as const, content: "Compacted by input budget" },
			],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "gpt-5.4-mini",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "gpt-5.4-mini",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{
				role: "user",
				content: "large prompt ".repeat(20_000),
			},
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "gpt-5.4-mini",
				provider: "openai-codex",
				info: {
					id: "gpt-5.4-mini",
					contextWindow: 400_000,
					maxInputTokens: 200_000,
					maxTokens: 128_000,
				},
			},
		});

		expect(compact).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("targets basic compaction at a third of the input budget for long conversations", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [
				{ role: "user" as const, content: "Compacted by target budget" },
			],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "gpt-5.5",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "gpt-5.5",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic", compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "turn 1" },
			{ role: "assistant", content: "answer 1" },
			{ role: "user", content: "turn 2" },
			{ role: "assistant", content: "answer 2" },
			{ role: "user", content: "turn 3" },
			{ role: "assistant", content: "answer 3" },
			{ role: "user", content: "turn 4" },
			{ role: "assistant", content: "answer 4" },
			{ role: "user", content: "turn 5" },
			{ role: "assistant", content: "answer 5" },
			{ role: "user", content: "large prompt ".repeat(70_000) },
		];

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "gpt-5.5",
				provider: "openai-codex",
				info: {
					id: "gpt-5.5",
					maxInputTokens: 272_000,
					// An eighth of the input budget: a cap this tight is a real
					// constraint on how much a turn can say, and that is what the
					// aggressive target is for.
					maxTokens: 32_000,
				},
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.triggerTokens).toBe(244_800);
		// A third of maxInputTokens (272,000), so one summary buys the run about
		// two thirds of the window back rather than 40 points of it.
		expect(context?.budget.request.targetTokens).toBe(89_760);
		expect(context?.budget.messages.targetTokens).toBe(
			(context?.budget.request.targetTokens ?? 0) -
				(context?.budget.request.overheadTokens ?? 0),
		);
	});

	// The regression this pins: `modelMaxTokens < maxInputTokens` was written when
	// the cap was almost never populated, and read as "this model has a tight
	// cap". Once the cap reached the session it was true of every local model, so
	// the aggressive target went from never firing to always firing and the
	// retained context fell from 54,600 to 36,300 on a 110,000-token window.
	// Measured across a day: the task that finished in an hour at 54,600 did not
	// finish once at 36,300.
	it("does not take the aggressive target for a cap that is merely smaller", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "ollama",
			modelId: "local-model",
			providerConfig: {
				providerId: "ollama",
				modelId: "local-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic", compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "turn 1" },
			{ role: "assistant", content: "answer 1" },
			{ role: "user", content: "turn 2" },
			{ role: "assistant", content: "answer 2" },
			{ role: "user", content: "turn 3" },
			{ role: "assistant", content: "answer 3" },
			{ role: "user", content: "turn 4" },
			{ role: "assistant", content: "answer 4" },
			{ role: "user", content: "turn 5" },
			{ role: "assistant", content: "answer 5" },
			{ role: "user", content: "large prompt ".repeat(40_000) },
		];

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "local-model",
				provider: "ollama",
				// The live setup: a 110,000 window and the user's own 32,000
				// num_predict, which is 29% of the input budget.
				info: { id: "local-model", contextWindow: 110_000, maxTokens: 32_000 },
			},
		});

		const context = compact.mock.calls[0]?.[0];
		// Not 36,300. The conservative branch: 0.7 of the trigger, floored.
		expect(context?.budget.request.targetTokens).toBeCloseTo(57_750, -1);
	});

	it("keeps the long-conversation target below the fixed trigger", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [
				{ role: "user" as const, content: "Compacted by low threshold" },
			],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic",
				compact,
			},
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "turn 1" },
			{ role: "assistant", content: "answer 1" },
			{ role: "user", content: "turn 2" },
			{ role: "assistant", content: "answer 2" },
			{ role: "user", content: "turn 3" },
			{ role: "assistant", content: "answer 3" },
			{ role: "user", content: "turn 4" },
			{ role: "assistant", content: "answer 4" },
			{ role: "user", content: "turn 5" },
			{ role: "assistant", content: "answer 5" },
			{ role: "user", content: "large prompt ".repeat(20) },
		];

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: {
					id: "mock-model",
					maxInputTokens: 100,
					maxTokens: 12,
				},
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.triggerTokens).toBe(90);
		expect(context?.budget.request.targetTokens).toBe(33);
		expect(context?.budget.messages.targetTokens).toBe(
			Math.max(
				1,
				(context?.budget.request.targetTokens ?? 0) -
					(context?.budget.request.overheadTokens ?? 0),
			),
		);
	});

	it("uses a conservative input budget when only contextWindow is reported", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [
				{ role: "user" as const, content: "Compacted by derived input budget" },
			],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "gpt-5.5",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "gpt-5.5",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{
				role: "user",
				content: "large prompt ".repeat(80_000),
			},
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "gpt-5.5",
				provider: "openai-codex",
				info: {
					id: "gpt-5.5",
					contextWindow: 400_000,
					maxTokens: 128_000,
				},
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.maxInputTokens).toBe(360_000);
		// The ratio would allow 324,000, but a turn has to hold prompt and reply
		// in one 400,000 window. The trigger is whichever bound comes first, and
		// here it is the one that leaves room to answer. The model's own 128,000
		// cap is not reserved in full -- a third of the window held back for an
		// output that size costs more than it saves -- so a quarter is.
		expect(context?.budget.request.triggerTokens).toBe(300_000);
		expect(context?.budget.request.thresholdRatio).toBe(0.9);
		expect(result?.messages).toEqual([
			{ role: "user", content: "Compacted by derived input budget" },
		]);
	});

	it("uses the lower split input budget when it is below context-derived input budget", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [
				{ role: "user" as const, content: "Compacted by split input" },
			],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "gpt-5.5",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "gpt-5.5",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{
				role: "user",
				content: "large prompt ".repeat(60_000),
			},
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "gpt-5.5",
				provider: "openai-codex",
				info: {
					id: "gpt-5.5",
					contextWindow: 400_000,
					maxInputTokens: 200_000,
					maxTokens: 128_000,
				},
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.maxInputTokens).toBe(200_000);
		expect(context?.budget.request.triggerTokens).toBe(180_000);
		expect(context?.budget.request.thresholdRatio).toBe(0.9);
		expect(result?.messages).toEqual([
			{ role: "user", content: "Compacted by split input" },
		]);
	});

	it("uses contextWindow when maxTokens leaves no input budget", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted by fallback" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "large-output-model",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "large-output-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [{ role: "user", content: "small prompt" }],
			apiMessages: [{ role: "user", content: "small prompt" }],
			model: {
				id: "large-output-model",
				provider: "openai-codex",
				info: {
					id: "large-output-model",
					maxInputTokens: 200_000,
					contextWindow: 200_000,
					maxTokens: 200_000,
				},
			},
		});

		expect(compact).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("does not compact early when maxInputTokens equals contextWindow", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted by fallback" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openrouter",
			modelId: "minimax/minimax-m3",
			providerConfig: {
				providerId: "openrouter",
				modelId: "minimax/minimax-m3",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic", compact },
			logger: undefined,
		});
		const messages: MessageWithMetadata[] = [
			{
				role: "user",
				content: "regex prompt ".repeat(3_000),
			},
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "minimax/minimax-m3",
				provider: "openrouter",
				info: {
					id: "minimax/minimax-m3",
					contextWindow: 524_288,
					maxInputTokens: 524_288,
					maxTokens: 512_000,
				},
			},
		});

		expect(compact).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("triggers compaction from provider-sized tool result payloads", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [
				{ role: "user" as const, content: "Compacted provider payload" },
			],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "gpt-5.4-mini",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "gpt-5.4-mini",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});
		const largeToolResult = "x".repeat(800_000);
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Read a large file" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool-large",
						name: "read_files",
						input: { file_paths: ["/tmp/large.txt"] },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-large",
						name: "tool",
						content: [{ type: "text", text: largeToolResult }],
					},
				],
			},
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "gpt-5.4-mini",
				provider: "openai-codex",
				info: { id: "gpt-5.4-mini", maxInputTokens: 272_000 },
			},
		});

		expect(createHandlerMock).not.toHaveBeenCalled();
		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.triggerTokens).toBe(244_800);
		expect(context?.budget.request.utilizationRatio).toBeGreaterThan(0.9);
		expect(result?.messages).toEqual([
			{ role: "user", content: "Compacted provider payload" },
		]);
	});

	it("does not compact below the fixed 90 percent threshold", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted explicitly" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, compact },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Short request" },
				{ role: "assistant", content: "Short reply" },
			],
			apiMessages: [
				{ role: "user", content: "Short request" },
				{ role: "assistant", content: "Short reply" },
			],
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100 },
			},
		});

		expect(createHandlerMock).not.toHaveBeenCalled();
		expect(compact).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("manual mode forces compaction below the auto threshold", async () => {
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "Compacted manually" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn(
			{
				providerId: "anthropic",
				modelId: "mock-model",
				providerConfig: {
					providerId: "anthropic",
					modelId: "mock-model",
				} as LlmsProviders.ProviderConfig,
				compaction: {
					enabled: true,
					compact,
				},
				logger: undefined,
			},
			{ mode: "manual" },
		);

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Short request" },
				{ role: "assistant", content: "Short reply" },
			],
			apiMessages: [
				{ role: "user", content: "Short request" },
				{ role: "assistant", content: "Short reply" },
			],
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		const context = compact.mock.calls[0]?.[0];
		expect(context?.budget.request.maxInputTokens).toBe(100);
		expect(context?.budget.request.triggerTokens).toBe(90);
		expect(context?.budget.messages.targetTokens).toBeLessThan(
			context?.budget.messages.triggerTokens ?? 0,
		);
		expect(result?.messages).toEqual([
			{ role: "user", content: "Compacted manually" },
		]);
	});

	it("manual mode lowers the agentic preserve budget below the default floor", async () => {
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-manual",
						text: "## Goal\nManual compact\n\n## Next\nContinue",
					},
					{ type: "done", id: "summary-manual", success: true },
				]),
			),
		});
		const repeatedText = "manual compact content ".repeat(100);
		const prepareTurn = createContextCompactionPrepareTurn(
			{
				providerId: "anthropic",
				modelId: "mock-model",
				providerConfig: {
					providerId: "anthropic",
					modelId: "mock-model",
				} as LlmsProviders.ProviderConfig,
				compaction: {
					enabled: true,
					strategy: "agentic",
				},
				logger: undefined,
			},
			{ mode: "manual" },
		);

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: `Old request ${repeatedText}` },
				{ role: "assistant", content: `Old reply ${repeatedText}` },
				{ role: "user", content: `Latest request ${repeatedText}` },
				{ role: "assistant", content: `Latest reply ${repeatedText}` },
			],
			apiMessages: [
				{ role: "user", content: `Old request ${repeatedText}` },
				{ role: "assistant", content: `Old reply ${repeatedText}` },
				{ role: "user", content: `Latest request ${repeatedText}` },
				{ role: "assistant", content: `Latest reply ${repeatedText}` },
			],
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 10_000 },
			},
		});

		expect(createHandlerMock).toHaveBeenCalledTimes(1);
		expect(result?.messages[0]).toMatchObject({
			role: "user",
			metadata: expect.objectContaining({
				kind: "compaction_summary",
			}),
		});
		expect(result?.messages.length).toBeLessThan(4);
	});

	it("automatic agentic compaction clamps preservation to a small model budget", async () => {
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() =>
				streamChunks([
					{
						type: "text",
						id: "summary-auto-small",
						text: "## Goal\nCompact a small context\n\n## Next\nContinue",
					},
					{ type: "done", id: "summary-auto-small", success: true },
				]),
			),
		});
		const repeatedText = "small model content ".repeat(100);
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: `Old request ${repeatedText}` },
			{ role: "assistant", content: `Old reply ${repeatedText}` },
			{ role: "user", content: `Latest request ${repeatedText}` },
			{ role: "assistant", content: `Latest reply ${repeatedText}` },
		];
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "small-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "small-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "agentic" },
			logger: undefined,
		});

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "small-model",
				provider: "anthropic",
				info: { id: "small-model", maxInputTokens: 2_000 },
			},
		});

		expect(createHandlerMock).toHaveBeenCalledTimes(1);
		expect(result?.messages[0]).toMatchObject({
			role: "user",
			metadata: expect.objectContaining({ kind: "compaction_summary" }),
		});
		expect(result?.messages.length).toBeLessThan(messages.length);
	});

	it("drops old user image blocks during basic compaction sanitization", () => {
		const messages: LlmsProviders.Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "  Older user turn  " },
					{ type: "image", data: "abc", mediaType: "image/png" },
				],
			},
			{ role: "assistant", content: "Older assistant response" },
			{ role: "user", content: "Latest user turn" },
		];

		const result = runBasicCompaction({
			context: {
				agentId: "agent-1",
				conversationId: "conv-1",
				parentAgentId: null,
				iteration: 1,
				messages,
				model: {
					id: "mock-model",
					provider: "anthropic",
					info: { id: "mock-model", maxInputTokens: 100 },
				},
				mode: "manual",
				budget: {
					request: {
						inputTokens: 10,
						maxInputTokens: 100,
						triggerTokens: 100,
						targetTokens: 100,
						overheadTokens: 0,
						thresholdRatio: 1,
						utilizationRatio: 0.1,
					},
					messages: {
						inputTokens: 10,
						triggerTokens: 100,
						targetTokens: 100,
					},
				},
			},
			estimateMessageTokens: createTokenEstimator(),
		});

		// The older turn's image is dropped, but its concluding assistant
		// answer is preserved as a real message.
		expect(result?.messages).toHaveLength(3);
		expect(result?.messages[0]?.content).toEqual([
			{ type: "text", text: "Older user turn" },
		]);
		expect(result?.messages[1]).toMatchObject({
			role: "assistant",
			content: "Older assistant response",
		});
		expect(result?.messages[2]?.content).toBe("Latest user turn");
	});

	it("does not compact when only pre-truncation messages exceed the threshold", async () => {
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
			},
			logger: undefined,
		});
		expect(prepareTurn).toBeDefined();

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: [
				{ role: "user", content: "Initial request" },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							name: "tool",
							content: "x".repeat(1000),
						},
					],
				},
			],
			apiMessages: [
				{ role: "user", content: "Initial request" },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							name: "tool",
							content: "x".repeat(100),
						},
					],
				},
			],
			model: {
				id: "mock-model",
				provider: "anthropic",
				// 200 puts the trigger at 180: the request that actually goes
				// out is ~102 tokens and must not compact, while the
				// pre-truncation transcript is ~382 and would. At 100 the
				// request itself cleared the threshold, so this only ever
				// asserted that agentic compaction declined.
				info: { id: "mock-model", maxInputTokens: 200 },
			},
		});

		expect(createHandlerMock).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	// ------------------------------------------------------------------
	// Telemetry coverage — task.compaction_executed / task.compaction_skipped
	// ------------------------------------------------------------------

	it("emits task.compaction_executed telemetry after a successful basic compaction", async () => {
		const captureCalls: Array<{
			event: string;
			properties?: Record<string, unknown>;
		}> = [];
		const telemetry = {
			capture: (call: {
				event: string;
				properties?: Record<string, unknown>;
			}) => captureCalls.push(call),
			captureRequired: () => {},
			setDistinctId: () => {},
			updateCommonProperties: () => {},
			identify: () => {},
		} as unknown as Parameters<
			typeof createContextCompactionPrepareTurn
		>[0]["telemetry"];

		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic",
			},
			telemetry,
			sessionId: "ulid-test-1",
		});

		const filler = "x".repeat(200);
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: `Old answer ${filler}` },
			{ role: "user", content: `Older user followup ${filler}` },
			{ role: "assistant", content: `Older assistant ${filler}` },
			{ role: "user", content: "Latest user question" },
		];

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100 },
			},
		});

		expect(result?.messages).toBeDefined();
		const executed = captureCalls.find(
			(call) => call.event === "task.compaction_executed",
		);
		expect(executed).toBeDefined();
		const props = executed?.properties as Record<string, unknown>;
		expect(props.strategy).toBe("basic");
		expect(props.mode).toBe("auto");
		expect(props.ulid).toBe("ulid-test-1");
		expect(props.provider).toBe("anthropic");
		expect(props.modelId).toBe("mock-model");
		expect(props.agentId).toBe("agent-1");
		expect(props.conversationId).toBe("conv-1");
		expect(typeof props.durationMs).toBe("number");
		expect(typeof props.tokensBefore).toBe("number");
		expect(typeof props.tokensAfter).toBe("number");
		expect(props.messagesBefore).toBe(messages.length);
		expect(typeof props.messagesAfter).toBe("number");
		expect(props.tokensSaved).toBe(
			(props.tokensBefore as number) - (props.tokensAfter as number),
		);
	});

	it("marks strategy as 'custom' when a user-supplied compact callback is used", async () => {
		const captureCalls: Array<{
			event: string;
			properties?: Record<string, unknown>;
		}> = [];
		const telemetry = {
			capture: (call: {
				event: string;
				properties?: Record<string, unknown>;
			}) => captureCalls.push(call),
			captureRequired: () => {},
			setDistinctId: () => {},
			updateCommonProperties: () => {},
			identify: () => {},
		} as unknown as Parameters<
			typeof createContextCompactionPrepareTurn
		>[0]["telemetry"];

		const customCompact = vi.fn(async () => ({
			messages: [
				{ role: "user", content: "trimmed" },
			] as LlmsProviders.Message[],
		}));

		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic", // ignored when `compact` is provided
				compact: customCompact,
			},
			telemetry,
		});

		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: "x".repeat(500) },
			{ role: "user", content: "Latest" },
		];

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 2,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100 },
			},
		});

		expect(customCompact).toHaveBeenCalledTimes(1);
		const executed = captureCalls.find(
			(call) => call.event === "task.compaction_executed",
		);
		expect(executed).toBeDefined();
		expect((executed?.properties as Record<string, unknown>).strategy).toBe(
			"custom",
		);
	});

	it("reports executed compaction telemetry in full-request token units", async () => {
		const captureCalls: Array<{
			event: string;
			properties?: Record<string, unknown>;
		}> = [];
		const telemetry = {
			capture: (call: {
				event: string;
				properties?: Record<string, unknown>;
			}) => captureCalls.push(call),
			captureRequired: () => {},
			setDistinctId: () => {},
			updateCommonProperties: () => {},
			identify: () => {},
		} as unknown as Parameters<
			typeof createContextCompactionPrepareTurn
		>[0]["telemetry"];

		const compact = vi.fn(async () => ({
			messages: [{ role: "user" as const, content: "trimmed" }],
		}));
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic",
				compact,
			},
			telemetry,
		});
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: "short answer" },
			{ role: "user", content: "Latest" },
		];
		const apiMessages: LlmsProviders.Message[] = [
			...messages,
			{ role: "assistant", content: "provider-only payload ".repeat(1_000) },
		];

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 3,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages,
			apiMessages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100 },
			},
		});

		expect(compact).toHaveBeenCalledTimes(1);
		const executed = captureCalls.find(
			(call) => call.event === "task.compaction_executed",
		);
		const props = executed?.properties as Record<string, unknown>;
		expect(props.tokensBefore as number).toBeGreaterThanOrEqual(
			props.triggerTokens as number,
		);
		expect(props.tokensSaved).toBe(
			(props.tokensBefore as number) - (props.tokensAfter as number),
		);
		expect(props.tokensSaved as number).toBeGreaterThanOrEqual(0);
	});

	it("emits task.compaction_skipped when the strategy returns undefined", async () => {
		const emitStatusNotice = vi.fn();
		const captureCalls: Array<{
			event: string;
			properties?: Record<string, unknown>;
		}> = [];
		const telemetry = {
			capture: (call: {
				event: string;
				properties?: Record<string, unknown>;
			}) => captureCalls.push(call),
			captureRequired: () => {},
			setDistinctId: () => {},
			updateCommonProperties: () => {},
			identify: () => {},
		} as unknown as Parameters<
			typeof createContextCompactionPrepareTurn
		>[0]["telemetry"];

		// Force the trigger to fire (small budget vs large transcript) but
		// supply a `compact` callback that intentionally returns undefined
		// so the wrapper records a skip.
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig: {
				providerId: "anthropic",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic",
				compact: async () => undefined,
			},
			telemetry,
			sessionId: "ulid-test-skip",
		});

		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: "x".repeat(500) },
			{ role: "user", content: "Latest" },
		];
		const apiMessages: LlmsProviders.Message[] = [
			{ role: "user", content: "api-shaped ".repeat(500) },
		];
		const estimateMessageTokens = createTokenEstimator();
		const sessionInputTokens = messages.reduce(
			(total, message) => total + estimateMessageTokens(message),
			0,
		);
		const apiInputTokens = apiMessages.reduce(
			(total, message) => total + estimateMessageTokens(message),
			0,
		);
		const requestInputTokens = estimateRequestInputTokens({
			systemPrompt: "",
			messages: apiMessages,
			tools: [],
		});
		expect(apiInputTokens).not.toBe(sessionInputTokens);

		const result = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 3,
			emitStatusNotice,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages,
			apiMessages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100 },
			},
		});

		expect(result).toBeUndefined();
		const skipped = captureCalls.find(
			(call) => call.event === "task.compaction_skipped",
		);
		expect(skipped).toBeDefined();
		const props = skipped?.properties as Record<string, unknown>;
		expect(props.strategy).toBe("custom");
		expect(props.mode).toBe("auto");
		expect(props.reason).toBe("no_result");
		expect(emitStatusNotice).toHaveBeenLastCalledWith(
			"auto-compaction-skipped",
			expect.objectContaining({
				kind: "auto_compaction",
				phase: "skipped",
			}),
		);
		expect(props.ulid).toBe("ulid-test-skip");
		expect(props.tokensBefore).toBe(requestInputTokens);
		expect(typeof props.durationMs).toBe("number");
		expect(
			captureCalls.find((call) => call.event === "task.compaction_executed"),
		).toBeUndefined();
	});

	it("tags telemetry mode as 'manual' when prepareTurn is run with mode: manual", async () => {
		const captureCalls: Array<{
			event: string;
			properties?: Record<string, unknown>;
		}> = [];
		const telemetry = {
			capture: (call: {
				event: string;
				properties?: Record<string, unknown>;
			}) => captureCalls.push(call),
			captureRequired: () => {},
			setDistinctId: () => {},
			updateCommonProperties: () => {},
			identify: () => {},
		} as unknown as Parameters<
			typeof createContextCompactionPrepareTurn
		>[0]["telemetry"];

		const prepareTurn = createContextCompactionPrepareTurn(
			{
				providerId: "anthropic",
				modelId: "mock-model",
				providerConfig: {
					providerId: "anthropic",
					modelId: "mock-model",
				} as LlmsProviders.ProviderConfig,
				compaction: {
					enabled: true,
					strategy: "basic",
				},
				telemetry,
			},
			{ mode: "manual" },
		);

		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: "x".repeat(500) },
			{ role: "user", content: "Older followup" },
			{ role: "assistant", content: "x".repeat(500) },
			{ role: "user", content: "Latest" },
		];

		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 4,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100_000 },
			},
		});

		const compactionEvent = captureCalls.find(
			(call) =>
				call.event === "task.compaction_executed" ||
				call.event === "task.compaction_skipped",
		);
		expect(compactionEvent).toBeDefined();
		expect((compactionEvent?.properties as Record<string, unknown>).mode).toBe(
			"manual",
		);
	});

	it("does not immediately re-trigger basic compaction on the next turn after accounting for the protected tail", async () => {
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "openai-codex",
			modelId: "mock-model",
			providerConfig: {
				providerId: "openai-codex",
				modelId: "mock-model",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic" },
			logger: undefined,
		});
		const estimateMessageTokens = createTokenEstimator();
		const model = {
			id: "mock-model",
			provider: "openai-codex",
			info: { id: "mock-model", maxInputTokens: 300 },
		};
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "old user context ".repeat(80) },
			{ role: "assistant", content: "old assistant context ".repeat(80) },
			{ role: "user", content: "current request" },
		];
		const triggerTokens = 270;
		const firstResult = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model,
		});

		expect(firstResult?.messages).toBeDefined();
		const firstAfterTokens = firstResult?.messages.reduce(
			(total, message) => total + estimateMessageTokens(message),
			0,
		);
		expect(firstAfterTokens).toBeLessThanOrEqual(triggerTokens);

		const nextTurnMessages: LlmsProviders.Message[] = [
			...(firstResult?.messages ?? []),
			{ role: "assistant", content: "short answer" },
			{ role: "user", content: "next request" },
		];
		const secondResult = await prepareTurn?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 2,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: nextTurnMessages,
			apiMessages: nextTurnMessages,
			model,
		});

		expect(secondResult).toBeUndefined();
	});

	it("projects existing sidecar state without a compact fn (manual /compact with auto-compaction disabled)", async () => {
		const originalMessages: LlmsProviders.Message[] = [
			{ role: "user", content: "original request" },
			{ role: "assistant", content: "original answer" },
		];
		const compactedMessages: LlmsProviders.Message[] = [
			{ role: "user", content: "summary of the session so far" },
		];
		const existingState = createSessionCompactionState({
			sourceMessages: originalMessages,
			compactedMessages,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const saveState = vi.fn();
		const prepareTurn = createCompactionStateAwarePrepareTurn({
			compact: undefined,
			getState: () => existingState,
			saveState,
		});
		const currentMessages: LlmsProviders.Message[] = [
			...originalMessages,
			{ role: "user", content: "follow-up request" },
		];

		const result = await prepareTurn({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages: currentMessages,
			apiMessages: currentMessages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100_000 },
			},
		});

		expect(result?.messages).toEqual([
			...compactedMessages,
			{ role: "user", content: "follow-up request" },
		]);
		expect(saveState).not.toHaveBeenCalled();
	});

	it("keeps stale sidecar state when replacement compaction returns no result", async () => {
		const originalMessages: LlmsProviders.Message[] = [
			{ role: "user", content: "original" },
		];
		const existingState = createSessionCompactionState({
			sourceMessages: originalMessages,
			compactedMessages: [{ role: "user", content: "summary" }],
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const compact = vi.fn().mockResolvedValue(undefined);
		const saveState = vi.fn();
		const prepareTurn = createCompactionStateAwarePrepareTurn({
			compact,
			getState: () => existingState,
			saveState,
		});
		const currentMessages: LlmsProviders.Message[] = [
			{ role: "user", content: "edited original" },
			{ role: "assistant", content: "tail" },
		];

		const result = await prepareTurn({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages: currentMessages,
			apiMessages: currentMessages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100_000 },
			},
		});

		expect(result).toBeUndefined();
		expect(compact).toHaveBeenCalledWith(
			expect.objectContaining({ messages: currentMessages }),
		);
		expect(saveState).not.toHaveBeenCalled();
	});

	it("passes the exact source messages to saveState so hosts can validate against them", async () => {
		// Regression: local-runtime-host validated the persist by projecting the
		// state against agent.getMessages(), which mid-turn can legally differ
		// from the transcript the prepareTurn context carries (the state's hash
		// input) — so auto-compaction persists were spuriously skipped as stale.
		// saveState must receive the same messages the hash was computed over.
		const compact = vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: "summary" }],
		});
		const saveState = vi.fn();
		const prepareTurn = createCompactionStateAwarePrepareTurn({
			compact,
			getState: () => undefined,
			saveState,
		});
		const currentMessages: LlmsProviders.Message[] = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "follow-up" },
		];

		await prepareTurn({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "",
			tools: [],
			messages: currentMessages,
			apiMessages: currentMessages,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: 100_000 },
			},
		});

		expect(saveState).toHaveBeenCalledTimes(1);
		const [savedState, sourceMessages] = saveState.mock.calls[0];
		expect(sourceMessages).toBe(currentMessages);
		expect(
			projectSessionCompactionState(savedState, currentMessages),
		).toBeDefined();
	});
});

describe("the output budget ladder", () => {
	// Generation 1 has to land where the flat cap used to, or every short task
	// silently changes behaviour to buy something only long ones benefit from.
	it("starts where the flat cap was and climbs to the ceiling", () => {
		const target = 32_670; // a 110k window, the model this was specified on
		const shares = [1, 2, 3, 4, 5, 9].map(
			(generation) =>
				resolveCompactionOutputBudgets({
					messageTargetTokens: target,
					generation,
				}).combinedTokens / target,
		);

		expect(shares.map((share) => Number(share.toFixed(2)))).toEqual([
			0.33, 0.4, 0.45, 0.5, 0.55, 0.55,
		]);
	});

	it("gives the summary seven tenths and lets it write first", () => {
		const budgets = resolveCompactionOutputBudgets({
			messageTargetTokens: 32_670,
			generation: 1,
		});

		expect(budgets.combinedTokens).toBe(10_781);
		expect(budgets.summaryMaxTokens).toBe(7_546);
	});

	// The whole reason the summary is written first: an economical one buys the
	// retrospective room rather than leaving it unspent.
	it("hands the retrospective what the summary did not spend", () => {
		const budgets = resolveCompactionOutputBudgets({
			messageTargetTokens: 32_670,
			generation: 1,
		});

		const afterAFullSummary = resolveThinkingSummaryMaxTokens({
			budgets,
			summaryTokens: budgets.summaryMaxTokens,
		});
		const afterAShortSummary = resolveThinkingSummaryMaxTokens({
			budgets,
			summaryTokens: Math.floor(budgets.combinedTokens * 0.3),
		});

		// 30% when the summary took its whole share, and capped at 50% when it
		// came in well under -- not the whole 70% it left behind.
		expect(afterAFullSummary).toBe(budgets.combinedTokens - budgets.summaryMaxTokens);
		expect(afterAShortSummary).toBe(Math.floor(budgets.combinedTokens * 0.5));
	});

	it("keeps a floor when the summary overran its share", () => {
		const budgets = resolveCompactionOutputBudgets({
			messageTargetTokens: 32_670,
			generation: 1,
		});

		expect(
			resolveThinkingSummaryMaxTokens({
				budgets,
				summaryTokens: budgets.combinedTokens * 2,
			}),
		).toBe(Math.floor(budgets.combinedTokens * 0.2));
	});
});

describe("resolvePreserveRecentTokens", () => {
	// The two anchors this was specified against. A flat 20,000 is right for
	// exactly one window: on 32k it asks to preserve more than the compaction
	// target, and on 1M it throws away a task with room for forty times that.
	it("holds its anchors at 128k and 1M", () => {
		expect(resolvePreserveRecentTokens({ contextWindow: 128_000 })).toBe(20_000);
		expect(resolvePreserveRecentTokens({ contextWindow: 1_000_000 })).toBe(78_745);
	});

	it("grows sub-linearly between them", () => {
		const at256k = resolvePreserveRecentTokens({ contextWindow: 256_000 });

		// Eight times the window buys four times the tail, not eight.
		expect(at256k).toBeGreaterThan(20_000);
		expect(at256k).toBeLessThan(40_000);
	});

	it("never claims more than its share of what compaction is aiming for", () => {
		// A 32k window: the ladder asks 7,937 against a 9,732 target, which would
		// leave the summary nothing to be written into.
		expect(
			resolvePreserveRecentTokens({
				contextWindow: 32_768,
				messageTargetTokens: 9_732,
			}),
		).toBe(Math.floor(9_732 * 0.6));
	});

	it("yields to an explicit setting", () => {
		expect(
			resolvePreserveRecentTokens({ contextWindow: 1_000_000, override: 4_000 }),
		).toBe(4_000);
	});
});

describe("serializeReasoningWithOutcomes", () => {
	// Reasoning alone reads as a plan, and every plan reads as sound. What makes
	// it a retrospective is the outcome sitting next to it.
	it("pairs each stretch of reasoning with what its call came back as", () => {
		const rendered = serializeReasoningWithOutcomes([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "the range must have moved" },
					{
						type: "tool_use",
						id: "call_1",
						name: "editor",
						input: { path: "game.html" },
					},
				],
				metrics: { outputTokens: 17_901 },
			} as MessageWithMetadata,
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						name: "editor",
						content:
							'{"error":"Editor operation failed: No change: lines 94-98 already reads exactly this way"}',
						is_error: true,
					},
				],
			} as MessageWithMetadata,
		]);

		expect(rendered).toContain("the range must have moved");
		expect(rendered).toContain("editor -> refused: the change was already in the file");
		// The cost, which is the one thing the model cannot read back off its own
		// thinking: whether the turn that felt thorough was the expensive one.
		expect(rendered).toContain("17901 output tokens");
	});

	it("names a loop-guard refusal as its own outcome", () => {
		const rendered = serializeReasoningWithOutcomes([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "try it once more" },
					{ type: "tool_use", id: "c", name: "editor", input: {} },
				],
			} as MessageWithMetadata,
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "c",
						name: "editor",
						content: "No change: …\n\nWarning: you have only 2 strikes left …",
						is_error: true,
					},
				],
			} as MessageWithMetadata,
		]);

		expect(rendered).toContain("refused by the loop guard as an unchanged repeat");
	});

	it("has nothing to say about turns that did not reason", () => {
		expect(
			serializeReasoningWithOutcomes([
				{ role: "user", content: [{ type: "text", text: "fix it" }] },
			] as MessageWithMetadata[]),
		).toBe("");
	});
});

describe("buildThinkingSummaryRequest", () => {
	it("asks the model to revise its standing assessment, not repeat it", () => {
		const request = buildThinkingSummaryRequest({
			previousThinkingSummary: "editing from stale reads cost most of the time",
			reasoningText: "Reasoning: …",
		});

		expect(request).toContain("Carry forward what still holds");
		expect(request).toContain("editing from stale reads cost most of the time");
	});

	it("bans the specifics that belong in the summary", () => {
		expect(buildThinkingSummaryRequest({ reasoningText: "x" })).toContain(
			"No file names, line numbers, code, identifiers or values",
		);
	});

	it("takes a replacement instruction", () => {
		expect(
			buildThinkingSummaryRequest({
				reasoningText: "x",
				promptTemplate: "Be brutal and be brief.",
			}),
		).toContain("Be brutal and be brief.");
	});
});

describe("buildSummaryMessage", () => {
	// The wire rejects it. Reasoning parts are valid only on an assistant
	// message, and the compaction summary is the user turn that replaces the
	// transcript — so a retrospective shipped as a thinking block took down a
	// live run with `AI_TypeValidationError: The messages do not match the
	// ModelMessage[] schema`, with a perfectly good retrospective inside it.
	it("never puts reasoning on the user message the transcript is replaced with", () => {
		const message = buildSummaryMessage({
			summary: "what the task has done",
			fileOps: { readFiles: [], modifiedFiles: [] },
			tokensBefore: 1_000,
			userRunSpan: 1,
			thinkingSummary: "## What worked\n- narrowing the range",
		});

		expect(message.role).toBe("user");
		expect(
			Array.isArray(message.content) ? message.content.map((block) => block.type) : [],
		).toEqual(["text", "text"]);
	});

	it("puts the retrospective first, and says what it is", () => {
		const message = buildSummaryMessage({
			summary: "what the task has done",
			fileOps: { readFiles: [], modifiedFiles: [] },
			tokensBefore: 1_000,
			userRunSpan: 1,
			thinkingSummary: "## What worked\n- narrowing the range",
		});

		const first = Array.isArray(message.content) ? message.content[0] : undefined;
		expect(first?.type === "text" ? first.text : "").toContain("Retrospective");
		expect(first?.type === "text" ? first.text : "").toContain("narrowing the range");
	});

	it("keeps it on the metadata, which is what chains it to the next compaction", () => {
		const message = buildSummaryMessage({
			summary: "s",
			fileOps: { readFiles: [], modifiedFiles: [] },
			tokensBefore: 1,
			userRunSpan: 1,
			generation: 3,
			thinkingSummary: "lessons",
		});

		expect(getCompactionSummaryMetadata(message)?.thinkingSummary).toBe("lessons");
		expect(getCompactionSummaryMetadata(message)?.generation).toBe(3);
	});

	it("is one block when there was no retrospective", () => {
		const message = buildSummaryMessage({
			summary: "s",
			fileOps: { readFiles: [], modifiedFiles: [] },
			tokensBefore: 1,
			userRunSpan: 1,
		});

		expect(Array.isArray(message.content) ? message.content.length : 0).toBe(1);
	});
})
