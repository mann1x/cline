import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createAtomicProtocolSession,
	readSelfReport,
	withAtomicProtocolRules,
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
			expect(session?.rules()).toContain("you are the check");
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
				expect(session?.rules()).toContain("node run_game.js");
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
			expect(message).toContain("TX-02 is now open");
			await expect(
				fs.readFile(path.join(root, "game.js"), "utf8"),
			).resolves.toBe("broken");
			expect(session?.rules()).toContain("TX-01 — discarded");
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
				"TX-02 is now open",
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

describe("keeping the rules where the model can see them", () => {
	// A rule that scrolled out of the window is a rule that is not followed, and
	// the rules are not part of the conversation for compaction to weigh.
	it("appends the open transaction's rules to the system prompt", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
			});
			const prepare = withAtomicProtocolRules(undefined, session);

			const result = await prepare?.({
				systemPrompt: "You are Cline.",
				messages: [],
			} as never);

			expect(result?.systemPrompt).toContain("You are Cline.");
			expect(result?.systemPrompt).toContain("CHANGE PROTOCOL");
		});
	});

	it("keeps whatever the rest of the pipeline decided", async () => {
		await withWorkspace({ "game.js": "broken" }, async (root) => {
			const session = await createAtomicProtocolSession({
				workspaceRoot: root,
				config: { mode: "always" },
			});
			const prepare = withAtomicProtocolRules(
				async () => ({
					messages: ["compacted"] as never,
					systemPrompt: "Rewritten.",
				}),
				session,
			);

			const result = await prepare?.({
				systemPrompt: "You are Cline.",
				messages: [],
			} as never);

			expect(result?.systemPrompt).toContain("Rewritten.");
			expect(result?.systemPrompt).not.toContain("You are Cline.");
			expect(result?.messages).toEqual(["compacted"]);
		});
	});

	it("is not installed at all when the protocol is off", () => {
		const inner = async () => ({ messages: [] as never });
		expect(withAtomicProtocolRules(inner, undefined)).toBe(inner);
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
