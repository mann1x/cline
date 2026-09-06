/**
 * Giving back a check that has never passed.
 *
 * The freeze on a model-proposed check is load-bearing — a model that may
 * re-propose after a failed transaction will weaken the check until one passes
 * — but a check that cannot pass at all freezes the run into failure instead.
 * Measured over ten runs on one workspace, that took two of them: one froze a
 * check keyed on a field no correct fix produces, one froze a `node -e` whose
 * program was not valid JavaScript. Both spent every transaction they had, and
 * the second proposed the correct check twice and was refused both times.
 *
 * So the crack is exactly one replacement, and every clause below is what
 * keeps it from becoming the weakening the freeze exists to stop.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandOracle } from "./oracle";
import { TransactionController } from "./transaction-controller";

async function withWorkspace(
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-reconsider-"));
	try {
		await fs.writeFile(path.join(root, "game.js"), "broken", "utf8");
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** Passes only when the file says the word. `never` is the unsatisfiable one. */
function saysOracle(root: string, needle: string): CommandOracle {
	return {
		label: `grep ${needle}`,
		command: "sh",
		args: ["-c", `grep -q ${needle} ${path.join(root, "game.js")}`],
		cwd: root,
		reason: "proposed for this task and approved by you",
	};
}

function controllerOn(
	root: string,
	options: { after?: number; maxTransactions?: number; oracle?: CommandOracle },
): TransactionController {
	return new TransactionController({
		workspaceRoot: root,
		maxChanges: 3,
		maxTransactions: options.maxTransactions ?? 6,
		allowCheckProposal: true,
		checkReconsideredAfter: options.after ?? 2,
		...(options.oracle ? { oracle: options.oracle } : {}),
	});
}

/**
 * One attempt that really changes a file and then fails the check.
 *
 * `settle` opens the next transaction itself and returns its rules, which is
 * the flow the host drives: nothing calls `open` after a discard.
 */
async function discardOne(
	controller: TransactionController,
	root: string,
	body: string,
): Promise<string> {
	await fs.writeFile(path.join(root, "game.js"), body, "utf8");
	const settled = await controller.settle({ account: "tried it" });
	return settled.kept ? "" : (settled.nextPrompt ?? "");
}

describe("a check that has never passed", () => {
	it("is offered back after the configured number of discarded attempts", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 2 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "never"));
			expect(controller.checkIsUnderReconsideration).toBe(false);

			await discardOne(controller, root, "attempt one");
			// One discard is not enough: an unlucky attempt is not evidence.
			expect(controller.checkIsUnderReconsideration).toBe(false);

			const rules = await discardOne(controller, root, "attempt two");

			expect(controller.checkIsUnderReconsideration).toBe(true);
			expect(controller.canAdoptOracle).toBe(true);
			expect(rules).toContain("THE CHECK HAS NEVER PASSED");
		});
	});

	// The whole point of the condition. A check that passed once is a check
	// that can be satisfied, and the failures after it are the model's.
	it("is not offered back once it has passed, even if it fails afterwards", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 1 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "fixed"));
			await fs.writeFile(path.join(root, "game.js"), "fixed", "utf8");
			const kept = await controller.settle({ account: "done" });
			expect(kept.kept).toBe(true);
			// A kept transaction ends the task, so the failures come first.
			await controller.open();
			await discardOne(controller, root, "broken again");
			await discardOne(controller, root, "still broken");

			expect(controller.checkIsUnderReconsideration).toBe(false);
		});
	});

	// A pass seen from `run_check` counts. It answers the same question, and
	// the model reaching it there is the loop this protocol wants.
	it("counts a pass seen from run_check", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 1 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "fixed"));
			await fs.writeFile(path.join(root, "game.js"), "fixed", "utf8");
			await controller.runCheck();
			await discardOne(controller, root, "broken");

			expect(controller.checkIsUnderReconsideration).toBe(false);
		});
	});

	// Counting an empty attempt would let a model that edits nothing buy its
	// way back to a fresh proposal, which is the weakening being guarded.
	it("does not count an attempt that changed nothing", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 2 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "never"));

			await controller.settle({ account: "nothing to do" });
			await controller.settle({ account: "still nothing" });

			expect(controller.checkIsUnderReconsideration).toBe(false);
		});
	});

	it("is offered once and not again", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 1 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "never"));
			await discardOne(controller, root, "one");
			expect(controller.checkIsUnderReconsideration).toBe(true);

			// The replacement is no better, and there is no third go.
			controller.adoptOracle(saysOracle(root, "alsonever"));
			await discardOne(controller, root, "two");
			await discardOne(controller, root, "three");

			expect(controller.checkIsUnderReconsideration).toBe(false);
		});
	});
});

describe("what is never reconsidered", () => {
	// The user's own check is the specification. Handing the model a way to
	// disagree with it is not a safety valve, it is a bug.
	it("leaves a check the user configured alone", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, {
				after: 1,
				oracle: saysOracle(root, "never"),
			});
			await controller.open();
			await discardOne(controller, root, "one");
			await discardOne(controller, root, "two");

			expect(controller.checkIsUnderReconsideration).toBe(false);
			expect(controller.canAdoptOracle).toBe(false);
		});
	});

	it("does nothing at all when the setting is zero", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 0 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "never"));
			await discardOne(controller, root, "one");
			await discardOne(controller, root, "two");
			await discardOne(controller, root, "three");

			expect(controller.checkIsUnderReconsideration).toBe(false);
			expect(controller.canAdoptOracle).toBe(false);
		});
	});

	// `maxTransactions` is a setting. A fixed threshold of two would fire on
	// the last attempt of a three-attempt task, where a replacement judges
	// nothing, so the threshold is bounded by the budget it is spent from.
	it("never fires on the last transaction", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 2, maxTransactions: 2 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "never"));
			await discardOne(controller, root, "one");

			// TX-02 of 2: the threshold clamped to 1 and was met, and it is
			// still refused because nothing would judge the replacement.
			expect(controller.transaction).toBe(2);
			expect(controller.checkIsUnderReconsideration).toBe(false);
		});
	});
});

describe("what the record of earlier attempts concludes", () => {
	// It used to close every reopened transaction with "the previous reading of
	// it was wrong" -- which told two measured runs, six times each, that the
	// fault was their diagnosis when the fault was the check.
	it("stops blaming the reading when the check has never passed", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 0 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "never"));
			const rules = await discardOne(controller, root, "one");

			expect(rules).toContain("the check itself is not asking for what a fix");
			expect(rules).not.toContain("the previous reading of it was wrong");
		});
	});

	it("still blames the reading when the check has passed before", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, { after: 0 });
			await controller.open();
			controller.adoptOracle(saysOracle(root, "fixed"));
			await fs.writeFile(path.join(root, "game.js"), "fixed", "utf8");
			await controller.settle({ account: "done" });
			await controller.open();
			const rules = await discardOne(controller, root, "broken again");

			expect(rules).toContain("the previous reading of it was wrong");
		});
	});
});
