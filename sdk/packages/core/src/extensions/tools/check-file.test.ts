import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildLintCommand,
	CHECK_FILE_TOOL_DESCRIPTION,
	checkFileReport,
	checkSource,
	compileCheck,
	createCheckFileTool,
	extractScripts,
	LINT_COMMAND_FILE_PLACEHOLDER,
} from "./check-file";

const made: string[] = [];

async function tempFile(name: string, content: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "check-file-"));
	made.push(dir);
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, content, "utf-8");
	return filePath;
}

afterEach(async () => {
	while (made.length > 0) {
		await fs.rm(made.pop() as string, { recursive: true, force: true });
	}
});

describe("compiling without running", () => {
	it("says nothing about a file that parses", () => {
		expect(compileCheck("const a = 1;\n", "ok.js")).toBeUndefined();
	});

	it("names the line the parser stopped on", () => {
		const found = compileCheck("let a = 1;\nlet b = (2;\nlet c = 3;", "bad.js");
		expect(found?.line).toBe(2);
		expect(found?.located).toBe(true);
		expect(found?.message).toContain("Unexpected token");
		expect(found?.sourceText).toContain("let b");
	});

	// The whole reason this is `vm.Script` and not `eval`: a page that starts a
	// game must not start one because somebody asked whether it parses.
	it("does not run what it compiles", () => {
		const sideEffect = "globalThis.__checkFileRan = true;";
		expect(compileCheck(sideEffect, "effect.js")).toBeUndefined();
		expect(
			(globalThis as Record<string, unknown>).__checkFileRan,
		).toBeUndefined();
	});

	it("shifts the reported line by the offset it is given", () => {
		const found = compileCheck("let b = (2;", "page.html", 40);
		expect(found?.line).toBe(41);
	});
});

describe("finding the scripts in a page", () => {
	it("reads an inline block and the line it starts on", () => {
		const html = [
			"<html>",
			"<body>",
			"<script>",
			"let a = 1;",
			"</script>",
		].join("\n");
		const blocks = extractScripts(html);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].startLine).toBe(3);
	});

	// Three ways a `<script>` is not ours to parse. Reporting a syntax error in
	// a JSON island would send a model to edit something that was correct.
	it("leaves alone what it does not own", () => {
		expect(extractScripts('<script src="game.js"></script>')).toHaveLength(0);
		expect(
			extractScripts('<script type="application/json">{"a":1}</script>'),
		).toHaveLength(0);
		expect(extractScripts("<script>   </script>")).toHaveLength(0);
	});

	it("keeps modules, which are JavaScript", () => {
		expect(
			extractScripts('<script type="module">export const a = 1;</script>'),
		).toHaveLength(1);
	});
});

describe("what a file check says", () => {
	it("reports a clean file in one line", () => {
		const report = checkSource("ok.js", "const a = 1;\n");
		expect(report).toContain("No syntax errors.");
	});

	// The measured case: the broken game page. The error has to be reported at
	// its line in the HTML, not at its line inside the script block.
	it("reports an html error at its line in the html", () => {
		const html = [
			"<html>",
			"<head><title>t</title></head>",
			"<body>",
			"<script>",
			"function ok() { return 1; }",
			"function bad( { return 2; }",
			"</script>",
			"</body>",
		].join("\n");
		const report = checkSource("game.html", html);
		expect(report).toMatch(/game\.html:[67]: error:/);
	});

	it("reports malformed json", () => {
		expect(checkSource("a.json", "{ not json }")).toContain("error:");
	});

	// A file whose brackets cross can still parse; the scan runs either way.
	it("adds the delimiter scan beneath the parse result", () => {
		const report = checkSource("bad.js", "function a() { return (1; }\n");
		expect(report).toContain("error:");
	});

	// This report now travels on its own to whatever file a failing command
	// blames, in whatever language. "No syntax errors" about a file nothing here
	// can parse is a clean bill of health signed by a check that never ran — and
	// the model takes it, because it did not ask for any of this.
	it("says it did not check a language it does not know", () => {
		const report = checkSource("notes.rst", "this is (not balanced\n");
		expect(report).toContain("Not checked");
		expect(report).toContain(".rst");
		expect(report).not.toContain("No syntax errors.");
	});

	it("says how far it got on a language it scans but cannot parse", () => {
		const report = checkSource("app.ts", "export const a: number = 1;\n");
		expect(report).toContain("Brackets balance");
		expect(report).toContain("unchecked");
	});
});

