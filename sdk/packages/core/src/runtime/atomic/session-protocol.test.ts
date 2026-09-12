import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createAtomicProtocolSession,
	DEFAULT_MAX_CHANGES,
	DEFAULT_MAX_UNSTARTED_ATTEMPTS,
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

/**
 * One real tool call in the open transaction.
 *
 * A transaction is spent by an empty submission only once the model has
 * actually worked in it; a direct `fs.writeFile` in a test is not that, because
 * a real edit reaches the file through a decorated tool. Running the check is
 * the cheapest call that makes the transaction begun without changing anything.
 */
async function workIn(session: {
	tools: readonly unknown[];
	decorateTools: (given: never[]) => readonly unknown[];
}): Promise<void> {
	const tools = (
		session as unknown as {
			decorateTools: (g: unknown[]) => { name: string; execute?: unknown }[];
			tools: unknown[];
		}
	).decorateTools([...(session as unknown as { tools: unknown[] }).tools]);
	const check = tools.find((tool) => tool.name === "run_check");
	if (!check?.execute) {
		throw new Error("no run_check tool");
	}
	await (check.execute as (a: unknown, b: unknown) => Promise<unknown>)({}, {
		iteration: 1,
	} as never);
}

describe("the undo the protocol hands the model", () => {
	// The transaction has held every file's opening state all along, and until
	// now only the rollback could read it. Both halves are gated on the
	// protocol being armed, because without an open transaction there is no
	// base revision to read or restore to.
	it("offers restore_file whenever the protocol is armed", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always", oracleCommand: shellCheck(root, "fixed") },
			});

			expect(session?.tools.map((tool) => tool.name)).toContain("restore_file");
		});
	});

	// Every tool is wrapped now, because the plan capture has to see the first
	// call of a turn whatever it is. So the claim is no longer about identity —
	// it is that nothing but `read_files` gains an argument, which is the part
	// the model can see.
	it("adds the base revision to read_files, and no argument to any other tool", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always", oracleCommand: shellCheck(root, "fixed") },
			});
			const plainRead = {
				name: "read_files",
				description: "Read files.",
				inputSchema: { type: "object", properties: {} },
			};
			const plainSearch = {
				name: "search_codebase",
				description: "Search.",
				inputSchema: { type: "object", properties: {} },
			};

			const decorated = session?.decorateTools([plainRead, plainSearch]) ?? [];

			expect(
				(decorated[0]?.inputSchema.properties as Record<string, unknown>)
					.revision,
			).toBeDefined();
			expect(decorated[1]?.name).toBe(plainSearch.name);
			expect(decorated[1]?.description).toBe(plainSearch.description);
			expect(decorated[1]?.inputSchema).toEqual(plainSearch.inputSchema);
		});
	});

	it("hands no such tools to a session the protocol declined to arm", async () => {
		// A host running without the protocol keeps byte-for-byte the tools it
		// had: there is nothing to restore to and nothing to read.
		await withWorkspace({ "notes.md": "# hello" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto" },
			});

			expect(session).toBeUndefined();
		});
	});
});

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
	it("lets a task that changed nothing end when the check agrees", async () => {
		await withWorkspace({ "game.js": "fine" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fine") },
			});

			await expect(
				session?.onCompletionAttempt({ text: "That file draws the sprite." }),
			).resolves.toBeUndefined();
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("fine");
		});
	});

	// The run this comes from ended `completed` on an early turn with TX-01
	// open, nothing read and nothing edited. Whether there was work to do is
	// not the model's to declare where a check can answer it, and standing down
	// here left the rest of the run unguarded.
	it("refuses to stand down while the check still fails", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});

			const message = await session?.onCompletionAttempt({
				text: "Everything looks correct to me, so there is nothing to do.",
			});

			expect(message).toContain("NOTHING WAS CHANGED");
			expect(message).toContain("FAILED");
			// Held open, not spent: the model gets to make the attempt it has
			// not made yet.
			expect(message).toContain("TX-01");
			expect(message).toContain("still open");
		});
	});

	// A reasoning model takes turns without calling tools; that is what it is
	// for. Charging it an attempt for that spent the whole six-transaction
	// budget in about twenty turns with no edit ever tried, and left six
	// discarded transactions that read as six failed attempts.
	it("does not spend a transaction nothing was ever called in", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});

			// Four quiet turns: under the old rule the second of these spent
			// TX-01 and opened TX-02.
			for (let attempt = 0; attempt < 4; attempt += 1) {
				const message = await session?.onCompletionAttempt({ text: "Done." });
				expect(message).toContain("TX-01");
				expect(message).not.toContain("This one is TX-02");
				expect(message).toContain("no tool called in it at all");
			}
		});
	});

	// The other half of the same rule: once the model has actually worked in a
	// transaction, an empty submission is a failed attempt again and the
	// original budget applies.
	it("spends a transaction that was worked in and came back empty", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
			});
			if (!session) {
				throw new Error("the protocol did not arm");
			}
			// One real tool call, which is all it takes for the transaction to
			// count as begun — it need not have changed anything.
			await workIn(session as never);

			expect(await session.onCompletionAttempt({ text: "Done." })).toContain(
				"was not spent and is still open",
			);
			expect(await session.onCompletionAttempt({ text: "Done." })).toContain(
				"This one is TX-02",
			);
		});
	});

	// The backstop. A model that will never call a tool must not hold a session
	// open forever — but the run ends saying that, rather than by quietly
	// consuming a budget of attempts it never made.
	it("stops the run when nothing is ever called, and says so", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const notices: string[] = [];
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto", oracleCommand: shellCheck(root, "fixed") },
				onEvent: (event) => {
					if (event.type === "empty") {
						notices.push(event.message);
					}
				},
			});

			for (
				let attempt = 0;
				attempt < DEFAULT_MAX_UNSTARTED_ATTEMPTS;
				attempt += 1
			) {
				expect(await session?.onCompletionAttempt({ text: "Done." })).toContain(
					"no tool called in it at all",
				);
			}
			// One past the backstop: the run ends.
			await expect(
				session?.onCompletionAttempt({ text: "Done." }),
			).resolves.toBeUndefined();
			expect(notices.at(-1)).toContain("never started work");
			// Still TX-01. Nothing was spent on the way here.
			expect(notices.at(-1)).toContain("TX-01");
		});
	});

	// A check that cannot run has no verdict. Inventing a failure would turn a
	// broken harness into a session with no way out.
	it("lets the run end when there is no check to ask", async () => {
		await withWorkspace({ "game.js": "fine" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
			});

			await expect(
				session?.onCompletionAttempt({ text: "Nothing to change here." }),
			).resolves.toBeUndefined();
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
	// against the run's wall clock. But the second empty submission spends the
	// transaction rather than ending the run: measured on the harness, a model
	// that submitted nothing twice in TX-02 stopped the run with four
	// transactions unspent and nothing said about what had been tried.
	it("spends the transaction on a second empty submission and opens the next", async () => {
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
			await session?.onCompletionAttempt({ text: "Fixed." });

			// TX-02 is worked in, so its empty submissions are failed attempts
			// rather than a transaction that never began.
			if (session) {
				await workIn(session as never);
			}
			expect(await session?.onCompletionAttempt({})).toContain(
				"NOTHING WAS CHANGED",
			);

			const message = await session?.onCompletionAttempt({});
			// It says what happened to TX-02, and it is not "the run is stopping".
			expect(message).toContain("being spent and closed");
			expect(message).not.toContain("the run is stopping");
			// And it is the next transaction's rules in full, the same message a
			// judged discard opens one with.
			expect(message).toContain("This one is TX-03");
			expect(message).toContain("TX-02 — discarded");
			expect(session?.controller.transaction).toBe(3);
			expect(session?.controller.outcomes).toHaveLength(2);
			expect(events).toContain("empty:2:false");
		});
	});

	// The stopping rule is the budget and nothing else. A model that never edits
	// anything works through its transactions one pair of empty submissions at a
	// time and then the run ends, rather than ending early with them unspent.
	it("ends only once a model that changes nothing has spent every transaction", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: {
					mode: "auto",
					oracleCommand: shellCheck(root, "fixed"),
					maxTransactions: 3,
				},
			});

			await fs.writeFile(path.join(root, "game.js"), "still broken", "utf8");
			await session?.onCompletionAttempt({ text: "Fixed." });

			// TX-02: worked in, nudged, then spent.
			if (session) {
				await workIn(session as never);
			}
			expect(await session?.onCompletionAttempt({})).toContain(
				"NOTHING WAS CHANGED",
			);
			expect(await session?.onCompletionAttempt({})).toContain(
				"This one is TX-03",
			);
			// TX-03 is the last one: worked in, nudged, then spent, and now there
			// is no next.
			if (session) {
				await workIn(session as never);
			}
			expect(await session?.onCompletionAttempt({})).toContain(
				"NOTHING WAS CHANGED",
			);
			await expect(session?.onCompletionAttempt({})).resolves.toBeUndefined();
			expect(session?.controller.outcomes).toHaveLength(3);
			// Every transaction was spent and the file is back as it was seeded.
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("broken");
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
			expect(message).toContain(`AT MOST ${DEFAULT_MAX_CHANGES} changes`);
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

				// The proposal tool specifically, not the tool list: the protocol
				// also carries `restore_file` whenever it is armed, and a model
				// that can run the workspace's own check still needs an undo.
				expect(session?.tools.map((tool) => tool.name)).not.toContain(
					"propose_check",
				);
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

