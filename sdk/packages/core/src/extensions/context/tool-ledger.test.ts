import type { AgentMessage } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	buildToolLedger,
	collectFileHistories,
	DEFAULT_TOOL_LEDGER_LIMITS,
	evictToolLedger,
	mergeToolLedger,
	renderToolLedger,
	spliceLedgerCitations,
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

	describe("which files the stretch touched", () => {
		it("records the paths a call named, with or without a revision log", () => {
			// A path is a fact about the call. It is recorded unconditionally
			// because nothing about it is a claim -- unlike a revision number,
			// which is one.
			const entries = buildToolLedger([
				...exchange("editor", { path: "/w/a.ts" }, "written"),
			]);

			expect(entries[0]?.files).toEqual(["/w/a.ts"]);
		});

		it("lists each file once, with the revisions that hold its earlier content", () => {
			// This is what makes the elision safe: the content is not in the
			// ledger, but the ledger says which revisions hold it. Stated per
			// file rather than per call, because the log records revisions in
			// order without recording which call made which -- so `#1 → #2` on
			// a given line would be a claim nothing can check.
			const entries = buildToolLedger([
				...exchange("editor", { path: "/w/a.ts" }, "written"),
				...exchange("read_files", { path: "/w/a.ts" }, "ok"),
				...exchange("editor", { path: "/w/b.ts" }, "written"),
			]);

			const histories = collectFileHistories(entries, (path) =>
				path === "/w/a.ts" ? "#1–#3" : undefined,
			);

			expect(histories).toEqual([{ path: "/w/a.ts", span: "#1–#3" }]);
		});

		it("says nothing about files when no revision log was given", () => {
			const entries = buildToolLedger([
				...exchange("editor", { path: "/w/a.ts" }, "written"),
			]);

			expect(collectFileHistories(entries, undefined)).toEqual([]);
		});

		it("keeps the order the files were first touched in", () => {
			const entries = buildToolLedger([
				...exchange("editor", { path: "/w/b.ts" }, "written"),
				...exchange("editor", { path: "/w/a.ts" }, "written"),
			]);

			expect(
				collectFileHistories(entries, () => "#1").map((file) => file.path),
			).toEqual(["/w/b.ts", "/w/a.ts"]);
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

		it("appends the files whose earlier content is still held", () => {
			const entries = buildToolLedger([
				...exchange("editor", { path: "/w/a.ts" }, "written"),
			]);

			const text = renderToolLedger(
				entries,
				collectFileHistories(entries, () => "#1–#4"),
			);

			expect(text).toContain("/w/a.ts");
			expect(text).toContain("#1–#4");
		});

		it("makes no per-call revision claim on the call lines", () => {
			// The regression this replaces: a `#a → #b` per call read as a
			// statement about that call, and the log cannot support one.
			const entries = buildToolLedger([
				...exchange("editor", { path: "/w/a.ts" }, "written"),
			]);

			const [callLine] = renderToolLedger(
				entries,
				collectFileHistories(entries, () => "#1–#4"),
			).split("\n");

			expect(callLine).not.toMatch(/#\d/);
		});

		it("adds no trailing block when nothing is held", () => {
			const text = renderToolLedger(
				buildToolLedger([...exchange("editor", { path: "/w/a.ts" }, "ok")]),
			);

			expect(text).not.toMatch(/#\d/);
			expect(text.split("\n")).toHaveLength(2);
		});
	});

	describe("the other block shape", () => {
		// The ledger is read from two pipelines that disagree about what a tool
		// call looks like: the agent runtime speaks the AI SDK's `tool-call` /
		// `toolCallId`, and compaction speaks `tool_use` / `id` with results
		// keyed by `tool_use_id`. Reading only one of them does not half-work --
		// it reports that no tools were called at all, which is the most
		// damaging thing this file could say, and it says it silently.
		function useCall(name: string, input: unknown, id: string): AgentMessage {
			return {
				role: "assistant",
				content: [{ type: "tool_use", id, name, input }],
			} as unknown as AgentMessage;
		}

		function useResult(
			name: string,
			content: unknown,
			id: string,
			isError = false,
		): AgentMessage {
			return {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						name,
						content,
						...(isError ? { is_error: true } : {}),
					},
				],
			} as unknown as AgentMessage;
		}

		it("reads a compaction-shaped call and its result", () => {
			const entries = buildToolLedger([
				useCall("read_files", { path: "a.ts" }, "u1"),
				useResult("read_files", "the contents", "u1"),
			]);

			expect(entries).toHaveLength(1);
			expect(entries[0]?.toolName).toBe("read_files");
			expect(entries[0]?.input).toContain("a.ts");
			expect(entries[0]?.result).toContain("the contents");
		});

		it("keeps its own error flag", () => {
			const entries = buildToolLedger([
				useCall("editor", { path: "a.ts" }, "u1"),
				useResult("editor", "no such file", "u1", true),
			]);

			expect(entries[0]?.failed).toBe(true);
		});

		it("pairs by id even when the results arrive out of order", () => {
			const entries = buildToolLedger([
				useCall("read_files", { path: "a.ts" }, "u1"),
				useCall("read_files", { path: "b.ts" }, "u2"),
				useResult("read_files", "B contents", "u2"),
				useResult("read_files", "A contents", "u1"),
			]);

			expect(entries[0]?.result).toContain("A contents");
			expect(entries[1]?.result).toContain("B contents");
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

describe("the measured record of a structured result", () => {
	// The ledger is placed beside the model's replay so the two accounts can
	// be compared, which only works if the ledger carries one. `run_commands`
	// answers with `{query, result, success}` entries and the ledger printed
	// `[1 items]` for them -- so when a pandorum summary claimed a checker run
	// had succeeded, the line that could have contradicted it said nothing.
	it("prints what a structured tool result returned", () => {
		const ledger = buildToolLedger([
			call("run_commands", { commands: ["node run_game.js game.html"] }, "c1"),
			result(
				"run_commands",
				[
					{
						query: "node run_game.js game.html",
						result:
							'{"ok":false,"error":"ReferenceError: collide is not defined"}',
						success: true,
					},
				],
				"c1",
			),
		]);

		const rendered = renderToolLedger(ledger);

		expect(rendered).toContain("ReferenceError: collide is not defined");
		// The result line specifically: the input names the command too, now,
		// and the arrow is what separates the two halves of the entry.
		expect(rendered).toMatch(
			/\u2192 node run_game\.js game\.html: \{"ok":false/,
		);
	});

	// The other half of the same fault. The result line was fixed first and the
	// input line was left saying `commands=[1 items]`, so the ledger named
	// neither the command that ran nor the file that was read -- and the model
	// that could not remember to check with `run_game.js` had a record in front
	// of it that never said the name either.
	it("names the command that ran", () => {
		const ledger = buildToolLedger([
			...exchange(
				"run_commands",
				{ commands: ["node run_game.js game.html"] },
				"ok",
			),
		]);

		expect(ledger[0]?.input).toContain("node run_game.js game.html");
		expect(ledger[0]?.input).not.toContain("items]");
	});

	it("names the file that was read, with the range that was asked for", () => {
		const ledger = buildToolLedger([
			...exchange(
				"read_files",
				{ files: [{ path: "game.html", start_line: 1, end_line: 200 }] },
				"ok",
			),
		]);

		expect(ledger[0]?.input).toContain("game.html:1-200");
	});

	it("spells out an executable and its argv", () => {
		const ledger = buildToolLedger([
			...exchange(
				"run_commands",
				{ commands: [{ command: "node", args: ["run_game.js", "game.html"] }] },
				"ok",
			),
		]);

		expect(ledger[0]?.input).toContain("node run_game.js game.html");
	});

	// The repeat rule keys on the rendered input, so a rendering that said
	// `[1 items]` for every call made two different commands with the same
	// answer indistinguishable -- and collapsed them into one entry that named
	// neither.
	it("does not collapse two different commands that answered the same", () => {
		const ledger = buildToolLedger([
			...exchange(
				"run_commands",
				{ commands: ["node run_game.js a.html"] },
				"ok",
			),
			...exchange(
				"run_commands",
				{ commands: ["node run_game.js b.html"] },
				"ok",
			),
		]);

		expect(ledger).toHaveLength(2);
		expect(ledger[0]?.input).toContain("a.html");
		expect(ledger[1]?.input).toContain("b.html");
	});

	it("still collapses the same command answering the same twice", () => {
		const ledger = buildToolLedger([
			...exchange(
				"run_commands",
				{ commands: ["node run_game.js a.html"] },
				"ok",
			),
			...exchange(
				"run_commands",
				{ commands: ["node run_game.js a.html"] },
				"ok",
			),
		]);

		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.repeated).toBe(2);
	});

	it("keeps a long list inside the field budget and says what it dropped", () => {
		const files = Array.from({ length: 40 }, (_, index) => ({
			path: `/src/module-${index}.ts`,
		}));
		const ledger = buildToolLedger(
			[...exchange("read_files", { files }, "ok")],
			{
				limits: { maxFieldChars: 120 },
			},
		);

		expect(ledger[0]?.input).toContain("/src/module-0.ts");
		expect(ledger[0]?.input).toMatch(/\+\d+ more/);
		expect(ledger[0]?.input.length).toBeLessThan(220);
	});

	it("falls back to the shape when an entry names nothing", () => {
		const ledger = buildToolLedger([
			...exchange("mystery", { things: [{ alpha: 1, beta: 2 }] }, "ok"),
		]);

		expect(ledger[0]?.input).toContain("{alpha, beta}");
	});

	it("names a failed entry as failed", () => {
		const ledger = buildToolLedger([
			call("read_files", { files: [{ path: "game.html" }] }, "c2"),
			result(
				"read_files",
				[
					{
						query: "game.html",
						result: "",
						success: false,
						error: "Read too large: this window is 29867 characters",
					},
				],
				"c2",
			),
		]);

		expect(renderToolLedger(ledger)).toContain("failed: Read too large");
	});
});

describe("a ledger that outlives its own compaction", () => {
	// The ledger used to live for exactly one generation, on the reasoning
	// that anything fed back accumulates. That is true of prose and false of
	// a record: a record can be evicted. What it costs to throw away is the
	// standing evidence -- after one compaction the model no longer knew it
	// had a checker to run, and started again from a reading of the source.
	const entry = (
		toolName: string,
		input: string,
		result: string,
		extra: Partial<ReturnType<typeof buildToolLedger>[number]> = {},
	) => ({
		index: 0,
		toolName,
		input,
		result,
		failed: false,
		repeated: 1,
		files: [],
		...extra,
	});

	it("renumbers the merged run so the order still reads", () => {
		const merged = mergeToolLedger(
			[entry("read_files", "path=a.ts", "40 lines")],
			[entry("editor", "path=a.ts", "replaced 3 lines")],
		);

		expect(merged.map((e) => e.index)).toEqual([1, 2]);
		expect(merged.map((e) => e.toolName)).toEqual(["read_files", "editor"]);
	});

	it("collapses a repeat that spans the seam", () => {
		// The same check run either side of a compaction is one fact, not two,
		// and it is the fact most likely to be repeated: the checker is run
		// after every edit.
		const merged = mergeToolLedger(
			[entry("run_commands", "commands=[node run_game.js]", "ok:false")],
			[entry("run_commands", "commands=[node run_game.js]", "ok:false")],
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.repeated).toBe(2);
	});

	it("starts a new entry when the answer changed across the seam", () => {
		const merged = mergeToolLedger(
			[entry("run_commands", "commands=[node run_game.js]", "ok:false")],
			[entry("run_commands", "commands=[node run_game.js]", "ok:true")],
		);

		expect(merged).toHaveLength(2);
		expect(merged.map((e) => e.result)).toEqual(["ok:false", "ok:true"]);
	});

	it("evicts old reads before anything that returned a verdict", () => {
		// The stated order: reads and edits go first because the files are
		// still on disk, and a command's result is a judgement about the work
		// that nothing else records.
		const entries = mergeToolLedger(
			[],
			[
				entry("read_files", "path=a.ts", "x".repeat(400)),
				entry("editor", "path=a.ts", "y".repeat(400)),
				entry("run_commands", "commands=[node run_game.js]", "ok:false"),
				entry("read_files", "path=b.ts", "z".repeat(400)),
			],
		);

		const kept = evictToolLedger(entries, 100);

		expect(kept.map((e) => e.toolName)).toEqual(["run_commands"]);
	});

	it("keeps a failed read over a successful one", () => {
		// A refused call is the one kind the summary is worst at keeping, and
		// re-making it is the cost of losing it.
		const entries = mergeToolLedger(
			[],
			[
				entry("read_files", "path=a.ts", "x".repeat(400)),
				entry("read_files", "path=b.ts", "Read too large", { failed: true }),
			],
		);

		const kept = evictToolLedger(entries, 60);

		expect(kept.map((e) => e.failed)).toEqual([true]);
	});

	it("leaves a ledger that already fits alone", () => {
		const entries = mergeToolLedger([], [entry("read_files", "a", "b")]);
		expect(evictToolLedger(entries, 10_000)).toEqual(entries);
	});

	it("renumbers what survives eviction", () => {
		const entries = mergeToolLedger(
			[],
			[
				entry("read_files", "path=a.ts", "x".repeat(400)),
				entry("run_commands", "commands=[node run_game.js]", "ok:false"),
			],
		);

		expect(evictToolLedger(entries, 100).map((e) => e.index)).toEqual([1]);
	});
});

/**
 * The replay narrates and the ledger records, in the same order — so the
 * writer cites rather than transcribes. Before this, tool transcription took
 * 69% of a small model's output budget and the prose was cut off mid-sentence.
 */
describe("putting each call where the replay says it happened", () => {
	const ledger = () =>
		buildToolLedger([
			...exchange(
				"run_commands",
				{ commands: ["node run_game.js"] },
				"ok:false",
			),
			...exchange(
				"read_files",
				{ files: [{ path: "game.html" }] },
				"<400 lines>",
			),
			...exchange("check_file", { path: "game.html" }, "no problems"),
		]);

	it("splices the cited entry in at the point it was cited", () => {
		const spliced = spliceLedgerCitations(
			"Let me run the checker. [#1] It reports a failure.",
			ledger(),
		);
		expect(spliced.text).toContain("Let me run the checker.");
		expect(spliced.text).toContain("node run_game.js");
		expect(spliced.text).toContain("It reports a failure.");
		expect(spliced.text).not.toContain("[#1]");
		expect(spliced.cited).toEqual([1]);
	});

	it("keeps the narrated order, not the ledger's", () => {
		const spliced = spliceLedgerCitations("[#3] then [#1]", ledger());
		expect(spliced.cited).toEqual([3, 1]);
		expect(spliced.text.indexOf("check_file")).toBeLessThan(
			spliced.text.indexOf("run_commands"),
		);
	});

	// Every failure degrades to the ledger block that was there before.
	it("reports what the replay never cited", () => {
		const spliced = spliceLedgerCitations("Let me work. [#2]", ledger());
		expect(spliced.cited).toEqual([2]);
		expect(spliced.uncited).toEqual([1, 3]);
	});

	// The bad number goes; the sentence around it stays. Counting them is the
	// only signal that the prose has run past the record — measured on
	// pandorum, a replay cited [#31]-[#33] against a 30-entry ledger.
	it("drops a citation naming an entry that does not exist, and counts it", () => {
		const spliced = spliceLedgerCitations("Let me work. [#99] Done.", ledger());
		expect(spliced.text).not.toContain("[#99]");
		expect(spliced.text).toContain("Let me work.");
		expect(spliced.text).toContain("Done.");
		expect(spliced.cited).toEqual([]);
		expect(spliced.invalid).toEqual([99]);
	});

	it("drops a repeated citation rather than saying the call twice", () => {
		const spliced = spliceLedgerCitations("[#1] and again [#1]", ledger());
		expect(spliced.cited).toEqual([1]);
		expect(spliced.invalid).toEqual([1]);
		expect(spliced.text.match(/run_commands/g)).toHaveLength(1);
	});

	// Measured on pandorum, session 1789914699018_6pm02: the replay cited four
	// consecutive identical check_file calls as `[#2-5]` and every one of them
	// fell through to the appended block, because the pattern only matched a
	// single number. Compressing a run of identical calls is the sensible thing
	// to write, so the splice meets it.
	it("expands a range citation into the calls it names", () => {
		const spliced = spliceLedgerCitations(
			"I check it repeatedly. [#1-3] Nothing changes.",
			ledger(),
		);
		expect(spliced.cited).toEqual([1, 2, 3]);
		expect(spliced.uncited).toEqual([]);
		expect(spliced.invalid).toEqual([]);
		expect(spliced.text).toContain("I check it repeatedly.");
		expect(spliced.text).toContain("Nothing changes.");
		expect(spliced.text).not.toContain("[#1-3]");
		// In ledger order, between the two sentences.
		expect(spliced.text.indexOf("run_commands")).toBeLessThan(
			spliced.text.indexOf("read_files"),
		);
		expect(spliced.text.indexOf("read_files")).toBeLessThan(
			spliced.text.indexOf("check_file"),
		);
	});

	it("accepts the ways a model writes a range", () => {
		for (const citation of ["[#1-2]", "[#1 - 2]", "[#1-#2]", "[#1\u20132]"]) {
			const spliced = spliceLedgerCitations(
				`Work. ${citation} Done.`,
				ledger(),
			);
			expect(spliced.cited, citation).toEqual([1, 2]);
		}
	});

	it("splices the half of a range that exists and counts the rest", () => {
		const spliced = spliceLedgerCitations("Work. [#2-4] Done.", ledger());
		expect(spliced.cited).toEqual([2, 3]);
		expect(spliced.invalid).toEqual([4]);
	});

	// `[#5-2]` is not a range anybody meant. Reordering it would invent a
	// reading; dropping it leaves the sentence and says so in `invalid`.
	it("refuses a backwards range rather than guessing", () => {
		const spliced = spliceLedgerCitations("Work. [#3-1] Done.", ledger());
		expect(spliced.cited).toEqual([]);
		expect(spliced.invalid).toEqual([3]);
		expect(spliced.text).toBe("Work.  Done.");
	});

	// A span longer than the whole ledger is not a citation, and expanding it
	// would put thousands of numbers into `invalid` for one bad token.
	it("refuses a range wider than the ledger without enumerating it", () => {
		const spliced = spliceLedgerCitations("Work. [#1-9000] Done.", ledger());
		expect(spliced.cited).toEqual([]);
		expect(spliced.invalid).toEqual([1]);
		expect(spliced.uncited).toEqual([1, 2, 3]);
	});

	it("leaves a replay that cites nothing exactly as it was", () => {
		const prose = "Let me work on the file. It is not parsing yet.";
		expect(spliceLedgerCitations(prose, ledger()).text).toBe(prose);
	});
});
