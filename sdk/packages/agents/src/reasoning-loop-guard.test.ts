import { describe, expect, it } from "vitest";
import {
	contentGivenToModel,
	describeReasoningLoop,
	ReasoningLoopGuard,
	type ReasoningLoopVerdict,
} from "./reasoning-loop-guard";

/** Feed text through the guard in small deltas, the way a stream arrives. */
function stream(
	text: string,
	chunk = 32,
): { verdict: ReasoningLoopVerdict | null; fed: number } {
	const guard = new ReasoningLoopGuard();
	let fed = 0;
	for (let i = 0; i < text.length; i += chunk) {
		const slice = text.slice(i, i + chunk);
		fed += slice.length;
		const v = guard.push(slice);
		if (v) return { verdict: v, fed };
	}
	return { verdict: null, fed };
}

describe("ReasoningLoopGuard", () => {
	it("trips on the mann1x/cline#69 collapse, early", () => {
		// The real shape: two checklist items, the checkbox flipping between
		// runs, repeated until the context window. Not cleanly periodic, which
		// is why an exact-period test alone is not enough.
		const items = [
			"- [ ] Create a new file",
			"- [x] Implement a new feature",
			"- [x] Create a new file",
			"- [ ] Implement a new feature",
		];
		const text = Array.from(
			{ length: 2000 },
			(_, i) => items[i % items.length],
		).join("\n");

		const { verdict, fed } = stream(text);
		expect(verdict?.kind).toBe("low-uniqueness");
		expect(verdict?.distinct).toBeLessThanOrEqual(4);
		// It must not wait for the whole block; the point is to stop early.
		expect(fed).toBeLessThan(8000);
	});

	it("trips on a phrase repeating inside one unbroken line", () => {
		const { verdict } = stream("and I'll do it, ".repeat(600));
		expect(verdict?.kind).toBe("phrase-cycle");
	});

	it("trips on an exactly periodic block of lines", () => {
		const unit = [
			"checking line 90 again",
			"yes it is still unbalanced",
			"let me look once more",
		];
		const text = Array.from(
			{ length: 400 },
			(_, i) => `${unit[i % 3]} ${"x".repeat(20)}`,
		).join("\n");
		const { verdict } = stream(text);
		expect(verdict).not.toBeNull();
	});

	it("leaves long healthy reasoning alone", () => {
		// Agentic reasoning legitimately runs to six figures per turn. Volume is
		// never the signal -- a guard that fired on length would kill good turns.
		const lines: string[] = [];
		for (let i = 0; i < 4000; i++) {
			lines.push(
				`Step ${i}: inspect symbol ${i % 97} in module ${i % 31} and record offset ${i * 7}.`,
			);
		}
		const text = lines.join("\n");
		expect(text.length).toBeGreaterThan(150_000);
		expect(stream(text).verdict).toBeNull();
	});

	it("leaves a legitimately repetitive but rotating list alone", () => {
		const text = Array.from(
			{ length: 600 },
			(_, i) => `- retry attempt ${i % 30}`,
		).join("\n");
		expect(stream(text).verdict).toBeNull();
	});

	it("never judges a short block", () => {
		const text = Array.from(
			{ length: 40 },
			() => "- [x] same line every time",
		).join("\n");
		expect(text.length).toBeLessThan(4000);
		expect(stream(text).verdict).toBeNull();
	});

	it("returns the same verdict once tripped, so a caller cannot act twice", () => {
		const guard = new ReasoningLoopGuard();
		const text = Array.from(
			{ length: 2000 },
			() => "- [x] Create a new file",
		).join("\n");
		let first: ReasoningLoopVerdict | null = null;
		for (let i = 0; i < text.length && !first; i += 64)
			first = guard.push(text.slice(i, i + 64));
		expect(first).not.toBeNull();
		expect(guard.push("anything at all")).toBe(first);
		expect(guard.tripped).toBe(first);
	});

	it("describes the diagnosis without prescribing the consequence", () => {
		const message = describeReasoningLoop({
			kind: "low-uniqueness",
			distinct: 2,
			chars: 4000,
			sample: "- [x] a / - [ ] a",
		});
		expect(message).toContain("2 distinct lines");
		expect(message).toContain("4,000 characters");
		expect(message).not.toMatch(/abort|stopp|cancel/i);
	});
});