describe("the check the model can reach", () => {
	// The check used to be readable from exactly one place -- `settle`, at the
	// completion attempt -- while the tool that proposes one told the model it
	// ran every turn. Measured under that arrangement: 341 messages and 65 edits
	// with no verdict, then one failure and a full rollback.
	it("offers run_check whenever the protocol is armed", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always", oracleCommand: shellCheck(root, "fixed") },
			});

			expect(session?.tools.map((tool) => tool.name)).toContain("run_check");
		});
	});

	it("runs the check without settling the transaction", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always", oracleCommand: shellCheck(root, "fixed") },
			});
			const runCheck = session?.tools.find((tool) => tool.name === "run_check");
			const before = await runCheck?.execute?.({}, {} as never);
			expect(String(before)).toContain("The check failed");

			await fs.writeFile(path.join(root, "game.js"), "let fixed = 1", "utf8");
			const after = await runCheck?.execute?.({}, {} as never);
			expect(String(after)).toContain("The check passed");

			// Nothing was judged and nothing was put back: the file the model
			// wrote is still the file on disk, and the transaction is still open.
			expect(await fs.readFile(path.join(root, "game.js"), "utf8")).toBe(
				"let fixed = 1",
			);
			expect(session?.controller.outcomes).toHaveLength(0);
		});
	});

	it("says there is no check rather than nothing", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
			});
			const runCheck = session?.tools.find((tool) => tool.name === "run_check");

			expect(String(await runCheck?.execute?.({}, {} as never))).toContain(
				"no check to run",
			);
		});
	});
});

