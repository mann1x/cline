import { describe, expect, it } from "vitest";
import { MessageBuilder } from "./message-builder";

/**
 * The reverse redundancy case: a later read fully contained in an earlier one.
 *
 * Observed live — `manic_miner.html` read at 80-120 and then again at 94-113.
 * The second read is not newer information, it is the same lines a second
 * time, and nothing collapsed it because supersession only looked forward.
 */
function readPair(
	laterStart: number,
	laterEnd: number,
	laterText: string,
	earlierText = " 80 | a\n 94 | x\n 95 | y\n120 | b",
) {
	return [
		{
			role: "assistant" as const,
			content: [
				{
					type: "tool_use" as const,
					id: "call-1",
					name: "read_files",
					input: { path: "app.ts", start_line: 80, end_line: 120 },
				},
			],
		},
		{
			role: "user" as const,
			content: [
				{
					type: "tool_result" as const,
					tool_use_id: "call-1",
					content: JSON.stringify([
						{ path: "app.ts", start_line: 80, end_line: 120, content: earlierText },
					]),
				},
			],
		},
		{
			role: "assistant" as const,
			content: [
				{
					type: "tool_use" as const,
					id: "call-2",
					name: "read_files",
					input: { path: "app.ts", start_line: laterStart, end_line: laterEnd },
				},
			],
		},
		{
			role: "user" as const,
			content: [
				{
					type: "tool_result" as const,
					tool_use_id: "call-2",
					content: JSON.stringify([
						{
							path: "app.ts",
							start_line: laterStart,
							end_line: laterEnd,
							content: laterText,
						},
					]),
				},
			],
		},
	];
}

function build(messages: unknown[]) {
	// Eager rewriting: this asserts the classification, not the batching.
	const builder = new MessageBuilder({ minOutdatedRewriteBytes: 0 });
	return JSON.stringify(builder.buildForApi(messages as never));
}

describe("duplicate reads", () => {
	it("collapses a later read contained in an earlier one", () => {
		const out = build(readPair(94, 95, " 94 | x\n 95 | y"));
		expect(out).toContain("duplicate - this range was already read earlier");
	});

	// The newest copy of a range is never stale. Telling the model to go look
	// for a newer version sends it to re-read what it just read.
	it("does not call it outdated", () => {
		const out = build(readPair(94, 95, " 94 | x\n 95 | y"));
		expect(out).not.toContain("outdated - see the latest file content");
	});

	// An edit landed between the two reads, so the contained read is the only
	// fresh copy in the transcript — collapsing it would feed the model source
	// that no longer exists.
	it("keeps a contained read whose content changed", () => {
		const out = build(readPair(94, 95, " 94 | x\n 95 | CHANGED"));
		expect(out).toContain("CHANGED");
		expect(out).not.toContain("duplicate - this range was already read earlier");
	});

	// Line-number padding differs between reads of different widths; the
	// witness must not mistake that for a change.
	it("ignores line-number padding differences", () => {
		const out = build(
			readPair(94, 95, "  94 | x\n  95 | y", " 80 | a\n 94 | x\n 95 | y\n120 | b"),
		);
		expect(out).toContain("duplicate - this range was already read earlier");
	});

	it("leaves a read that is not contained alone", () => {
		const out = build(readPair(200, 201, "200 | p\n201 | q"));
		expect(out).toContain("200 | p");
		expect(out).not.toContain("duplicate - this range was already read earlier");
	});
});
