/**
 * A checker for hosts that have no language server.
 *
 * VS Code's `check_file` asks the editor's own language servers and is as good
 * as whatever the user has installed. Every other host — the CLI above all —
 * had nothing, and the edit-verification guard stands aside when no checker is
 * named. Measured on the CLI: a run made ten `editor` calls, checked nothing,
 * and reported "the implementation is complete" on a file that does not parse.
 * The model was not being careless so much as blind; `run_commands` was its
 * only way to find out and it did not think to use it.
 *
 * So this answers the narrower question the editor cannot be asked here: does
 * this file still parse, and where do its brackets stop matching. It is not a
 * type checker and does not pretend to be — the description says so, because a
 * model that believes a clean result means "correct" is worse off than one
 * that knows the bound.
 *
 * Compilation is `vm.Script`, which parses without running: an HTML page that
 * starts a game must not start one because someone asked whether it parses.
 *
 * A host that can name a real checker gets to close the rest of the distance:
 * pass a lint command and this runs it too, and says so in its description. The
 * point of that is not convenience — it is that the two hosts stop shipping
 * different tools under one name. Without it the extension tells the model
 * `check_file` is the linter and the type checker while the CLI tells it the
 * same tool is a syntax check, and an edit-verification mode of `require`
 * therefore forces a much weaker check on the CLI than the words suggest.
 */

import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vm from "node:vm";
import type { AgentTool, AgentToolContext } from "@cline/shared";
import {
	canScanDelimiters,
	describeDelimiterBalance,
} from "./delimiter-balance";

const execAsync = promisify(exec);

export const CHECK_FILE_TOOL_NAME = "check_file";

/**
 * Written at the model that gets this wrong.
 *
 * The failure is not ignorance of what a linter is: it is that `run_commands`
 * is the tool a model reaches for by reflex. So the commands it would
 * otherwise type are named here, in the description of the tool that replaces
 * them, which is where the model is standing when it is about to type one.
 */
export const CHECK_FILE_TOOL_DESCRIPTION = `Check files for syntax errors and unbalanced brackets. **This is the syntax check.** Whichever word the question uses — parse error, syntax error, "is it valid", "is it clean now", "what is still broken" — this is the tool that answers it, for the files you name, in milliseconds, without running anything.

Ask this instead of running \`node --check\`, \`python -m py_compile\`, \`tsc --noEmit\` or a bracket-counting script of your own. It parses the file without executing it, so it is safe on a page that would otherwise start a game or a server.

When to call it:
- After editing a file, to confirm the edit is valid before moving on.
- Before reporting a task finished, on every file you changed. An edit you have not looked at is not a change you can report as done.
- On a file you are about to change, to see what was already wrong with it.

Pass every file you want checked in one call.

For \`.html\` files each \`<script>\` block is parsed as JavaScript and the line numbers reported are the line numbers in the HTML file, not in the block.

Read the bound carefully. This reports **syntax**, not meaning: a file that parses may still call a function that does not exist, and this will not say so. It is not a type checker, it does not run tests, and it does not know your project's lint rules — for those, use \`run_commands\`.

Output: JSON, in the shape a language server answers in. \`files\` holds one entry per path you named, each with \`uri\`, \`checked\` and \`diagnostics\`. There is no \`success\` field — diagnostics being listed is this tool working, not failing.

\`checked\` says which check actually ran, and you have to read it before calling a file clean: \`parsed\` a real parser was satisfied, \`delimiters\` only the bracket scan reads this language so anything past brackets is unchecked, \`none\` nothing here reads this file type at all — empty \`diagnostics\` there means nothing was checked, not that the file is sound.

Each diagnostic carries \`range\` (zero-based line and character), \`severity\` (1 = error) and \`message\`. \`located: false\` means the parser could not name a position, so the range is a placeholder rather than a claim about the top of the file. \`complexity\` appears on a file big enough to be worth a word about — a note to you, not a diagnostic.

When a file's brackets do not match, a diagnostic names the line to edit and how many brackets that line is out by, one line per place the trouble starts — a file can be broken in several spots at once, so work through every line it lists before re-checking rather than re-checking after each one. Edit the lines it names; do not re-derive the balance by hand or with a script you write, which costs more thinking than you have and counts brackets inside strings, comments and regex literals that this scan skips. A parse error is always reported where the parser gave up, which is the closing bracket; the line named here is the one the error cannot name.`;

