import type * as LlmsProviders from "@cline/llms";
import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";
import { getCompactionSummaryMetadata } from "./compaction-shared";

// A compaction's summary is the session's only record of what it folded.
// claude-hooks measured two ways it invents (compaction-v7, qwen3.6 27B):
// steps the session never took, cited past the record, and tables of
// files no call opened. These drive the whole compaction with a scripted
// writer and check what the next turn would read.

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
	reasoningHistoryModeForProvider: () => "all",
}));

async function* chunks(parts: Array<Record<string, unknown>>) {
	for (const part of parts) yield part;
}

function summarizerReplying(texts: string[]) {
	let index = 0;
	const createMessage = vi.fn((_system: string, _request: unknown) => {
		const text = texts[Math.min(index, texts.length - 1)] ?? "";
		index += 1;
		return chunks([
			{ type: "text", id: "s", text },
			{ type: "done", id: "s", success: true },
		]);
	});
	createHandlerMock.mockReturnValue({ createMessage });
	return createMessage;
}

const WINDOW_TOKENS = 32_000;

const TASK = "Audit every module except `config/limits.py`.";

const messages: MessageWithMetadata[] = [
	{ role: "user", content: TASK },
	{
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "ls",
				name: "list_files",
				input: { path: "src/admin" },
			},
		],
	},
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "ls",
				name: "list_files",
				content:
					"src/admin/keeper.py\nsrc/admin/registry.py\nsrc/admin/slot.py",
			},
		],
	},
	{
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "k0",
				name: "read_files",
				input: { files: [{ path: "src/admin/keeper.py" }] },
			},
		],
	},
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "k0",
				name: "read_files",
				content: "WEIGHT = 1\nSPILL_TARGET = 2",
			},
		],
	},
	...Array.from({ length: 40 }, (_, index) => ({
		role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
		content: `turn ${index} ${"detail ".repeat(420)}`,
	})),
];

const TABLE = [
	"## Goal",
	"Audit the modules.",
	"",
	"## Progress",
	"I listed src/admin [#1] and read the keeper module [#2].",
	"",
	"*   `src/admin/keeper.py`: `weight`, `spill_target`",
	"*   `src/admin/registry.py`: `hold_epoch`, `retention_class`",
	"*   `src/admin/slot.py`: `lineage`, `fence_token`",
	"The task excludes `config/limits.py`.",
].join("\n");

const FORECAST = `${TABLE}\n\nThen I read the cluster modules. [#5-7]`;

function prepare() {
	return createContextCompactionPrepareTurn({
		providerId: "anthropic",
		modelId: "mock-model",
		providerConfig: {
			providerId: "anthropic",
			modelId: "mock-model",
		} as LlmsProviders.ProviderConfig,
		compaction: {
			enabled: true,
			strategy: "agentic",
			councilEnabled: false,
			preserveRecentTokens: 1,
			thinkingSummaryEnabled: false,
			keepRecentMessages: false,
		},
	});
}

async function run(transcript: MessageWithMetadata[] = messages) {
	return prepare()?.({
		agentId: "agent-1",
		conversationId: "conv-1",
		parentAgentId: null,
		iteration: 1,
		abortSignal: new AbortController().signal,
		systemPrompt: "You are helpful.",
		tools: [],
		messages: transcript,
		apiMessages: transcript,
		model: {
			id: "mock-model",
			provider: "anthropic",
			info: { id: "mock-model", maxInputTokens: WINDOW_TOKENS },
		},
	});
}

function summaryOf(result: Awaited<ReturnType<typeof run>>) {
	const summary = result?.messages?.find(
		(message) => getCompactionSummaryMetadata(message) !== undefined,
	);
	expect(summary).toBeDefined();
	return {
		metadata: getCompactionSummaryMetadata(summary as MessageWithMetadata),
		text: JSON.stringify(summary?.content),
	};
}

const requestText = (call: unknown[] | undefined) => JSON.stringify(call?.[1]);

beforeEach(() => {
	createHandlerMock.mockReset();
});

describe("a compaction that invents", () => {
	it("numbers each call in the writer's transcript as the key numbers it", async () => {
		const writer = summarizerReplying([TABLE]);
		await run();
		const request = requestText(writer.mock.calls[0]);
		expect(request).toContain("#1 list_files(");
		expect(request).toContain("#2 read_files(");
	});

	it("re-asks a writer that narrated steps past the record, with the numbers", async () => {
		const writer = summarizerReplying([FORECAST, TABLE]);
		const { text } = summaryOf(await run());
		expect(writer).toHaveBeenCalledTimes(2);
		expect(requestText(writer.mock.calls[1])).toContain(
			"cited #5–#7. Only #1–#2 happened",
		);
		expect(text).not.toContain("cluster");
	});

	it("cuts the invented step that is left after the last attempt", async () => {
		const writer = summarizerReplying([FORECAST]);
		const { text } = summaryOf(await run());
		expect(writer).toHaveBeenCalledTimes(3);
		expect(text).not.toContain("cluster");
		expect(text).toContain("keeper module");
	});

	it("keeps the rows it read, names the rest, and carries what was seen", async () => {
		summarizerReplying([TABLE]);
		const { text, metadata } = summaryOf(await run());
		expect(text).toContain("`src/admin/keeper.py`: `weight`");
		expect(text).not.toContain("hold_epoch");
		expect(text).not.toContain("fence_token");
		// Only listed: named, never described.
		expect(text).toContain("Not yet read (2 lines");
		expect(text).toContain("`src/admin/registry.py`, `src/admin/slot.py`");
		// The task names it: never cut.
		expect(text).toContain("The task excludes `config/limits.py`.");
		expect(metadata?.seenFiles).toContain("src/admin/keeper.py");
		expect(metadata?.seenFiles).not.toContain("src/admin/registry.py");
	});

	it("carries what was seen to the next compaction", async () => {
		summarizerReplying([TABLE]);
		const first = await run();
		// The next fold reads registry.py; the writer carries the first
		// fold's keeper row along with it.
		const second: MessageWithMetadata[] = [
			...(first?.messages ?? []),
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "k9",
						name: "read_files",
						input: { files: [{ path: "src/admin/registry.py" }] },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "k9",
						name: "read_files",
						content: "HOLD = 3",
					},
				],
			},
			...Array.from({ length: 40 }, (_, index) => ({
				role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
				content: `again ${index} ${"detail ".repeat(420)}`,
			})),
		];
		summarizerReplying([TABLE]);
		const { text, metadata } = summaryOf(await run(second));
		expect(metadata?.generation).toBe(2);
		expect(text).toContain("keeper.py`: `weight`");
		expect(text).toContain("registry.py`: `hold_epoch`");
		expect(text).not.toContain("fence_token");
		expect(metadata?.seenFiles).toEqual(
			expect.arrayContaining(["src/admin/keeper.py", "src/admin/registry.py"]),
		);
	});
});
