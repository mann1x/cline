import type { MessageWithMetadata } from "@cline/shared";
import { observeRequestTokens, resetTokenCalibration } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildCappedThinkingRequest,
	createCappedThinkingPrepareTurn,
	findCappedThinkingIndex,
	locateCappedThinking,
} from "./capped-thinking";

/**
 * Configs the condenser asked for a handler with, in order.
 *
 * On a global rather than a module binding: `vi.mock` factories are hoisted
 * above this file's declarations, so a module-level array is not necessarily
 * the one the factory closes over.
 */
const CAPTURED = Symbol.for("cline.test.summarizerConfigs");
function summarizerConfigs(): Array<Record<string, unknown>> {
	const container = globalThis as unknown as Record<symbol, unknown>;
	if (!container[CAPTURED]) {
		container[CAPTURED] = [];
	}
	return container[CAPTURED] as Array<Record<string, unknown>>;
}

vi.mock("@cline/llms", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createHandlerAsync: async (config: Record<string, unknown>) => {
		const container = globalThis as unknown as Record<symbol, unknown>;
		const key = Symbol.for("cline.test.summarizerConfigs");
		if (!container[key]) {
			container[key] = [];
		}
		(container[key] as Array<Record<string, unknown>>).push(config);
		return {
			createMessage: async function* () {
				yield { type: "text", text: "the note" };
			},
		};
	},
}));

/**
 * Measured on a live session: the same ground covered a dozen times, each pass
 * reaching "this is the final plan" and then "wait, I just realised…", each one
 * ending at the same cap, each one producing a differently-malformed call
 * because writing the arguments was the part that got cut.
 */
