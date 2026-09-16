import type { AgentMessage } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	buildToolLedger,
	DEFAULT_TOOL_LEDGER_LIMITS,
	renderToolLedger,
} from "./tool-ledger";

function call(
	toolName: string,
	input: unknown,
	toolCallId = `c${Math.random().toString(36).slice(2, 8)}`,
): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "tool-call", toolCallId, toolName, input }],
	} as AgentMessage;
}

function result(
	toolName: string,
	output: unknown,
	toolCallId: string,
	isError = false,
): AgentMessage {
	return {
		role: "user",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output,
				...(isError ? { isError } : {}),
			},
		],
	} as AgentMessage;
}

function exchange(
	toolName: string,
	input: unknown,
	output: unknown,
	isError = false,
): AgentMessage[] {
	const id = `id-${toolName}-${JSON.stringify(input).length}-${Math.random()}`;
	return [call(toolName, input, id), result(toolName, output, id, isError)];
}

describe("the tool ledger", () => {
	it("pairs each call with its result, in the order they happened", () => {
		const entries = buildToolLedger([
			...exchange("read_files", { path: "a.ts" }, "ok"),
			...exchange("editor", { path: "b.ts", diff: "x" }, "written"),
		]);

		expect(entries.map((entry) => [entry.index, entry.toolName])).toEqual([
			[1, "read_files"],
			[2, "editor"],
		]);
		expect(entries[0]?.result).toContain("ok");
		expect(entries[1]?.input).toContain("b.ts");
	});

	it("keeps a result that reported an error, and says so", () => {
		// A refused call is the most informative kind of entry: it is the one
		// the model must not simply repeat after the transcript is gone.
		const entries = buildToolLedger([
			...exchange("editor", { path: "a.ts" }, "no such file", true),
		]);

		expect(entries[0]?.failed).toBe(true);
	});

	describe("trimming", () => {
		it("elides a long field and says how much it dropped", () => {
			const body = "L".repeat(5_000);
			const entries = buildToolLedger([
				...exchange("editor", { path: "a.ts", content: body }, "written"),
			]);

			const input = entries[0]?.input ?? "";
			expect(input.length).toBeLessThan(1_000);
			expect(input).toContain("a.ts");
			expect(input).toMatch(/elided/i);
		});

		it("reports a multi-line body as its size rather than its text", () => {
			// The reason the revisions exist: a whole-file write is the largest
			// thing in any transcript and the least worth reproducing, because
			// the file itself is still on disk.
			const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join(
				"\n",
			);
			const entries = buildToolLedger([
				...exchange("editor", { path: "a.ts", content: body }, "written"),
			]);

			expect(entries[0]?.input).toMatch(/400 lines/);
			expect(entries[0]?.input).not.toContain("line 200");
		});

		it("never elides a short field, which is most of them", () => {
			const entries = buildToolLedger([
				...exchange("run_commands", { command: "ls -la" }, "3 files"),
			]);

			expect(entries[0]?.input).toContain("ls -la");
			expect(entries[0]?.input).not.toMatch(/elided/i);
		});
	});

	describe("repetition", () => {
		it("collapses an identical call made several times", () => {
			const entries = buildToolLedger([
				...exchange("read_files", { path: "a.ts" }, "contents"),
				...exchange("read_files", { path: "a.ts" }, "contents"),
				...exchange("read_files", { path: "a.ts" }, "contents"),
			]);

			expect(entries).toHaveLength(1);
			expect(entries[0]?.repeated).toBe(3);
		});

		it("does not collapse the same tool on different arguments", () => {
			const entries = buildToolLedger([
				...exchange("read_files", { path: "a.ts" }, "A"),
				...exchange("read_files", { path: "b.ts" }, "B"),
			]);

			expect(entries).toHaveLength(2);
		});

		it("keeps a repeat whose result changed, because that is the story", () => {
			// Same call, different answer, is the shape of a fix landing -- or of
			// a flaky check. Collapsing it to one line loses the only evidence
			// that anything moved.
			const entries = buildToolLedger([
				...exchange("run_commands", { command: "test" }, "1 failing"),
				...exchange("run_commands", { command: "test" }, "0 failing"),
			]);

			expect(entries).toHaveLength(2);
		});
	});

	describe("file impact", () => {
		it("names the revision a file was at before and after a call", () => {
			// This is what makes the elision safe: the content is not in the
			// ledger, but the ledger says exactly which revision holds it.
			const entries = buildToolLedger(
				[...exchange("editor", { path: "/w/a.ts" }, "written")],
				{
					revisionsFor: (path) =>
						path === "/w/a.ts" ? { before: "#1", after: "#2" } : undefined,
				},
			);

			expect(entries[0]?.files).toEqual([
				{ path: "/w/a.ts", before: "#1", after: "#2" },
			]);
		});

		it("says nothing about files when no revision log was given", () => {
			const entries = buildToolLedger([
				...exchange("editor", { path: "/w/a.ts" }, "written"),
			]);

			expect(entries[0]?.files).toEqual([]);
		});
	});

	describe("rendering", () => {
		it("produces one legible line per entry", () => {
			const text = renderToolLedger(
				buildToolLedger([
					...exchange("read_files", { path: "a.ts" }, "ok"),
					...exchange("editor", { path: "b.ts" }, "written"),
				]),
			);

			expect(text).toContain("read_files");
			expect(text).toContain("editor");
			expect(text.split("\n").length).toBeGreaterThanOrEqual(2);
		});

		it("marks the failures and the repeats where a reader will see them", () => {
			const text = renderToolLedger(
				buildToolLedger([
					...exchange("editor", { path: "a.ts" }, "refused", true),
					...exchange("read_files", { path: "b.ts" }, "x"),
					...exchange("read_files", { path: "b.ts" }, "x"),
				]),
			);

			expect(text).toMatch(/failed|error/i);
			expect(text).toMatch(/2×|×2|twice|2 times/i);
		});

		it("is empty for a stretch with no tool calls at all", () => {
			expect(renderToolLedger([])).toBe("");
		});
	});

	it("has limits a caller can see and override", () => {
		expect(DEFAULT_TOOL_LEDGER_LIMITS.maxFieldChars).toBeGreaterThan(0);
		const entries = buildToolLedger(
			[...exchange("run_commands", { command: "x".repeat(300) }, "ok")],
			{ limits: { maxFieldChars: 50 } },
		);
		expect(entries[0]?.input.length).toBeLessThan(200);
	});
});
