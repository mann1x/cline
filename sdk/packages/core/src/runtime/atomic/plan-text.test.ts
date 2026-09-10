import { describe, expect, it } from "vitest";
import { readPlan } from "./plan-text";

/**
 * The four plans below are verbatim reasoning from one manic_miner session
 * (jackdelta-9b, 2026-09-10, session 1789032320523_q29ta, assistant messages
 * 7, 61, 77 and 79). Every one of those messages had a reply of zero
 * characters, which is the whole reason this file exists — so the fixtures are
 * the real thing rather than a tidied-up idea of it, table and all.
 */

const NUMBERED_WITH_HEADING = `Plan for TX-01 (at most 6 changes):

1. **WHERE**: Line 90, inside \`dDec\` method — the closing brace \`}\` at column 382
   **WHAT**: Delete that extra \`}\`
   **WHY**: The delimiter scan says line 90 has one more \`}\` than \`{\`

2. **WHERE**: Line 95, inside \`dBoss\` method — the closing brace \`}\` at column 494
   **WHAT**: Delete that extra \`}\`
   **WHY**: The delimiter scan says line 95 has one more \`}\` than \`{\`

After these bracket fixes, re-run the check.`;

const PROSE_THEN_PLAN = `I see the file now. Looking at line 90, the issue is that the \`else\` block lacks an opening brace after it, and the closing braces are wrong. Let me fix these:

Plan (TX-01):
1. **WHERE**: Line 90, \`dDec\` method
   **WHAT**: Replace \`else{...});};\` with \`else { ... };\`
   **WHY**: The linter reports a missing \`{\` at column 34

2. **WHERE**: Line 111, enemy forEach
   **WHAT**: Add the missing closing brace \`};\` at end of line
   **WHY**: Linter reports missing \`}\` for the forEach loop

Let me apply these changes:`;

const MARKDOWN_TABLE = `I need to restore the original file and start fresh.

# TX-01 Plan

**Symptom**: The linter reports bracket imbalance starting at line 90.

| # | WHERE | WHAT | WHY |
|---|-------|------|-----|
| 1 | Line 90 | Remove the trailing \`};\` | The inner \`forEach\` closes with \`});\` |
| 2 | Line 111 | Remove one \`}\` leaving \`}}\` | A third is a stray brace |

I'll make both edits now.`;

const BOLD_HEADING = `I see the file now. The issue is on line 90.

**TX-01 Plan:**

1. **WHERE**: Line 90, \`dDec\` method - \`else if(d.tp==='msh')\`
   **WHAT**: Add \`{\` after \`else if(d.tp==='msh')\`
   **WHY**: The linter reports "Declaration or statement expected" at column 381.`;

describe("readPlan", () => {
	it("finds a numbered plan under its own heading", () => {
		const plan = readPlan(NUMBERED_WITH_HEADING);

		expect(plan).toContain("Plan for TX-01");
		expect(plan).toContain("Line 90");
		expect(plan).toContain("Line 95");
	});

	// The plan is buried in reasoning, which is the case that matters: it must
	// start at the heading and not drag the paragraph above it along.
	it("starts at the heading, not at the reasoning before it", () => {
		const plan = readPlan(PROSE_THEN_PLAN) ?? "";

		expect(plan.startsWith("Plan (TX-01):")).toBe(true);
		expect(plan).not.toContain("I see the file now");
		expect(plan).toContain("Line 111");
	});

	// One of the four real plans was a table. A recogniser that only knew
	// numbered lists would have found nothing in the message that stated the
	// clearest plan of the run.
	it("reads a plan laid out as a markdown table", () => {
		const plan = readPlan(MARKDOWN_TABLE) ?? "";

		expect(plan).toContain("# TX-01 Plan");
		expect(plan).toContain("| # | WHERE | WHAT | WHY |");
		expect(plan).toContain("Line 111");
		expect(plan).not.toContain("I need to restore");
	});

	it("reads a bolded heading", () => {
		const plan = readPlan(BOLD_HEADING) ?? "";

		expect(plan.startsWith("**TX-01 Plan:**")).toBe(true);
		expect(plan).toContain("Declaration or statement expected");
	});

	// A plan needs no announcement if its entries name the three things.
	it("finds an unannounced list that names all three", () => {
		const plan = readPlan(
			"1. WHERE: line 4. WHAT: delete the brace. WHY: it closes nothing.",
		);

		expect(plan).toContain("delete the brace");
	});

	// The false positives, which are the real risk: this text is written into
	// the transaction record and shown to the user as the model's plan.
	it("refuses prose that only talks about planning", () => {
		expect(
			readPlan(
				"I should plan this carefully. I know where the fault is and what to do about it, and why it matters.",
			),
		).toBeUndefined();
	});

	it("refuses a list that does not name where, what and why", () => {
		expect(
			readPlan("1. Read the file\n2. Fix the brace\n3. Run the check"),
		).toBeUndefined();
	});

	// The one the first draft of these tests missed: an announced plan whose
	// body is a sentence. It names all three words, so only the demand for list
	// or table structure keeps it out.
	it("refuses a heading followed by prose", () => {
		expect(
			readPlan(
				"# TX-01 Plan\n\nI will change where the stray brace is, what it closes, and why that matters.",
			),
		).toBeUndefined();
	});

	it("refuses a plan heading with nothing under it", () => {
		expect(readPlan("# TX-01 Plan\n\nI am not sure yet.")).toBeUndefined();
	});

	it("says nothing for nothing", () => {
		expect(readPlan(undefined)).toBeUndefined();
		expect(readPlan("")).toBeUndefined();
		expect(readPlan("   \n  \n")).toBeUndefined();
	});

	// Reasoning runs long. A plan is a plan; a transcript pasted into the chat
	// is not, and this is what stops one becoming the other.
	it("caps a runaway block", () => {
		const entry = "1. WHERE: line 4 WHAT: delete WHY: it closes nothing\n";
		const plan = readPlan(`Plan:\n${entry.repeat(400)}`) ?? "";

		expect(plan.length).toBeLessThanOrEqual(4002);
		expect(plan.endsWith("…")).toBe(true);
	});
});
