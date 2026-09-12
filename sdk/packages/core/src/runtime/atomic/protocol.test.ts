import { describe, expect, it } from "vitest";
import type { Oracle } from "./oracle";
import {
	buildEmptyAttemptPrompt,
	buildProtocolPrompt,
	describeVerdict,
	type TransactionOutcome,
} from "./protocol";

const oracle: Oracle = {
	label: "node run_game.js manic_miner.html",
	command: "sh",
	args: ["-c", "node run_game.js manic_miner.html"],
	cwd: "/tmp",
	reason: "named for this task",
};

describe("the rules put to the model", () => {
	it("states the change limit and asks for a plan before any edit", () => {
		const prompt = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 3,
			maxTransactions: 6,
			history: [],
		});

		expect(prompt).toContain("AT MOST 3 changes");
		expect(prompt).toContain("WHERE");
		expect(prompt).toContain("WHY");
	});

	// The model is never asked to undo its own edits: it is bad at it, and a
	// half-undone transaction is worse than the change it was reverting.
	it("says the rollback is done for the model, not by it", () => {
		const prompt = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 3,
			maxTransactions: 6,
			oracle,
			history: [],
		});

		expect(prompt).toContain("never be asked to undo an edit yourself");
	});

	it("names a task-specific oracle as the standard the change is held to", () => {
		const prompt = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 3,
			maxTransactions: 6,
			oracle,
			history: [],
		});

		expect(prompt).toContain("node run_game.js manic_miner.html");
		expect(prompt).toContain("named for this task");
	});

	it("tells the model it is the check when the workspace has none", () => {
		const prompt = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 3,
			maxTransactions: 6,
			history: [],
		});

		expect(prompt).toContain("you are the check");
	});

	it("says a discarded transaction's changes are gone", () => {
		const prompt = buildProtocolPrompt({
			transaction: 2,
			maxChanges: 3,
			maxTransactions: 6,
			oracle,
			history: [
				{
					transaction: 1,
					kept: false,
					source: "oracle",
					plan: "1. WHERE draw() WHAT clamp y",
					evidence: "TypeError: y is not a function",
				},
			],
		});

		expect(prompt).toContain("TX-01 — discarded");
		expect(prompt).toContain("clamp y");
		expect(prompt).toContain("TypeError");
		expect(prompt).toContain("Those changes are gone");
	});
});

describe("the line a transaction ends on", () => {
	it.each([
		{
			name: "a failing check",
			verdict: {
				passed: false,
				exitCode: 1,
				output: "",
				timedOut: false,
			},
			expected: "the check failed (exit 1)",
		},
		{
			name: "a check that never finished",
			verdict: {
				passed: false,
				exitCode: null,
				output: "",
				timedOut: true,
			},
			expected: "did not finish",
		},
		{
			name: "a check that could not run",
			verdict: {
				passed: false,
				exitCode: null,
				output: "",
				timedOut: false,
			},
			expected: "could not be run at all",
		},
	])("distinguishes $name", ({ verdict, expected }) => {
		const line = describeVerdict(1, false, "oracle", verdict);
		expect(line).toContain(expected);
		expect(line).toContain("back as they were");
	});
});

// ---------------------------------------------------------------------------
// A host-supplied check that has passed nothing
// ---------------------------------------------------------------------------

