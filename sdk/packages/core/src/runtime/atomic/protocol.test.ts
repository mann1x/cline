import { describe, expect, it } from "vitest";
import type { Oracle } from "./oracle";
import { buildProtocolPrompt, describeVerdict } from "./protocol";

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