describe("finding the turn that ran out of thinking budget", () => {
	const turn = (thinkingChars: number): MessageWithMetadata =>
		({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "x".repeat(thinkingChars) },
				{ type: "tool_use", id: "c", name: "editor", input: {} },
			],
		}) as MessageWithMetadata;

	/** A turn that also reported what the provider counted for it. */
	const measuredTurn = (
		thinkingChars: number,
		outputTokens: number,
	): MessageWithMetadata =>
		({
			...turn(thinkingChars),
			metrics: { outputTokens },
		}) as MessageWithMetadata;

	// 16,000 tokens of allowance at the ~2.6 chars per token this model reasons
	// at is roughly 41,600 characters.
	const budget = 16_000;

	afterEach(() => {
		resetTokenCalibration();
	});

	it("recognises a turn that spent its whole allowance", () => {
		expect(findCappedThinkingIndex([turn(45_000)], budget)).toBe(0);
	});

	it("leaves an ordinary turn alone", () => {
		expect(findCappedThinkingIndex([turn(2_000)], budget)).toBe(-1);
	});

	it("only ever looks at the most recent turn", () => {
		// An older capped turn has already had its consequences play out, and
		// rewriting history the model has since acted on is a different and more
		// dangerous idea than helping it continue.
		expect(findCappedThinkingIndex([turn(45_000), turn(500)], budget)).toBe(-1);
	});

	it("believes the provider's own count over the character ratio", () => {
		// Same reasoning, two different reported usages. The ratio is a fallback
		// for turns that reported nothing; where the provider said how many
		// tokens it produced, that is the answer, and two turns with identical
		// text can land on either side of the cap because of it.
		expect(findCappedThinkingIndex([measuredTurn(45_000, 16_000)], budget)).toBe(0);
		expect(findCappedThinkingIndex([measuredTurn(45_000, 5_000)], budget)).toBe(-1);
	});

	it("matches a Modelfile message however its line breaks survived the trip", () => {
		// `v7-coder_tb` writes its message as one quoted line of `\n` escapes
		// opening with two blank lines. The model's own copy of it is whatever
		// the server streamed, which kept neither the leading blanks nor,
		// between the two sentences, the break. Comparing the layouts rather
		// than the words denied every capped turn in a whole run.
		const message =
			"\n\nI have used my thinking budget. I must stop analysing now and act on what I have: make the tool call, or give a short final answer if no call is needed.\nI'll be more terse and concise now and maybe I need to consider a different approach.\n"
		const thinking =
			`${"x".repeat(30_000)}\nI have used my thinking budget. I must stop analysing now and act on what I have: make the tool call, or give a short final answer if no call is needed.I'll be more terse and concise now and maybe I need to consider a different approach.`
		const capped = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking },
				{ type: "tool_use", id: "c", name: "editor", input: {} },
			],
		} as MessageWithMetadata

		expect(
			findCappedThinkingIndex([capped], budget, { budgetMessage: message.trim() }),
		).toBe(0)
	})

	it("looks for the longest line of a message, not its first", () => {
		// A message typed into the settings box can open with anything, and a
		// short opener is a phrase ordinary reasoning also uses.
		const message = "Stop.\nYou have spent the thinking budget you were given for this turn."
		const innocent = turn(45_000)

		expect(findCappedThinkingIndex([innocent], budget, { budgetMessage: message })).toBe(-1)
	})

	it("says why it found nothing", () => {
		const message = "You have spent the thinking budget you were given for this turn."

		expect(locateCappedThinking([turn(45_000)], budget, { budgetMessage: message })).toMatchObject({
			index: -1,
			reason: "budget-message-absent",
			thinkingChars: 45_000,
		})
		expect(locateCappedThinking([turn(2_000)], budget)).toMatchObject({
			index: -1,
			reason: "under-budget",
		})
		expect(locateCappedThinking([], budget)).toMatchObject({ index: -1, reason: "no-assistant-turn" })
		expect(locateCappedThinking([turn(45_000)], undefined)).toMatchObject({ index: -1, reason: "no-budget" })
	})

	it("stands down when no allowance is known", () => {
		expect(findCappedThinkingIndex([turn(45_000)], undefined)).toBe(-1);
		expect(findCappedThinkingIndex([turn(45_000)], 0)).toBe(-1);
	});

	it("steps over the half of a turn that carries only the call", () => {
		// A turn reaches the transcript as its reasoning and its call, and
		// depending on how it was assembled those are one message or two.
		// Stopping at the half without the reasoning meant never finding a
		// capped turn at all.
		const callOnly = {
			role: "assistant",
			content: [{ type: "tool_use", id: "c", name: "editor", input: {} }],
		} as MessageWithMetadata;

		expect(locateCappedThinking([turn(45_000), callOnly], budget)).toMatchObject({
			index: 0,
			skippedFragments: 1,
		});
	});

	it("still stops at a turn that answered without reasoning", () => {
		// Text means it answered, and an answered turn supersedes whatever came
		// before it — which is the whole reason only the most recent counts.
		const answered = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
		} as MessageWithMetadata;

		expect(locateCappedThinking([turn(45_000), answered], budget)).toMatchObject({
			index: -1,
			reason: "turn-did-not-reason",
		});
	});

});

describe("the continuation note's request", () => {
	it("leads with what was ruled out, which is what stops the next pass", () => {
		const request = buildCappedThinkingRequest({
			thinking: "I should try old_text again",
			outcomes: [
				{
					name: "editor",
					input: "path",
					result: "No change: already reads that way",
				},
			],
		});

		expect(request).toContain("## Ruled out");
		expect(request).toContain("I should try old_text again");
		expect(request).toContain("No change: already reads that way");
	});

	it("says so when the budget ran out before any call was made", () => {
		expect(
			buildCappedThinkingRequest({ thinking: "…", outcomes: [] }),
		).toContain("You made no tool call before the budget ran out.");
	});

	it("takes a replacement instruction", () => {
		expect(
			buildCappedThinkingRequest({
				thinking: "…",
				outcomes: [],
				promptTemplate: "Two lines, no more.",
			}),
		).toContain("Two lines, no more.");
	});
});

/**
 * The detector was dead for its whole first life, and the reason was what it
 * compared against rather than how it compared. These pin both halves of the
 * fix.
 */
