/**
 * The transaction that moved the problem without solving it.
 *
 * Measured on the pandorum run of 2026-09-13: the fix needed three separate
 * repairs on three lines, and each was found because the one before it had
 * changed what the parser complained about. A plain rollback discards all
 * three and re-derives them from the same starting file, which is what the
 * protocol-armed runs of the same task spend their clock on -- 189 and 177
 * editor calls against 33, and 26 and 35 rollbacks.
 *
 * The guard on all of it is that the check has repeated itself at least once,
 * so "it has never said this before" is a fact about the files rather than
 * about a timestamp in the output.
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
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-carried-"));
	try {
		await fs.writeFile(path.join(root, "game.js"), "A\n", "utf8");
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** Fails always, and says exactly what the file says, so novelty tracks bytes. */
function echoesTheFile(root: string): CommandOracle {
	return {
		label: "node game.js",
		command: "sh",
		args: ["-c", `cat ${path.join(root, "game.js")}; exit 1`],
		cwd: root,
		reason: "the task's own check",
	};
}

/**
 * Fails always, and says something different every single run -- a check that
 * prints a duration, a timestamp or a seed. The counter lives outside the
 * workspace so the snapshot never sees it.
 */
async function neverRepeats(root: string): Promise<CommandOracle> {
	const counter = path.join(
		await fs.mkdtemp(path.join(os.tmpdir(), "atomic-counter-")),
		"n",
	);
	return {
		label: "node game.js",
		command: "sh",
		args: [
			"-c",
			`n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; echo "run $n"; exit 1`,
		],
		cwd: root,
		reason: "the task's own check",
	};
}

function controllerOn(
	root: string,
	oracle: CommandOracle,
	maxTransactions = 6,
): TransactionController {
	return new TransactionController({
		workspaceRoot: root,
		maxChanges: 3,
		maxTransactions,
		oracle,
	});
}

/** Run the check twice over the same bytes, which is what proves it repeats. */
async function establishTheCheckRepeats(
	controller: TransactionController,
): Promise<void> {
	await controller.runCheck();
	await controller.runCheck();
}

async function readGame(root: string): Promise<string> {
	return await fs.readFile(path.join(root, "game.js"), "utf8");
}

describe("a failing transaction whose check said something new", () => {
	it("keeps the work on disk and says the answer moved", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, echoesTheFile(root));
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");

			const settled = await controller.settle({ account: "tried it" });

			expect(settled.kept).toBe(false);
			expect(settled.message).toContain("carried");
			expect(await readGame(root)).toBe("B\n");
		});
	});

	// It is not a pass, and the sentence must not read like one.
	it("says plainly that nothing has verified the work", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, echoesTheFile(root));
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");

			const settled = await controller.settle({ account: "tried it" });

			expect(settled.message).toContain("Nothing has verified them");
			expect(settled.message).not.toContain("kept");
		});
	});

	it("rolls back when the check repeated an answer it had already given", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, echoesTheFile(root));
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "A\n", "utf8");
			await fs.writeFile(path.join(root, "other.js"), "new file\n", "utf8");

			const settled = await controller.settle({ account: "tried it" });

			expect(settled.message).toContain("discarded");
			expect(await readGame(root)).toBe("A\n");
			await expect(
				fs.readFile(path.join(root, "other.js"), "utf8"),
			).rejects.toThrow();
		});
	});

	// The trap the codebase already documents from the other direction: a check
	// that prints a clock says something new every run, and treating that as
	// progress would mean nothing is ever rolled back again.
	it("rolls back when the check has never repeated itself", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, await neverRepeats(root));
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");

			const settled = await controller.settle({ account: "tried it" });

			expect(settled.message).toContain("discarded");
			expect(await readGame(root)).toBe("A\n");
		});
	});

	it("rolls back a settlement the model did not ask for", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, echoesTheFile(root));
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");

			await controller.settle({ account: "tried it", forced: true });

			expect(await readGame(root)).toBe("A\n");
		});
	});

	// There is no next transaction to open on top of the work, and a run that
	// ended by leaving unverified changes behind is worse than one that did not.
	it("rolls back the last transaction whatever the check said", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, echoesTheFile(root), 1);
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");

			await controller.settle({ account: "tried it" });

			expect(await readGame(root)).toBe("A\n");
		});
	});
});

describe("what a carried transaction leaves behind it", () => {
	// The rollback target does not move. Unverified work never accumulates past
	// one discard, however many transactions carried before it.
	it("puts back everything since the last verified state on the next discard", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, echoesTheFile(root));
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");
			const carried = await controller.settle({ account: "moved it" });
			expect(carried.message).toContain("carried");

			// An answer the run has already seen, so this one is discarded.
			await fs.writeFile(path.join(root, "game.js"), "A\n", "utf8");
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");
			await fs.writeFile(path.join(root, "game.js"), "A\n", "utf8");
			await controller.settle({ account: "tried again" });

			expect(await readGame(root)).toBe("A\n");
		});
	});

	// The next transaction opens over files that are already changed, and an
	// empty one still has to read as empty -- it is the question that decides
	// whether a transaction is judged at all.
	it("still reports a transaction nobody touched as untouched", async () => {
		await withWorkspace(async (root) => {
			const controller = controllerOn(root, echoesTheFile(root));
			await controller.open();
			await establishTheCheckRepeats(controller);
			await fs.writeFile(path.join(root, "game.js"), "B\n", "utf8");
			await controller.settle({ account: "moved it" });

			await expect(controller.isUntouched()).resolves.toBe(true);
		});
	});
});
