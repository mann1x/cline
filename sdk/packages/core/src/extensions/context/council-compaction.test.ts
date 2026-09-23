import type { MessageWithMetadata } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	buildCouncilCriticRequest,
	buildCouncilSynthesizerRequest,
	COUNCIL_HALF_MARKER,
	COUNCIL_SYSTEM_PROMPTS,
	parseCouncilSections,
	runCouncilReview,
	splitReplayAtMarker,
	stripHalfMarker,
} from "./council-compaction";

function text(role: "user" | "assistant", body: string): MessageWithMetadata {
	return {
		role,
		content: [{ type: "text", text: body }],
	} as MessageWithMetadata;
}

const messages = [
	text("user", "fix the collision"),
	text("assistant", "a".repeat(200)),
	text("user", "b".repeat(200)),
	text("assistant", "c"),
];

/** A replay long enough that neither half is trivial. */
const marked = [
	"Let me run the checker. ".repeat(20).trim(),
	COUNCIL_HALF_MARKER,
	"Let me read the file. ".repeat(20).trim(),
].join("\n");

/** Long enough to clear the collapse guard, as a real merge would be. */
const bulk = (label: string) =>
	`${label}. ${"Let me keep working. ".repeat(40)}`;

const isCritic = (call: { systemPrompt: string }) =>
	call.systemPrompt === COUNCIL_SYSTEM_PROMPTS.critic;

describe("splitReplayAtMarker", () => {
	it("splits on the marker line the replay carries", () => {
		const halves = splitReplayAtMarker(marked);
		expect(halves?.first).toContain("run the checker");
		expect(halves?.first).not.toContain("read the file");
		expect(halves?.second).toContain("read the file");
		expect(halves?.second).not.toContain(COUNCIL_HALF_MARKER);
	});

	it("tolerates whitespace and inner spacing around the marker", () => {
		const halves = splitReplayAtMarker(
			marked.replace(COUNCIL_HALF_MARKER, "  <<< HALFWAY >>>  "),
		);
		expect(halves).toBeDefined();
	});

	it("reports that it used the writer's own marker", () => {
		expect(splitReplayAtMarker(marked)?.source).toBe("marker");
	});

	// Measured on pandorum: the writer put the marker at 19%, leaving one
	// reviewer 919 characters and the other 3,939 — and the oversized half came
	// back byte-identical, the writer handed four times the work having done
	// none of it.
	it("rebalances a marker that landed far off-centre", () => {
		const lopsided = [
			"Opening.",
			COUNCIL_HALF_MARKER,
			...Array.from({ length: 40 }, (_, i) => `Let me do step ${i}.`),
		].join("\n\n");
		const halves = splitReplayAtMarker(lopsided);
		expect(halves?.source).toBe("rebalanced");
		const share =
			(halves?.first.length ?? 0) /
			((halves?.first.length ?? 0) + (halves?.second.length ?? 1));
		expect(share).toBeGreaterThan(0.3);
		expect(share).toBeLessThan(0.7);
		expect(halves?.first).not.toContain(COUNCIL_HALF_MARKER);
		expect(halves?.second).not.toContain(COUNCIL_HALF_MARKER);
	});

	it("splits at a paragraph when there is no marker at all", () => {
		const plain = Array.from(
			{ length: 20 },
			(_, i) => `Let me do step ${i}.`,
		).join("\n\n");
		const halves = splitReplayAtMarker(plain);
		expect(halves?.source).toBe("rebalanced");
		// Never mid-line: each half starts and ends on a whole step.
		expect(halves?.first.endsWith(".")).toBe(true);
		expect(halves?.second.startsWith("Let me")).toBe(true);
	});

	it("gives up on one unbroken block with nowhere to cut", () => {
		expect(splitReplayAtMarker("one continuous replay")).toBeUndefined();
	});

	it("strips a stray marker so it never reaches the context", () => {
		expect(stripHalfMarker(marked)).not.toContain(COUNCIL_HALF_MARKER);
		expect(stripHalfMarker(marked)).toContain("read the file");
	});
});

describe("buildCouncilCriticRequest", () => {
	const request = buildCouncilCriticRequest({
		half: "first",
		ownReplay: "MY HALF",
		otherReplay: "THEIR HALF",
		transcript: "[User]: hello",
	});

	it("names which half is owned and forbids returning the other", () => {
		expect(request).toContain("**first half**");
		expect(request).toContain("return the first half only");
		expect(request).toContain("do not return it");
	});

	it("supplies the other half for grounding and the whole transcript", () => {
		expect(request).toContain("THEIR HALF");
		expect(request).toContain("MY HALF");
		expect(request).toContain("[User]: hello");
		expect(request).toContain("reference only");
	});

	it("asks for the owned half's own length, not the whole replay's", () => {
		expect(request).toContain(`Your half is ${"MY HALF".length} characters`);
	});

	it("asks for prose repair in present continuous, not only fact checking", () => {
		expect(request).toContain("present continuous");
		expect(request).toContain("Prose that has drifted");
	});

	it("says nothing about a retrospective", () => {
		expect(request.toLowerCase()).not.toContain("retrospective");
	});
});