/**
 * The description when the host has a real checker to point at.
 *
 * The bound paragraph above is the whole reason this is a second string rather
 * than a suffix: with a lint command wired in, "it is not a type checker, it
 * does not know your project's lint rules" is no longer true, and a model that
 * believes it will go and run the command through `run_commands` anyway --
 * which is the reflex this tool exists to displace.
 *
 * The command is named rather than described, because a model deciding whether
 * to trust a result wants to know what produced it.
 */
export function buildCheckFileDescription(lintCommand: string): string {
	return `Check files for errors, using this project's own checker. **This is the linter.** Whichever word the question uses — lint error, type error, parse error, syntax error, "is it valid", "is it clean now", "what is still broken" — this is the tool that answers it, for the files you name.

Two checks run on every file you name. First the file is parsed without being executed, so it is safe on a page that would otherwise start a game or a server. Then \`${lintCommand}\` is run against it and its output is reported here.

Ask this instead of running that command yourself, and instead of \`node --check\`, \`python -m py_compile\`, \`tsc --noEmit\` or a bracket-counting script of your own. Running the checker through \`run_commands\` gets you the same answer more slowly and with none of the bracket analysis below.

When to call it:
- After editing a file, to confirm the edit is valid before moving on.
- Before reporting a task finished, on every file you changed. An edit you have not looked at is not a change you can report as done.
- On a file you are about to change, to see what was already wrong with it.

Pass every file you want checked in one call.

For \`.html\` files each \`<script>\` block is parsed as JavaScript and the line numbers reported are the line numbers in the HTML file, not in the block.

Read the bound: this is as good as the command behind it. A checker that does not cover a language reports nothing for it, and nothing reported is not the same as clean.

Output: JSON, in the shape a language server answers in. \`files\` holds one entry per path you named, each with \`uri\`, \`checked\` and \`diagnostics\`. There is no \`success\` field — diagnostics being listed is this tool working, not failing.

\`checked\` says which check actually ran, and you have to read it before calling a file clean: \`parsed\` a real parser was satisfied, \`delimiters\` only the bracket scan reads this language so anything past brackets is unchecked, \`none\` nothing here reads this file type at all — empty \`diagnostics\` there means nothing was checked, not that the file is sound.

Each diagnostic carries \`range\` (zero-based line and character), \`severity\` (1 = error) and \`message\`. \`located: false\` means the parser could not name a position, so the range is a placeholder rather than a claim about the top of the file. \`complexity\` appears on a file big enough to be worth a word about — a note to you, not a diagnostic. \`lint\` carries what your own checker said: \`command\`, \`exitCode\` and \`output\`. \`exitCode: 0\` with empty output means it ran and found nothing; the key missing altogether means no checker ran, which is not the same thing.

When a file's brackets do not match, a diagnostic names the line to edit and how many brackets that line is out by, one line per place the trouble starts — a file can be broken in several spots at once, so work through every line it lists before re-checking rather than re-checking after each one. Edit the lines it names; do not re-derive the balance by hand or with a script you write, which costs more thinking than you have and counts brackets inside strings, comments and regex literals that this scan skips. A parse error is always reported where the parser gave up, which is the closing bracket; the line named here is the one the error cannot name.`;
}

export const CHECK_FILE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		paths: {
			type: "array",
			items: { type: "string" },
			description:
				"Files to check. Absolute, or relative to the working directory. Pass all of them in one call.",
		},
	},
	required: ["paths"],
} as const;

/** Files checked in one call. A model that wants more wants a build. */
const MAX_FILES_PER_CALL = 20;

