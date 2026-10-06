import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTarGz } from "./tar-extract";
import { pieces, tarGz } from "./tar-fixture";

describe("extractTarGz", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "tar-extract-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("writes the files under the target, without the leading folder", async () => {
		const big = Buffer.alloc(70_000, "x");
		const archive = tarGz([
			{ name: "package/", type: "5" },
			{ name: "package/package.json", body: '{"name":"p"}' },
			{ name: "package/dist/index.js", body: "module.exports = 1;\n" },
			{ name: "package/empty.txt", body: "" },
			{ name: "package/big.bin", body: big },
		]);
		const files = await extractTarGz(pieces(archive, 37), root);
		expect(files).toBe(4);
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
			'{"name":"p"}',
		);
		expect(readFileSync(join(root, "dist/index.js"), "utf8")).toBe(
			"module.exports = 1;\n",
		);
		expect(readFileSync(join(root, "empty.txt")).length).toBe(0);
		expect(readFileSync(join(root, "big.bin")).equals(big)).toBe(true);
	});

	it("reads a name too long for the header from its PAX record", async () => {
		const long = `package/${"deep/".repeat(30)}file.js`;
		const archive = tarGz([{ name: long, body: "ok" }]);
		await extractTarGz(pieces(archive, 4096), root);
		expect(
			readFileSync(join(root, "deep/".repeat(30), "file.js"), "utf8"),
		).toBe("ok");
	});

	it("skips links", async () => {
		const archive = tarGz([
			{ name: "package/link", type: "2" },
			{ name: "package/real.txt", body: "r" },
		]);
		expect(await extractTarGz(pieces(archive, 512), root)).toBe(1);
		expect(existsSync(join(root, "link"))).toBe(false);
	});

	it("refuses a path that leaves the target", async () => {
		const archive = tarGz([{ name: "package/../../escape.txt", body: "x" }]);
		await expect(extractTarGz(pieces(archive, 512), root)).rejects.toThrow(
			/outside its folder/,
		);
		expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
	});

	it("fails on data that is not an archive", async () => {
		await expect(
			extractTarGz(pieces(Buffer.from("not gzip at all"), 4), root),
		).rejects.toThrow();
	});
});
