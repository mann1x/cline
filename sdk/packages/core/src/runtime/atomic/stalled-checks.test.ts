import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createStalledChecks,
	DEFAULT_MAX_CHECKS_WITHOUT_EDIT,
	describeStalledChecks,
	withChangeSignal,
} from "./stalled-checks";

/** A source whose transaction number the test moves by hand. */
function source(max?: number) {
	const state = { transaction: 1 };
	return {
		state,
		counter: createStalledChecks({
			get transaction() {
				return state.transaction;
			},
			...(max === undefined ? {} : { max }),
		}),
	};
}

describe("counting checks over files nobody changed", () => {
	it("fires on the third failure and not the second", () => {
		const { counter } = source();

		expect(DEFAULT_MAX_CHECKS_WITHOUT_EDIT).toBe(3);
		expect(counter.checked(false)).toBe(false);
		expect(counter.checked(false)).toBe(false);
		expect(counter.checked(false)).toBe(true);
	});

	// The distinction the whole guard rests on. A transaction working its way
	// through several edits fails the task's own check after every one of them,
	// because the check only passes when the last fix lands -- and the model is
	// told to run it on the unmodified files before it edits at all. Counting
	// those would close a transaction one edit short of working.
	it("does not count failures that had a change between them", () => {
		const { counter } = source();

		for (const _ of [1, 2, 3, 4, 5]) {
			expect(counter.checked(false)).toBe(false);
			counter.changed();
		}

		expect(counter.streak).toBe(0);
	});

	it("starts again after a passing check", () => {
		const { counter } = source();

		counter.checked(false);
		counter.checked(false);
		expect(counter.checked(true)).toBe(false);
		expect(counter.streak).toBe(0);
		expect(counter.checked(false)).toBe(false);
	});

	// Observed rather than announced, like the check-first gate next door: a
	// discarded transaction has to be able to see the failure the last one died
	// on, which means running the check again from a clean count.
	it("starts again when the transaction number moves", () => {
		const { state, counter } = source();

		counter.checked(false);
		counter.checked(false);
		state.transaction = 2;

		expect(counter.checked(false)).toBe(false);
		expect(counter.streak).toBe(1);
	});

	it("takes the limit from the source when one is given", () => {
		const { counter } = source(2);

		expect(counter.checked(false)).toBe(false);
		expect(counter.checked(false)).toBe(true);
	});
});

describe("hearing about a change", () => {
	function tools(seen: string[]): AgentTool<unknown, unknown>[] {
		return ["editor", "apply_patch", "restore_file", "read_files"].map(
			(name) =>
				({
					name,
					description: name,
					inputSchema: {},
					execute: async () => {
						seen.push(name);
						return name;
					},
				}) as unknown as AgentTool<unknown, unknown>,
		);
	}

	async function call(name: string, onChange: () => void): Promise<string[]> {
		const seen: string[] = [];
		const wrapped = withChangeSignal(tools(seen), onChange);
		const tool = wrapped.find((entry) => entry.name === name);
		if (!tool) {
			throw new Error(`no ${name} tool`);
		}
		await tool.execute({}, {} as never);
		return seen;
	}

	it.each([
		"editor",
		"apply_patch",
		"restore_file",
	])("counts %s as a change", async (name) => {
		let changes = 0;
		const seen = await call(name, () => {
			changes += 1;
		});

		expect(changes).toBe(1);
		// Wrapped, not replaced: the tool still ran.
		expect(seen).toEqual([name]);
	});

	// Reading is not changing. A model that reads the same file between two
	// checks has learned nothing the check did not already tell it, which is
	// exactly the loop being counted.
	it("does not count a read", async () => {
		let changes = 0;
		await call("read_files", () => {
			changes += 1;
		});

		expect(changes).toBe(0);
	});
});

describe("what the model is told", () => {
	it("names the check and how many times it ran", () => {
		const message = describeStalledChecks(3, "node run_game.js");

		expect(message).toContain("node run_game.js");
		expect(message).toContain("3 times");
		expect(message).toContain("have not changed");
	});
});
