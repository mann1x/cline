import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CodeIndex,
	codeCollectionName,
	isIndexableCodePath,
} from "./code-index";

describe("CodeIndex", () => {
	let directory: string;
	let workspace: string;
	let index: CodeIndex;

	const files: Record<string, string> = {
		"src/auth/login.ts": [
			"export function verifyPassword(user: User, password: string): boolean {",
			"\treturn hash(password, user.salt) === user.passwordHash;",
			"}",
		].join("\n"),
		"src/billing/invoice.ts": [
			"// Totals for an invoice.",
			"",
			"export function invoiceTotal(lines: Line[]): number {",
			"\treturn lines.reduce((sum, line) => sum + line.amount, 0);",
			"}",
		].join("\n"),
		"package-lock.json": '{"lockfileVersion": 3}',
		"assets/logo.bin": "\u0000\u0001\u0002binary",
	};

	async function write(relativePath: string, text: string) {
		const target = join(workspace, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, text);
	}

	const listFiles = async () => Object.keys(files);

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "code-index-"));
		workspace = await mkdtemp(join(tmpdir(), "code-index-ws-"));
		for (const [relativePath, text] of Object.entries(files)) {
			await write(relativePath, text);
		}
		index = new CodeIndex({ directory });
	});

	afterEach(async () => {
		await index.close();
		await rm(directory, { recursive: true, force: true });
		await rm(workspace, { recursive: true, force: true });
	});

	it("indexes source files and leaves out lockfiles and binaries", async () => {
		const result = await index.sync(workspace, { listFiles });

		expect(result).toMatchObject({
			files: 2,
			added: 2,
			updated: 0,
			removed: 0,
		});
		// The binary is read and refused; the lockfile is not even listed.
		expect(result.skipped).toBe(1);
		expect(index.status(workspace)).toMatchObject({ indexed: true, files: 2 });
	});

	it("finds a passage by keyword and says which lines it is on", async () => {
		await index.sync(workspace, { listFiles });

		const result = await index.search(workspace, "invoiceTotal amount");

		expect(result.mode).toBe("keyword");
		expect(result.hits[0]).toMatchObject({
			path: "src/billing/invoice.ts",
			startLine: 1,
			endLine: 5,
		});
	});

	it("reads only what changed on the next run, and drops what is gone", async () => {
		await index.sync(workspace, { listFiles });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await write(
			"src/auth/login.ts",
			`${files["src/auth/login.ts"]}\n\nexport const MAX_ATTEMPTS = 5;\n`,
		);
		await rm(join(workspace, "src/billing/invoice.ts"));

		const result = await index.sync(workspace, {
			listFiles: async () => ["src/auth/login.ts"],
		});

		expect(result).toMatchObject({
			files: 1,
			added: 0,
			updated: 1,
			removed: 1,
		});
		const found = await index.search(workspace, "MAX_ATTEMPTS");
		expect(found.hits[0]?.path).toBe("src/auth/login.ts");
		expect((await index.search(workspace, "invoiceTotal")).hits).toEqual([]);
	});

	it("gives a passage without line numbers when the file has since changed", async () => {
		await index.sync(workspace, { listFiles });
		await write("src/billing/invoice.ts", "export const nothing = 1;\n");

		const result = await index.search(workspace, "invoiceTotal");

		expect(result.hits[0]?.path).toBe("src/billing/invoice.ts");
		expect(result.hits[0]?.startLine).toBeUndefined();
	});

	it("keeps workspaces apart and forgets one on request", async () => {
		await index.sync(workspace, { listFiles });
		const other = await mkdtemp(join(tmpdir(), "code-index-other-"));
		try {
			expect(index.status(other).indexed).toBe(false);
			expect((await index.search(other, "invoiceTotal")).hits).toEqual([]);
		} finally {
			await rm(other, { recursive: true, force: true });
		}

		expect(await index.remove(workspace)).toBe(true);
		expect(index.status(workspace).indexed).toBe(false);
	});
});

describe("code index names", () => {
	it("gives one name to a workspace however its path ends", () => {
		expect(codeCollectionName("/work/app/")).toBe(
			codeCollectionName("/work/app"),
		);
	});

	it.each([
		["src/index.ts", true],
		["README.md", true],
		["yarn.lock", false],
		["dist/app.min.js", false],
		["src/schema.generated.ts", false],
		["web/app.js.map", false],
	])("%s indexable: %s", (path, expected) => {
		expect(isIndexableCodePath(path)).toBe(expected);
	});
});
