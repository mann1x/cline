/**
 * The files a command's output blames, whatever produced the output.
 *
 * A model that runs the build gets told *that* something is broken and where
 * the tool gave up. A checker tells it *which line to edit*. Measured across
 * four transactions on three builds of the harness arm: the model that had the
 * first and not the second wrote its own analyser rather than asking for the
 * second — `find_error.js`, then five checkers in one transaction, then
 * `diagnose.mjs`, `diagnose2.mjs`, `diagnose3.mjs`. Sixty-two minutes of one
 * transaction went into scripts and the broken file was never opened.
 *
 * Instructions did not move that. So the two halves are joined here instead:
 * name a file in a failing command's output and the host's own checker is asked
 * about it, without the model having to think of it.
 *
 * Nothing here knows a language. It matches the shapes compilers, linters and
 * runtimes use to say "here", and every candidate has to resolve to a file that
 * actually exists inside the workspace before it is believed — which is what
 * rejects a URL, a version string and a line of prose that happens to hold a
 * colon.
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * How an error names a place, across the tools that print one.
 *
 * Each pattern captures the path first. They are deliberately loose: a false
 * match costs one `stat` and is dropped, while a missed one costs the
 * model the turn this exists to save.
 */
const LOCATION_PATTERNS: RegExp[] = [
	// Python: File "app/main.py", line 42
	/File "([^"]+)", line (\d+)/g,
	// Rust, and anything else that points: --> src/main.rs:12:5
	/-->\s+([^\s:]+):(\d+):(\d+)/g,
	// MSVC, C#, older tsc: src\app.ts(12,5): error
	/((?:[A-Za-z]:)?[^\s(),:"'`]+\.[A-Za-z0-9_]+)\((\d+)[,:](\d+)\)/g,
	// gcc, clang, tsc, eslint, ruff, go, shellcheck, node stack frames:
	// src/app.ts:12:5  ·  at /abs/app.js:12:5  ·  (app.js:12)
	/((?:[A-Za-z]:)?[^\s():"'`]+\.[A-Za-z0-9_]+):(\d+)(?::(\d+))?/g,
];

/**
 * Words that mean the output is a complaint rather than a report.
 *
 * A passing test run prints file names too, and checking those would be noise
 * charged to the model's context. Non-zero exit is the stronger signal and the
 * caller passes it; this covers the tools that fail while exiting zero.
 */
const FAILURE_WORDS =
	/\berror\b|\bexception\b|traceback|\bpanic\b|\bfailed\b|\bfailure\b|syntaxerror|cannot find|unexpected/i;

/** Past this an output is a log to be searched, not an error to be read. */
const MAX_SCANNED_OUTPUT = 200_000;

/** Files named per command. Two is a compiler cascade; ten is a build log. */
const MAX_FILES = 2;

export interface ErrorLocation {
	/** Absolute path, verified to exist and to sit inside the workspace. */
	path: string;
	/** The line the output blamed, when it gave one. */
	line?: number;
}

/**
 * A command that names this many files is doing bulk work, not running one
 * thing, and its arguments say nothing about where a failure lives.
 */
const MAX_COMMAND_TARGETS = 8;

/** Whether this output is worth asking a checker about at all. */
export function looksLikeFailure(
	output: string,
	exitedNonZero: boolean,
): boolean {
	return exitedNonZero || FAILURE_WORDS.test(output);
}

/**
 * Resolve one candidate against the workspace, or reject it.
 *
 * `seen` records rejections as well as hits, so a path repeated forty times in
 * one stack trace costs one `stat`.
 */
function workspaceFile(
	candidate: string,
	root: string,
	seen: Set<string>,
): string | undefined {
	const absolute = isAbsolute(candidate)
		? resolve(candidate)
		: resolve(root, candidate);
	if (seen.has(absolute)) {
		return undefined;
	}
	seen.add(absolute);
	const within = relative(root, absolute);
	if (within === "" || within.startsWith("..") || isAbsolute(within)) {
		return undefined;
	}
	try {
		return statSync(absolute).isFile() ? absolute : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The workspace files a command names in its own arguments.
 *
 * The fallback for the case the output patterns cannot cover, and it is the
 * common one rather than the exotic one. Measured on the harness arm: of 96
 * commands in one transaction, exactly one printed a `file:line` — because the
 * page under repair is HTML, `node` cannot run it directly, and the model's own
 * wrapper scripts caught the parse error and printed a summary of their own
 * devising. The file was named on the command line every time: `node
 * run_game.js manic_miner.html`, `node diagnose8.js manic_miner.html`.
 *
 * Argument order is kept, which puts the runner script before the file it runs;
 * both are checked, and a broken runner is worth hearing about too.
 */
export function findCommandFileTargets(
	command: string,
	workspace: string,
): string[] {
	const root = resolve(workspace);
	// Shell-ish tokenisation: quotes stripped, operators dropped. This is a
	// heuristic feeding a filesystem check, not a parser — anything it gets
	// wrong fails to resolve and is discarded.
	const tokens = command
		.split(/[\s;|&]+/)
		.map((token) => token.replace(/^["']|["']$/g, ""))
		.filter((token) => token !== "" && !token.startsWith("-"));
	const seen = new Set<string>();
	const found: string[] = [];
	for (const token of tokens) {
		const absolute = workspaceFile(token, root, seen);
		if (absolute) {
			found.push(absolute);
		}
		if (found.length > MAX_COMMAND_TARGETS) {
			return [];
		}
	}
	return found.slice(0, MAX_FILES);
}

/**
 * Every workspace file the output points at, in the order it points at them.
 *
 * Resolution against the workspace is the whole filter. A path that does not
 * exist was never a path, and one that exists outside the workspace belongs to
 * a dependency or the toolchain — asking a checker about `node_modules` or
 * `/usr/lib/python3` answers a question nobody asked.
 */
export function findErrorLocations(
	output: string,
	workspace: string,
): ErrorLocation[] {
	const text =
		output.length > MAX_SCANNED_OUTPUT
			? output.slice(0, MAX_SCANNED_OUTPUT)
			: output;
	const root = resolve(workspace);
	const found: ErrorLocation[] = [];
	const seen = new Set<string>();

	for (const pattern of LOCATION_PATTERNS) {
		// Each pattern carries `g`, so its lastIndex has to be reset: the same
		// regex object is reused for every command in the process.
		pattern.lastIndex = 0;
		let match = pattern.exec(text);
		while (match) {
			const candidate = match[1];
			const line = Number.parseInt(match[2] ?? "", 10);
			const absolute = workspaceFile(candidate, root, seen);
			if (absolute) {
				found.push(
					Number.isFinite(line) ? { path: absolute, line } : { path: absolute },
				);
			}
			if (found.length >= MAX_FILES) {
				return found;
			}
			match = pattern.exec(text);
		}
	}

	return found;
}
