import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";
import { createFileReadExecutor } from "./file-read";
import { createReadReceipts } from "./read-receipts";

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
	signal: undefined as unknown as AbortSignal,
};

const FILE = ["one", "two", "three", "four"].join("\n");

async function withFile(
	run: (paths: {
		dir: string;
		filePath: string;
		read: ReturnType<typeof createFileReadExecutor>;
		edit: ReturnType<typeof createEditorExecutor>;
		/** A write by somebody who is not this session. */
		somebodyElseWrites: (text: string) => Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "concurrent-"));
	const filePath = path.join(dir, "shared.txt");
	await fs.writeFile(filePath, FILE, "utf-8");
	const receipts = createReadReceipts();
	try {
		await run({
			dir,
			filePath,
			read: createFileReadExecutor({ receipts, cwd: dir }),
			edit: createEditorExecutor({ receipts }),
			somebodyElseWrites: async (text) => {
				// The stamp is size + mtime at nanosecond precision, so a write
				// in the same millisecond is still a different stamp. The wait
				// is here only to keep the test honest on a filesystem with a
				// coarser clock than the one this was written on.
				await new Promise((resolve) => setTimeout(resolve, 10));
				await fs.writeFile(filePath, text, "utf-8");
			},
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function textOf(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	return JSON.stringify(result);
}

describe("a file two writers share", () => {
	it("says nothing on the first read of a file", async () => {
		await withFile(async ({ filePath, read }) => {
			const result = await read({ path: filePath }, context as never);

			expect(textOf(result)).not.toContain("changed since you last looked");
		});
	});

	it("says nothing when the session is the only writer", async () => {
		// The guard has to be invisible to a session working alone, or it is a
		// tax on every edit rather than a safety net for the one that matters.
		await withFile(async ({ filePath, read, edit }) => {
			await read({ path: filePath }, context as never);
			await edit(
				{ path: filePath, old_text: "two", new_text: "TWO" },
				path.dirname(filePath),
				context as never,
			);
			const second = await read({ path: filePath }, context as never);

			expect(textOf(second)).not.toContain("changed since you last looked");
			await expect(
				edit(
					{ path: filePath, old_text: "three", new_text: "THREE" },
					path.dirname(filePath),
					context as never,
				),
			).resolves.toBeTruthy();
		});
	});

	it("warns on a read of a file somebody else rewrote", async () => {
		await withFile(async ({ filePath, read, somebodyElseWrites }) => {
			await read({ path: filePath }, context as never);
			await somebodyElseWrites("one\nTWO\nthree\nfour");

			const result = textOf(await read({ path: filePath }, context as never));

			expect(result).toContain("changed since you last looked");
			expect(result).toContain("not because of anything you did");
			// The content still comes back: the warning is a preface, not a
			// refusal. A read is safe; it is the edit that is not.
			expect(result).toContain("TWO");
		});
	});

	it("warns once, then goes quiet until it moves again", async () => {
		await withFile(async ({ filePath, read, somebodyElseWrites }) => {
			await read({ path: filePath }, context as never);
			await somebodyElseWrites("one\nTWO\nthree\nfour");
			await read({ path: filePath }, context as never);

			const third = textOf(await read({ path: filePath }, context as never));

			expect(third).not.toContain("changed since you last looked");
		});
	});

	it("refuses an edit to a file somebody else rewrote", async () => {
		// The read path warns; this one refuses, because a warning attached to
		// a write arrives after the damage.
		await withFile(async ({ filePath, read, edit, somebodyElseWrites }) => {
			await read({ path: filePath }, context as never);
			await somebodyElseWrites("one\ntwo\nthree\nfour\nfive");

			await expect(
				edit(
					{ path: filePath, old_text: "two", new_text: "TWO" },
					path.dirname(filePath),
					context as never,
				),
			).rejects.toThrow(/changed since you last read it/);

			// And the file is untouched, which is the half that matters.
			expect(await fs.readFile(filePath, "utf-8")).toBe(
				"one\ntwo\nthree\nfour\nfive",
			);
		});
	});

	it("lets the edit through once the model has looked again", async () => {
		// The refusal has to be recoverable in one step, or it is a wall.
		await withFile(async ({ filePath, read, edit, somebodyElseWrites }) => {
			await read({ path: filePath }, context as never);
			await somebodyElseWrites("one\ntwo\nthree\nfour\nfive");
			await edit(
				{ path: filePath, old_text: "two", new_text: "TWO" },
				path.dirname(filePath),
				context as never,
			).catch(() => undefined);

			await read({ path: filePath }, context as never);

			await expect(
				edit(
					{ path: filePath, old_text: "two", new_text: "TWO" },
					path.dirname(filePath),
					context as never,
				),
			).resolves.toBeTruthy();
			expect(await fs.readFile(filePath, "utf-8")).toContain("TWO");
		});
	});

	it("does not refuse twice for one change", async () => {
		// A model that resends without reading gets the read-before-editing
		// refusal, not this one again: being told two different things about
		// the same call is how a small model gets stuck.
		await withFile(async ({ filePath, read, edit, somebodyElseWrites }) => {
			await read({ path: filePath }, context as never);
			await somebodyElseWrites("one\ntwo\nthree\nfour\nfive");

			const first = await edit(
				{ path: filePath, old_text: "two", new_text: "TWO" },
				path.dirname(filePath),
				context as never,
			).catch((error: Error) => error.message);
			const second = await edit(
				{ path: filePath, old_text: "two", new_text: "TWO" },
				path.dirname(filePath),
				context as never,
			).catch((error: Error) => error.message);

			expect(first).toMatch(/changed since you last read it/);
			expect(second).not.toMatch(/changed since you last read it/);
		});
	});

	it("notices a file that vanished under the session", async () => {
		await withFile(async ({ filePath, read, edit }) => {
			await read({ path: filePath }, context as never);
			await new Promise((resolve) => setTimeout(resolve, 10));
			await fs.rm(filePath);

			await expect(
				edit(
					{ path: filePath, old_text: "two", new_text: "TWO" },
					path.dirname(filePath),
					context as never,
				),
			).rejects.toThrow(/changed since you last read it/);
		});
	});
});
