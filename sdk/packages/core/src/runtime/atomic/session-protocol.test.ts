import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createAtomicProtocolSession,
	readSelfReport,
} from "./session-protocol";

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-session-"));
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

/** A command that passes only once the file says what it is told to look for. */
function shellCheck(root: string, needle: string): string {
	return `grep -q ${needle} ${path.join(root, "game.js")}`;
}

describe("arming the protocol for a session", () => {
	it("stays out of the way when it is off", async () => {
		await withWorkspace({}, async (root) => {
			expect(
				await createAtomicProtocolSession({ workspaceRoot: root, config: {} }),
			).toBeUndefined();
		});
	});

	// The whole reason the protocol exists is that a model's account of its own
	// change and the program disagree. Engaging with only the account to go on
	// buys the cost and not the verdict.
	it("declines auto in a workspace with nothing to run, and says why", async () => {
		await withWorkspace({ "notes.md": "# hello" }, async (root) => {
			const logged: string[] = [];
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto" },
				logger: { log: (message) => logged.push(message) },
			});

			expect(session).toBeUndefined();
			expect(logged[0]).toContain("Stood down");
		});
	});

	it("engages always in the same workspace, with the model as the check", async () => {
		await withWorkspace({ "notes.md": "# hello" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
			});

			expect(session?.oracle).toBeUndefined();
			expect(session?.takeOpeningRules()).toContain("you are the check");
		});
	});

	it("judges by the command the user wrote for this task", async () => {
		await withWorkspace(
			{ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) },
			async (root) => {
				const session = await createAtomicProtocolSession({
					workspaceRoot: root,
					config: { mode: "auto", oracleCommand: "node run_game.js" },
				});

				expect(session?.oracle?.label).toBe("node run_game.js");
				expect(session?.takeOpeningRules()).toContain("node run_game.js");
			},
		);
	});
});

describe("the boundary", () => {
	it("lets a task that changed nothing end without running the check", async () => {
		await withWorkspace({ "game.js": "fine" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: {
					mode: "auto",
					// Fails if it is ever run, which is the point of the assertion.
					oracleCommand: "exit 1",
				},
			});

			await expect(
				session?.onCompletionAttempt({ text: "That file draws the sprite." }),
			).resolves.toBeUndefined();
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("fine");
		});
	});

	it("lets the run end when the check passes", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});
			await fs.writeFile(path.join(root, "game.js"), "fixed", "utf8");

			await expect(
				session?.onCompletionAttempt({ text: "Fixed." }),
			).resolves.toBeUndefined();
		});
	});

	it("puts the files back and reopens when the check fails", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});
			await fs.writeFile(path.join(root, "game.js"), "still broken", "utf8");

			const message = await session?.onCompletionAttempt({ text: "Fixed." });

			expect(message).toContain("TX-01 discarded");
			// The reopened transaction's rules, in full, on this message.
			expect(message).toContain("This one is TX-02");
			expect(message).toContain("TX-01 — discarded");
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("broken");
		});
	});

	// Asking again would settle a transaction that was never opened, and the
	// run would never be allowed to end.
	it("stops asking once the transactions are spent", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: {
					mode: "auto",
					oracleCommand: shellCheck(root, "fixed"),
					maxTransactions: 2,
				},
			});

			await fs.writeFile(path.join(root, "game.js"), "no", "utf8");
			expect(await session?.onCompletionAttempt({})).toContain(
				"This one is TX-02",
			);
			await fs.writeFile(path.join(root, "game.js"), "no again", "utf8");
			expect(await session?.onCompletionAttempt({})).toBeUndefined();
			expect(await session?.onCompletionAttempt({})).toBeUndefined();
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("broken");
		});
	});

	it("discards a change the model says it could not verify", async () => {
		await withWorkspace({ "notes.md": "before" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
			});
			await fs.writeFile(path.join(root, "notes.md"), "after", "utf8");

			const message = await session?.onCompletionAttempt({
				text: "I rewrote the section, but I could not verify it renders.",
			});

			expect(message).toContain("TX-01 discarded");
			await expect(
				fs.readFile(path.join(root, "notes.md"), "utf8"),
			).resolves.toBe("before");
		});
	});
});

describe("where the rules are put", () => {
	// Measured, and the reason this moved: from the system prompt the same model
	// on the same file made eight edits in one transaction against a limit of
	// three and never wrote the plan. The harness that puts the identical text
	// in the opening message gets the plan.
	it("hands the opening rules over once, for the user's own message", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
			});

			expect(session?.takeOpeningRules()).toContain("CHANGE PROTOCOL");
			expect(session?.takeOpeningRules()).toBeUndefined();
		});
	});

	// The message that reopens a transaction is the only thing that opens it, so
	// it carries the rules in full — exactly as a fresh session's opening prompt
	// does in the harness this comes from.
	it("restates the whole of the next transaction's rules when one is discarded", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});
			session?.takeOpeningRules();
			await fs.writeFile(path.join(root, "game.js"), "still broken", "utf8");

			const message = await session?.onCompletionAttempt({ text: "Fixed." });

			expect(message).toContain("TX-01 discarded");
			expect(message).toContain("CHANGE PROTOCOL");
			expect(message).toContain("AT MOST 3 changes");
			expect(message).toContain("TX-01 — discarded");
		});
	});
});

describe("reading a model's account of its own change", () => {
	it.each([
		{ text: "Fixed the collision check.", expected: undefined },
		{ text: "I could not verify the change.", expected: "unsure" },
		{ text: "The sprite still fails to draw.", expected: "failure" },
		{ text: "Left it unverified.", expected: "unsure" },
	])("reads $text", ({ text, expected }) => {
		expect(readSelfReport(text)).toBe(expected);
	});
});
