import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createStalledChecks,
	DEFAULT_MAX_CHECKS_BEFORE_SETTLING,
	DEFAULT_MAX_CHECKS_WITHOUT_EDIT,
	describeStalledCheckNudge,
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
	// Nudged at three, settled at five. Measured on the pandorum run of
	// 2026-09-13: eleven of eighteen check runs returned the previous answer
	// byte for byte, and what ended the loop was a sentence -- the guard quoting
	// the model's own "I'm stuck in an infinite loop of edits" back at it, after
	// which it converged in three minutes. Settling is a rollback, which is the
	// most expensive possible answer to "that check told you nothing new".
	it("nudges on the third failure, and not before", () => {
		const { counter } = source();

		expect(DEFAULT_MAX_CHECKS_WITHOUT_EDIT).toBe(3);
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("nudge");
	});

	it("settles only after two more stalled checks", () => {
		const { counter } = source();

		expect(DEFAULT_MAX_CHECKS_BEFORE_SETTLING).toBe(5);
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("nudge");
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("settle");
	});

	// The nudge is spent once per transaction. A guard that repeats itself every
	// third check is noise, and the model has already been told.
	it("does not nudge twice in one transaction", () => {
		const { counter } = source();

		counter.checked(false);
		counter.checked(false);
		expect(counter.checked(false)).toBe("nudge");
		counter.changed();
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("settle");
	});

	// The distinction the whole guard rests on. A transaction working its way
	// through several edits fails the task's own check after every one of them,
	// because the check only passes when the last fix lands -- and the model is
	// told to run it on the unmodified files before it edits at all. Counting
	// those would close a transaction one edit short of working.
	it("does not count failures that had a change between them", () => {
		const { counter } = source();

		for (const _ of [1, 2, 3, 4, 5]) {
			expect(counter.checked(false)).toBe("ok");
			counter.changed();
		}

		expect(counter.streak).toBe(0);
	});

	it("starts again after a passing check", () => {
		const { counter } = source();

		counter.checked(false);
		counter.checked(false);
		expect(counter.checked(true)).toBe("ok");
		expect(counter.streak).toBe(0);
		expect(counter.checked(false)).toBe("ok");
	});

	// Observed rather than announced, like the check-first gate next door: a
	// discarded transaction has to be able to see the failure the last one died
	// on, which means running the check again from a clean count.
	it("starts again when the transaction number moves", () => {
		const { state, counter } = source();

		counter.checked(false);
		counter.checked(false);
		state.transaction = 2;

		expect(counter.checked(false)).toBe("ok");
		expect(counter.streak).toBe(1);
	});

	it("takes the limit from the source when one is given", () => {
		const { counter } = source(2);

		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("nudge");
		expect(counter.checked(false)).toBe("ok");
		expect(counter.checked(false)).toBe("settle");
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

	// The nudge must not read as a verdict. Nothing has been judged, nothing
	// has been put back, and a message that sounds like a settlement would have
	// the model report a transaction that is still open.
	it("nudges without judging anything, and names a sharper instrument", () => {
		const message = describeStalledCheckNudge(3, "node run_game.js");

		expect(message).toContain("node run_game.js");
		expect(message).toContain("3 times");
		expect(message).toMatch(/check_file/);
		expect(message).not.toMatch(/judged|put back|discarded|rolled back/i);
	});
});