describe("what the budget is measured against", () => {
	afterEach(() => {
		resetTokenCalibration();
	});

	const cappedTurn = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "x".repeat(43_000) },
			{ type: "tool_use", id: "c", name: "editor", input: {} },
		],
		metrics: { outputTokens: 16_400 },
	} as MessageWithMetadata;

	it("survives a request-wide ratio calibrated on JSON and code", () => {
		// The live failure. A session measured 4.2 characters per token across
		// whole serialized requests, and reasoning at that rate turned a turn
		// that had spent all 16,000 of its tokens into ~10,300 — below the
		// 14,400 line, on every one of nearly 300 capped requests.
		observeRequestTokens(420_000, 100_000);

		expect(findCappedThinkingIndex([cappedTurn], 16_000)).toBe(0);
	});

	it("uses the turn's own reported cost rather than any ratio at all", () => {
		// Nothing here needs a chars-per-token assumption: the provider counted
		// 16,400 output tokens for what this turn wrote, and the thinking is
		// effectively all of it.
		const noRatioNeeded = {
			...cappedTurn,
			content: [{ type: "thinking", thinking: "x".repeat(1_000) }],
			metrics: { outputTokens: 15_000 },
		} as MessageWithMetadata;

		expect(findCappedThinkingIndex([noRatioNeeded], 16_000)).toBe(0);
	});

	it("does not read a long tool call as a long think", () => {
		// The share matters: a turn whose output went into arguments rather than
		// reasoning did not run out of thinking budget, however many tokens it
		// cost.
		const toolHeavy = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "x".repeat(1_000) },
				{
					type: "tool_use",
					id: "c",
					name: "editor",
					input: { new_text: "y".repeat(60_000) },
				},
			],
			metrics: { outputTokens: 16_400 },
		} as MessageWithMetadata;

		expect(findCappedThinkingIndex([toolHeavy], 16_000)).toBe(-1);
	});

	it("falls back to the reasoning ratio when the turn reported nothing", () => {
		const unreported = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "x".repeat(43_000) }],
		} as MessageWithMetadata;

		expect(findCappedThinkingIndex([unreported], 16_000)).toBe(0);
	});
});

/**
 * The measurement is good and not certain: it cannot tell which cap stopped a
 * turn, and it falls back to a ratio where a turn reported no usage. Where the
 * session knows what the server appends — Cline set it, or Ollama reported the
 * model's own — that is not an inference at all, so it settles the question in
 * both directions.
 */
describe("confirming against the server's own budget message", () => {
	const message =
		"\n\nI have used my thinking budget. I must stop analysing now and act on what I have.\n";

	const turnEnding = (tail: string): MessageWithMetadata =>
		({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `${"x".repeat(43_000)}${tail}` },
				{ type: "tool_use", id: "c", name: "editor", input: {} },
			],
			metrics: { outputTokens: 16_400 },
		}) as MessageWithMetadata;

	it("confirms a turn whose reasoning ends with it", () => {
		expect(
			findCappedThinkingIndex([turnEnding(message)], 16_000, {
				budgetMessage: message,
			}),
		).toBe(0);
	});

	it("denies a long turn that the server did not cut", () => {
		// Without this the measurement alone would call it capped — it is long
		// enough — but the server says otherwise, and the server is right.
		expect(
			findCappedThinkingIndex([turnEnding("")], 16_000, {
				budgetMessage: message,
			}),
		).toBe(-1);
	});

	it("ignores a mention of the budget in the middle of the reasoning", () => {
		const discussed = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `${message}${"x".repeat(43_000)}`,
				},
			],
			metrics: { outputTokens: 16_400 },
		} as MessageWithMetadata;

		expect(
			findCappedThinkingIndex([discussed], 16_000, { budgetMessage: message }),
		).toBe(-1);
	});

	it("measures when no message is configured anywhere", () => {
		expect(findCappedThinkingIndex([turnEnding("")], 16_000, {})).toBe(0);
		expect(
			findCappedThinkingIndex([turnEnding("")], 16_000, {
				budgetMessage: "  ",
			}),
		).toBe(0);
	});
});

/**
 * A feature that silently does nothing is indistinguishable from one that is
 * working and has nothing to do. This one stood down on every session for a
 * missing provider config — reading a field the host never sets — and produced
 * no note, no failure and no log through a run where the cap fired on 288
 * requests. The only defence is saying so.
 */