describe("buildCouncilSynthesizerRequest", () => {
	const request = buildCouncilSynthesizerRequest({
		firstOriginal: "FIRST BEFORE",
		secondOriginal: "SECOND BEFORE",
		firstRewritten: "FIRST AFTER",
		secondRewritten: "SECOND AFTER",
		thinkingSummary: "THE RETRO",
		originalLength: 1_000,
	});

	it("pairs each half's original with that half's rewrite", () => {
		expect(request).toContain("First half — as originally written");
		expect(request).toContain("FIRST BEFORE");
		expect(request).toContain("First half — as rewritten");
		expect(request).toContain("FIRST AFTER");
		expect(request).toContain("SECOND BEFORE");
		expect(request).toContain("SECOND AFTER");
	});

	it("gives the whole-replay target and the 10% allowance", () => {
		expect(request).toContain("was 1000 characters");
		expect(request).toContain("up to 1100");
	});

	it("hands it the retrospective to revise against the joined replay", () => {
		expect(request).toContain("THE RETRO");
		expect(request).toContain("## Retrospective");
	});

	it("asks for one section only when there is no retrospective", () => {
		const alone = buildCouncilSynthesizerRequest({
			firstOriginal: "a",
			secondOriginal: "b",
			firstRewritten: "c",
			secondRewritten: "d",
			originalLength: 10,
		});
		expect(alone).not.toContain("## Retrospective");
	});
});

describe("parseCouncilSections", () => {
	it("reads both sections", () => {
		const parsed = parseCouncilSections(
			"## Replay\n\nLet me read the file.\n\n## Retrospective\n\nToo many reads.",
		);
		expect(parsed.replay).toBe("Let me read the file.");
		expect(parsed.retrospective).toBe("Too many reads.");
	});

	it("tolerates a different heading level and a preamble", () => {
		const parsed = parseCouncilSections(
			"Here you go:\n\n### Replay\n\nbody\n\n#### Retrospective\n\njudgement",
		);
		expect(parsed.replay).toBe("body");
		expect(parsed.retrospective).toBe("judgement");
	});

	it("returns nothing when there is no recognisable section", () => {
		expect(parseCouncilSections("I have no notes.")).toEqual({});
	});
});

