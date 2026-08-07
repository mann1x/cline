import { describe, expect, it } from "vitest";
import { measureRequestInputChars } from "./tokens";

/** A transcript shaped like the live one: reasoning is most of it. */
function transcript(reasoningBlocks: number) {
	const messages: { role: string; content: { type: string; text: string }[] }[] =
		[{ role: "user", content: [{ type: "text", text: "fix the page" }] }];
	for (let i = 0; i < reasoningBlocks; i += 1) {
		messages.push({
			role: "assistant",
			content: [
				{ type: "reasoning", text: "t".repeat(10_000) },
				{ type: "text", text: "s".repeat(200) },
			],
		});
		messages.push({ role: "user", content: [{ type: "text", text: "next" }] });
	}
	return messages as never;
}

describe("measuring a request the provider will trim", () => {
	it("counts only the reasoning that will be sent", () => {
		const messages = transcript(5);
		const all = measureRequestInputChars({ messages });
		const last = measureRequestInputChars({ messages }, {
			reasoningHistory: "last",
		});

		// Four of the five blocks are dropped before the wire.
		expect(all - last).toBeGreaterThan(4 * 10_000 - 100);
		expect(last).toBeLessThan(all / 3);
	});

	it("keeps the last reasoning, not the last message", () => {
		// The final message is a tool result, so "the last message" would drop
		// every block — including the one the provider does send.
		const messages = transcript(2);
		const kept = measureRequestInputChars({ messages }, {
			reasoningHistory: "last",
		});

		expect(kept).toBeGreaterThan(10_000);
	});

	it("drops all of it when the provider sends none", () => {
		const messages = transcript(3);
		const none = measureRequestInputChars({ messages }, {
			reasoningHistory: "none",
		});

		expect(none).toBeLessThan(2_000);
	});

	it("is unchanged for providers that send the whole history", () => {
		const messages = transcript(3);

		expect(measureRequestInputChars({ messages }, { reasoningHistory: "all" })).toBe(
			measureRequestInputChars({ messages }),
		);
	});

	it("does not let the error track how much the model thought", () => {
		// The defect, stated as a property: two transcripts with the same content
		// on the wire must measure the same, however much thinking was retained
		// behind them. Measured live, this varied 32%-61% turn to turn and became
		// the estimator's entire error.
		const thinkHeavy = measureRequestInputChars({ messages: transcript(8) }, {
			reasoningHistory: "last",
		});
		const thinkLight = measureRequestInputChars({ messages: transcript(1) }, {
			reasoningHistory: "last",
		});
		const perTurnOverhead = 400;

		expect(thinkHeavy - thinkLight).toBeLessThan(7 * perTurnOverhead);
	});
});
