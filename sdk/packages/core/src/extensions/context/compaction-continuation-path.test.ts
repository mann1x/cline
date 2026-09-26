import type * as LlmsProviders from "@cline/llms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";
import type {
	ContinuationCall,
	ContinuationCallResult,
	PrepareContinuationInput,
} from "./continuation-compaction";

const createHandlerMock = vi.fn();
const modelCalls: ContinuationCall[] = [];
const modelBehaviour: {
	fail?: (call: ContinuationCall) => Error | undefined;
} = {};

vi.mock("@cline/llms", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
	reasoningHistoryModeForProvider: () => "all",
}));

// The continuation's one model seam, so no request leaves the test.
vi.mock("./continuation-compaction", async (importOriginal) => {
	const actual =
		(await importOriginal()) as typeof import("./continuation-compaction");
	return {
		...actual,
		prepareCompactionContinuation: (input: PrepareContinuationInput) =>
			actual.prepareCompactionContinuation({
				...input,
				sleep: async () => {},
				model: async (
					call: ContinuationCall,
				): Promise<ContinuationCallResult> => {
					modelCalls.push(call);
					const failure = modelBehaviour.fail?.(call);
					if (failure) {
						throw failure;
					}
					return {
						text:
							call.purpose === "writer"
								? "## Goal\nShip the feature.\n\n<<<HALFWAY>>>\n\n## Next\n- Finish it."
								: "## Goal\nShip the feature; finish it next.",
						reasoningChars: 0,
						timings: { engine: "ollama", promptTokens: 900, cachedTokens: 860 },
					};
				},
			}),
	};
});

function summarizerHandler(
	text = "## Goal\nShip it (as text)\n\n## Next\n- Finish",
) {
	createHandlerMock.mockReturnValue({
		createMessage: vi.fn(() =>
			(async function* () {
				yield { type: "text", id: "s", text };
				yield { type: "done", id: "s", success: true };
			})(),
		),
	});
}

async function compact(
	providerConfig: Record<string, unknown>,
	maxInputTokens = 3_000,
	log = vi.fn(),
) {
	const messages: LlmsProviders.Message[] = [
		{ role: "user", content: "Original task" },
		{ role: "assistant", content: `Old answer ${"x ".repeat(3000)}` },
		{ role: "user", content: "Older follow-up" },
		{ role: "assistant", content: `Older response ${"y ".repeat(3000)}` },
		{ role: "user", content: "Latest request" },
	];
	const providerId = String(providerConfig.providerId);
	const prepareTurn = createContextCompactionPrepareTurn({
		providerId,
		modelId: "mock-model",
		providerConfig: {
			modelId: "mock-model",
			...providerConfig,
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
			provider: providerId,
			info: { id: "mock-model", maxInputTokens },
		},
	});
	const line = log.mock.calls
		.map((call) => String(call[0]))
		.find((text) => text.startsWith("[compaction] path="));
	return { result, line, log };
}

beforeEach(() => {
	modelCalls.length = 0;
	modelBehaviour.fail = undefined;
	createHandlerMock.mockReset();
	summarizerHandler();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("compaction on a prompt-cache provider", () => {
	it("writes the summary as the session's next turn and never pastes the transcript", async () => {
		const { result, line } = await compact({ providerId: "ollama" });

		expect(result?.messages[0]?.metadata?.kind).toBe("compaction_summary");
		expect(modelCalls.map((call) => call.purpose)).toEqual([
			"writer",
			"critic",
			"critic",
			"synthesizer",
		]);
		expect(modelCalls[0]?.systemPrompt).toBe("You are helpful.");
		expect(createHandlerMock).not.toHaveBeenCalled();
		// Ollama's prompt_eval_count counts the cache: 900 - 860 evaluated.
		expect(line).toMatch(
			/^\[compaction\] path=continuation \(prompt-cache continuation\) prefill=\d+/,
		);
		expect(line).toContain("cache_n writer=860/");
	});

	// A keep-tail result still over the trigger is rescued without the tail.
	// The continuation has given its cells back by then: the rescue goes as
	// text, and the line says so.
	it("counts a no-tail rescue in the same line", async () => {
		const { line } = await compact({ providerId: "ollama" }, 10);

		expect(line).toContain(
			"path=continuation (prompt-cache continuation; no-tail rescue as text)",
		);
		expect(createHandlerMock).toHaveBeenCalled();
	});

	it("compacts from the transcript when the writer cannot answer", async () => {
		modelBehaviour.fail = (call) =>
			call.purpose === "writer" ? new Error("400 template error") : undefined;
		const { result, line } = await compact({ providerId: "ollama" });

		expect(result?.messages[0]?.metadata?.kind).toBe("compaction_summary");
		expect(createHandlerMock).toHaveBeenCalled();
		expect(line).toContain(
			"path=fallback (continuation wrote no usable summary; transcript as text)",
		);
	});

	it("compacts from the transcript when the setting is off", async () => {
		const { line } = await compact({
			providerId: "ollama",
			polykv: { continuationCompaction: false },
		});

		expect(modelCalls).toEqual([]);
		expect(createHandlerMock).toHaveBeenCalled();
		expect(line).toContain("path=fallback (switched off");
	});

	it("keeps the transcript-as-text path on a hosted API", async () => {
		const { line } = await compact({ providerId: "anthropic" });

		expect(modelCalls).toEqual([]);
		expect(line).toContain("path=fallback (anthropic keeps no prefix");
	});
});