describe("runCouncilReview", () => {
	it("gives each writer its own half and joins what they return", async () => {
		const calls: { systemPrompt: string; request: string }[] = [];
		const result = await runCouncilReview({
			summary: marked,
			thinkingSummary: "original retrospective",
			messages,
			generate: async (call) => {
				calls.push(call);
				if (isCritic(call)) {
					return call.request.includes("**first half**")
						? "first rewritten"
						: "second rewritten";
				}
				return `## Replay\n\n${bulk("merged replay")}\n\n## Retrospective\n\nmerged retro`;
			},
		});

		expect(calls).toHaveLength(3);
		const merge = calls[2].request;
		expect(merge).toContain("first rewritten");
		expect(merge).toContain("second rewritten");
		expect(merge).toContain("original retrospective");

		expect(result.summary).toBe(bulk("merged replay").trim());
		expect(result.thinkingSummary).toBe("merged retro");
		expect(result.reviewers).toBe(2);
		expect(result.merged).toBe(true);
	});

	// The splice: a writer that ignores the instruction and returns the whole
	// replay would otherwise put every step in twice.
	it("keeps only the owned side when a writer returns both halves", async () => {
		let merge = "";
		await runCouncilReview({
			summary: marked,
			messages,
			generate: async (call) => {
				if (isCritic(call)) {
					return `MINE-FIRST\n${COUNCIL_HALF_MARKER}\nMINE-SECOND`;
				}
				merge = call.request;
				return "## Replay\n\nmerged";
			},
		});

		expect(merge).toContain("MINE-FIRST");
		expect(merge).toContain("MINE-SECOND");
		// Each appears once, from the writer that owned it.
		expect(merge.match(/MINE-FIRST/g)).toHaveLength(1);
		expect(merge.match(/MINE-SECOND/g)).toHaveLength(1);
	});

	it("does not run when the replay carries no marker", async () => {
		let generated = 0;
		const result = await runCouncilReview({
			summary: "one continuous replay with no marker",
			messages,
			generate: async () => {
				generated += 1;
				return "## Replay\n\nx";
			},
		});
		expect(generated).toBe(0);
		expect(result.merged).toBe(false);
		expect(result.summary).toBe("one continuous replay with no marker");
	});

	it("falls back to the half as written when one writer fails", async () => {
		let merge = "";
		const result = await runCouncilReview({
			summary: marked,
			messages,
			generate: async (call) => {
				if (isCritic(call)) {
					if (call.request.includes("**first half**")) {
						throw new Error("provider exploded");
					}
					return "second rewritten";
				}
				merge = call.request;
				return `## Replay\n\n${bulk("merged")}`;
			},
		});
		expect(result.reviewers).toBe(1);
		// The original first half still reaches the synthesiser.
		expect(merge).toContain("run the checker");
		expect(merge).toContain("second rewritten");
		expect(result.summary).toBe(bulk("merged").trim());
	});

	it("keeps the original when the synthesiser returns nothing usable", async () => {
		const result = await runCouncilReview({
			summary: marked,
			thinkingSummary: "retro",
			messages,
			generate: async (call) => (isCritic(call) ? "rewritten" : "   "),
		});
		expect(result.merged).toBe(false);
		expect(result.thinkingSummary).toBe("retro");
		expect(result.summary).not.toContain(COUNCIL_HALF_MARKER);
	});

	it("refuses a merge that collapsed the replay", async () => {
		const warnings: string[] = [];
		const result = await runCouncilReview({
			summary: marked,
			messages,
			logger: {
				debug: () => undefined,
				log: (message: string) => warnings.push(message),
			},
			generate: async (call) =>
				isCritic(call)
					? "Let me run the checker. ".repeat(20)
					: "## Replay\n\nIt did not work.",
		});
		expect(result.merged).toBe(false);
		expect(warnings.join("\n")).toContain("far shorter than the original");
	});

	it("never lets the marker reach the context", async () => {
		const result = await runCouncilReview({
			summary: marked,
			messages,
			generate: async (call) =>
				isCritic(call)
					? "rewritten half"
					: `## Replay\n\nmerged\n${COUNCIL_HALF_MARKER}\nreplay`,
		});
		expect(result.summary).not.toContain(COUNCIL_HALF_MARKER);
	});

	it("records every intermediate text where the log can carry it", async () => {
		const lines: string[] = [];
		await runCouncilReview({
			summary: marked,
			thinkingSummary: "Too many reads.",
			messages,
			logger: {
				debug: (message: string) => lines.push(message),
				log: () => undefined,
			},
			generate: async (call) =>
				isCritic(call)
					? "corrected half"
					: "## Replay\n\nmerged replay\n\n## Retrospective\n\nmerged retro",
		});

		const joined = lines.join("\n");
		expect(joined).toContain("[council] original replay");
		expect(joined).toContain("[council] first-half rewritten");
		expect(joined).toContain("[council] second-half rewritten");
		expect(joined).toContain("[council] merged replay");
	});

	it("bounds every line it writes, however long the texts are", async () => {
		const lines: string[] = [];
		const huge = "Let me read the file. ".repeat(4_000);
		await runCouncilReview({
			summary: `${huge}\n${COUNCIL_HALF_MARKER}\n${huge}`,
			thinkingSummary: huge,
			messages,
			logger: {
				debug: (message: string) => lines.push(message),
				log: () => undefined,
			},
			generate: async () => `## Replay\n\n${huge}`,
		});

		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			expect(line.length).toBeLessThan(2_000);
		}
		expect(lines.join("\n")).toContain("chars…");
	});

	it("does not run on an empty summary", async () => {
		let generated = 0;
		await runCouncilReview({
			summary: "   ",
			messages,
			generate: async () => {
				generated += 1;
				return "x";
			},
		});
		expect(generated).toBe(0);
	});
});

describe("the citations a writer is handed", () => {
	// Measured on pandorum with thinking on: with no explanation of `[#7]` the
	// writer wrote its own reading into its task list -- "write every step as
	// `Step [number]. Outcome.`" -- and restructured its half around a step
	// numbering that does not exist, returning 30% of what it was given.
	it("explains the marks and carries the record they point at", () => {
		const request = buildCouncilCriticRequest({
			half: "second",
			ownReplay: "I am running the checker. [#7] It reports a SyntaxError.",
			otherReplay: "I am reading the file. [#1]",
			transcript: "...",
			toolLedgerKey: "7. run_commands — node run_game.js manic_miner.html",
		});
		expect(request).toContain("citations, not step numbers");
		expect(request).toContain("Do not renumber");
		expect(request).toContain("Only cite a number that appears in the record");
		expect(request).toContain(
			"7. run_commands — node run_game.js manic_miner.html",
		);
	});

	it("tells the writer to revise rather than re-derive from the transcript", () => {
		// Its 11,400 chars of thinking were spent re-tracing the whole run from
		// the transcript ("Let's re-trace carefully from the error...") instead
		// of checking the draft it was handed, and a rebuild under a length cap
		// loses its tail.
		const request = buildCouncilCriticRequest({
			half: "first",
			ownReplay: "a",
			otherReplay: "b",
			transcript: "t",
		});
		expect(request).toContain("The user's own words stay");
		expect(request).toContain("revising a draft, not writing one");
		expect(request).toContain("Do not re-derive your half");
	});

	it("omits the record section when there is no ledger", () => {
		const request = buildCouncilCriticRequest({
			half: "first",
			ownReplay: "a",
			otherReplay: "b",
			transcript: "t",
		});
		expect(request).not.toContain("The numbered record the citations point at");
	});

	it("hands the record to both writers", async () => {
		const seen: string[] = [];
		await runCouncilReview({
			summary: `one [#1]\n\n${COUNCIL_HALF_MARKER}\n\ntwo [#2]`,
			messages,
			toolLedgerKey: "1. read_files — a.ts\n2. editor — a.ts",
			generate: async (call) => {
				if (call.systemPrompt === COUNCIL_SYSTEM_PROMPTS.critic) {
					seen.push(call.request);
				}
				return "ok";
			},
		});
		expect(seen).toHaveLength(2);
		for (const request of seen) {
			expect(request).toContain("1. read_files — a.ts");
		}
	});
});

