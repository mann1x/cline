import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { joinCheckerToShell, withCheckOnFailure } from "./check-on-failure";
import type { ToolOperationResult } from "./types";

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "cline-checkfail-"));
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(path.join(root, name), body);
	}
	return root;
}

/** A shell tool that returns whatever the test hands it. */
function shellReturning(
	results: ToolOperationResult[] | unknown,
): AgentTool<unknown, unknown> {
	return {
		name: "run_commands",
		description: "runs commands",
		inputSchema: {},
		execute: async () => results,
	};
}

function checkerSaying(
	report: string,
	seen?: { paths?: string[] },
): AgentTool<{ paths: string[] }, string> {
	return {
		name: "check_file",
		description: "checks files",
		inputSchema: {},
		execute: async (input) => {
			if (seen) {
				seen.paths = input.paths;
			}
			return report;
		},
	};
}

const context = {} as never;

describe("the checker's answer arriving with the failure", () => {
	it("appends the checker's report to a failing command", async () => {
		const root = workspace({ "game.js": "f(\n" });
		const seen: { paths?: string[] } = {};
		const wrapped = withCheckOnFailure(
			shellReturning([
				{
					query: "node game.js",
					result:
						"SyntaxError: missing ) after argument list\n  at game.js:1:2",
					success: false,
				},
			]),
			{
				cwd: root,
				checker: checkerSaying("## game.js\nline 1: 1 more `(`", seen),
			},
		);

		const results = (await wrapped.execute(
			{},
			context,
		)) as ToolOperationResult[];

		expect(seen.paths).toEqual([path.join(root, "game.js")]);
		expect(String(results[0]?.result)).toContain("SyntaxError");
		expect(String(results[0]?.result)).toContain("line 1: 1 more `(`");
	});

	it("says where the extra text came from, so it is not read as command output", async () => {
		const root = workspace({ "game.js": "f(\n" });
		const wrapped = withCheckOnFailure(
			shellReturning([
				{
					query: "node game.js",
					result: "SyntaxError: bad\n  at game.js:1:2",
					success: false,
				},
			]),
			{ cwd: root, checker: checkerSaying("## game.js\nfine") },
		);

		const results = (await wrapped.execute(
			{},
			context,
		)) as ToolOperationResult[];
		expect(String(results[0]?.result)).toContain("the checker, run for you");
	});

	it("works the same for a language the delimiter scanner never reads", async () => {
		// The whole point of the split: extraction is by shape, checking is the
		// host's. A host whose checker knows Python gets Python checked.
		const root = workspace({ "main.py": "print(\n" });
		const seen: { paths?: string[] } = {};
		const wrapped = withCheckOnFailure(
			shellReturning([
				{
					query: "python main.py",
					result:
						'Traceback (most recent call last):\n  File "main.py", line 1',
					error: "SyntaxError: unexpected EOF while parsing",
					success: false,
				},
			]),
			{ cwd: root, checker: checkerSaying("## main.py\nunclosed `(`", seen) },
		);

		await wrapped.execute({}, context);
		expect(seen.paths).toEqual([path.join(root, "main.py")]);
	});

	it("reads the error field, not only the output", async () => {
		const root = workspace({ "a.ts": "1\n" });
		const seen: { paths?: string[] } = {};
		const wrapped = withCheckOnFailure(
			shellReturning([
				{
					query: "tsc",
					result: "",
					error: "a.ts:3:9 - error TS1005",
					success: false,
				},
			]),
			{ cwd: root, checker: checkerSaying("## a.ts\nok", seen) },
		);
		await wrapped.execute({}, context);
		expect(seen.paths).toEqual([path.join(root, "a.ts")]);
	});

	it("leaves a successful command untouched", async () => {
		const root = workspace({ "a.js": "1\n" });
		const checker = checkerSaying("should never be called");
		const spy = vi.spyOn(checker, "execute");
		const wrapped = withCheckOnFailure(
			shellReturning([
				{ query: "node a.js", result: "ran a.js fine", success: true },
			]),
			{ cwd: root, checker },
		);

		const results = (await wrapped.execute(
			{},
			context,
		)) as ToolOperationResult[];
		expect(spy).not.toHaveBeenCalled();
		expect(results[0]?.result).toBe("ran a.js fine");
	});

	it("leaves a failure that names no workspace file untouched", async () => {
		const root = workspace({ "a.js": "1\n" });
		const checker = checkerSaying("nope");
		const spy = vi.spyOn(checker, "execute");
		const wrapped = withCheckOnFailure(
			shellReturning([
				{
					query: "curl x",
					result: "error: connection refused",
					success: false,
				},
			]),
			{ cwd: root, checker },
		);

		await wrapped.execute({}, context);
		expect(spy).not.toHaveBeenCalled();
	});

	it("falls back to the file the command named when the output names none", async () => {
		// The measured case this exists for: the page is HTML, `node` cannot run
		// it, the model's wrapper script caught the parse error and printed a
		// summary of its own. Nothing in that output is a file — but the command
		// that produced it named one.
		const root = workspace({
			"run_game.js": "1\n",
			"manic_miner.html": "<script>f(</script>\n",
		});
		const seen: { paths?: string[] } = {};
		const wrapped = withCheckOnFailure(
			shellReturning([
				{
					query: "cd . && node run_game.js manic_miner.html",
					result:
						"Script length: 12610\nRuntime/Parse Error: SyntaxError: missing ) after argument list",
					success: false,
				},
			]),
			{
				cwd: root,
				checker: checkerSaying("## manic_miner.html\nreport", seen),
			},
		);

		await wrapped.execute({}, context);
		expect(seen.paths).toEqual([
			path.join(root, "run_game.js"),
			path.join(root, "manic_miner.html"),
		]);
	});

	it("prefers the file the output blamed over the one the command named", async () => {
		const root = workspace({ "runner.js": "1\n", "app.js": "1\n" });
		const seen: { paths?: string[] } = {};
		const wrapped = withCheckOnFailure(
			shellReturning([
				{
					query: "node runner.js app.js",
					result: "SyntaxError\n    at app.js:4:1",
					success: false,
				},
			]),
			{ cwd: root, checker: checkerSaying("## app.js\nreport", seen) },
		);

		await wrapped.execute({}, context);
		expect(seen.paths).toEqual([path.join(root, "app.js")]);
	});

	it("attaches one copy when several commands fail", async () => {
		const root = workspace({ "a.js": "1\n", "b.js": "1\n" });
		const wrapped = withCheckOnFailure(
			shellReturning([
				{ query: "node a.js", result: "error at a.js:1:1", success: false },
				{ query: "node b.js", result: "error at b.js:1:1", success: false },
			]),
			{ cwd: root, checker: checkerSaying("## both\nreport") },
		);

		const results = (await wrapped.execute(
			{},
			context,
		)) as ToolOperationResult[];
		const carrying = results.filter((entry) =>
			String(entry.result).includes("## both"),
		);
		expect(carrying).toHaveLength(1);
		// The one the model is looking at: the last thing that failed.
		expect(carrying[0]?.query).toBe("node b.js");
	});

	it("returns the command's own output when the checker throws", async () => {
		const root = workspace({ "a.js": "1\n" });
		const wrapped = withCheckOnFailure(
			shellReturning([
				{ query: "node a.js", result: "error at a.js:1:1", success: false },
			]),
			{
				cwd: root,
				checker: {
					execute: () => {
						throw new Error("checker exploded");
					},
				},
			},
		);

		const results = (await wrapped.execute(
			{},
			context,
		)) as ToolOperationResult[];
		expect(results[0]?.result).toBe("error at a.js:1:1");
	});

	it("passes through a result shape it does not recognise", async () => {
		const root = workspace({ "a.js": "1\n" });
		const wrapped = withCheckOnFailure(shellReturning("just a string"), {
			cwd: root,
			checker: checkerSaying("report"),
		});
		expect(await wrapped.execute({}, context)).toBe("just a string");
	});

	it("keeps the tool's own name and description", async () => {
		const shell = shellReturning([]);
		const wrapped = withCheckOnFailure(shell, {
			cwd: "/w",
			checker: checkerSaying("report"),
		});
		expect(wrapped.name).toBe("run_commands");
		expect(wrapped.description).toBe(shell.description);
	});
});