/**
 * The token a user writes in their lint command to mark where the path goes.
 *
 * Escaped rather than written plainly: as a plain literal it reads to the
 * linter as an unescaped template placeholder, which is exactly what it is not
 * — it is data the user types, and it has to stay a string to be matched.
 */
export const LINT_COMMAND_FILE_PLACEHOLDER = `\${file}`;

/** How long a lint command gets before it is treated as hung. */
const LINT_COMMAND_TIMEOUT_MS = 60_000;

/** Bytes of output kept. A linter that says more than this is saying it twice. */
const LINT_COMMAND_MAX_BUFFER = 1_000_000;

/** Characters of lint output shown per file. */
const LINT_OUTPUT_LIMIT = 8_000;

export interface LintCommandResult {
	exitCode: number;
	output: string;
}

/**
 * Substitute the file into the configured command.
 *
 * A command without the placeholder gets the path appended, because `"eslint"`
 * is what a user will actually type and refusing it would be pedantry.
 */
export function buildLintCommand(template: string, filePath: string): string {
	const quoted = /[\s"']/.test(filePath) ? JSON.stringify(filePath) : filePath;
	return template.includes(LINT_COMMAND_FILE_PLACEHOLDER)
		? template.replaceAll(LINT_COMMAND_FILE_PLACEHOLDER, quoted)
		: `${template} ${quoted}`;
}

/**
 * Run the command and report what it said, whatever it exited with.
 *
 * A non-zero exit is the normal outcome for a linter that found something, so
 * it is not an error here: the output is the answer either way, and both
 * streams are kept because linters disagree about which one findings belong on.
 */
async function runLintCommandInShell(
	template: string,
	filePath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<LintCommandResult> {
	const command = buildLintCommand(template, filePath);
	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd,
			timeout: LINT_COMMAND_TIMEOUT_MS,
			maxBuffer: LINT_COMMAND_MAX_BUFFER,
			...(signal ? { signal } : {}),
		});
		return { exitCode: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as {
			code?: number;
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		// A command that never ran -- misspelled, not installed -- has no
		// streams, and reporting it as a clean pass would be the worst of the
		// available lies. Its message stands in as the output.
		const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
		return {
			exitCode: typeof failure.code === "number" ? failure.code : 1,
			output: output.trim() !== "" ? output : (failure.message ?? ""),
		};
	}
}

/** Extensions parsed as JavaScript. */
const JS_LIKE = new Set([".js", ".mjs", ".cjs"]);
const HTML_LIKE = new Set([".html", ".htm"]);

export interface CheckFinding {
	line: number;
	/** Whether the runtime named that line, or it is just the start of the file. */
	located: boolean;
	message: string;
	/**
	 * The text of the line the parser stopped on, when it named one.
	 *
	 * Not `source`: LSP spends that name on the producer of a diagnostic
	 * ("tsc", "eslint"), and the structured report speaks LSP. A familiar key
	 * holding an unfamiliar value is worse than an unfamiliar key.
	 */
	sourceText?: string;
}

/**
 * Top-level `import`/`export`, which only a module may have.
 *
 * `new Function` compiles a function body, where module syntax is a syntax
 * error however correct the module is. Reporting that would send a model to
 * "fix" a working ES module, so module code is left to the locator alone.
 */
const MODULE_SYNTAX = /^[ \t]*(?:import|export)[\s{*]/m;

/**
 * Whether the code parses at all.
 *
 * `new Function` rather than `vm.Script` because the two runtimes disagree and
 * the CLI runs on the one that says nothing: measured on the same broken page,
 * Node's `vm.Script` throws `missing ) after argument list` and **Bun's parses
 * it without complaint**, because Bun compiles the script lazily. `new
 * Function` has to produce a callable, so both runtimes parse eagerly and both
 * throw.
 */
function parseError(code: string): string | undefined {
	if (MODULE_SYNTAX.test(code)) {
		return undefined;
	}
	try {
		new Function(code);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Which line stopped the parser, where the runtime will say.
 *
 * `vm.Script` puts `filename:line` at the head of the stack along with the
 * offending source line; the message alone carries neither. Bun does not throw
 * here at all, so this returns nothing there and the delimiter scan below
 * carries the location instead — which names the *opening* bracket, and is the
 * more useful answer regardless.
 */
function locateError(
	code: string,
	label: string,
): { line: number; sourceText?: string } | undefined {
	try {
		new vm.Script(code, { filename: label });
		return undefined;
	} catch (error) {
		if (!(error instanceof Error)) {
			return undefined;
		}
		const head = (error.stack ?? "").split("\n");
		const located = head[0]?.match(/:(\d+)$/);
		if (!located) {
			return undefined;
		}
		const sourceText = head[1]?.trim();
		return {
			line: Number(located[1]),
			...(sourceText ? { sourceText } : {}),
		};
	}
}

/** Compile without running, and say what and where. */
export function compileCheck(
	code: string,
	label: string,
	lineOffset = 0,
): CheckFinding | undefined {
	const message = parseError(code);
	if (message === undefined) {
		return undefined;
	}
	const where = locateError(code, label);
	return {
		line: where ? where.line + lineOffset : 1 + lineOffset,
		located: where !== undefined,
		message,
		...(where?.sourceText ? { sourceText: where.sourceText } : {}),
	};
}

/** A `<script>` body, and the line the body starts on. */
export interface ScriptBlock {
	code: string;
	startLine: number;
}

/**
 * The inline scripts of an HTML page.
 *
 * Blocks with a `src` are somebody else's file, and a `type` that is not
 * JavaScript (`application/json`, an import map, a template) is not ours to
 * parse — reporting a syntax error in a JSON island as a script error would
 * send a model to edit something that was correct.
 */
export function extractScripts(html: string): ScriptBlock[] {
	const blocks: ScriptBlock[] = [];
	const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
	for (const match of html.matchAll(pattern)) {
		const attributes = match[1] ?? "";
		const code = match[2] ?? "";
		if (/\bsrc\s*=/i.test(attributes)) {
			continue;
		}
		const type = attributes.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1];
		if (
			type &&
			!/^(text\/javascript|application\/javascript|module)$/i.test(type)
		) {
			continue;
		}
		if (!code.trim()) {
			continue;
		}
		const bodyStart = (match.index ?? 0) + match[0].indexOf(">") + 1;
		blocks.push({
			code,
			startLine: html.slice(0, bodyStart).split("\n").length,
		});
	}
	return blocks;
}

/** Everything this can say about one file. */
/**
 * What a check found, in the shape the model already reads.
 *
 * The redesign, and the reason for it is measured rather than aesthetic: the
 * A/B that added a sentence telling the model to call `check_file` tripled the
 * calls and bought nothing (9/20 vs 6/20 FIXED, p=0.51) at 1.8x the wall time.
 * Telling a model to use a tool harder does not make the tool legible. So the
 * result now arrives in the vocabulary the LSP surface already taught it —
 * `range`, `severity`, `message` — where it has to learn nothing at all.
 *
 * Positions are LSP's: zero-based line and character. Converting at the edge
 * rather than carrying one-based numbers under LSP names, because a familiar
 * shape holding unfamiliar values is worse than an unfamiliar shape.
 */
export interface CheckDiagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	/** LSP severity: 1 error, 2 warning. Everything here is an error. */
	severity: 1 | 2;
	/** LSP's `source` is the producer of the diagnostic, not the code. */
	source: string;
	message: string;
	/**
	 * Whether the parser actually named this position.
	 *
	 * Every LSP diagnostic must carry a range, so an error located nowhere has
	 * to be given one -- and the only honest choice is the top of the file,
	 * which is exactly the lie the text renderer refused to print. Marked
	 * rather than omitted: a reader that trusts the range needs to be told
	 * when it is a placeholder.
	 */
	located: boolean;
	/** The text of the line the parser stopped on, when it named one. */
	sourceLine?: string;
}

/**
 * Which check actually ran, because `diagnostics: []` cannot say.
 *
 * `parsed` a real parser was satisfied; `delimiters` only the bracket scan
 * ran, which is real but narrow; `none` nothing here reads this language and
 * the empty list means nothing at all. Reporting the third as clean tells a
 * model its file is sound on the authority of a check that never happened,
 * which is the failure the prose version was careful to avoid and which a bare
 * list would quietly reintroduce.
 */
export type CheckCoverage = "parsed" | "delimiters" | "none";

export interface CheckFileReport {
	uri: string;
	checked: CheckCoverage;
	diagnostics: CheckDiagnostic[];
}

/** One finding, converted to the LSP shape. */
function toDiagnostic(finding: CheckFinding): CheckDiagnostic {
	// One-based in, zero-based out, and never below zero: an unlocated finding
	// carries line 1 as a placeholder, which is line 0 here.
	const line = Math.max(0, finding.line - 1);
	return {
		range: {
			start: { line, character: 0 },
			end: { line, character: finding.sourceText?.length ?? 0 },
		},
		severity: 1,
		source: CHECK_FILE_TOOL_NAME,
		message: finding.message,
		located: finding.located,
		...(finding.sourceText ? { sourceLine: finding.sourceText } : {}),
	};
}

/**
 * Check one file and report it structurally.
 *
 * The source of truth; {@link checkSource} renders this for hosts still
 * reading prose, so the two can never disagree about what was found.
 */
export function checkFileReport(
	filePath: string,
	text: string,
): CheckFileReport {
	const extension = path.extname(filePath).toLowerCase();
	const findings = findIssues(filePath, text, extension);
	const parsed =
		JS_LIKE.has(extension) ||
		HTML_LIKE.has(extension) ||
		extension === ".json" ||
		extension === ".jsonc";
	const scanned = canScanDelimiters(filePath);
	const balance = describeDelimiterBalance(filePath, text);
	const diagnostics = findings.map(toDiagnostic);
	if (balance) {
		// The scan speaks about the file rather than about one position, so it
		// gets the top of the file and says it was not located there.
		diagnostics.push({
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 },
			},
			severity: 1,
			source: CHECK_FILE_TOOL_NAME,
			message: balance,
			located: false,
		});
	}
	return {
		uri: filePath,
		checked: parsed ? "parsed" : scanned ? "delimiters" : "none",
		diagnostics,
	};
}

