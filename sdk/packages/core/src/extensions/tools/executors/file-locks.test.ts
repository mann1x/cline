import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";
import { isFileLocked, withFileLock } from "./file-locks";

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
	signal: undefined as unknown as AbortSignal,
};

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-locks-"));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("withFileLock", () => {
	it("runs one holder at a time for the same path", async () => {
		const order: string[] = [];
		const slow = async (name: string) => {
			order.push(`${name} in`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push(`${name} out`);
		};

		await Promise.all([
			withFileLock("/w/a.ts", () => slow("first")),
			withFileLock("/w/a.ts", () => slow("second")),
		]);

		expect(order).toEqual(["first in", "first out", "second in", "second out"]);
	});

	it("does not serialise different paths", async () => {
		const order: string[] = [];
		const slow = async (name: string) => {
			order.push(`${name} in`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push(`${name} out`);
		};

		await Promise.all([
			withFileLock("/w/a.ts", () => slow("a")),
			withFileLock("/w/b.ts", () => slow("b")),
		]);

		// Both entered before either left, so neither waited on the other.
		expect(order.slice(0, 2).sort()).toEqual(["a in", "b in"]);
	});

	it("releases when the work throws, and the failure reaches only its own caller", async () => {
		// The failure path is the one where holding a lock forever is worst, and
		// a rejection that propagated down the chain would fail every waiter
		// behind it for something it did not do.
		const failing = withFileLock("/w/c.ts", async () => {
			throw new Error("boom");
		});
		const following = withFileLock("/w/c.ts", async () => "fine");

		await expect(failing).rejects.toThrow("boom");
		await expect(following).resolves.toBe("fine");
	});

	it("forgets a path once nothing is queued on it", async () => {
		await withFileLock("/w/d.ts", async () => undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(isFileLocked("/w/d.ts")).toBe(false);
	});
});

describe("two agents editing one file", () => {
	it("does not lose the first agent's edit", async () => {
		// The race this exists for, and it is not a torn byte. Both edits read
		// the file, compute a complete result and write it; without the lock the
		// second write is well-formed, succeeds, and contains none of the first
		// agent's work. Nothing reports it, because nothing failed.
		await withDir(async (dir) => {
			const filePath = path.join(dir, "shared.txt");
			await fs.writeFile(filePath, "alpha\nbeta\n", "utf-8");
			// No receipts: this is about the write race, not the read guard.
			const edit = createEditorExecutor();

			await Promise.all([
				edit(
					{ path: filePath, old_text: "alpha", new_text: "ALPHA" },
					dir,
					context as never,
				),
				edit(
					{ path: filePath, old_text: "beta", new_text: "BETA" },
					dir,
					context as never,
				),
			]);

			const after = await fs.readFile(filePath, "utf-8");
			expect(after).toContain("ALPHA");
			expect(after).toContain("BETA");
		});
	});
});