describe("the tool", () => {
	const tool = createCheckFileTool();

	it("checks the files it is given", async () => {
		const filePath = await tempFile("broken.js", "let a = (1;\n");
		const report = (await tool.execute(
			{ paths: [filePath] },
			{} as never,
		)) as string;
		expect(report).toContain("error:");
	});

	it("says so when a file cannot be read rather than failing the call", async () => {
		const report = (await tool.execute(
			{ paths: ["/nope/does-not-exist.js"] },
			{} as never,
		)) as string;
		expect(report).toContain("Could not read this file");
	});

	it("asks for paths when given none", async () => {
		const report = (await tool.execute({ paths: [] }, {} as never)) as string;
		expect(report).toContain("No files named");
	});

	// The number rides on this tool because this is where the model already is
	// when it is about to change a file. It must arrive with its bound attached
	// -- a score handed over bare gets read as a verdict.
	it("reports the file's cognitive complexity, with the bound", async () => {
		const filePath = await tempFile(
			"nested.js",
			[
				"function tick(items) {",
				"  items.forEach((d) => {",
				"    if (d.on) {",
				"      for (const p of d.parts) { if (p.hit) { p.y += 1; } }",
				"    }",
				"  });",
				"}",
			].join("\n"),
		);
		const report = (await tool.execute(
			{ paths: [filePath] },
			{} as never,
		)) as string;
		expect(report).toContain("Cognitive complexity of");
		expect(report).toContain("treat it as context, not as evidence");
	});

	// Silence, not a zero: a language with no grammar simply has no line.
	it("says nothing about complexity for a language it cannot measure", async () => {
		const filePath = await tempFile("notes.txt", "if if if\n");
		const report = (await tool.execute(
			{ paths: [filePath] },
			{} as never,
		)) as string;
		expect(report).not.toContain("Cognitive complexity");
	});

	it("checks every file named in one call", async () => {
		const good = await tempFile("good.js", "const a = 1;\n");
		const bad = await tempFile("bad.js", "const b = (1;\n");
		const report = (await tool.execute(
			{ paths: [good, bad] },
			{} as never,
		)) as string;
		expect(report).toContain("No syntax errors.");
		expect(report).toContain("error:");
	});
});

describe("substituting the file into a lint command", () => {
	it("replaces the placeholder wherever it appears", () => {
		expect(
			buildLintCommand(
				`biome check ${LINT_COMMAND_FILE_PLACEHOLDER} --write ${LINT_COMMAND_FILE_PLACEHOLDER}`,
				"/w/a.ts",
			),
		).toBe("biome check /w/a.ts --write /w/a.ts");
	});

	// `eslint` is what a user will actually type, and refusing it would be
	// pedantry.
	it("appends the path to a command that names no placeholder", () => {
		expect(buildLintCommand("eslint", "/w/a.ts")).toBe("eslint /w/a.ts");
	});

	it("quotes a path a shell would split", () => {
		expect(buildLintCommand("eslint", "/w/my file.ts")).toBe(
			'eslint "/w/my file.ts"',
		);
	});
});

describe("the checker with a project checker behind it", () => {
	// The description is the half of this that changes what the model does:
	// told it has only a syntax check, it goes and runs the linter through
	// `run_commands` anyway, which is the reflex the tool exists to displace.
	it("calls itself the linter only when it has one", () => {
		const bare = createCheckFileTool({ cwd: "/w" });
		expect(bare.description).toBe(CHECK_FILE_TOOL_DESCRIPTION);

		const linting = createCheckFileTool({ cwd: "/w", lintCommand: "biome" });
		expect(linting.description).toContain("**This is the linter.**");
		expect(linting.description).toContain("biome");
	});

	it("reports what the checker said alongside the syntax check", async () => {
		const filePath = await tempFile("a.js", "const a = 1;\n");
		const tool = createCheckFileTool({
			cwd: path.dirname(filePath),
			lintCommand: "biome check",
			runLintCommand: async () => ({
				exitCode: 1,
				output: "a.js:1:7 lint/style/noVar",
			}),
		});

		const report = (await tool.execute(
			{ paths: [filePath] },
			{} as never,
		)) as string;

		expect(report).toContain("No syntax errors.");
		expect(report).toContain("lint/style/noVar");
		expect(report).toContain("exited 1");
	});

	it("says a clean checker was clean, so silence is never inferred", async () => {
		const filePath = await tempFile("a.js", "const a = 1;\n");
		const tool = createCheckFileTool({
			cwd: path.dirname(filePath),
			lintCommand: "biome check",
			runLintCommand: async () => ({ exitCode: 0, output: "" }),
		});

		const report = (await tool.execute(
			{ paths: [filePath] },
			{} as never,
		)) as string;

		expect(report).toContain("passed with no output");
	});

	// A command that could not run at all must not read as a pass: the model
	// has been told this tool is the linter and would believe it.
	it("reports a checker that would not run", async () => {
		const filePath = await tempFile("a.js", "const a = 1;\n");
		const tool = createCheckFileTool({
			cwd: path.dirname(filePath),
			lintCommand: "nope",
			runLintCommand: async () => {
				throw new Error("spawn nope ENOENT");
			},
		});

		const report = (await tool.execute(
			{ paths: [filePath] },
			{} as never,
		)) as string;

		expect(report).toContain("could not be run");
		expect(report).toContain("ENOENT");
	});

	it("runs nothing when no command is configured", async () => {
		const filePath = await tempFile("a.js", "const a = 1;\n");
		let called = false;
		const tool = createCheckFileTool({
			cwd: path.dirname(filePath),
			runLintCommand: async () => {
				called = true;
				return { exitCode: 0, output: "" };
			},
		});

		await tool.execute({ paths: [filePath] }, {} as never);

		expect(called).toBe(false);
	});
});

