import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Oracle } from "./oracle";
import {
	type AttemptContext,
	type AttemptResult,
	runAtomicTask,
	type TransactionEvent,
} from "./transaction-runner";

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-runner-"));
	try {
		for (const [name, body] of Object.entries(files)) {
			const full = path.join(root, name);
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, body, "utf8");
		}
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** An oracle that passes only once the file says what it is told to look for. */
function fileSaysOracle(root: string, needle: string): Oracle {
	return {
		label: `grep ${needle}`,
		command: process.execPath,
		args: [
			"-e",
			`const fs=require('fs');process.exit(fs.readFileSync(${JSON.stringify(path.join(root, "game.js"))},'utf8').includes(${JSON.stringify(needle)})?0:1)`,
		],
		cwd: root,
		reason: "test",
	};
}

describe("running a task in transactions", () => {
	it("keeps a transaction whose oracle passes", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const result = await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 6,
					oracle: fileSaysOracle(root, "fixed"),
				},
				async () => {
					await fs.writeFile(path.join(root, "game.js"), "fixed", "utf8");
					return {};
				},
			);

			expect(result.succeeded).toBe(true);
			expect(result.stopped).toBe("kept");
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("fixed");
		});
	});

	// The whole point: a failed transaction leaves nothing behind, so the next
	// attempt starts from the file as it was and not from the wreckage.
	it("puts every file back when the oracle fails", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const seen: string[] = [];
			await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 2,
					oracle: fileSaysOracle(root, "fixed"),
				},
				async () => {
					seen.push(await fs.readFile(path.join(root, "game.js"), "utf8"));
					await fs.writeFile(
						path.join(root, "game.js"),
						"still broken",
						"utf8",
					);
					await fs.writeFile(path.join(root, "scratch.js"), "junk", "utf8");
					return {};
				},
			);

			expect(seen).toEqual(["broken", "broken"]);
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("broken");
			await expect(fs.access(path.join(root, "scratch.js"))).rejects.toThrow();
		});
	});

	// Without the record a second attempt is indistinguishable from a first, and
	// the model re-derives the same plan from the same starting file.
	it("carries what the last transaction tried into the next one", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const prompts: string[] = [];
			await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 2,
					oracle: fileSaysOracle(root, "fixed"),
				},
				async (context: AttemptContext): Promise<AttemptResult> => {
					prompts.push(context.protocolPrompt);
					return { plan: `1. WHERE draw() WHAT swap ${context.transaction}` };
				},
			);

			expect(prompts[0]).not.toContain("WHAT EARLIER TRANSACTIONS TRIED");
			expect(prompts[1]).toContain("TX-01 — discarded");
			expect(prompts[1]).toContain("WHAT swap 1");
		});
	});

	it("stops after the last transaction it was given", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			let attempts = 0;
			const result = await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 3,
					oracle: fileSaysOracle(root, "fixed"),
				},
				async () => {
					attempts++;
					return {};
				},
			);

			expect(attempts).toBe(3);
			expect(result.stopped).toBe("exhausted");
			expect(result.transactions).toHaveLength(3);
		});
	});

	it("keeps the oracle's output as the record of the failure", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const result = await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 1,
					oracle: {
						label: "check",
						command: process.execPath,
						args: [
							"-e",
							"console.error('TypeError: x is not a function');process.exit(1)",
						],
						cwd: root,
						reason: "test",
					},
				},
				async () => ({}),
			);

			expect(result.transactions[0]?.evidence).toContain("TypeError");
		});
	});
});

