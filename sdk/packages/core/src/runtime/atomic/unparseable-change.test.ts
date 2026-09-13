/**
 * The failure that is not about the fix.
 *
 * A check run against a file the engine refuses measures the refusal. On the
 * run this came from, the model read those verdicts as verdicts on its plan
 * and rewrote the plan, four times, over a missing bracket.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandOracle } from "./oracle";
import { TransactionController } from "./transaction-controller";
import {
	describeUnparseableChange,
	looksLikeSyntaxError,
} from "./unparseable-change";

/** One spare `}` at column 48 — refused by the parser and placed by the scan. */
const UNPARSEABLE = "dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n";

async function withWorkspace(
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-unparseable-"));
	try {
		await fs.writeFile(
			path.join(root, "game.js"),
			"function dDec(){ return 1; }\n",
			"utf8",
		);
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** Always fails, saying whichever thing the test wants it to say. */
function failingOracle(root: string, says: string): CommandOracle {
	return {
		label: "node game.js",
		command: "sh",
		args: ["-c", `echo ${JSON.stringify(says)}; exit 1`],
		cwd: root,
		reason: "the task's own check",
	};
}

describe("reading the check's output for a parse failure", () => {
	it("recognises what a runtime says when it refused the source", () => {
		expect(looksLikeSyntaxError("SyntaxError: Unexpected token '}'")).toBe(
			true,
		);
		expect(
			looksLikeSyntaxError('  File "m.py", line 4\n    invalid syntax'),
		).toBe(true);
	});

	// The scan is a heuristic and speaks up about files that run. A verdict is
	// the wrong place for a guess, so the check's own words are the gate.
	it("stays quiet about a check that failed for a real reason", () => {
		expect(looksLikeSyntaxError("AssertionError: expected 3 rows, got 4")).toBe(
			false,
		);
	});
});

describe("naming the file the check could not run", () => {
	it("names the file and where the fault is", () => {
		const notice = describeUnparseableChange(
			[{ path: "/w/game.js", text: UNPARSEABLE }],
			"/w",
		);

		expect(notice).toContain("game.js does not parse");
		expect(notice).toContain("line 1");
		expect(notice).toContain("`}` than `{`");
	});

	// By the time this is read the rollback has happened, so the column the
	// scan named belongs to a file that no longer exists. Handing that over as
	// an instruction spends the next transaction rather than saving one.
	it("does not prescribe an edit against a file that has been put back", () => {
		const notice = describeUnparseableChange(
			[{ path: "/w/game.js", text: UNPARSEABLE }],
			"/w",
		);

		expect(notice).not.toContain("start_column");
		expect(notice).not.toContain("send it as it stands");
	});

	it("says nothing when the changed files parse", () => {
		expect(
			describeUnparseableChange(
				[{ path: "/w/game.js", text: "function f(){ return 1; }\n" }],
				"/w",
			),
		).toBeNull();
	});
});

describe("a transaction discarded over a file that does not parse", () => {
	it("says so in the settlement, with the fault the check could not name", async () => {
		await withWorkspace(async (root) => {
			const controller = new TransactionController({
				workspaceRoot: root,
				maxChanges: 3,
				maxTransactions: 6,
				oracle: failingOracle(root, "SyntaxError: Unexpected token '}'"),
			});
			await controller.open();
			await fs.writeFile(path.join(root, "game.js"), UNPARSEABLE, "utf8");

			const settled = await controller.settle({ account: "tried it" });

			expect(settled.kept).toBe(false);
			expect(settled.message).toContain("game.js does not parse");
			expect(settled.message).toContain("`}` than `{`");
		});
	});

	it("says nothing when the check failed for its own reasons", async () => {
		await withWorkspace(async (root) => {
			const controller = new TransactionController({
				workspaceRoot: root,
				maxChanges: 3,
				maxTransactions: 6,
				oracle: failingOracle(root, "AssertionError: expected 3 rows, got 4"),
			});
			await controller.open();
			await fs.writeFile(path.join(root, "game.js"), UNPARSEABLE, "utf8");

			const settled = await controller.settle({ account: "tried it" });

			expect(settled.kept).toBe(false);
			expect(settled.message).not.toContain("does not parse");
		});
	});

	// The point of asking before the restore rather than after it.
	it("still puts the file back", async () => {
		await withWorkspace(async (root) => {
			const controller = new TransactionController({
				workspaceRoot: root,
				maxChanges: 3,
				maxTransactions: 6,
				oracle: failingOracle(root, "SyntaxError: Unexpected token '}'"),
			});
			await controller.open();
			await fs.writeFile(path.join(root, "game.js"), UNPARSEABLE, "utf8");

			await controller.settle({ account: "tried it" });

			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("function dDec(){ return 1; }\n");
		});
	});
});