describe("closing a transaction the model will not close", () => {
	// `settle` is reachable from exactly one place, `onCompletionAttempt`, so a
	// model that never ends its turn never settles anything. That is the
	// measured timeout shape: the three JackOD4-AC 9B timeouts closed zero
	// transactions between them over 308-428 iterations. What ends it is not a
	// count of failures -- a healthy transaction fails the task's own check
	// after every edit on the way to passing -- but a count of checks run over
	// files nothing has changed in between.
	async function armed(root: string) {
		const session = await createAtomicProtocolSession({
			workspaceRoot: root,
			config: { mode: "always", oracleCommand: shellCheck(root, "fixed") },
		});
		if (!session) {
			throw new Error("the protocol did not arm");
		}
		// The editing tool belongs to the host, not the protocol -- `decorateTools`
		// is where the two meet -- so the stub stands in for it and records
		// whether the call ever reached an executor.
		const applied: unknown[] = [];
		const editor = {
			name: "editor",
			description: "edit a file",
			inputSchema: {},
			execute: async (input: unknown) => {
				applied.push(input);
				return "edited";
			},
		} as unknown as (typeof session.tools)[number];
		const tools = session.decorateTools([...session.tools, editor]);
		const named = (name: string) => {
			const tool = tools.find((entry) => entry.name === name);
			if (!tool?.execute) {
				throw new Error(`no ${name} tool`);
			}
			return (input: unknown, iteration = 1) =>
				(tool.execute as (a: unknown, b: unknown) => Promise<unknown>)(input, {
					iteration,
				} as never).then(String);
		};
		return { session, tools, named, applied };
	}

	it("settles on the third check over files nobody changed", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const { session, named } = await armed(root);
			const runCheck = named("run_check");

			expect(await runCheck({})).not.toContain("judged here");
			expect(await runCheck({})).not.toContain("judged here");
			expect(session.controller.outcomes).toHaveLength(0);

			const third = await runCheck({});

			// The verdict, the reason it closed, and the whole of the next
			// transaction's rules, all in the one reply -- the model is not
			// waiting on a turn boundary it was never going to reach.
			expect(third).toContain("The check failed");
			expect(third).toContain("judged here");
			expect(session.controller.outcomes).toHaveLength(1);
			expect(session.controller.transaction).toBe(2);
		});
	});

	it("does not settle when something changed between the checks", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const { session, named } = await armed(root);
			const runCheck = named("run_check");
			const restore = named("restore_file");

			await runCheck({});
			await runCheck({});
			await restore({ path: "game.js", reason: "start again" });
			await runCheck({});
			const fourth = await runCheck({});

			expect(fourth).not.toContain("judged here");
			expect(session.controller.outcomes).toHaveLength(0);
			expect(session.controller.transaction).toBe(1);
		});
	});

	it("does not settle a transaction whose check passes", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const { session, named } = await armed(root);
			const runCheck = named("run_check");

			await runCheck({});
			await runCheck({});
			await fs.writeFile(path.join(root, "game.js"), "let fixed = 1", "utf8");
			expect(await runCheck({})).toContain("The check passed");
			expect(session.controller.outcomes).toHaveLength(0);
		});
	});

	// The hazard of settling from inside a tool call: the rest of the turn's
	// batch is still queued, and it was written against the transaction that
	// just closed. It does not need a guard of its own -- the check-first gate
	// holds the first edit of every transaction, and the forced settle opened a
	// new one -- but that is a property worth a test, because the failure it
	// prevents is silent.
	it("refuses an edit that trails the forced settle in the same turn", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const { named, applied } = await armed(root);
			const runCheck = named("run_check");
			const edit = named("editor");
			const change = {
				command: "str_replace",
				path: path.join(root, "game.js"),
				old_str: "let a = 1",
				new_str: "let a = 2",
			};

			// Spend the gate inside TX-01 first, so that what holds the trailing
			// edit below can only be the new transaction. Without this the test
			// passes on the gate every transaction's first edit meets anyway.
			await runCheck({});
			await edit(change);
			await edit(change, 2);
			expect(applied).toHaveLength(1);

			await runCheck({}, 3);
			await runCheck({}, 3);
			await runCheck({}, 3);

			const trailing = await edit(change, 3);

			expect(trailing).toContain("That edit was not made");
			expect(applied).toHaveLength(1);
		});
	});
});