describe("repetition that was in what the model was given", () => {
	const feed = (text: string, given: string | undefined, chunk = 4) => {
		const guard = new ReasoningLoopGuard(
			{},
			given === undefined ? {} : { given: () => given },
		);
		for (let i = 0; i < text.length; i += chunk) {
			const verdict = guard.push(text.slice(i, i + chunk));
			if (verdict) return { verdict, at: i + chunk };
		}
		return { verdict: null, at: text.length };
	};
	// Text that does not itself repeat, long enough for the guard to judge.
	const prose = Array.from(
		{ length: 130 },
		(_, i) => `Step ${i}: sound ${i * 7} goes into slot ${i * 3 + 1}.`,
	).join(" ");
	// An MP3's padding, as base64: one character, hundreds of times.
	const padding = "V".repeat(484);
	const base64 = `//uUxAAAAAAAWGluZwAAAA8AAAAG${"TU1N".repeat(3)}${padding}MzLjEwMA`;

	it("is not a loop when the model copies base64 it read", () => {
		const reasoning = `${prose}const SOUND = '${base64}'; Now the editor call.`;
		expect(feed(reasoning, undefined).verdict?.kind).toBe("phrase-cycle");
		expect(feed(reasoning, `{"result":"${base64}"}`).verdict).toBeNull();
	});

	it("is a loop once the model has written more of it than the source holds", () => {
		const runaway = `${prose}const SOUND = '//uUxAAAAAAAWGluZw${"V".repeat(2942)}`;
		const { verdict, at } = feed(runaway, `{"result":"${base64}"}`);
		expect(verdict?.kind).toBe("phrase-cycle");
		// Not at thirteen repeats, and not long after the source's own run.
		const written = at - prose.length;
		expect(written).toBeGreaterThan(484);
		expect(written).toBeLessThan(484 + 200);
	});

	it("does not excuse repetition the source merely mentions once", () => {
		const loop = `${prose}${"ctx.fillText('O2',VIEWPORT_W-80,65);".repeat(80)}`;
		const given = "58 | ctx.fillText('O2',VIEWPORT_W-80,65);\n59 | draw();";
		expect(feed(loop, given).verdict?.kind).toBe("phrase-cycle");
	});

	it("lets the model restate a file whose lines repeat, and no further", () => {
		const row = "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0";
		const file = Array.from({ length: 80 }, (_, i) => `${i + 1} | ${row}`).join(
			"\n",
		);
		const intro = `${Array.from({ length: 90 }, (_, i) => `Row ${i} of the level map holds tile ${i * 5}.`).join("\n")}\n`;
		const restated = `${intro}${`${row}\n`.repeat(80)}So the map is empty.\n`;
		expect(feed(restated, undefined).verdict).not.toBeNull();
		expect(feed(restated, file).verdict).toBeNull();

		const runaway = `${intro}${`${row}\n`.repeat(400)}`;
		const cut = feed(runaway, file);
		expect(cut.verdict).not.toBeNull();
		const lines = runaway.slice(intro.length, cut.at).split("\n").length;
		expect(lines).toBeGreaterThan(80);
		expect(lines).toBeLessThan(80 + 5);
	});

	it("still trips on the model's own reasoning going round", () => {
		const cycle = [
			"Let me reconsider. The deficit is 2 braces.",
			"1. Add 2 opening braces",
			"2. Remove 2 closing braces",
		].join("\n");
		const text = `${prose.replaceAll(". ", ".\n")}\n${`${cycle}\n`.repeat(60)}`;
		const given = "The scanner says line 90 has 2 more `{` than `}`.";
		expect(feed(text, given).verdict).not.toBeNull();
		expect(feed(text, given).at).toBe(feed(text, undefined).at);
	});

	it("reads what the model was given, and not what it wrote", () => {
		const given = contentGivenToModel([
			{
				id: "1",
				role: "user",
				createdAt: 0,
				content: [{ type: "text", text: "embed the sound" }],
			},
			{
				id: "2",
				role: "assistant",
				createdAt: 0,
				content: [{ type: "reasoning", text: "VVVVVVVV" }],
			},
			{
				id: "3",
				role: "tool",
				createdAt: 0,
				content: [
					{
						type: "tool-result",
						toolCallId: "c",
						toolName: "run_commands",
						output: [{ query: "base64", result: "//uUxAAA", success: true }],
					},
				],
			},
		] as never);
		expect(given).toContain("embed the sound");
		expect(given).toContain("//uUxAAA");
		expect(given).not.toContain("VVVVVVVV");
	});
});
