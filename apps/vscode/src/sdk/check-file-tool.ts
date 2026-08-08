import { type AgentTool, createTool } from "@cline/shared"
import * as fs from "fs/promises"
import * as path from "path"
import type { FileDiagnostics } from "@/shared/proto/index.cline"
import { Logger } from "@/shared/services/Logger"
import { describeDelimiterBalance } from "./delimiter-balance"
import { readHostDiagnostics, readSettledDiagnostics, renderFileDiagnostics, samePath, sleep } from "./editor-diagnostics"

/**
 * A tool that answers "is this file broken?".
 *
 * The editor already knows. It type-checks and lints continuously, and until
 * now the only way that verdict reached the model was as an unsolicited
 * appendix to an edit it had just made. A model that wants to check something
 * it did *not* just write — a file it read, a file the user mentioned, a file
 * three edits ago — has no way to ask.
 *
 * What it does instead is shell out. `tsc --noEmit`, `eslint`, `ruff`, `go
 * build`, and then it waits thirty seconds for a whole-project answer to a
 * one-file question. Gemma and Qwen do this constantly. The tool that would
 * have answered in milliseconds did not exist, so this is it, and its
 * description says so in the terms those models actually respond to.
 *
 * Everything about *reading* diagnostics — waiting for the language server to
 * settle, dropping hint-level noise, capping and rendering a file's problems —
 * already existed for the post-edit report and is imported from there. This
 * module adds only what is genuinely new: a tool surface, and a fallback for
 * when the editor has nothing to say.
 */

export const CHECK_FILE_TOOL_NAME = "check_file"

/**
 * Deliberately written at the model that gets this wrong.
 *
 * The failure is not that the model does not know what a linter is; it is that
 * `run_commands` is the tool it reaches for by reflex. So the alternatives it
 * would otherwise type are named here, in the description of the tool that
 * replaces them, which is where a model is standing when it is about to make
 * the mistake.
 *
 * The second failure is naming. Asked "how many errors is the linter
 * reporting?", a model answered that it could not count them and recited the
 * problems from its last edit report instead — with this tool in front of it.
 * The description said "check files for errors" and named `eslint` and `ruff`,
 * but never the word the question used, and `check_file` does not read as a
 * linter either. So the vocabulary is stated outright: this is the linter, the
 * type checker, the diagnostics, the Problems panel. A tool the model cannot
 * name is a tool it does not have.
 */
export const CHECK_FILE_TOOL_DESCRIPTION = `Check files for errors and warnings, using the editor's own language servers (LSP). **This is the linter.** It is also the type checker, the syntax check, and the source of the problems the IDE lists in its Problems panel — whichever of those words the question uses, this is the tool that answers it. The results are live and follow your edits: one is current as of the moment you ask, so if it still reports a problem after an edit, the problem is still there. Restarting a language server is neither possible nor necessary from here.

Ask this before running a checker yourself. For a file whose language the IDE understands, it answers the same question as \`tsc\`, \`eslint\`, \`biome\`, \`ruff\`, \`mypy\`, \`go build\` or \`cargo check\` would — for the files you name, in milliseconds, without building the project.

When to call it:
- Whenever the question is about the linter, lint errors, diagnostics, problems, warnings, type errors, syntax errors or compile errors — "how many errors is the linter reporting?", "is it clean now?", "what is still broken?". You have no other way to know, and the report you were shown after an earlier edit does not answer it: that was true then, and you have edited since.
- After editing a file, to confirm the edit is valid before moving on.
- Before reporting a task finished, on every file you changed.
- On a file you are about to change, when you want to know what was already wrong with it.

Pass every file you want checked in one call.

Read a clean result carefully. "No problems reported by the editor" is conclusive only where the IDE has a language server for that file, and it does not for every language on every machine. If this reports nothing and you have reason to expect a problem, or the project has a checker the IDE does not run, run that checker with \`run_commands\`. Tests and builds are always \`run_commands\`; this tool does not run them.

Output: plain text, one section per file you named, each problem on its own line as \`file:line:column\` with its severity and message. A file with nothing wrong says so in one line. There is no object to unpack and no \`success\` field — problems being listed is this tool working, not failing.

When a file's brackets do not match, a \`Delimiter scan\` section names the *opening* bracket involved, and one line per place the trouble starts — a file can be broken in several spots at once, so fix every line it lists in one edit rather than one per round trip. A parse error is always reported where the parser gave up, which is the closing bracket; the opener is the one you have to edit, and it is the one the error cannot name. Trust those lines over counting brackets yourself — the scan skips strings, comments and regex literals, which counting characters does not. It runs whether or not the editor reported anything, so it can appear beneath a file the editor called clean — no language server checks the script inside an \`.html\` file, and there this is the only report you will get.`