describe("the switch on model-proposed checks", () => {
	// The comparison this exists for: the proposed check against the
	// self-declared verdict it replaced, on one workspace rather than across
	// two releases.
	it("offers propose_check where nothing runs and someone can be asked", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
				approveCheck: async () => ({ approved: true }),
			});

			expect(session?.tools.map((tool) => tool.name)).toContain(
				"propose_check",
			);
		});
	});

	it("withholds it when the setting is off, and says the model judges itself", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const messages: string[] = [];
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
				approveCheck: async () => ({ approved: true }),
				proposeCheck: false,
				onStatus: ({ message }) => messages.push(message),
			});

			expect(session?.tools.map((tool) => tool.name)).not.toContain(
				"propose_check",
			);
			expect(messages.join(" ")).toContain("judges its own work");
		});
	});

	it("stands down in auto with the switch off, as it did before the feature", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "auto" },
				approveCheck: async () => ({ approved: true }),
				proposeCheck: false,
			});

			expect(session).toBeUndefined();
		});
	});
});

// A setting that is written, sent and stored but never read back reaches the
// model as the default and nothing says so. This one has an off position that
// is the arm it is measured against, so a silent default would run both arms
// switched on.
describe("the reconsideration setting reaching the controller", () => {
	it("carries a zero through as off rather than as unset", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				approveCheck: async () => ({ approved: true }),
				config: { mode: "always", checkReconsideredAfter: 0 },
			});
			const controller = session?.controller;
			expect(controller).toBeDefined();
			if (!controller) return;

			await controller.open();
			controller.adoptOracle({
				label: "never",
				command: "sh",
				args: ["-c", "exit 1"],
				cwd: root,
				reason: "proposed for this task and approved by you",
			});
			await fs.writeFile(path.join(root, "game.js"), "one", "utf8");
			await controller.settle({ account: "tried it" });
			await fs.writeFile(path.join(root, "game.js"), "two", "utf8");
			await controller.settle({ account: "tried it" });

			expect(controller.checkIsUnderReconsideration).toBe(false);
		});
	});

	it("arms on the configured count", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				approveCheck: async () => ({ approved: true }),
				config: { mode: "always", checkReconsideredAfter: 2 },
			});
			const controller = session?.controller;
			expect(controller).toBeDefined();
			if (!controller) return;

			await controller.open();
			controller.adoptOracle({
				label: "never",
				command: "sh",
				args: ["-c", "exit 1"],
				cwd: root,
				reason: "proposed for this task and approved by you",
			});
			await fs.writeFile(path.join(root, "game.js"), "one", "utf8");
			await controller.settle({ account: "tried it" });
			await fs.writeFile(path.join(root, "game.js"), "two", "utf8");
			const settled = await controller.settle({ account: "tried it" });

			expect(controller.checkIsUnderReconsideration).toBe(true);
			expect(settled.kept).toBe(false);
			if (!settled.kept) {
				expect(settled.nextPrompt).toContain("THE CHECK HAS NEVER PASSED");
			}
		});
	});
});

