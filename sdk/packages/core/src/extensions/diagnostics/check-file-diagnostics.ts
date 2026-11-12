import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import {
	buildLintCommand,
	CHECK_FILE_TOOL_NAME,
	type LintCommandResult,
} from "../tools/check-file";
import { describeDelimiterBalance } from "../tools/delimiter-balance";
import {
	readSettledDiagnostics,
	renderFileDiagnostics,
	samePath,
	sleep,
	withoutPending,
} from "./editor-diagnostics";
import type {
	HostFileDiagnostics,
	ReadDiagnostics,
	ReadText,
	TouchDocument,
} from "./types";

/**
 * `check_file` answered from language-server diagnostics: the extension's
 * tool, moved here so the CLI and automaticum's runner offer the same one.
 *
 * Core's other `check_file` (`tools/check-file.ts`) parses the file itself and
 * answers a narrower question -- syntax and brackets, not types. A host with
 * language servers -- VS Code's, or the ones `createLspHost` starts -- builds
 * this one instead, and may hand the files no server covers to that one
 * through `describeUnserved`.
 *
 * Everything about *reading* diagnostics -- waiting for the server to settle,
 * dropping hint-level noise, capping and rendering a file's problems -- is the
 * post-edit report's, imported from there. Two different answers to "what is
 * wrong with this file" would be worse than either.
 */

/**
 * Deliberately written at the model that gets this wrong: `run_commands` is
 * the tool it reaches for by reflex, so the alternatives it would otherwise
 * type are named here, and so is every word a question about it uses -- a
 * tool the model cannot name is a tool it does not have.
 */
export const DIAGNOSTICS_CHECK_FILE_TOOL_DESCRIPTION = `Check files for errors and warnings, using the editor's own language servers (LSP). **This is the linter.** It is also the type checker, the syntax check, and the source of the problems that would show in a Problems panel — whichever of those words the question uses, this is the tool that answers it. The results are live and follow your edits: one is current as of the moment you ask, so if it still reports a problem after an edit, the problem is still there. Restarting a language server is neither possible nor necessary from here.

Ask this before running a checker yourself. For a file whose language a language server covers, it answers the same question as \`tsc\`, \`eslint\`, \`biome\`, \`ruff\`, \`mypy\`, \`go build\` or \`cargo check\` would — for the files you name, in milliseconds, without building the project.

When to call it:
- Whenever the question is about the linter, lint errors, diagnostics, problems, warnings, type errors, syntax errors or compile errors — "how many errors is the linter reporting?", "is it clean now?", "what is still broken?". You have no other way to know, and the report you were shown after an earlier edit does not answer it: that was true then, and you have edited since.
- After editing a file, to confirm the edit is valid before moving on.
- Before reporting a task finished, on every file you changed.
- On a file you are about to change, when you want to know what was already wrong with it.

Pass every file you want checked in one call.

Read a clean result carefully. "No problems reported by the editor" is conclusive only where a language server covers that file, and it does not for every language on every machine. If this reports nothing and you have reason to expect a problem, or the project has a checker the language servers do not run, run that checker with \`run_commands\`. Tests and builds are always \`run_commands\`; this tool does not run them.

Output: plain text, one section per file you named, each problem on its own line as \`file:line:column\` with its severity and message. A file with nothing wrong says so in one line. Problems being listed is this tool working, not failing.

A parse error is reported where the parser gave up. That is where the code stopped making sense to it, which is often but not always where the mistake is: a bracket left open earlier makes it give up later. When a file's brackets do not match, a \`Delimiter scan\` section adds the lines where they stop pairing up and how many each line is out by, one line per place the trouble starts — read both before you edit, and work through every line listed before re-checking. A count says where brackets stop pairing, not which bracket is wrong, so read the code at those lines rather than editing them blind. The scan reads the whole file from line 1, and names each bracket by its line, its column and the text just before it: find it by that text rather than by counting columns. Do not count brackets yourself — the scan skips strings, comments and regex literals, which counting characters does not. It runs whether or not the editor reported anything, so it can appear beneath a file the editor called clean — no language server checks the script inside an \`.html\` file, and there this is the only report you will get.`;