describe("splicing a writer's answer back to its own half", () => {
	const both = `first side\n\n${COUNCIL_HALF_MARKER}\n\nsecond side`;

	it("keeps a writer's half whole when it returned only its half", async () => {
		// The bug this pins: `splitReplayAtMarker` rebalances at the midpoint
		// when there is no marker, so a writer that obeyed and returned one
		// half had it halved again and half of it discarded. Measured at 19%
		// and 6% retention against a model that had done the work correctly.
		const kept: Record<string, string> = {};
		const rewritten =
			"I am reading the file. [#1] I am editing line 82. [#2]\n\nI am re-checking it. [#3] It parses.";
		const result = await runCouncilReview({
			summary: both,
			messages,
			generate: async (call) => {
				if (call.systemPrompt === COUNCIL_SYSTEM_PROMPTS.critic) {
					return rewritten;
				}
				kept.synth = call.request;
				return call.request;
			},
		});
		// Both writers returned the text whole, so it reaches the synthesizer
		// whole twice -- once as each half. Under the rebalance fallback each
		// writer kept a different slice and every sentence appeared exactly
		// once, which is why counting is the assertion and `toContain` is not.
		const occurrences = (needle: string) => kept.synth.split(needle).length - 1;
		expect(occurrences("I am reading the file. [#1]")).toBe(2);
		expect(occurrences("I am re-checking it. [#3]")).toBe(2);
		expect(result.summary.length).toBeGreaterThan(0);
	});

	it("still splices a writer that returned both halves with the marker", async () => {
		let synthRequest = "";
		await runCouncilReview({
			summary: both,
			messages,
			generate: async (call) => {
				if (call.systemPrompt === COUNCIL_SYSTEM_PROMPTS.critic) {
					return `REWROTE-FIRST\n\n${COUNCIL_HALF_MARKER}\n\nREWROTE-SECOND`;
				}
				synthRequest = call.request;
				return "merged";
			},
		});
		// Each writer contributed only its own side, so neither string is
		// present twice.
		expect(synthRequest.split("REWROTE-FIRST").length - 1).toBe(1);
		expect(synthRequest.split("REWROTE-SECOND").length - 1).toBe(1);
	});
});

describe("a custom council prompt", () => {
	// The instruction is the user's to change; the evidence is not. A custom
	// reviewer prompt that forgot to ask for the transcript must still be
	// handed it, or the review checks the summary against nothing.
	it("replaces the reviewer's instruction and keeps the evidence after it", () => {
		const request = buildCouncilCriticRequest({
			half: "first",
			ownReplay: "x".repeat(120),
			otherReplay: "other half",
			transcript: "THE TRANSCRIPT",
			instructions:
				"Fix the {{half}} half ({{half_length}} chars); {{other_half}} is not yours.",
		});
		expect(
			request.startsWith(
				"Fix the first half (120 chars); second is not yours.",
			),
		).toBe(true);
		expect(request).not.toContain("You wrote the replay below");
		expect(request).toContain("other half");
		expect(request).toContain("THE TRANSCRIPT");
	});

	it("replaces the synthesiser's instruction and keeps the parsed answer format", () => {
		const request = buildCouncilSynthesizerRequest({
			firstOriginal: "a",
			secondOriginal: "b",
			firstRewritten: "c",
			secondRewritten: "d",
			thinkingSummary: "retro",
			originalLength: 1000,
			instructions:
				"Join them; stay near {{original_length}}, at most {{max_length}}.",
		});
		expect(request.startsWith("Join them; stay near 1000, at most 1100.")).toBe(
			true,
		);
		expect(request).toContain("## Replay");
		expect(request).toContain("## Retrospective");
	});
});
