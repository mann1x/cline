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
			const status: { armed: boolean; message: string }[] = [];
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto" },
				logger: { log: (message) => logged.push(message) },
				onStatus: (update) => status.push(update),
			});

			expect(session).toBeUndefined();
			expect(logged[0]).toContain("stood down");
			// To the user as well as the log: standing down is invisible from the
			// chat, and looks exactly like a feature that is not working.
			expect(status[0]?.armed).toBe(false);
			expect(status[0]?.message).toContain("Settings");
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

	// Measured on the harness: a run whose first transaction was discarded closed
	// the remaining five in nine minutes with no edit in any of them, and read as
	// six failed attempts when it had made one.
	it("does not spend a transaction on a submission that changed nothing", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const events: string[] = [];
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
				onEvent: (event) =>
					events.push(
						event.type === "empty"
							? `empty:${event.transaction}:${event.continued}`
							: `${event.type}:${event.transaction}`,
					),
			});

			await fs.writeFile(path.join(root, "game.js"), "still broken", "utf8");
			expect(await session?.onCompletionAttempt({ text: "Fixed." })).toContain(
				"TX-01 discarded",
			);

			// TX-02 is open and the model changes nothing in it.
			const message = await session?.onCompletionAttempt({ text: "Done." });

			expect(message).toContain("NOTHING WAS CHANGED");
			expect(message).toContain("was not spent");
			expect(session?.controller.transaction).toBe(2);
			expect(session?.controller.outcomes).toHaveLength(1);
			expect(events).toContain("empty:2:true");
			// Nothing was judged, so nothing was put back either.
			expect(events.filter((event) => event.startsWith("judging"))).toEqual([
				"judging:1",
			]);
		});
	});

	// Bounded like the runtime's own no-tool-call nudge. Asking a model that has
	// stopped working to carry on is worth one turn; asking forever is a spin
	// against the run's wall clock.
	it("lets the run end rather than nudging an empty submission twice", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});

			await fs.writeFile(path.join(root, "game.js"), "still broken", "utf8");
			await session?.onCompletionAttempt({ text: "Fixed." });

			expect(await session?.onCompletionAttempt({})).toContain(
				"NOTHING WAS CHANGED",
			);
			await expect(session?.onCompletionAttempt({})).resolves.toBeUndefined();
			// Four of the six transactions are still unspent, and the run stopped
			// instead of feeding them empty submissions.
			expect(session?.controller.outcomes).toHaveLength(1);
		});
	});

	it("gives the next transaction its own budget once a real change lands", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});

			await fs.writeFile(path.join(root, "game.js"), "still broken", "utf8");
			await session?.onCompletionAttempt({ text: "Fixed." });
			expect(await session?.onCompletionAttempt({})).toContain(
				"NOTHING WAS CHANGED",
			);

			// A real change in the same transaction: the strike is forgotten, and
			// the empty submission that follows it in TX-03 is nudged rather than
			// treated as the second in a row.
			await fs.writeFile(path.join(root, "game.js"), "broken again", "utf8");
			expect(await session?.onCompletionAttempt({})).toContain(
				"This one is TX-03",
			);
			expect(await session?.onCompletionAttempt({})).toContain(
				"NOTHING WAS CHANGED",
			);
			expect(session?.controller.outcomes).toHaveLength(2);
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