describe("joining the two tools in an assembled toolset", () => {
	const root = workspace({ "a.js": "1\n" });

	it("wraps the shell tool and leaves the rest alone", async () => {
		const shell = shellReturning([
			{ query: "node a.js", result: "error at a.js:1:1", success: false },
		]);
		const checker = checkerSaying("## a.js\nreport");
		const other = shellReturning([]);
		other.name = "editor";

		const tools = joinCheckerToShell(
			[shell, checker, other] as unknown as AgentTool<never, unknown>[],
			{ cwd: root, shellName: "run_commands", checkerName: "check_file" },
		);

		expect(tools).toHaveLength(3);
		expect(tools[1]).toBe(checker);
		expect(tools[2]).toBe(other);
		const results = (await tools[0]?.execute(
			{} as never,
			context,
		)) as ToolOperationResult[];
		expect(String(results[0]?.result)).toContain("report");
	});

	it("returns the list untouched when the host has no checker", () => {
		const shell = shellReturning([]);
		const tools = joinCheckerToShell(
			[shell] as unknown as AgentTool<never, unknown>[],
			{ cwd: root, shellName: "run_commands", checkerName: "check_file" },
		);
		expect(tools[0]).toBe(shell);
	});

	it("wraps a host's own shell tool by name, not by identity", async () => {
		// VS Code substitutes a terminal-aware `run_commands`; it gets the same
		// wiring as the builtin.
		const hostShell = shellReturning([
			{ query: "node a.js", result: "error at a.js:1:1", success: false },
		]);
		hostShell.description = "the editor's terminal";
		const tools = joinCheckerToShell(
			[
				hostShell,
				checkerSaying("## a.js\nhost report"),
			] as unknown as AgentTool<never, unknown>[],
			{ cwd: root, shellName: "run_commands", checkerName: "check_file" },
		);
		expect(tools[0]?.description).toBe("the editor's terminal");
		const results = (await tools[0]?.execute(
			{} as never,
			context,
		)) as ToolOperationResult[];
		expect(String(results[0]?.result)).toContain("host report");
	});
});
