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
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vm from "node:vm";
import type { AgentTool, AgentToolContext } from "@cline/shared";
import { describeDelimiterBalance } from "./delimiter-balance";

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

Output: plain text, one section per file you named. A file with nothing wrong says so in one line. There is no object to unpack and no \`success\` field — problems being listed is this tool working, not failing.

When a file's brackets do not match, a \`Delimiter scan\` section names the *opening* bracket involved, and one line per place the trouble starts — a file can be broken in several spots at once, so fix every line it lists in one edit rather than one per round trip. A parse error is always reported where the parser gave up, which is the closing bracket; the opener is the one you have to edit, and it is the one the error cannot name.`;

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

/** Extensions parsed as JavaScript. */
const JS_LIKE = new Set([".js", ".mjs", ".cjs"]);
const HTML_LIKE = new Set([".html", ".htm"]);

export interface CheckFinding {
	line: number;
	/** Whether the runtime named that line, or it is just the start of the file. */
	located: boolean;
	message: string;
	/** The source line the parser stopped on, when it named one. */
	source?: string;
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
): { line: number; source?: string } | undefined {
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
		const source = head[1]?.trim();
		return { line: Number(located[1]), ...(source ? { source } : {}) };
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
		...(where?.source ? { source: where.source } : {}),
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
export function checkSource(filePath: string, text: string): string {
	const extension = path.extname(filePath).toLowerCase();
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

	const lines: string[] = [`## ${filePath}`];
	if (findings.length === 0) {
		lines.push("No syntax errors.");
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
		if (finding.source) {
			lines.push(`    ${finding.source}`);
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
export function createCheckFileTool(options?: {
	cwd?: string;
}): AgentTool<{ paths: string[] }, string> {
	return {
		name: CHECK_FILE_TOOL_NAME,
		description: CHECK_FILE_TOOL_DESCRIPTION,
		inputSchema: CHECK_FILE_TOOL_INPUT_SCHEMA,
		execute: async (
			input: { paths: string[] },
			_context: AgentToolContext,
		): Promise<string> => {
			const requested = Array.isArray(input?.paths) ? input.paths : [];
			const paths = requested
				.filter((entry) => typeof entry === "string" && entry.trim() !== "")
				.slice(0, MAX_FILES_PER_CALL);
			if (paths.length === 0) {
				return "No files named. Pass the paths you want checked in `paths`.";
			}
			const root = options?.cwd ?? process.cwd();
			const sections: string[] = [];
			for (const entry of paths) {
				const filePath = path.isAbsolute(entry)
					? entry
					: path.resolve(root, entry);
				try {
					const text = await fs.readFile(filePath, "utf-8");
					sections.push(checkSource(entry, text));
				} catch (error) {
					sections.push(
						`## ${entry}\nCould not read this file: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			if (requested.length > MAX_FILES_PER_CALL) {
				sections.push(
					`Only the first ${MAX_FILES_PER_CALL} files were checked; ${
						requested.length - MAX_FILES_PER_CALL
					} more were named.`,
				);
			}
			return sections.join("\n\n");
		},
	} as unknown as AgentTool<{ paths: string[] }, string>;
}