/**
 * Exported so the template generator can state this tool's real call shape.
 *
 * A model rewriting a prompt template writes example calls, and an example is
 * copied more readily than a schema is read — so the generator audits every
 * example against the schemas, and it can only do that for a host tool if the
 * host hands the schema over.
 */
export const CHECK_FILE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		paths: {
			type: "array",
			items: { type: "string" },
			description: "Files to check. Absolute, or relative to the working directory. Pass all of them in one call.",
		},
	},
	required: ["paths"],
} as const

/** Files checked in one call. A model that wants more wants a build. */
const MAX_FILES_PER_CALL = 20

/**
 * A shorter settle budget than the post-edit report uses.
 *
 * That one runs the instant a write lands, when the language server has not
 * started yet. This one usually runs against a file that has been sitting
 * still, so the server has already had its chance and waiting two seconds for
 * it to change its mind would be two seconds of the model's turn spent on
 * nothing.
 */
const SETTLE_BUDGET = { pollMs: 150, timeoutMs: 1_500 }

export interface LintCommandResult {
	exitCode: number
	output: string
}

export interface CheckFileToolOptions {
	cwd: string
	/** Injection point for tests; defaults to the host bridge. */
	readDiagnostics?: () => Promise<FileDiagnostics[]>
	/**
	 * Make the language server aware of a file it may never have opened.
	 * Optional: without it the tool still reports whatever the editor knows.
	 */
	loadDocument?: (filePath: string) => Promise<void>
	/** The user's `cline.lintCommand`, if they set one. */
	resolveLintCommand?: () => string | undefined
	/** Runs the configured command. Injected so tests never spawn anything. */
	runLintCommand?: (template: string, filePath: string, signal?: AbortSignal) => Promise<LintCommandResult>
	/** Injection point for tests; defaults to a real timer. */
	delay?: (ms: number) => Promise<void>
}

/**
 * The token a user writes in `cline.lintCommand` to mark where the path goes.
 *
 * Escaped rather than written plainly: as a plain literal it reads to the
 * linter as an unescaped template placeholder, which is exactly what it is not
 * — it is data the user types, and it has to stay a string to be matched.
 */
export const LINT_COMMAND_FILE_PLACEHOLDER = `\${file}`

/**
 * Substitute the file into the configured command.
 *
 * A command without the placeholder gets the path appended, because `"eslint"`
 * is what a user will actually type and refusing it would be pedantry.
 */
export function buildLintCommand(template: string, filePath: string): string {
	const quoted = /[\s"']/.test(filePath) ? JSON.stringify(filePath) : filePath
	return template.includes(LINT_COMMAND_FILE_PLACEHOLDER)
		? template.replaceAll(LINT_COMMAND_FILE_PLACEHOLDER, quoted)
		: `${template} ${quoted}`
}

interface CheckFileInput {
	paths?: unknown
}

/** Accept the shapes a model actually sends, not only the documented one. */
export function readRequestedPaths(input: CheckFileInput | undefined): string[] {
	const raw = input?.paths
	const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : []
	return list.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim())
}

