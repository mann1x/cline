import { describe, expect, it } from "vitest";
import {
	buildToolArgumentLoopNudge,
	ToolArgumentLoopGuard,
} from "./tool-argument-loop-guard";

// The f099u loop (pandorum, 2026-10-22): one script written out again and
// again inside a single `editor` call, each copy a little off the last, so no
// exact period ever held.

/** A script of `n` distinct long lines; copy `c` changes one of them. */
function script(n: number, copy: number): string {
	return Array.from({ length: n }, (_, i) =>
		i === copy % n
			? `    const value${i} = compute(${i}, state.level, ${copy});`
			: `    const value${i} = compute(${i}, state.level);`,
	).join("\n");
}

/** Feed `text` in pieces the size a stream delivers, until a verdict. */
function feed(guard: ToolArgumentLoopGuard, text: string) {
	for (let at = 0; at < text.length; at += 64) {
		const found = guard.push("call_1", text.slice(at, at + 64), "editor");
		if (found) return { found, at };
	}
	return undefined;
}

describe("restated lines in a call's arguments", () => {
	it("cuts a script written out again with every copy drifting", () => {
		const copies = Array.from({ length: 13 }, (_, c) => script(150, c));
		const text = `${copies.join("\n")}\n`;

		const cut = feed(new ToolArgumentLoopGuard(), text);

		expect(cut?.found.verdict.kind).toBe("restated-lines");
		// Into the third copy, not at the end of the thirteenth.
		expect(cut?.at).toBeLessThan(text.length / 4);
		expect(cut?.at).toBeGreaterThan((text.length / 13) * 2);
	});

	it("leaves a call that writes a block twice: a rewrite of what was read", () => {
		const text = `${script(400, 0)}\n${script(400, 1)}\n`;

		expect(feed(new ToolArgumentLoopGuard(), text)).toBeUndefined();
	});

	it("leaves a long file whose lines differ", () => {
		const text = `${script(2000, 0)}\n`;

		expect(feed(new ToolArgumentLoopGuard(), text)).toBeUndefined();
	});

	it("allows the repeats the source already has, and one more copy", () => {
		// A file that holds one section four times, a little different each
		// time, read and written back with a fifth: that is the model restating
		// what it was given. (Exact copies are the block test's business.)
		const source = [0, 1, 2, 3].map((c) => script(120, c)).join("\n");
		const text = `${[0, 1, 2, 3, 4].map((c) => script(120, c)).join("\n")}\n`;

		expect(
			feed(new ToolArgumentLoopGuard({}, { given: () => source }), text),
		).toBeUndefined();
		expect(feed(new ToolArgumentLoopGuard(), text)?.found.verdict.kind).toBe(
			"restated-lines",
		);
	});

	it("counts only long lines, so closing braces do not add up", () => {
		const lines: string[] = [];
		for (let i = 0; i < 600; i++) {
			lines.push(`    if (state.value${i} > limit) {`, "    }", "  });");
		}

		expect(
			feed(new ToolArgumentLoopGuard(), `${lines.join("\n")}\n`),
		).toBeUndefined();
	});

	it("tells the model what it did in words it can act on", () => {
		const copies = Array.from({ length: 13 }, (_, c) => script(150, c));
		const cut = feed(new ToolArgumentLoopGuard(), `${copies.join("\n")}\n`);

		expect(buildToolArgumentLoopNudge(cut?.found as never)).toMatch(
			/^\[SYSTEM\] Your call to `editor` was cut while you were writing it, and nothing ran: its arguments had come to repeat lines already written twice, one of them \d+ times\. Make the call again with only what it needs\.$/,
		);
	});
});
