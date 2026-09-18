import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createRevisionLog, type RevisionLog } from "./file-revisions";
import {
	createRestoreFileTool,
	MAX_RESTORES_PER_TRANSACTION,
} from "./restore-file-tool";

const context = {} as never;

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-restore-"));
	try {
		for (const [name, body] of Object.entries(files)) {
			await fs.writeFile(path.join(root, name), body, "utf8");
		}
		await run(await fs.realpath(root));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** A session with no transaction: no snapshot, transaction 0, a real log. */
function sessionSource(root: string): {
	pending: undefined;
	transaction: number;
	root: string;
	revisions: RevisionLog;
} {
	return {
		pending: undefined,
		transaction: 0,
		root,
		revisions: createRevisionLog(),
	};
}

/**
 * Restoring with the change protocol off.
 *
 * The case this exists for, measured: pandorum session 1789708543200_eqgqe
 * replaced a 133-line file with the literal string "test content" while
 * probing the editor's argument syntax, and then had nothing to go back to —
 * `restore_file` is added by the protocol's `decorateTools`, and the protocol
 * was off, so the tool did not exist and the transcript never mentions it.
 */
describe("putting one file back with no transaction open", () => {
	it("goes back to what the file said before this session wrote to it", async () => {
		await withWorkspace(
			{ "game.html": "line one\nline two\n" },
			async (root) => {
				const source = sessionSource(root);
				const file = path.join(root, "game.html");
				// What the session capture does at first touch.
				source.revisions.seed(
					file,
					Buffer.from("line one\nline two\n"),
					"session",
				);
				await fs.writeFile(file, "test content", "utf8");
				source.revisions.record(file, Buffer.from("test content"), "editor");

				const tool = createRestoreFileTool({ controller: source });
				const said = String(await tool.execute({ path: "game.html" }, context));

				await expect(fs.readFile(file, "utf8")).resolves.toBe(
					"line one\nline two\n",
				);
				expect(said).toContain("game.html");
				// Never "transaction": there is none, and naming one describes a
				// rollback the model cannot ask for.
				expect(said).not.toContain("transaction");
			},
		);
	});

	it("undoes only the last write when asked for it", async () => {
		await withWorkspace({ "game.html": "one\n" }, async (root) => {
			const source = sessionSource(root);
			const file = path.join(root, "game.html");
			source.revisions.seed(file, Buffer.from("one\n"), "session");
			source.revisions.record(file, Buffer.from("two\n"), "editor");
			await fs.writeFile(file, "three\n", "utf8");
			source.revisions.record(file, Buffer.from("three\n"), "editor");

			const tool = createRestoreFileTool({ controller: source });
			await tool.execute({ path: "game.html", revision: "last" }, context);

			await expect(fs.readFile(file, "utf8")).resolves.toBe("two\n");
		});
	});

	it("says plainly when nothing has written the file this session", async () => {
		await withWorkspace({ "game.html": "one\n" }, async (root) => {
			const source = sessionSource(root);
			const tool = createRestoreFileTool({ controller: source });

			const said = String(await tool.execute({ path: "game.html" }, context));

			// Not "no transaction is open" — that was true and useless, and it is
			// what the tool said to every call before this.
			expect(said).toContain("game.html");
			expect(said.toLowerCase()).toContain("no earlier version");
			await expect(
				fs.readFile(path.join(root, "game.html"), "utf8"),
			).resolves.toBe("one\n");
		});
	});

	it("refuses a path outside the workspace", async () => {
		await withWorkspace({ "game.html": "one\n" }, async (root) => {
			const source = sessionSource(root);
			const tool = createRestoreFileTool({ controller: source });

			const said = String(
				await tool.execute(
					{ path: path.join(os.tmpdir(), "elsewhere.txt") },
					context,
				),
			);

			expect(said.toLowerCase()).toContain("outside");
		});
	});

	it("gives the restore budget back once real work has happened", async () => {
		// With no transaction there is no boundary to reset the budget, so the
		// rule is the pathology itself: restores in a row with nothing done in
		// between. One edit clears it.
		await withWorkspace({ "game.html": "one\n" }, async (root) => {
			const source = sessionSource(root);
			const file = path.join(root, "game.html");
			source.revisions.seed(file, Buffer.from("one\n"), "session");
			const tool = createRestoreFileTool({ controller: source });

			for (let i = 0; i < MAX_RESTORES_PER_TRANSACTION + 5; i += 1) {
				await fs.writeFile(file, `edit ${i}\n`, "utf8");
				source.revisions.record(file, Buffer.from(`edit ${i}\n`), "editor");
				const said = String(await tool.execute({ path: "game.html" }, context));
				expect(said).not.toContain("no more will be made");
			}
		});
	});

	it("still stops a run of restores with no work between them", async () => {
		await withWorkspace({ "game.html": "one\n" }, async (root) => {
			const source = sessionSource(root);
			const file = path.join(root, "game.html");
			source.revisions.seed(file, Buffer.from("one\n"), "session");
			const tool = createRestoreFileTool({ controller: source });

			const answers: string[] = [];
			for (let i = 0; i < MAX_RESTORES_PER_TRANSACTION + 2; i += 1) {
				await fs.writeFile(file, `wrecked ${i}\n`, "utf8");
				answers.push(
					String(await tool.execute({ path: "game.html" }, context)),
				);
			}

			expect(
				answers.some((said) => said.includes("no more will be made")),
			).toBe(true);
		});
	});
});