describe("the structured report", () => {
	it("uses LSP positions: zero-based line, with a range", () => {
		// The point of the redesign. The model already knows this shape from
		// the LSP surface, and a shape it knows is one it does not have to be
		// taught in the description.
		const report = checkFileReport("/w/a.js", "function f( {\n");

		// The parse error, not the delimiter scan that also fires here: the
		// scan speaks about the file, so it carries no located position.
		const first = report.diagnostics.find((d) => d.located);
		expect(first).toBeDefined();
		expect(first?.range.start).toHaveProperty("character");
		expect(first?.range.end).toHaveProperty("line");
		expect(first?.severity).toBe(1);

		// Pinned against the prose renderer rather than a hardcoded number,
		// because that is the actual claim: the same finding, one-based for a
		// human reader and zero-based for an LSP one. A literal would pass
		// just as well if both were one-based.
		const printed = checkSource("/w/a.js", "function f( {\n").match(
			/a\.js:(\d+):/,
		);
		expect(printed).not.toBeNull();
		expect(first?.range.start.line).toBe(Number(printed?.[1]) - 1);
	});

	it("says what actually ran, because an empty list cannot", () => {
		// Three silences that must not read alike: a parser ran and was
		// satisfied, only the bracket scan ran, or nothing here reads this
		// language. `diagnostics: []` is identical in all three, and calling
		// the last one clean tells the model its file is sound on the
		// authority of a check that never happened.
		expect(checkFileReport("/w/a.js", "const a = 1;\n").checked).toBe("parsed");
		// .css is scanned for delimiters but has no parser here; .rb has
		// neither, and its empty list means nothing at all.
		expect(checkFileReport("/w/a.css", "a { color: red; }\n").checked).toBe(
			"delimiters",
		);
		expect(checkFileReport("/w/a.bin", "\u0000\u0001").checked).toBe("none");
	});

	it("reports the file it checked, so a batch result can be split", () => {
		expect(checkFileReport("/w/a.js", "const a = 1;\n").uri).toContain("a.js");
	});

	it("keeps the offending source line under its own name, not LSP's `source`", () => {
		// LSP's `source` is the producer -- "tsc", "eslint". Ours was the text
		// of the line the parser stopped on. Shipping that under the same key
		// would be a lie in a shape the model reads fluently, which is worse
		// than an unfamiliar shape.
		const report = checkFileReport("/w/a.js", "function f( {\n");
		const first = report.diagnostics.find((d) => d.located);

		expect(first?.source).toBe("check_file");
		if (first?.sourceLine !== undefined) {
			expect(typeof first.sourceLine).toBe("string");
		}
	});

	it("still carries an unlocated error, without pointing at line 1", () => {
		// A parse error the runtime located nowhere used to print `:1:`, which
		// sends the model to the wrong end of the file. In LSP shape every
		// diagnostic has a range, so the lie has to be marked rather than
		// avoided by omission.
		const report = checkFileReport("/w/a.json", "{ oops ");

		const parseError = report.diagnostics.find((d) =>
			/JSON|token|position/i.test(d.message),
		);
		expect(parseError?.located).toBe(false);
		expect(parseError?.range.start.line).toBe(0);
	});

	it("carries the delimiter scan as a diagnostic, not as prose", () => {
		const report = checkFileReport("/w/a.js", "function f() {\n");

		expect(
			report.diagnostics.some((d) => /brace|bracket|\{/i.test(d.message)),
		).toBe(true);
	});
});