export const DIAGNOSTICS_CHECK_FILE_TOOL_INPUT_SCHEMA = {
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
 * A shorter settle budget than the post-edit report uses: that one runs the
 * instant a write lands; this one usually runs against a file that has been
 * sitting still, so the server has already had its chance.
 */
export const CHECK_SETTLE_BUDGET = { pollMs: 150, timeoutMs: 1_500 };

/**
 * How long to wait for the editor's copy of a file to catch up with the disk.
 * VS Code reloads an unmodified document a moment after the write lands, and
 * a check right behind an edit can get there first.
 */
const SYNC_BUDGET = { pollMs: 100, timeoutMs: 1_000 };

/** What the editor holds for a file: the text its language server checks. */
export interface LoadedDocument {
	text: string;
	/** The user has changes to it they have not saved. */
	dirty: boolean;
}

export interface DiagnosticsCheckFileToolOptions {
	cwd: string;
	readDiagnostics: ReadDiagnostics;
	/**
	 * Hand a file to its server before reading its diagnostics: a file the
	 * server has never seen has none, and none reads as clean. For a host
	 * whose servers are its own (`LspHost.touch`).
	 */
	touch?: TouchDocument;
	/**
	 * Make the editor load a file it may never have opened, and report its
	 * copy, which is compared with the disk (VS Code). Nothing returned skips
	 * the comparison.
	 */
	loadDocument?: (filePath: string) => Promise<LoadedDocument | undefined>;
	/**
	 * Whether a server answers for a file. With `describeUnserved`, a file no
	 * server answers for gets that answer instead of "no problems reported".
	 */
	serves?: (filePath: string) => boolean;
	/** The answer for a file no server covers -- core's syntax check, say. */
	describeUnserved?: (
		absolutePath: string,
		displayPath: string,
	) => Promise<string | undefined>;
	/** The user's lint command, if they set one. */
	resolveLintCommand?: () => string | undefined;
	/** Runs the configured command. Injected so tests never spawn anything. */
	runLintCommand?: (
		template: string,
		filePath: string,
		signal?: AbortSignal,
	) => Promise<LintCommandResult>;
	/**
	 * What reported paths are written relative to. Defaults to `cwd`; the
	 * extension writes them relative to the workspace root it reports.
	 */
	displayCwd?: () => string | Promise<string>;
	/** Replaces the description, for a host that words it for its own setting. */
	description?: string;
	/** The disk, as the host reads it. Defaults to the real one. */
	readFile?: ReadText;
	/** Injection point for tests; defaults to a real timer. */
	delay?: (ms: number) => Promise<void>;
	onError?: (message: string, error: unknown) => void;
}

interface CheckFileInput {
	paths?: unknown;
}

/** Accept the shapes a model actually sends, not only the documented one. */
export function readRequestedPaths(
	input: CheckFileInput | undefined,
): string[] {
	const raw = input?.paths;
	const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
	return list
		.filter(
			(entry): entry is string =>
				typeof entry === "string" && entry.trim() !== "",
		)
		.map((entry) => entry.trim());
}

export function createDiagnosticsCheckFileTool(
	options: DiagnosticsCheckFileToolOptions,
): AgentTool {
	const delay = options.delay ?? sleep;

	return createTool({
		name: CHECK_FILE_TOOL_NAME,
		description: options.description ?? DIAGNOSTICS_CHECK_FILE_TOOL_DESCRIPTION,
		inputSchema: DIAGNOSTICS_CHECK_FILE_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context) => {
			const requested = readRequestedPaths(input as CheckFileInput | undefined);
			if (requested.length === 0) {
				return "No files were named. Pass the paths to check in `paths`.";
			}
			const overflow = requested.length - MAX_FILES_PER_CALL;
			const paths = requested.slice(0, MAX_FILES_PER_CALL);
			const absolute = paths.map((filePath) =>
				path.resolve(options.cwd, filePath),
			);

			// A file the language server has never seen has no diagnostics, and
			// no diagnostics reads as "clean". Handing it over first is what
			// makes the difference between a check and a guess.
			if (options.touch) {
				await Promise.all(
					absolute.map((filePath) =>
						options.touch?.(filePath).catch(() => undefined),
					),
				);
			}
			const stale = new Map<string, LoadedDocument>();
			if (options.loadDocument) {
				await Promise.all(
					absolute.map(async (filePath) => {
						const divergent = await awaitEditorSync(filePath, options, delay);
						if (divergent) {
							stale.set(filePath, divergent);
						}
					}),
				);
			}

			let diagnostics: HostFileDiagnostics[] = [];
			try {
				diagnostics = withoutPending(
					await readSettledDiagnostics(
						new Set(absolute),
						options.readDiagnostics,
						delay,
						CHECK_SETTLE_BUDGET,
					),
				);
			} catch (error) {
				options.onError?.("[CheckFile] failed to read diagnostics:", error);
				return `Could not read the editor's diagnostics: ${error instanceof Error ? error.message : String(error)}`;
			}

			const sections: string[] = [];
			for (let index = 0; index < absolute.length; index++) {
				sections.push(
					await describeFile({
						displayPath: paths[index],
						absolutePath: absolute[index],
						diagnostics,
						options,
						stale: stale.get(absolute[index]),
						signal: context?.signal,
					}),
				);
			}

			if (overflow > 0) {
				sections.push(
					`(${overflow} more file(s) were not checked; call again with the rest.)`,
				);
			}
			return sections.join("\n\n");
		},
	});
}

function readTextOf(options: DiagnosticsCheckFileToolOptions): ReadText {
	return options.readFile ?? ((filePath) => fs.readFile(filePath, "utf-8"));
}

