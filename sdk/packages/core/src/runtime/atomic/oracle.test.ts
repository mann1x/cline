import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverOracle, runOracle } from "./oracle";

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-oracle-"));
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

describe("finding something that can judge a change", () => {
	it("prefers a typecheck to a test suite, and both to a build", async () => {
		await withWorkspace(
			{
				"package.json": JSON.stringify({
					scripts: { build: "tsc -b", test: "vitest run", typecheck: "tsc" },
				}),
			},
			async (root) => {
				const oracle = await discoverOracle(root);
				expect(oracle?.args).toEqual(["run", "typecheck"]);
			},
		);
	});

	// Running `npm test` in a bun workspace writes a package-lock.json as a
	// side effect of judging an edit — a change the transaction never asked for
	// and would then roll back.
	it("runs scripts with the package manager the lockfile names", async () => {
		await withWorkspace(
			{
				"package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
				"bun.lock": "",
			},
			async (root) => {
				const oracle = await discoverOracle(root);
				expect(oracle?.command).toBe("bun");
			},
		);
	});

	it.each([
		{ marker: "Cargo.toml", body: "[package]", command: "cargo" },
		{ marker: "go.mod", body: "module x", command: "go" },
		{ marker: "pyproject.toml", body: "[project]", command: "python3" },
	])("recognises a $marker workspace", async ({ marker, body, command }) => {
		await withWorkspace({ [marker]: body }, async (root) => {
			expect((await discoverOracle(root))?.command).toBe(command);
		});
	});

	it("falls back to a typecheck when only a tsconfig is there", async () => {
		await withWorkspace({ "tsconfig.json": "{}" }, async (root) => {
			expect((await discoverOracle(root))?.label).toBe("tsc --noEmit");
		});
	});

	it("reads a Makefile for a target rather than assuming one", async () => {
		await withWorkspace(
			{ Makefile: "all:\n\techo hi\ncheck:\n\techo ok\n" },
			async (root) => {
				expect((await discoverOracle(root))?.args).toEqual(["check"]);
			},
		);
	});

	// Not a failure. It is the case where the verdict falls to the model, and
	// the caller has to say so rather than pretend a check happened.
	it("finds nothing in a workspace that runs nothing", async () => {
		await withWorkspace({ "notes.md": "# hello" }, async (root) => {
			expect(await discoverOracle(root)).toBeUndefined();
		});
	});

	it("takes an explicitly configured command as written", async () => {
		await withWorkspace({ "package.json": "{}" }, async (root) => {
			const oracle = await discoverOracle(root, {
				explicit: "node run_game.js manic_miner.html",
			});
			expect(oracle?.label).toBe("node run_game.js manic_miner.html");
			expect(oracle?.reason).toBe("named in settings");
		});
	});
});

describe("reading the oracle's verdict", () => {
	it("passes on a zero exit", async () => {
		await withWorkspace({}, async (root) => {
			const verdict = await runOracle({
				label: "true",
				command: process.execPath,
				args: ["-e", "process.exit(0)"],
				cwd: root,
				reason: "test",
			});
			expect(verdict.passed).toBe(true);
			expect(verdict.exitCode).toBe(0);
		});
	});

	it("fails on a non-zero exit and keeps the output as the record", async () => {
		await withWorkspace({}, async (root) => {
			const verdict = await runOracle({
				label: "false",
				command: process.execPath,
				args: ["-e", "console.error('SyntaxError: boom'); process.exit(1)"],
				cwd: root,
				reason: "test",
			});
			expect(verdict.passed).toBe(false);
			expect(verdict.exitCode).toBe(1);
			expect(verdict.output).toContain("SyntaxError: boom");
		});
	});

	// An oracle that cannot run has judged nothing. Treating "not found" as a
	// pass would keep every transaction it was pointed at.
	it("fails when the command does not exist", async () => {
		await withWorkspace({}, async (root) => {
			const verdict = await runOracle({
				label: "missing",
				command: "definitely-not-a-real-command-xyz",
				args: [],
				cwd: root,
				reason: "test",
			});
			expect(verdict.passed).toBe(false);
			expect(verdict.exitCode).toBeNull();
		});
	});

	it("fails a run that never finished, and says why", async () => {
		await withWorkspace({}, async (root) => {
			const verdict = await runOracle(
				{
					label: "sleep",
					command: process.execPath,
					args: ["-e", "setTimeout(() => {}, 10000)"],
					cwd: root,
					reason: "test",
				},
				{ timeoutMs: 300 },
			);
			expect(verdict.passed).toBe(false);
			expect(verdict.timedOut).toBe(true);
			expect(verdict.output).toContain("not a pass");
		});
	});
});