describe("standing down", () => {
	const logger = () => {
		const lines: string[] = [];
		return {
			lines,
			logger: { log: () => {}, debug: (line: string) => lines.push(line) },
		};
	};

	it("says why when it has no provider config", () => {
		const { lines, logger: log } = logger();

		const result = createCappedThinkingPrepareTurn(undefined, {
			budgetTokens: 16_000,
			logger: log as never,
		});

		expect(result).toBeUndefined();
		expect(lines.join("\n")).toContain("no provider config");
	});

	it("says so when it is switched off", () => {
		const { lines, logger: log } = logger();

		createCappedThinkingPrepareTurn(undefined, {
			enabled: false,
			providerConfig: { providerId: "ollama", modelId: "m" } as never,
			logger: log as never,
		});

		expect(lines.join("\n")).toContain("is off");
	});

	it("says when it is armed, and with what", () => {
		const { lines, logger: log } = logger();

		createCappedThinkingPrepareTurn(undefined, {
			budgetTokens: 16_000,
			budgetMessage: "I have used my thinking budget.",
			providerConfig: { providerId: "ollama", modelId: "m" } as never,
			logger: log as never,
		});

		expect(lines.join("\n")).toContain("armed at 16000 thinking tokens");
		expect(lines.join("\n")).toContain("budget message");
	});
});

/**
 * The note has to reach the transcript, not only the log. `prepareTurn` runs
 * inside the request pipeline and `emitStatusNotice` is the one channel out of
 * it — the same one compaction reports its dividers through.
 */
describe("reporting the note", () => {
	it("emits it so the transcript can show it", async () => {
		const notices: { message: string; metadata?: Record<string, unknown> }[] =
			[];
		const messages = [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "x".repeat(43_000) }],
				metrics: { outputTokens: 16_400 },
			},
		] as never[];

		const prepareTurn = createCappedThinkingPrepareTurn(undefined, {
			budgetTokens: 16_000,
			providerConfig: { providerId: "ollama", modelId: "m" } as never,
			summarizer: { maxOutputTokens: 700 } as never,
		});

		// The condenser needs a model call to write the note; without one it
		// logs and leaves the reasoning alone, which is the path this asserts is
		// *not* silently taken when a note does exist.
		expect(prepareTurn).toBeDefined();
		await (
			prepareTurn as unknown as (input: {
				messages: unknown[];
				emitStatusNotice: (
					message: string,
					metadata?: Record<string, unknown>,
				) => void;
			}) => Promise<unknown>
		)({
			messages,
			emitStatusNotice: (message, metadata) =>
				notices.push({ message, metadata }),
		});

		// Either a note was produced and reported, or the model call failed and
		// nothing was — but never a note that exists and is not reported.
		for (const notice of notices) {
			expect(notice.message).toBe("thinking-condensed");
			expect(typeof notice.metadata?.note).toBe("string");
			expect(notice.metadata?.kind).toBe("capped_thinking");
		}
	});
});

describe("what the condenser asks the summariser for", () => {
	afterEach(() => {
		summarizerConfigs().length = 0;
		resetTokenCalibration();
	});

	it("sends no output cap of its own", async () => {
		// Cleared here, not in `afterEach`: earlier tests in this file drive the
		// same condenser and their calls are captured too.
		summarizerConfigs().length = 0;
		// A fixed 700-token cap was the whole failure. Against a template that
		// reasons whatever the request asks for, the summariser spent the entire
		// budget thinking and returned one usage chunk with no text -- measured
		// three times running, on thinks of 22,011, 19,007 and 39,544 chars.
		// Unset, the cap resolves from the window like any other turn: large
		// enough to survive a forced think, and already scaled to the session.
		const budgetMessage = "I have used my thinking budget.";
		const prepareTurn = createCappedThinkingPrepareTurn(undefined, {
			enabled: true,
			budgetTokens: 16_000,
			budgetMessage,
			providerConfig: { providerId: "ollama", modelId: "m" },
		});
		expect(prepareTurn).toBeDefined();

		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: `${"x".repeat(45_000)}\n${budgetMessage}`,
					},
				],
			},
		] as unknown as MessageWithMetadata[];

		await (
			prepareTurn as unknown as (input: {
				messages: MessageWithMetadata[];
			}) => Promise<unknown>
		)({ messages });

		expect(summarizerConfigs()).toHaveLength(1);
		const config = summarizerConfigs()[0];
		expect(config).not.toHaveProperty("maxOutputTokens");
		// The note needs no reasoning of its own, and asking for it is what left
		// no room for the note.
		expect(config.thinking).toBe(false);
		// And it still must not speak for the session.
		expect(config.auxiliary).toBe(true);
	});
});