/** The same text either side of a BOM and line endings, which the editor normalises. */
function normalised(text: string): string {
	return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * Load a file into the editor and wait for its copy to match the disk.
 *
 * Returns the editor's copy when it still differs once the wait is over, so
 * the check can say its errors may be for that text; nothing when they match,
 * or when either side cannot be read and there is nothing to compare.
 */
async function awaitEditorSync(
	filePath: string,
	options: DiagnosticsCheckFileToolOptions,
	delay: (ms: number) => Promise<void>,
): Promise<LoadedDocument | undefined> {
	let disk: string | undefined;
	try {
		disk = normalised(await readTextOf(options)(filePath));
	} catch {
		disk = undefined;
	}
	for (let waited = 0; ; waited += SYNC_BUDGET.pollMs) {
		let loaded: LoadedDocument | undefined;
		try {
			loaded = await options.loadDocument?.(filePath);
		} catch (error) {
			options.onError?.(`[CheckFile] could not load ${filePath}:`, error);
			return undefined;
		}
		if (!loaded || disk === undefined || normalised(loaded.text) === disk) {
			return undefined;
		}
		// Unsaved changes are not reloaded from the disk however long we wait.
		if (loaded.dirty || waited >= SYNC_BUDGET.timeoutMs) {
			return loaded;
		}
		await delay(SYNC_BUDGET.pollMs);
	}
}

/**
 * The note for a file whose editor copy is not what is on disk. The errors
 * the editor lists are for its copy; the delimiter scan read the disk.
 */
function describeStale(displayPath: string, stale: LoadedDocument): string {
	const why = stale.dirty
		? "it has changes in the editor that are not saved"
		: "the editor has not yet loaded what was last written to it";
	return `Note: the editor's copy of ${displayPath} is not what is on disk (${why}). The editor's errors above are for its copy and may not match the file; the delimiter scan read the file on disk.`;
}

/**
 * The delimiter scan for a file, or nothing when it cannot be read or has
 * nothing to report. A failure here must never mask the diagnostics it is
 * appended to, so every error is swallowed.
 */
async function describeBalance(
	absolutePath: string,
	options: DiagnosticsCheckFileToolOptions,
): Promise<{ text: string | null; missing: boolean }> {
	const onError = options.onError;
	try {
		const text = await readTextOf(options)(absolutePath);
		return {
			text: describeDelimiterBalance(absolutePath, text),
			missing: false,
		};
	} catch (error) {
		const missing =
			(error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
		if (!missing) {
			onError?.(
				`[CheckFile] delimiter scan skipped for ${absolutePath}:`,
				error,
			);
		}
		return { text: null, missing };
	}
}

async function describeFile(args: {
	displayPath: string;
	absolutePath: string;
	diagnostics: readonly HostFileDiagnostics[];
	options: DiagnosticsCheckFileToolOptions;
	stale?: LoadedDocument;
	signal?: AbortSignal;
}): Promise<string> {
	const { displayPath, absolutePath, diagnostics, options, stale, signal } =
		args;
	const file = diagnostics.find((entry) =>
		samePath(entry.filePath, absolutePath),
	);

	// A parse error is reported where the parser gave up, which is the closing
	// bracket -- never the opening one it failed to match. Scanned whatever the
	// editor said, including when it said nothing: VS Code ships no syntax
	// checking for the script inside an `.html` file, so an unclosed brace
	// there is reported by nobody else.
	const { text: balance, missing } = await describeBalance(
		absolutePath,
		options,
	);
	const staleNote = stale ? describeStale(displayPath, stale) : null;
	const withBalance = (text: string) =>
		[text, staleNote, balance].filter((part) => part).join("\n");

	const rendered = file
		? await renderFileDiagnostics(
				options.displayCwd ? await options.displayCwd() : options.cwd,
				file.filePath,
				file.diagnostics,
				options.readFile,
			)
		: "";
	if (rendered !== "") {
		return withBalance(rendered);
	}
	// Not "no problems": a session asked about six scripts it had deleted, was
	// told they were clean, and spent two turns on the contradiction.
	if (missing) {
		return `${displayPath}: no such file, so there is nothing to check.`;
	}

	// The editor said nothing, which is not the same as "this file is fine".
	const template = options.resolveLintCommand?.();
	if (template && options.runLintCommand) {
		const command = buildLintCommand(template, absolutePath);
		try {
			const result = await options.runLintCommand(
				template,
				absolutePath,
				signal,
			);
			if (result.exitCode !== 0 || result.output.trim() !== "") {
				return withBalance(
					[
						`${displayPath}: the editor reported nothing, so \`${command}\` was run.`,
						result.output.trim() || `(no output; exit code ${result.exitCode})`,
					].join("\n"),
				);
			}
			return withBalance(
				`${displayPath}: no problems. The editor reported none and \`${command}\` passed.`,
			);
		} catch (error) {
			return withBalance(
				`${displayPath}: the editor reported nothing, and \`${command}\` failed to run: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	// No server answers for this file: a host that has another check for it
	// answers with that, rather than a silence that reads as clean.
	if (
		options.describeUnserved &&
		options.serves &&
		!options.serves(absolutePath)
	) {
		try {
			const answer = await options.describeUnserved(absolutePath, displayPath);
			if (answer) {
				return answer;
			}
		} catch (error) {
			options.onError?.(
				`[CheckFile] fallback check failed for ${absolutePath}:`,
				error,
			);
		}
	}

	return withBalance(
		`${displayPath}: no problems reported by the editor. If no language server handles this file type, that is not the same as clean.`,
	);
}
