import { describe, expect, it } from "vitest";
import {
	DEFAULT_FULL_COMPACTION_PROMPT,
	FULL_COMPACTION_SECTIONS,
} from "./full-compaction";

const prompt = DEFAULT_FULL_COMPACTION_PROMPT;
const lower = prompt.toLowerCase();

describe("the full-compaction prompt", () => {
	it("says the transcript is gone, at the top, unmissably", () => {
		// Crush, Gemini CLI and opencode all lead with this, and it is the one
		// fact that changes how the model writes: a summary it believes is a
		// convenience is written differently from one it knows is the only
		// record left.
		const opening = prompt.slice(0, 600).toLowerCase();
		expect(opening).toMatch(/only|nothing else|discarded|lost/);
	});

	it("frames the reader as an agent resuming, not a person reading a report", () => {
		expect(lower).toMatch(
			/resum|continue the work|hand(?:ing|s)? over|handoff/,
		);
	});

	it("carries every section the sources converge on", () => {
		// Goal and Next appear in 16 of 16 harness prompts surveyed; the rest
		// are the convergent core plus the negative slot.
		for (const section of FULL_COMPACTION_SECTIONS) {
			expect(prompt).toContain(section);
		}
		expect(FULL_COMPACTION_SECTIONS.length).toBeGreaterThanOrEqual(6);
	});

	it("keeps a slot for what did not work", () => {
		// The measured failure is regressive exploration: after compaction the
		// agent re-issues actions that were already refused. Without a negative
		// slot there is nothing in the summary to stop it.
		expect(prompt).toMatch(/## (Ruled out|Failures|What did not work)/);
	});

	it("forbids mislabelling finished work as pending", () => {
		// arXiv 2608.06503: the summary condition terminates in 44.6% of
		// samples against 77.2% for plain truncation, because the agent loses
		// track of where in the process it is.
		expect(lower).toMatch(/finished|completed|done/);
		expect(lower).toMatch(
			/not .*(pending|unfinished|still to do)|do not describe/,
		);
	});

	it("demands verbatim carry for the things that cannot be summarised", () => {
		// arXiv 2608.01326: set membership over an enumerated list degrades to
		// near chance. Identifiers and checklists must be copied, not described.
		expect(lower).toContain("verbatim");
		expect(lower).toMatch(/identifier|id\b|checklist|list/);
	});

	it("requires every section to appear even when empty", () => {
		// The structural lever. Length adjectives are nearly inert
		// (arXiv 2605.23296), so completeness is enforced by schema instead.
		expect(lower).toMatch(/\(none\)|even when empty|every section/);
	});

	it("asks for a retrospective of the reasoning, as a required section", () => {
		expect(prompt).toContain("## Retrospective");
	});

	it("forbids calling tools, and says what it costs", () => {
		// The most common concrete failure in practice; Claude Code says it
		// three times and names the consequence.
		expect(lower).toMatch(/tool/);
		expect(lower).toMatch(/do not call|must not call|no tool calls/);
	});

	it("says the request is a system operation, not the user's latest turn", () => {
		// Otherwise "Next step" becomes "write a summary".
		expect(lower).toMatch(
			/system operation|not a (?:new )?(?:user )?(?:message|request|turn)/,
		);
	});

	it("forbids inventing what it cannot recall", () => {
		expect(lower).toMatch(/do not invent|never invent|do not fabricate/);
	});

	it("is task-agnostic", () => {
		// Cline is given jobs that are not programming; every coding-specific
		// noun here would be a lie about half the sessions it summarises.
		expect(lower).not.toContain("coding");
		expect(lower).not.toContain("codebase");
		expect(lower).not.toContain("programming");
		expect(lower).not.toContain("developer");
	});

	it("does not try to control length with an adjective", () => {
		// The measured non-lever. If this ever reads "be thorough" or "be
		// concise" again, the schema is doing the work and the adjective is
		// decoration that mostly does not move the output.
		expect(lower).not.toMatch(
			/be (?:very )?(?:thorough|concise|detailed|brief)/,
		);
	});
});
