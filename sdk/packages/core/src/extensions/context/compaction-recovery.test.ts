import type * as LlmsProviders from "@cline/llms";
import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";
import { createCompactionJournal } from "./compaction-journal";

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
	reasoningHistoryModeForProvider: () => "all",
}));

async function* chunks(parts: Array<Record<string, unknown>>) {
	for (const part of parts) {
		yield part;
	}
}

/** Replies in order; the last reply repeats once the list runs out. */
function summarizerReplying(texts: string[]) {
	let index = 0;
	const createMessage = vi.fn(() => {
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

/**
 * A realistic window, and the fixture is sized to it deliberately.
 *
 * At 2,000 tokens the no-tail prompt alone takes 1,400 of them and leaves 595
 * for the whole transcript, so the projection reports
 * `budget_unachievable_with_protections` and the compaction declines before a
 * single request is made. That is a true fact about tiny summarizer windows
 * rather than anything these tests are about — see the floor named in
 * `runAgenticCompaction`'s skip warning — and measuring the retry logic against
 * it would only ever measure the floor.
 */
const WINDOW_TOKENS = 32_000;

const messages: MessageWithMetadata[] = [
	{ role: "user", content: "the standing request" },
	...Array.from({ length: 40 }, (_, index) => ({
		role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
		content: `turn ${index} ${"detail ".repeat(420)}`,
	})),
];

function prepare(options: {
	keepRecentMessages?: boolean;
	journal?: ReturnType<typeof createCompactionJournal>;
	logger?: { debug: Mock; log: Mock };
	/**
	 * Leave the recency budget at its default instead of pinning it to 1.
	 *
	 * The pinned value keeps the tail to almost nothing, which is what most of
	 * these tests want and is exactly wrong for the escalation ones: the whole
	 * failure is a *default-sized* tail being unable to fit, so a test that
	 * shrinks the tail first cannot see it.
	 */
	defaultRecencyBudget?: boolean;
}) {
	return createContextCompactionPrepareTurn(
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
				...(options.defaultRecencyBudget ? {} : { preserveRecentTokens: 1 }),
				thinkingSummaryEnabled: false,
				...(options.keepRecentMessages === false
					? { keepRecentMessages: false }
					: {}),
			},
			logger: options.logger,
		},
		options.journal ? { journal: options.journal } : {},
	);
}

async function run(prepareTurn: ReturnType<typeof prepare>) {
	return prepareTurn?.({
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
			info: { id: "mock-model", maxInputTokens: WINDOW_TOKENS },
		},
	});
}

beforeEach(() => {
	createHandlerMock.mockReset();
});

describe("the compaction journal", () => {
	it("keeps the transcript a compaction replaced", async () => {
		// Compaction is the one operation here that destroys its own input.
		// Everything else the model does to state is recoverable; this was not.
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step."]);
		const journal = createCompactionJournal();

		const result = await run(prepare({ journal }));

		expect(result?.messages).toBeDefined();
		expect(journal.entries()).toHaveLength(1);
		expect(journal.restore()).toEqual(messages);
	});

	it("restores to the transcript, not to the summary", async () => {
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step."]);
		const journal = createCompactionJournal();
		await run(prepare({ journal, keepRecentMessages: false }));

		const restored = journal.restore() ?? [];

		expect(restored).toHaveLength(messages.length);
		expect(JSON.stringify(restored)).not.toContain("Context summary");
	});

	it("says whether the entry it is holding was a no-tail compaction", async () => {
		// The risky one. A restore offered for a keep-tail compaction is a
		// convenience; for a no-tail compaction it is the only way back.
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step."]);
		const journal = createCompactionJournal();

		await run(prepare({ journal, keepRecentMessages: false }));

		expect(journal.latest()?.keptRecentMessages).toBe(false);
	});

	it("holds two, so a bad summary built on a bad summary can be unwound", async () => {
		const journal = createCompactionJournal();
		journal.record({
			generation: 1,
			before: [{ role: "user", content: "first" }],
			afterMessageCount: 1,
			strategy: "agentic",
			keptRecentMessages: true,
		});
		journal.record({
			generation: 2,
			before: [{ role: "user", content: "second" }],
			afterMessageCount: 1,
			strategy: "agentic",
			keptRecentMessages: true,
		});
		journal.record({
			generation: 3,
			before: [{ role: "user", content: "third" }],
			afterMessageCount: 1,
			strategy: "agentic",
			keptRecentMessages: true,
		});

		expect(journal.entries()).toHaveLength(2);
		expect(journal.latest(1)).toBeUndefined();
		expect(journal.restore(2)).toEqual([{ role: "user", content: "second" }]);
	});

	it("never puts the journal on the wire", async () => {
		// A journal that reached the model would be the transcript it exists to
		// replace.
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step."]);
		const journal = createCompactionJournal();

		const result = await run(prepare({ journal }));

		expect(JSON.stringify(result?.messages)).not.toContain("turn 0");
	});
});