/**
 * What the model is told when it stops without starting.
 *
 * The generic no-tool-call nudge says only that the turn called nothing. With
 * the protocol engaged that leaves out the fact the model most needs: a
 * transaction is open and nothing has landed in it. Measured on pandorum
 * session 1789230811792_qnyfa — three turns of prose, two nudges, neither
 * mentioning the protocol, run ended with the file untouched.
 */
describe("the clause for a transaction nothing has landed in", () => {
	it("names the open transaction while the workspace is untouched", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always", oracleCommand: shellCheck(root, "fixed") },
			});

			const clause = await session?.describeUnstartedWork();

			expect(clause).toBeDefined();
			expect(clause).toContain("TX-01");
		});
	});

	it("says nothing once an edit has landed", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always", oracleCommand: shellCheck(root, "fixed") },
			});
			// Opening the transaction is what snapshots the file; the edit has to
			// come after it or there is nothing for the comparison to see.
			session?.takeOpeningRules();
			await fs.writeFile(path.join(root, "game.js"), "let a = 2", "utf8");

			expect(await session?.describeUnstartedWork()).toBeUndefined();
		});
	});

	it("says nothing when the protocol is not armed", async () => {
		await withWorkspace({ "game.js": "let a = 1" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: {},
			});

			expect(session).toBeUndefined();
		});
	});
});