describe("a workspace with nothing to run", () => {
	it("keeps the change when the model says it worked", async () => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			const result = await runAtomicTask(
				{ workspaceRoot: root, maxChanges: 3, maxTransactions: 2 },
				async () => {
					await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");
					return { selfReport: "success" as const };
				},
			);

			expect(result.succeeded).toBe(true);
			expect(result.transactions[0]?.source).toBe("self-declared");
			await expect(
				fs.readFile(path.join(root, "notes.md"), "utf8"),
			).resolves.toBe("after");
		});
	});

	// A model reporting its own doubt is real evidence about the change, so it
	// is treated the same as reporting failure.
	it.each([
		"failure",
		"unsure",
	] as const)("discards the change when the model reports %s", async (selfReport) => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			await runAtomicTask(
				{ workspaceRoot: root, maxChanges: 3, maxTransactions: 1 },
				async () => {
					await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");
					return { selfReport };
				},
			);

			await expect(
				fs.readFile(path.join(root, "notes.md"), "utf8"),
			).resolves.toBe("before");
		});
	});

	it("asks once when the model ended its turn without saying", async () => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			let asked = 0;
			await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 1,
					confirm: async () => {
						asked++;
						return "failure";
					},
				},
				async () => {
					await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");
					return {};
				},
			);

			expect(asked).toBe(1);
			await expect(
				fs.readFile(path.join(root, "notes.md"), "utf8"),
			).resolves.toBe("before");
		});
	});

	/**
	 * The report this came from (2026-09-04): a run ended "TX-01 kept
	 * self-declared" and the model had declared nothing anywhere in the
	 * transcript. It had been cut off after the no-tool-call nudges ran out,
	 * mid-edit, and the file it left behind did not parse.
	 */
	it("does not call an unspoken verdict self-declared", async () => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			const sources: string[] = [];
			await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 1,
					onEvent: (event: TransactionEvent) => {
						if (event.type === "settled") sources.push(event.source);
					},
				},
				async () => {
					await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");
					return {};
				},
			);

			expect(sources).toEqual(["undeclared"]);
		});
	});

	/**
	 * The nudge that produced this stop says, in as many words, "If the task
	 * really is finished, say so in one short sentence." A model that answers
	 * it has declared. Reported 2026-09-04 on 4.100.61, where a run closing
	 * "Task is finished - the file loads with zero JavaScript errors" was told
	 * it had been cut short before saying whether the change worked.
	 */
	it("treats a closing statement as a declaration even after a nudge", async () => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			const messages: string[] = [];
			const sources: string[] = [];
			await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 1,
					onEvent: (event: TransactionEvent) => {
						if (event.type === "settled") {
							messages.push(event.message);
							sources.push(event.source);
						}
					},
				},
				async () => {
					await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");
					return {
						account: "Task is finished - the file loads with zero errors.",
						forced: true,
					};
				},
			);

			expect(sources).toEqual(["self-declared"]);
			expect(messages[0]).not.toContain("cut short");
			expect(messages[0]).not.toContain("UNVERIFIED");
		});
	});

	it("says the run was cut short when that is why nothing was declared", async () => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			const messages: string[] = [];
			const result = await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 1,
					onEvent: (event: TransactionEvent) => {
						if (event.type === "settled") messages.push(event.message);
					},
				},
				async () => {
					await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");
					return { forced: true };
				},
			);

			expect(result.succeeded).toBe(true);
			expect(messages[0]).toContain("cut short");
			expect(messages[0]).toContain("UNVERIFIED");
			// The work still survives: destroying it because the runtime gave up
			// on the model would be the worse of the two failures.
			await expect(
				fs.readFile(path.join(root, "notes.md"), "utf8"),
			).resolves.toBe("after");
		});
	});

	// Silence is a reporting failure, not a statement about the change.
	// Discarding real work over a line the model forgot to write is the failure
	// a host-owned boundary exists to avoid.
	it("keeps a silent change rather than destroying it, and says it is unverified", async () => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			const messages: string[] = [];
			const result = await runAtomicTask(
				{
					workspaceRoot: root,
					maxChanges: 3,
					maxTransactions: 1,
					onEvent: (event: TransactionEvent) => {
						if (event.type === "settled") messages.push(event.message);
					},
				},
				async () => {
					await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");
					return {};
				},
			);

			expect(result.succeeded).toBe(true);
			// Kept, and said to be unverified rather than said to be declared:
			// a line reading "self-declared" over a change the model never
			// spoke about sends the reader hunting the transcript for a claim
			// that is not in it.
			expect(messages[0]).toContain("UNVERIFIED");
			expect(messages[0]).toContain("never stated to work");
			expect(messages[0]).not.toContain("self-declared");
			await expect(
				fs.readFile(path.join(root, "notes.md"), "utf8"),
			).resolves.toBe("after");
		});
	});
});

describe("a turn that was cut short", () => {
	// Rolling back here would destroy work the user interrupted for their own
	// reasons. The snapshot goes back to the host to offer as a choice instead.
	it("leaves the changes on disk and hands back the undo", async () => {
		await withWorkspace({ "game.js": "before" }, async (root) => {
			const result = await runAtomicTask(
				{ workspaceRoot: root, maxChanges: 3, maxTransactions: 3 },
				async () => {
					await fs.writeFile(path.join(root, "game.js"), "half done", "utf8");
					return { aborted: true };
				},
			);

			expect(result.stopped).toBe("aborted");
			expect(result.pending).toBeDefined();
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("half done");
		});
	});
});