describe("retrying the summarizer", () => {
	it("retries an empty response rather than ending the compaction", async () => {
		const createMessage = summarizerReplying([
			"   ",
			"## Goal\nThe goal.\n\n## Next\nThe step.",
		]);

		const result = await run(prepare({}));

		expect(createMessage).toHaveBeenCalledTimes(2);
		expect(result?.messages[0]?.metadata?.kind).toBe("compaction_summary");
	});

	it("tells the model the measurement when the summary overran", async () => {
		// The one place length is worth talking about. The prompts carry no
		// length adjective because adjectives are a measured non-lever; a number
		// against a limit is not an adjective, it is a fact the model had no
		// other way to know.
		const createMessage = summarizerReplying([
			`## Goal\n${"over ".repeat(20_000)}`,
			"## Goal\nThe goal.\n\n## Next\nThe step.",
		]);

		await run(prepare({}));

		expect(createMessage.mock.calls.length).toBeGreaterThan(1);
		const secondCall = createMessage.mock.calls[1] as unknown as
			| [string, Array<{ content: string }>]
			| undefined;
		const retry = String(secondCall?.[1]?.[0]?.content ?? "");
		expect(retry).toMatch(/previous attempt was about \d+ tokens/);
		expect(retry).toMatch(/has to fit in \d+/);
		// Never by dropping what cannot be dropped.
		expect(retry).toContain("Keep every section");
		expect(retry).toContain("verbatim and complete");
	});

	it("keeps an overrunning summary rather than losing the compaction", async () => {
		// The budget is a target the retry exists to hit, not a wall worth
		// losing the transcript over. An empty summary is different: there is
		// nothing in it.
		summarizerReplying([`## Goal\n${"over ".repeat(20_000)}`]);

		const result = await run(prepare({}));

		expect(result?.messages[0]?.metadata?.kind).toBe("compaction_summary");
	});
});

describe("a configuration that keeps nothing", () => {
	it("does not quietly run the strategy that keeps everything", async () => {
		// Basic compaction prunes tool results and keeps every message. A user
		// who turned the tail off did so because keeping it was the problem, so
		// substituting basic runs the opposite of what was configured.
		summarizerReplying(["   "]);
		const logger = { debug: vi.fn(), log: vi.fn() };

		const result = await run(prepare({ keepRecentMessages: false, logger }));

		expect(result?.messages).toBeUndefined();
		expect(logger.log).toHaveBeenCalledWith(
			"Agentic compaction produced no result and the tail is disabled; not substituting basic compaction",
			expect.objectContaining({ severity: "warn" }),
		);
	});

	it("still substitutes basic when the tail is the configured behaviour", async () => {
		summarizerReplying(["   "]);
		const logger = { debug: vi.fn(), log: vi.fn() };

		const result = await run(prepare({ logger }));

		expect(result?.messages).toBeDefined();
		expect(logger.log).toHaveBeenCalledWith(
			"Agentic compaction produced no result; falling back to basic compaction",
			expect.objectContaining({ severity: "warn" }),
		);
	});
});

