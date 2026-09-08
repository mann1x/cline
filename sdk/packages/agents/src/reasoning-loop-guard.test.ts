import { describe, expect, it } from "vitest";
import {
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
