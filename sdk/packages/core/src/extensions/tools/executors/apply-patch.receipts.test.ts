import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultExecutors } from "./index";

const ctx = { agentId: "a", conversationId: "c", iteration: 1 } as never;

function patch(...body: string[]): string {
	return [
		"*** Begin Patch",
		"*** Update File: game.js",
		"@@",
		...body,
		"*** End Patch",
	].join("\n");
}

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function workspace() {
	const dir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "apply-patch-receipts-")),
	);
	dirs.push(dir);
	const file = path.join(dir, "game.js");
	await fs.writeFile(file, "a\nb\nc\n", "utf8");
	// The host's wiring: one registry shared by the reader, the editor and
	// the patch.
	return { dir, file, executors: createDefaultExecutors() };
}

/**
 * A patch is this session's own write. Without recording it, the next read
 * said the file "changed since you last looked at it, and not because of
 * anything you did", and the next edit was refused in the same words — the
 * model was told someone else had changed what it had just changed itself.
 */
describe("apply_patch and the read receipts", () => {
	it("is not reported as someone else's change on the next read", async () => {
		const { dir, file, executors } = await workspace();
		await executors.readFile?.({ path: file }, ctx);

		await executors.applyPatch?.({ input: patch(" a", "+X", " b") }, dir, ctx);
		const again = String(await executors.readFile?.({ path: file }, ctx));

		expect(again).not.toContain("not because of anything you did");
		expect(again).toContain("X");
	});

	it("retires the line numbers a patch moved, and says why", async () => {
		const { dir, file, executors } = await workspace();
		await executors.readFile?.({ path: file, start_line: 1, end_line: 3 }, ctx);
		await executors.applyPatch?.(
			{ input: patch(" a", "+X", "+Y", " b") },
			dir,
			ctx,
		);

		// Line 3 was `c` when it was read; it is `Y` now.
		await expect(
			executors.editor?.(
				{ path: file, start_line: 3, end_line: 3, new_text: "C" } as never,
				dir,
				ctx,
			),
		).rejects.toThrow(/changed the file's length/);
		expect(await fs.readFile(file, "utf8")).toBe("a\nX\nY\nb\nc\n");
	});

	it("keeps the reads of a patch that moved no line", async () => {
		const { dir, file, executors } = await workspace();
		await executors.readFile?.({ path: file }, ctx);
		await executors.applyPatch?.(
			{ input: patch(" a", "-b", "+B", " c") },
			dir,
			ctx,
		);

		await executors.editor?.(
			{ path: file, start_line: 3, end_line: 3, new_text: "C" } as never,
			dir,
			ctx,
		);

		expect(await fs.readFile(file, "utf8")).toBe("a\nB\nC\n");
	});
});