describe("dropping the tail when keeping it did not fit", () => {
	/**
	 * A transcript whose individual messages are larger than the window.
	 *
	 * This is the shape that defeats a recency budget, and the reason is
	 * structural: the tail is whole messages and its floor is one message, so
	 * when a single message exceeds the window no budget can produce a tail
	 * that fits. Measured on a 32k window at 4x overshoot, keeping the tail
	 * returned 34,297 tokens — over the window it was compacting for — while
	 * the no-tail cut on the same transcript returned 17,217.
	 *
	 * Four times, specifically, because the bands differ and only this one is
	 * what the escalation is for. Below it both cuts fit and there is nothing
	 * to escalate. Above roughly eight times neither cut can run at all: the
	 * material stops projecting into the summarizer's input budget, agentic
	 * declines whichever tail it was asked for, and basic takes over and
	 * returns something still over the window. That band belongs to overflow
	 * recovery, not to this, and writing a test for it here would assert a path
	 * that does not exist.
	 */
	const OVERSHOOT = 4;

	function oversizedTranscript(): MessageWithMetadata[] {
		const turns = 10;
		// Seven characters per `detail `, four characters per token.
		const repeats = Math.floor((WINDOW_TOKENS * 4 * OVERSHOOT) / turns / 7);
		return [
			{ role: "user", content: "the standing request" },
			...Array.from({ length: turns }, (_, index) => ({
				role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
				content: `turn ${index} ${"detail ".repeat(repeats)}`,
			})),
		];
	}

	async function runOversized(logger?: { debug: Mock; log: Mock }) {
		const big = oversizedTranscript();
		const notices: Array<[string, Record<string, unknown>]> = [];
		const result = await prepare({ logger, defaultRecencyBudget: true })?.({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages: big,
			apiMessages: big,
			model: {
				id: "mock-model",
				provider: "anthropic",
				info: { id: "mock-model", maxInputTokens: WINDOW_TOKENS },
			},
			emitStatusNotice: (name: string, detail?: Record<string, unknown>) => {
				notices.push([name, detail ?? {}]);
			},
		});
		return { result, notices };
	}

	it("escalates to the no-tail cut, and says so", async () => {
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step."]);
		const logger = { debug: vi.fn(), log: vi.fn() };

		const { result, notices } = await runOversized(logger);

		expect(result?.messages).toBeDefined();
		expect(logger.log).toHaveBeenCalledWith(
			"Compaction kept the tail and stayed over the trigger; retrying without it",
			expect.objectContaining({ severity: "warn" }),
		);
		expect(notices.map(([name]) => name)).toContain("compaction-tail-dropped");
	});

	it("gets the transcript under the trigger, which keeping the tail did not", async () => {
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step."]);

		const { notices } = await runOversized();

		const dropped = notices.find(
			([name]) => name === "compaction-tail-dropped",
		)?.[1];
		expect(dropped).toBeDefined();
		expect(Number(dropped?.noTailTokens)).toBeLessThan(
			Number(dropped?.keptTailTokens),
		);
		expect(Number(dropped?.noTailTokens)).toBeLessThanOrEqual(
			Number(dropped?.messageTriggerTokens),
		);
	});

	it("leaves an ordinary compaction alone", async () => {
		// The escalation costs a second summarizer call, so it fires on the
		// transcript that is still over the *trigger* -- over the target merely
		// means the compaction was disappointing, and paying a request for that
		// would spend one on a transcript that is going to be fine.
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step."]);
		const logger = { debug: vi.fn(), log: vi.fn() };

		const result = await run(prepare({ logger }));

		expect(result?.messages).toBeDefined();
		expect(logger.log).not.toHaveBeenCalledWith(
			"Compaction kept the tail and stayed over the trigger; retrying without it",
			expect.anything(),
		);
	});

	it("keeps the oversized result when the no-tail cut declines", async () => {
		// An oversized transcript beats no transcript. The escalation is an
		// improvement it may fail to make, never a way to end up with nothing.
		summarizerReplying(["## Goal\nThe goal.\n\n## Next\nThe step.", "   "]);

		const { result } = await runOversized();

		expect(result?.messages).toBeDefined();
	});
});
