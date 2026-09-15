import { describe, expect, it } from "vitest";
import {
	mergeWorkDigests,
	parseWorkDigest,
	renderWorkDigest,
	WORK_DIGEST_SECTIONS,
} from "./work-digest";

describe("reading a worker's digest", () => {
	// Free-form JSON in a fence, not a grammar. A worker that has to satisfy a
	// schema spends its turn satisfying the schema; one that writes a block and
	// gets read tolerantly spends it on the work.
	it("reads the fenced block a worker was asked for", () => {
		const digest = parseWorkDigest(
			[
				"Here is what I found.",
				"```json",
				JSON.stringify({
					goal: "make the tests pass",
					done: ["fixed the parser"],
					next: ["run the suite"],
				}),
				"```",
			].join("\n"),
		);
		expect(digest?.goal).toBe("make the tests pass");
		expect(digest?.done).toEqual(["fixed the parser"]);
	});

	// A fence labelled anything, or not labelled at all, is still the block the
	// worker meant. Refusing it over the language tag loses the whole report.
	it("reads a fence however it was labelled", () => {
		const body = '{"goal":"a"}';
		for (const fence of ["```json", "```JSON", "```", "~~~json"]) {
			const close = fence.startsWith("~") ? "~~~" : "```";
			expect(parseWorkDigest(`${fence}\n${body}\n${close}`)?.goal).toBe("a");
		}
	});

	// The lead's own compaction note is markdown with these headings, and the
	// two artifacts have to read identically to the model -- a swarm round that
	// lands while the lead is over its watermark then feeds compaction instead
	// of adding to the pressure it was meant to relieve.
	it("reads the markdown form the compaction note already uses", () => {
		const digest = parseWorkDigest(
			[
				"## Goal",
				"Make the tests pass",
				"",
				"## Done",
				"- fixed the parser",
				"- updated the fixture",
				"",
				"## Next",
				"1. run the suite",
			].join("\n"),
		);
		expect(digest?.goal).toBe("Make the tests pass");
		expect(digest?.done).toEqual(["fixed the parser", "updated the fixture"]);
		expect(digest?.next).toEqual(["run the suite"]);
	});

	// A worker that breaks the contract is still represented. The reducer
	// cannot tell "nothing to report" from "lost" otherwise, and a silently
	// absent worker is the failure this whole path exists to avoid.
	it("keeps prose that is neither, rather than discarding the worker", () => {
		const digest = parseWorkDigest("I could not find the file anywhere.");
		expect(digest?.notes).toContain("could not find the file");
	});

	it("says nothing for nothing", () => {
		expect(parseWorkDigest("")).toBeUndefined();
		expect(parseWorkDigest("   \n  ")).toBeUndefined();
		expect(parseWorkDigest(undefined)).toBeUndefined();
	});

	// A JSON block that is not an object is a worker that wrote something else
	// in a fence; the prose around it is still the report.
	it("falls back to prose when the fence holds something that is not a digest", () => {
		const digest = parseWorkDigest("Found it.\n```json\n[1,2,3]\n```");
		expect(digest?.notes).toContain("Found it.");
	});
});

describe("rendering a digest", () => {
	it("writes the headings the compaction note uses, and skips empty ones", () => {
		const text = renderWorkDigest({
			agent: "worker-1",
			goal: "make the tests pass",
			done: ["fixed the parser"],
			next: ["run the suite"],
		});
		expect(text).toContain("## Goal");
		expect(text).toContain("## Done");
		expect(text).toContain("- fixed the parser");
		expect(text).not.toContain("## Ruled out");
	});

	// Round-tripping is the property that makes one artifact serve both: what
	// the reducer emits, compaction can read.
	it("round-trips through the parser", () => {
		const digest = {
			goal: "g",
			done: ["d1", "d2"],
			inProgress: ["p"],
			ruledOut: ["r"],
			keyFacts: ["k"],
			next: ["n"],
		};
		expect(parseWorkDigest(renderWorkDigest(digest))).toMatchObject(digest);
	});

	// A worker that spent its whole budget thinking returns empty content and a
	// full reasoning channel. Its reasoning tail IS the report, and dropping it
	// throws away the entire turn's work.
	it("carries a failed worker's reasoning and its error", () => {
		const text = renderWorkDigest({
			agent: "worker-2",
			error: "ran out of output budget",
			reasoning: "The parser fails on the second fence, not the first.",
		});
		expect(text).toContain("ran out of output budget");
		expect(text).toContain("second fence");
	});
});

describe("reducing several digests to one", () => {
	// One worker means nothing to reduce. A model call there costs a round trip
	// to rewrite a report that is already the answer.
	it("passes a single digest through untouched", () => {
		const one = { agent: "w1", goal: "g", done: ["d"] };
		expect(mergeWorkDigests([one])).toEqual(one);
	});

	it("keeps every worker's lines, attributed", () => {
		const merged = mergeWorkDigests([
			{ agent: "w1", done: ["fixed the parser"], next: ["run the suite"] },
			{ agent: "w2", done: ["updated the fixture"] },
		]);
		expect(merged.done).toEqual([
			"w1: fixed the parser",
			"w2: updated the fixture",
		]);
		expect(merged.next).toEqual(["w1: run the suite"]);
	});

	// Two workers on one prefix reach the same conclusion often. Saying it
	// twice makes the reducer's output look like twice the work.
	it("does not repeat a line two workers both wrote", () => {
		const merged = mergeWorkDigests([
			{ agent: "w1", keyFacts: ["the config is read twice"] },
			{ agent: "w2", keyFacts: ["the config is read twice"] },
		]);
		expect(merged.keyFacts).toEqual(["w1, w2: the config is read twice"]);
	});

	it("represents a worker that reported nothing at all", () => {
		const merged = mergeWorkDigests([
			{ agent: "w1", done: ["something"] },
			{ agent: "w2", error: "returned no content" },
		]);
		expect(merged.notes).toContain("w2");
		expect(merged.notes).toContain("returned no content");
	});

	it("says nothing for no workers", () => {
		expect(mergeWorkDigests([])).toEqual({});
	});
});

describe("the section list", () => {
	// The compaction prompt names these headings, and the digest has to use the
	// same ones or the two artifacts stop being one artifact.
	it("matches the compaction note's headings", () => {
		expect(WORK_DIGEST_SECTIONS.map((section) => section.heading)).toEqual([
			"Goal",
			"Done",
			"In progress",
			"Ruled out",
			"Key facts",
			"Next",
		]);
	});
});
