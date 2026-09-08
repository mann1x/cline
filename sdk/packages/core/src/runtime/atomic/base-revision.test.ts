import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	describeMissingBase,
	isTextBody,
	resolveBaseFile,
} from "./base-revision";
import { takeSnapshot } from "./snapshot";

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-base-"));
	try {
		for (const [name, body] of Object.entries(files)) {
			const full = path.join(root, name);
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, body, "utf8");
		}
		await run(await fs.realpath(root));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("addressing the transaction's base by path", () => {
	it("hands back what the file said when the transaction opened", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			const snapshot = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "wrecked", "utf8");

			const lookup = resolveBaseFile(snapshot, path.join(root, "game.html"));

			expect(lookup.kind).toBe("held");
			if (lookup.kind !== "held") return;
			expect(lookup.body.toString("utf8")).toBe("original");
		});
	});

	it("resolves a relative path against the transaction's root, not the process", async () => {
		// The model writes `game.html`; the extension host's cwd is usually "/".
		// Resolving there would report a file sitting in the workspace as being
		// outside the transaction.
		await withWorkspace({ "game.html": "original" }, async (root) => {
			const snapshot = await takeSnapshot(root);

			expect(resolveBaseFile(snapshot, "game.html").kind).toBe("held");
		});
	});

	it("separates a file this transaction created from one it never held", async () => {
		// Opposite meanings: the first has a base revision (it did not exist),
		// the second has none and would not be rolled back either.
		await withWorkspace({ "game.html": "original" }, async (root) => {
			const snapshot = await takeSnapshot(root);

			expect(resolveBaseFile(snapshot, path.join(root, "new.js")).kind).toBe(
				"created",
			);
			expect(
				resolveBaseFile(snapshot, path.join(root, "..", "elsewhere.js")).kind,
			).toBe("outside");
		});
	});

	it("reports a file the snapshot skipped as uncovered, never as created", async () => {
		await withWorkspace({ "big.bin": "xxxxxxxxxx" }, async (root) => {
			const snapshot = await takeSnapshot(root, { maxFileBytes: 4 });

			const lookup = resolveBaseFile(snapshot, path.join(root, "big.bin"));

			expect(lookup.kind).toBe("uncovered");
			if (lookup.kind === "held") return;
			// The distinction matters to the model: "it was too big to keep" and
			// "you made it" send it in opposite directions.
			expect(describeMissingBase(lookup)).toContain("a rollback would not");
		});
	});
});

describe("what can be shown as text", () => {
	it("refuses a body with a NUL in it", () => {
		expect(isTextBody(Buffer.from("plain text"))).toBe(true);
		expect(isTextBody(Buffer.from([0x50, 0x00, 0x4b]))).toBe(false);
	});
});