/** Every finding for one file, before it is shaped for a reader. */
function findIssues(
	filePath: string,
	text: string,
	extension: string,
): CheckFinding[] {
	const findings: CheckFinding[] = [];
	if (JS_LIKE.has(extension)) {
		const found = compileCheck(text, path.basename(filePath));
		if (found) {
			findings.push(found);
		}
	} else if (HTML_LIKE.has(extension)) {
		for (const block of extractScripts(text)) {
			// -1 because the block's own line 1 *is* the line it starts on.
			const found = compileCheck(
				block.code,
				path.basename(filePath),
				block.startLine - 1,
			);
			if (found) {
				findings.push(found);
			}
		}
	} else if (extension === ".json" || extension === ".jsonc") {
		try {
			JSON.parse(text);
		} catch (error) {
			findings.push({
				line: 1,
				located: false,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return findings;
}

export function checkSource(filePath: string, text: string): string {
	const extension = path.extname(filePath).toLowerCase();
	const findings = findIssues(filePath, text, extension);
	const report = checkFileReport(filePath, text);

	const lines: string[] = [`## ${filePath}`];
	if (findings.length === 0) {
		// Three different silences, and they must not read alike. A parser ran
		// and was satisfied; only the bracket scan ran, which is real but
		// narrow; or nothing here reads this language at all — and calling that
		// last one "No syntax errors" tells a model its file is sound on the
		// authority of a check that never happened. That report now travels
		// automatically to whatever file a failing command blames, in whatever
		// language, so the difference is no longer academic.
		//
		// `report.checked` is the same distinction, carried structurally for
		// the reader that gets JSON instead of this.
		if (report.checked === "parsed") {
			lines.push("No syntax errors.");
		} else if (report.checked === "delimiters") {
			lines.push(
				`Brackets balance. Nothing here parses \`${extension}\`, so anything past delimiters is unchecked.`,
			);
		} else {
			lines.push(
				`Not checked: no syntax checker here reads \`${extension || "this file type"}\`.`,
			);
		}
	}
	for (const finding of findings) {
		// A line is only quoted when the runtime named one. Printing `:1:` for
		// an error the parser located nowhere reads as "the trouble is at the
		// top", and sends the model to the wrong end of the file.
		lines.push(
			finding.located
				? `${filePath}:${finding.line}: error: ${finding.message}`
				: `${filePath}: error: ${finding.message}`,
		);
		if (finding.sourceText) {
			lines.push(`    ${finding.sourceText}`);
		}
	}
	// Runs whether or not the parse succeeded: a file can parse and still have
	// crossed brackets inside a string-heavy line, and a file that fails to
	// parse needs the opener named, which the parse error cannot do.
	const scan = describeDelimiterBalance(filePath, text);
	if (scan) {
		lines.push(scan);
	}
	return lines.join("\n");
}

/**
 * The checker as a tool.
 *
 * Reading is plain `fs`: this runs in the same process as the rest of the
 * local host's tools, which read files the same way.
 */
/**
 * The file's cognitive complexity, as a line to append, or nothing.
 *
 * Imported lazily and never fatally, the same way the escalation assessment
 * reaches it: the grammars are 50 MB of wasm that nothing should pay for until
 * a file in that language is actually asked about, and every failure -- no
 * grammar, no wasm runtime, a file that will not parse -- is silence. Silence
 * here means the line is absent, never that the file is simple.
 *
 * Why it rides on `check_file` at all: this is the tool a model calls on a
 * file it is about to change or has just changed, which is exactly the moment
 * the number is worth having. It is diagnostic context and the sentence that
 * travels with it says so -- it is not a verdict, and nothing downstream reads
 * it as one.
 */
async function describeFileComplexity(
	displayPath: string,
	absolutePath: string,
	text: string,
): Promise<string | undefined> {
	try {
		const { scoreComplexity, describeComplexity } = await import(
			"../complexity/walker"
		);
		const score = await scoreComplexity(absolutePath, text);
		return score ? describeComplexity(score, displayPath) : undefined;
	} catch {
		return undefined;
	}
}

/** One file in the tool's answer. Either it was checked, or it could not be. */
export type CheckFileEntry =
	| (CheckFileReport & {
			lint?: CheckFileLint;
			complexity?: string;
	  })
	| { uri: string; error: string };

/** What the user's own checker said, when one is configured. */
export interface CheckFileLint {
	command: string;
	/** Absent when the command could not be run at all. */
	exitCode?: number;
	output: string;
	/** Set when the command itself failed to launch. */
	error?: string;
}

export interface CheckFileAnswer {
	files: CheckFileEntry[];
	/** Present only when more files were named than could be checked. */
	notChecked?: { named: number; limit: number };
	/** Present only when the call could not be served at all. */
	error?: string;
}

/**
 * The answer, as JSON.
 *
 * Compact, not indented. Indenting reads better to a person and I wrote it
 * that way first, but measured on a two-file answer it costs 40% more
 * characters — an LSP `range` alone becomes twelve lines of mostly zeroes.
 * This tool is called after every edit, and the one measured fact about it is
 * that calling it more often cost 1.8x the wall time for no verdict gain; the
 * per-call price is the lever that matters, and a model does not need the
 * newlines to read JSON.
 */
function render(answer: CheckFileAnswer): string {
	return JSON.stringify(answer);
}

/** Run the configured checker and shape what it said. */
async function runLintCommand(
	template: string,
	run: NonNullable<Parameters<typeof createCheckFileTool>[0]>["runLintCommand"],
	filePath: string,
	signal?: AbortSignal,
): Promise<CheckFileLint> {
	const command = buildLintCommand(template, filePath);
	if (!run) {
		return { command, output: "", error: "no runner supplied" };
	}
	try {
		const result = await run(template, filePath, signal);
		const output = result.output.trim();
		return {
			command,
			exitCode: result.exitCode,
			// A linter that says more than this is saying it twice, and the
			// result lands in a transcript that compaction has to carry.
			output:
				output.length > LINT_OUTPUT_LIMIT
					? `${output.slice(0, LINT_OUTPUT_LIMIT)}\n(truncated at ${LINT_OUTPUT_LIMIT} characters)`
					: output,
		};
	} catch (error) {
		// Not a pass. The model has been told this tool is the linter and would
		// believe an empty answer.
		return {
			command,
			output: "",
			error: `could not be run: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

export function createCheckFileTool(options?: {
	cwd?: string;
	/** The user's lint command, if they configured one. */
	lintCommand?: string;
	/** Runs it. Injected so tests never spawn anything. */
	runLintCommand?: (
		template: string,
		filePath: string,
		signal?: AbortSignal,
	) => Promise<LintCommandResult>;
}): AgentTool<{ paths: string[] }, string> {
	const lintCommand = options?.lintCommand?.trim() || undefined;
	// Resolved once, at construction, because the description has to name it and
	// the description is fixed for the life of the tool. A host that changes the
	// command mid-session builds a new tool, which is what happens anyway: the
	// toolset is assembled per session.
	const runLint = lintCommand
		? (options?.runLintCommand ??
			((template: string, filePath: string, signal?: AbortSignal) =>
				runLintCommandInShell(
					template,
					filePath,
					options?.cwd ?? process.cwd(),
					signal,
				)))
		: undefined;
	return {
		name: CHECK_FILE_TOOL_NAME,
		description: lintCommand
			? buildCheckFileDescription(lintCommand)
			: CHECK_FILE_TOOL_DESCRIPTION,
		inputSchema: CHECK_FILE_TOOL_INPUT_SCHEMA,
		execute: async (
			input: { paths: string[] },
			context: AgentToolContext,
		): Promise<string> => {
			const requested = Array.isArray(input?.paths) ? input.paths : [];
			const paths = requested
				.filter((entry) => typeof entry === "string" && entry.trim() !== "")
				.slice(0, MAX_FILES_PER_CALL);
			if (paths.length === 0) {
				return render({
					files: [],
					error: "No files named. Pass the paths you want checked in `paths`.",
				});
			}
			const root = options?.cwd ?? process.cwd();
			const files: CheckFileEntry[] = [];
			for (const entry of paths) {
				const filePath = path.isAbsolute(entry)
					? entry
					: path.resolve(root, entry);
				try {
					const text = await fs.readFile(filePath, "utf-8");
					const report = checkFileReport(entry, text);
					const lint =
						lintCommand && runLint
							? await runLintCommand(
									lintCommand,
									runLint,
									filePath,
									context?.signal,
								)
							: undefined;
					const complexity = await describeFileComplexity(
						entry,
						filePath,
						text,
					);
					files.push({
						...report,
						...(lint ? { lint } : {}),
						...(complexity ? { complexity } : {}),
					});
				} catch (error) {
					// Represented rather than dropped: an absence is the one thing
					// a list cannot make a reader notice.
					files.push({
						uri: entry,
						error: `Could not read this file: ${
							error instanceof Error ? error.message : String(error)
						}`,
					});
				}
			}
			return render({
				files,
				...(requested.length > MAX_FILES_PER_CALL
					? {
							notChecked: {
								named: requested.length,
								limit: MAX_FILES_PER_CALL,
							},
						}
					: {}),
			});
		},
	} as unknown as AgentTool<{ paths: string[] }, string>;
}
