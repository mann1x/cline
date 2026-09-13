import { describe, expect, it } from "vitest";
import { generatePromptTemplate } from "./prompt-template-review";

/**
 * The guard that says "you handed that back unchanged".
 *
 * A delta run is the one case where the checker knows what the model was shown,
 * and until 2026-09-13 it did not use that. The downstream verbatim rule
 * compares a section against the BUILT-IN description, so it fires only while
 * the section still holds the built-in text; once a section has been written by
 * anyone, an unchanged reply audits clean.
 *
 * `kimi-k3:cloud` demonstrated both halves. Six attempts on 2026-09-12 returned
 * the built-in `grep`/`sed`/`awk` text and were caught. One run on 2026-09-13
 * returned the hand-written replacements byte-for-byte and reported "clean on
 * attempt 2" -- the same behaviour, passing, because nothing compared the reply
 * to the input.
 */
const FAMILY_TEMPLATE = [
	"---",
	"name: sample",
	"match:",
	'  family: ["sample*"]',
	"---",
	"",
	"# system",
	"",
	"Some system guidance that this test does not exercise.",
	"",
	"# tool: grep",
	"",
	"Grep words that somebody already wrote for this family.",
	"",
].join("\n");

const GREP_BODY = "Grep words that somebody already wrote for this family.";

function run(reply: string) {
	return generatePromptTemplate({
		defaultTemplate: FAMILY_TEMPLATE,
		familyTemplate: FAMILY_TEMPLATE,
		providerId: "ollama",
		modelId: "sample:cloud",
		family: "sample",
		knownToolNames: ["grep"],
		onlyTools: ["grep"],
		attempts: 1,
		fileName: "sample.md",
		complete: async () => reply,
	});
}

describe("a delta reply that is the input verbatim", () => {
	it("is called out, naming the section", async () => {
		const result = await run(`# tool: grep\n\n${GREP_BODY}\n`);
		const said = result.audit.problems.join("\n");
		expect(said).toContain("'# tool: grep'");
		expect(said).toContain("exactly as it was handed over");
	});

	it("is still called out when the reply only differs in trailing whitespace", async () => {
		// Normalized comparison, so re-indenting is not a rewrite either.
		const result = await run(`# tool: grep\n\n${GREP_BODY}   \n\n`);
		expect(result.audit.problems.join("\n")).toContain(
			"exactly as it was handed over",
		);
	});

	it("says nothing when the section was actually rewritten", async () => {
		const result = await run(
			"# tool: grep\n\nSearch files for lines matching a pattern, in this process.\n",
		);
		expect(result.audit.problems.join("\n")).not.toContain(
			"exactly as it was handed over",
		);
	});
});