describe("the stuck host check notice", () => {
	const failed = (
		transaction: number,
		evidence: string,
	): TransactionOutcome => ({
		transaction,
		kept: false,
		source: "oracle",
		evidence,
	});
	const ERR = '{"ok":false,"error":"SyntaxError: Unexpected token \')\'"}';
	const build = (history: TransactionOutcome[], hostSuppliedCheck = true) =>
		buildProtocolPrompt({
			transaction: history.length + 1,
			maxChanges: 6,
			maxTransactions: 6,
			oracle,
			hostSuppliedCheck,
			history,
		});

	it("fires once the same output has been reported across three attempts", () => {
		const prompt = build([failed(1, ERR), failed(2, ERR), failed(3, ERR)]);

		expect(prompt).toContain("THE CHECK HAS JUDGED 3 ATTEMPTS AND PASSED NONE");
		expect(prompt).toContain("has not changed since TX-01");
		expect(prompt).toContain("across 3 attempts");
		expect(prompt).toContain("gate to mark the task completed successfully");
	});

	// The user's wording, and the reason for it: told the check *is* the task, a
	// model games the check instead of fixing the code.
	it("never suggests the check itself might be wrong", () => {
		const prompt = build([failed(1, ERR), failed(2, ERR), failed(3, ERR)]);

		expect(prompt).not.toContain("the check itself is not asking");
		expect(prompt).not.toContain("propose_check");
	});

	// Two failures is an ordinary run.
	it("stays quiet below three attempts", () => {
		expect(build([failed(1, ERR), failed(2, ERR)])).not.toContain(
			"PASSED NONE",
		);
	});

	// Output that changed is not reported at all: a check that prints a
	// duration or a seed changes every run, and calling that progress would
	// tell a model its edits are landing when nothing moved.
	it("says nothing when the last output differs from the one before", () => {
		const prompt = build([
			failed(1, ERR),
			failed(2, ERR),
			failed(
				3,
				'{"ok":false,"error":"ReferenceError: collide is not defined"}',
			),
		]);

		expect(prompt).not.toContain("PASSED NONE");
	});

	// It reports the current streak, not the longest one anywhere in history.
	it("counts back only as far as the streak reaches", () => {
		const prompt = build([
			failed(
				1,
				'{"ok":false,"error":"ReferenceError: collide is not defined"}',
			),
			failed(2, ERR),
			failed(3, ERR),
			failed(4, ERR),
		]);

		expect(prompt).toContain("has not changed since TX-02");
		expect(prompt).toContain("across 3 attempts");
	});

	// A check the model proposed keeps the old message, which offers that the
	// check may be replaceable — because there it is.
	it("does not fire for a check the model proposed", () => {
		expect(
			build([failed(1, ERR), failed(2, ERR), failed(3, ERR)], false),
		).not.toContain("PASSED NONE");
	});

	// A kept transaction means the check passed once, so the premise is gone.
	it("does not fire once anything has been kept", () => {
		const history = [failed(1, ERR), failed(2, ERR), failed(3, ERR)];
		history[0] = { ...history[0], kept: true };
		expect(build(history)).not.toContain("PASSED NONE");
	});

	/**
	 * Measured on a run that spent 5h06m and 766 turns without closing a
	 * transaction: 34 helper programs written, 95% of its edits to those rather
	 * than to the file the task named, and the check called 18 times in the
	 * whole run. Every step of it was permitted -- helpers written with
	 * `editor`, run with `run_commands` -- so the rule has to be stated.
	 */
	it("rules out substituting a program of your own for the check", () => {
		const prompt = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 3,
			maxTransactions: 6,
			oracle,
			history: [],
		});

		expect(prompt).toContain("cannot take its place");
		expect(prompt).toContain("only tell you what you already believe");
		// The recognisable moment, not just the principle: a model needs to know
		// when it is in the failure, not only that the failure exists.
		expect(prompt).toContain("more than one helper");
	});

	// The propose branch needs it for a sharper reason than the oracle branch:
	// the approved check is itself a program the model wrote, so "write a
	// program to decide" is the move it has just been rewarded for. What is
	// ruled out is a second one, run instead of the approved one.
	it("rules it out for a proposed check too, once approved", () => {
		const prompt = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 3,
			maxTransactions: 6,
			canProposeCheck: true,
			history: [],
		});

		expect(prompt).toContain("the only one that counts");
		expect(prompt).toContain("cannot take its place");
		expect(prompt).toContain("more than one");
	});

	// It is a rule about a named check, so it must not appear where the model
	// is the check and cannot name one -- there is nothing there to substitute
	// for, and the sentence would forbid the only thing such a run can do.
	it("says nothing about helpers when no check exists", () => {
		const selfChecked = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 3,
			maxTransactions: 6,
			history: [],
		});

		expect(selfChecked).toContain("you are the check");
		expect(selfChecked).not.toContain("cannot take its place");
		expect(selfChecked).not.toContain("more than one helper");
	});
});

/**
 * The regression this exists for. The first version of this message ended with
 * "if you have run out of ideas, say so plainly in one sentence and stop...
 * it is not counted against you", and on pandorum session
 * 1789114968332_v7fsq a 9B took that offer on its first empty attempt and
 * closed the run -- while claiming its edits had never matched, which the
 * transcript contradicts. Nothing tested this message, so nothing caught it.
 */
describe("buildEmptyAttemptPrompt", () => {
	const prompt = (transaction: number, maxTransactions = 6) =>
		buildEmptyAttemptPrompt({
			transaction,
			maxChanges: 3,
			maxTransactions,
		});

	it("never offers stopping as an option", () => {
		const text = prompt(1);

		expect(text).not.toMatch(/run out of ideas/i);
		expect(text).not.toMatch(/and stop\b/i);
		expect(text).not.toMatch(/not counted against you/i);
		expect(text).not.toMatch(/worth more than another empty/i);
	});

	it("counts the remaining transactions out loud", () => {
		expect(prompt(1)).toContain("you have 6 left");
		expect(prompt(1)).toContain("TX-01 of 6");
		expect(prompt(4)).toContain("you have 3 left");
	});

	// The open transaction counts as available: it was not spent.
	it("says so plainly when only the last one is left", () => {
		const text = prompt(6);

		expect(text).toContain("TX-06 is the last transaction you have");
		expect(text).not.toContain("left, counting this one");
	});

	it("tells it to keep going and what the next step is", () => {
		const text = prompt(2);

		expect(text).toMatch(/keep going/i);
		expect(text).toContain("AT MOST 3 changes");
		expect(text).toMatch(/WHERE, WHAT and WHY/);
	});

	// The measured cause of the empty transaction in that session: five
	// consecutive editor refusals for an `old_text` disagreeing with the line
	// range. The refusal already says so; the model read it five times and
	// changed nothing.
	it("points at the refusal rather than at another read", () => {
		const text = prompt(1);

		expect(text).toMatch(/old_text/);
		expect(text).toMatch(/line range/i);
		expect(text).toMatch(/linter/i);
	});
});

/**
 * What counts as a change.
 *
 * Measured on pandorum session 1789122866533_br1d0: the model spent one of its
 * numbered changes on "Run check_file then node run_game.js to verify fix
 * passes /\"ok\":true/". That edits nothing, and nothing in the protocol ruled
 * it out — it asked for WHERE/WHAT/WHY and got three plausible answers.
 */
describe("what the protocol counts as a change", () => {
	it("says a change is an edit and a check is not one", () => {
		const prompt = buildProtocolPrompt({
			transaction: 1,
			maxChanges: 6,
			maxTransactions: 6,
			history: [],
		});

		expect(prompt).toContain("A change is an edit to a file");
		expect(prompt).toContain("must not take a number");
		// The budget is the reason it matters, so the prompt says the cheap
		// things are free rather than merely disallowed.
		expect(prompt).toContain("cost nothing from this budget");
	});
});
