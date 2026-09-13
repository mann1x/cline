import { describe, expect, it } from "vitest";
import type { TransactionOutcome } from "../atomic/protocol";
import { buildEscalationBrief } from "./brief";

const outcome = (
	over: Partial<TransactionOutcome> & { transaction: number },
): TransactionOutcome => ({
	kept: false,
	source: "oracle",
	evidence: "TypeError: cannot read property 'x' of undefined",
	...over,
});

describe("buildEscalationBrief", () => {
	// The expert starts with an empty context. Everything it is going to act on
	// is in this one message, so the goal has to survive into it unaltered --
	// paraphrasing the one sentence the base model wrote on purpose is the one
	// thing this builder must never do.
	it("states the goal and what the base model will accept, verbatim", () => {
		const brief = buildEscalationBrief({
			goal: "make the falling-block collision test pass",
			expectation: "run_game.js prints ok:true and the piece lands on row 19",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
		});

		expect(brief).toContain("make the falling-block collision test pass");
		expect(brief).toContain(
			"run_game.js prints ok:true and the piece lands on row 19",
		);
	});

	// Without it the expert is being asked to fix a symptom with no idea what
	// the user wanted, which is how an expensive model produces a correct change
	// to the wrong thing.
	it("carries the task as the user stated it", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			task: "The game freezes on level two. Make it playable.",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
		});

		expect(brief).toContain("The game freezes on level two. Make it playable.");
	});

	// The expert works inside the open transaction: the change budget is real
	// for it too, and the check it will be judged by is the only definition of
	// done that matters here.
	it("describes the open transaction, its budget and its check", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
			transaction: {
				transaction: 3,
				maxTransactions: 6,
				maxChanges: 6,
				changesUsed: 2,
				oracle: {
					kind: "command",
					label: "node run_game.js",
					cwd: "/work",
					command: "node",
					args: ["run_game.js"],
					reason: "named for this task",
				},
				history: [],
			},
		});

		expect(brief).toContain("TX-03");
		expect(brief).toContain("node run_game.js");
		// Four of six left, said as a number rather than left to arithmetic.
		expect(brief).toMatch(/4 (more )?changes?/i);
	});

	// A discarded transaction is invisible on disk -- the files are exactly as
	// they were before it. An expert that is not told what has already been
	// tried will re-derive the same plan from the same starting file, which is
	// the failure this record was added to the base model's own prompt to stop.
	it("carries what earlier transactions tried and what came back", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 2, of: 3 },
			followUpsAllowed: 20,
			transaction: {
				transaction: 3,
				maxTransactions: 6,
				maxChanges: 6,
				history: [
					outcome({
						transaction: 1,
						plan: "guard the array access in step()",
						evidence: "still throws on frame 2",
					}),
					outcome({
						transaction: 2,
						plan: "clamp the row index",
						evidence: "ok:false, piece never lands",
					}),
				],
			},
		});

		expect(brief).toContain("TX-01");
		expect(brief).toContain("guard the array access in step()");
		expect(brief).toContain("TX-02");
		expect(brief).toContain("ok:false, piece never lands");
	});

	// It has edit rights, so it has to know what happens to those edits. Inside
	// an open transaction a failing check throws the expert's work away with the
	// base model's, and an expert that does not know that will not re-check.
	it("tells an expert inside a transaction that its edits are judged and can be rolled back", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
			transaction: {
				transaction: 1,
				maxTransactions: 6,
				maxChanges: 6,
				history: [],
			},
		});

		expect(brief).toMatch(/rolled back|discarded|put back/i);
	});

	// And with the protocol off there is no transaction to be judged by: the
	// expert's edits are simply the state of the workspace. Escalation takes its
	// own snapshot in that case, so the sentence is still true -- but the
	// standard is different and saying "the check" would be a lie.
	it("tells an expert with no transaction that its edits stand, with a snapshot behind them", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
			snapshotTaken: true,
		});

		expect(brief).not.toContain("TX-");
		expect(brief).toMatch(/snapshot/i);
	});

	// The follow-up cap is the expert's budget as much as the base model's: an
	// expert that plans to deliver in five instalments needs to know it has one
	// conversation and how long it is.
	it("states how much conversation is left", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 2, of: 3 },
			followUpsAllowed: 20,
		});

		expect(brief).toContain("20");
	});

	// Phase-6 seam. The harness's own reading of the code is evidence the base
	// model cannot fake, and it belongs next to the goal rather than folded into
	// it, so the expert can weigh it separately from what it was told.
	it("includes the harness assessment when there is one, attributed to the harness", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
			assessment: "step() has a cognitive complexity of 41 across 6 branches",
		});

		expect(brief).toContain(
			"step() has a cognitive complexity of 41 across 6 branches",
		);
	});

	// Files the base model has been working in. Not a substitute for reading
	// them -- the expert has the tools -- but a starting point beats a search.
	it("names the files in play", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
			filesInPlay: ["src/game.js", "src/board.js"],
		});

		expect(brief).toContain("src/game.js");
		expect(brief).toContain("src/board.js");
	});

	// Nothing optional supplied: the brief still has to be a brief. A builder
	// that emits dangling headings for absent sections teaches the expert that
	// empty sections are normal, and it is the first escalation of a task with
	// no protocol that hits this path.
	it("emits no empty sections when only a goal was given", () => {
		const brief = buildEscalationBrief({
			goal: "fix the crash",
			escalation: { index: 1, of: 3 },
			followUpsAllowed: 20,
		});

		expect(brief).not.toContain("undefined");
		const lines = brief.split("\n");
		const heading = /^-- .* --$/;
		for (const [index, line] of lines.entries()) {
			if (!heading.test(line)) {
				continue;
			}
			const under = lines.slice(index + 1).find((rest) => rest.trim());
			expect(under, `nothing under ${line}`).toBeDefined();
			expect(under).not.toMatch(heading);
		}
	});
});
