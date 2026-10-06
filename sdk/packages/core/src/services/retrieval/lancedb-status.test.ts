import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lanceDbStatus } from "./lancedb-runtime";
import { LANCEDB_RUNTIME_MANIFEST } from "./lancedb-runtime.manifest";

/** An installed LanceDB to check against, when the machine has one. */
const RUNTIME = process.env.CEREBRILINE_LANCEDB_RUNTIME?.trim();

describe("where LanceDB stands", () => {
	it("says not downloaded for an empty folder, with the version it would install", () => {
		const directory = mkdtempSync(join(tmpdir(), "lancedb-status-"));
		try {
			const status = lanceDbStatus({ directory });
			expect(status).toMatchObject({
				version: LANCEDB_RUNTIME_MANIFEST.version,
				installed: false,
				working: false,
				root: join(directory, LANCEDB_RUNTIME_MANIFEST.version),
			});
			expect(status.error).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.skipIf(!RUNTIME)(
		"says working once the native library has loaded in this process",
		() => {
			expect(lanceDbStatus({ directory: RUNTIME as string })).toMatchObject({
				installed: true,
				working: true,
			});
		},
	);
});