export function createCheckFileTool(options: CheckFileToolOptions): AgentTool {
	const read = options.readDiagnostics ?? readHostDiagnostics
	const delay = options.delay ?? sleep

	return createTool({
		name: CHECK_FILE_TOOL_NAME,
		description: CHECK_FILE_TOOL_DESCRIPTION,
		inputSchema: CHECK_FILE_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context) => {
			const requested = readRequestedPaths(input as CheckFileInput | undefined)
			if (requested.length === 0) {
				return "No files were named. Pass the paths to check in `paths`."
			}
			const overflow = requested.length - MAX_FILES_PER_CALL
			const paths = requested.slice(0, MAX_FILES_PER_CALL)
			const absolute = paths.map((filePath) => path.resolve(options.cwd, filePath))

			// A file the language server has never seen has no diagnostics, and
			// no diagnostics reads as "clean". Loading it first is what makes the
			// difference between a check and a guess.
			if (options.loadDocument) {
				await Promise.all(
					absolute.map(async (filePath) => {
						try {
							await options.loadDocument?.(filePath)
						} catch (error) {
							Logger.log(
								`[CheckFile] could not load ${filePath}: ${error instanceof Error ? error.message : error}`,
							)
						}
					}),
				)
			}

			let diagnostics: FileDiagnostics[] = []
			try {
				diagnostics = await readSettledDiagnostics(new Set(absolute), read, delay, SETTLE_BUDGET)
			} catch (error) {
				Logger.error("[CheckFile] failed to read diagnostics:", error)
				return `Could not read the editor's diagnostics: ${error instanceof Error ? error.message : String(error)}`
			}

			const sections: string[] = []
			for (let index = 0; index < absolute.length; index++) {
				sections.push(
					await describeFile({
						displayPath: paths[index],
						absolutePath: absolute[index],
						diagnostics,
						options,
						signal: context?.signal,
					}),
				)
			}

			if (overflow > 0) {
				sections.push(`(${overflow} more file(s) were not checked; call again with the rest.)`)
			}
			return sections.join("\n\n")
		},
	})
}

/**
 * The delimiter scan for a file, or nothing when it cannot be read or has
 * nothing to report. A failure here must never mask the diagnostics it is
 * appended to, so every error is swallowed.
 */
async function describeBalance(absolutePath: string): Promise<string | null> {
	try {
		const text = await fs.readFile(absolutePath, "utf-8")
		return describeDelimiterBalance(absolutePath, text)
	} catch (error) {
		Logger.error(`[CheckFile] delimiter scan skipped for ${absolutePath}:`, error)
		return null
	}
}

async function describeFile(args: {
	displayPath: string
	absolutePath: string
	diagnostics: readonly FileDiagnostics[]
	options: CheckFileToolOptions
	signal?: AbortSignal
}): Promise<string> {
	const { displayPath, absolutePath, diagnostics, options, signal } = args
	const file = diagnostics.find((entry) => samePath(entry.filePath, absolutePath))

	// A parse error is reported where the parser gave up, which is the closing
	// bracket — never the opening one it failed to match. Say which opener it
	// belongs to, since that is the edit to make and the language server
	// structurally cannot tell you.
	//
	// Scanned whatever the editor said, including when it said nothing. A file
	// with no language server behind it is exactly where this is the only
	// answer available: VS Code ships no syntax checking for the script inside
	// an `.html` file, so an unclosed brace there is reported by nobody.
	const balance = await describeBalance(absolutePath)
	const withBalance = (text: string) => (balance ? `${text}\n${balance}` : text)

	// Same cap, same severity filter, same rendering as the post-edit report:
	// two different answers to "what is wrong with this file" would be worse
	// than either.
	const rendered = file ? await renderFileDiagnostics(file.filePath, file.diagnostics) : ""
	if (rendered !== "") {
		return withBalance(rendered)
	}

	// The editor said nothing, which is not the same as "this file is fine".
	const template = options.resolveLintCommand?.()
	if (template && options.runLintCommand) {
		const command = buildLintCommand(template, absolutePath)
		try {
			const result = await options.runLintCommand(template, absolutePath, signal)
			if (result.exitCode !== 0 || result.output.trim() !== "") {
				return withBalance(
					[
						`${displayPath}: the editor reported nothing, so \`${command}\` was run.`,
						result.output.trim() || `(no output; exit code ${result.exitCode})`,
					].join("\n"),
				)
			}
			return withBalance(`${displayPath}: no problems. The editor reported none and \`${command}\` passed.`)
		} catch (error) {
			return withBalance(
				`${displayPath}: the editor reported nothing, and \`${command}\` failed to run: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	return withBalance(
		`${displayPath}: no problems reported by the editor. If no language server handles this file type, that is not the same as clean.`,
	)
}