describe("a check the model proposes", () => {
	const WORKING =
		"<script>requestAnimationFrame(function loop(){ requestAnimationFrame(loop); });</script>";
	const BROKEN = "<script>gone();</script>";

	/** Runs the propose_check tool off a session, the way the agent would. */
	async function propose(
		session: { tools: readonly { name: string; execute: unknown }[] },
		input: unknown,
	): Promise<string> {
		const tool = session.tools.find((entry) => entry.name === "propose_check");
		if (!tool) {
			throw new Error("no propose_check tool on this session");
		}
		return (
			tool.execute as (input: unknown, context: unknown) => Promise<string>
		)(input, {} as never);
	}

	// Auto used to stand down here, and standing down means the model judges
	// its own work. With someone to ask there is a better answer available.
	it("arms in auto where there is nothing to run but someone to ask", async () => {
		await withWorkspace({ "game.html": WORKING }, async (root) => {
			const statuses: string[] = [];
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto" },
				approveCheck: async () => ({ approved: true }),
				onStatus: (status) => statuses.push(status.message),
			});

			expect(session).toBeDefined();
			expect(statuses[0]).toContain("propose a check");
		});
	});

	it("still stands down in auto when there is nobody to ask", async () => {
		await withWorkspace({ "game.html": WORKING }, async (root) => {
			expect(
				await createAtomicProtocolSession({
					workspaceRoot: root,
					config: { mode: "auto" },
				}),
			).toBeUndefined();
		});
	});

	it("tells the model to propose one, in the opening rules", async () => {
		await withWorkspace({ "game.html": WORKING }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto" },
				approveCheck: async () => ({ approved: true }),
			});

			expect(session?.takeOpeningRules()).toContain("propose_check");
		});
	});

	// The whole point: what the user approved decides, and the model's account
	// of its own work stops being the verdict.
	it("judges the transaction by the approved check", async () => {
		await withWorkspace({ "game.html": BROKEN }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
				approveCheck: async () => ({ approved: true }),
			});
			if (!session) {
				throw new Error("expected a session");
			}
			session.takeOpeningRules();

			await propose(session, {
				kind: "page",
				path: "game.html",
				reason: "the task is this page",
			});
			// An edit that leaves the page still broken, declared a success.
			await fs.writeFile(
				path.join(root, "game.html"),
				"<script>stillGone();</script>",
				"utf8",
			);

			const message = await session.onCompletionAttempt({
				text: "Fixed — the page loads cleanly now.",
			});

			expect(message).toContain("discarded");
			expect(message).toContain("the page did not run");
			// Put back, exactly as it was when the transaction opened.
			expect(await fs.readFile(path.join(root, "game.html"), "utf8")).toBe(
				BROKEN,
			);
		});
	});

	it("keeps the transaction when the approved check passes", async () => {
		await withWorkspace({ "game.html": BROKEN }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
				approveCheck: async () => ({ approved: true }),
			});
			if (!session) {
				throw new Error("expected a session");
			}
			session.takeOpeningRules();
			await propose(session, {
				kind: "page",
				path: "game.html",
				reason: "the task is this page",
			});
			await fs.writeFile(path.join(root, "game.html"), WORKING, "utf8");

			expect(
				await session.onCompletionAttempt({ text: "fixed" }),
			).toBeUndefined();
			expect(session.oracle?.kind).toBe("page");
		});
	});

	// A model that may re-propose after a failed transaction will weaken the
	// check until one passes, which is self-declaration with extra steps.
	it("freezes the check for the rest of the run", async () => {
		await withWorkspace({ "game.html": BROKEN }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
				approveCheck: async () => ({ approved: true }),
			});
			if (!session) {
				throw new Error("expected a session");
			}

			await propose(session, {
				kind: "page",
				path: "game.html",
				reason: "the task is this page",
			});
			const second = await propose(session, {
				kind: "command",
				command: "true",
				reason: "something easier",
			});

			expect(second).toContain("frozen for the rest of the run");
			expect(session.oracle?.kind).toBe("page");
		});
	});

	it("offers no proposal tool once the workspace has its own check", async () => {
		await withWorkspace(
			{ "package.json": JSON.stringify({ scripts: { test: "true" } }) },
			async (root) => {
				const session = await createAtomicProtocolSession({
					workspaceRoot: root,
					config: { mode: "auto" },
					approveCheck: async () => ({ approved: true }),
				});

				expect(session?.tools).toHaveLength(0);
			},
		);
	});

	// End to end, through the session the host builds: a check that already
	// passes on the page as the run found it is refused before it is frozen.
	it("refuses a check the unbroken page already passes", async () => {
		await withWorkspace({ "game.html": WORKING }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
				approveCheck: async () => ({ approved: true }),
			});
			if (!session) {
				throw new Error("expected a session");
			}

			const output = await propose(session, {
				kind: "page",
				path: "game.html",
				reason: "the task is this page",
			});

			expect(output).toContain("already passes");
			expect(session.oracle).toBeUndefined();
		});
	});
});
