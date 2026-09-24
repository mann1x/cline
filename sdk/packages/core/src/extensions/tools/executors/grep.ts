/**
 * POSIX `grep`, in process.
 *
 * The last of grep/sed/awk. See `sed.ts` for why these exist and why they are
 * not shelled out — and here there is a third reason: the repository already
 * spawns `rg` from `PATH` for `search_codebase` and falls back to a JavaScript
 * regex when it is absent, so the same tool call can behave differently on two
 * machines. This one cannot: it never leaves the process.
 *
 * grep is read-only. It records what it read so a later `sed -i` or `editor`
 * call on the same file is not refused for a file the model has just been
 * through, and it takes no write guard because there is nothing here to write.
 */
import type { Dirent, Stats } from "node:fs";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentOverlay } from "../../../runtime/sandbox/overlay-fs";
import { MAX_SEARCH_OUTPUT_CHARS } from "./output-limits";
import { compilePosixRegex } from "./posix-regex";
import { type ReadReceipts, readFileStamp } from "./read-receipts";

/**
 * Directories not worth searching.
 *
 * `grep -r` would descend into all of these. A model searching a repository
 * almost never wants a hit in `node_modules`, and one that gets thousands of
 * them learns to narrow patterns that were already correct.
 */
const SKIP_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".cache",
	".turbo",
	".output",
	"out",
	"target",
	".idea",
	".vscode-test",
]);

/** How much of a file to sniff for NUL before calling it binary, as grep does. */
const BINARY_SNIFF_BYTES = 8_000;

export interface GrepInput {
	pattern: string;
	/** Files or directories. Defaults to the working directory. */
	paths?: string[];
	/** `-i` */
	ignore_case?: boolean;
	/** `-v` */
	invert?: boolean;
	/** `-F`: the pattern is literal text. */
	fixed?: boolean;
	/** `-w`: match whole words only. */
	word?: boolean;
	/** `-E`: extended regular expressions. grep defaults to basic, and so does this. */
	extended?: boolean;
	/** `-c`: print a count per file instead of the matching lines. */
	count?: boolean;
	/** `-l`: print only the names of files with a match. */
	files_with_matches?: boolean;
	/** `-n`: prefix each line with its number. On by default, unlike grep. */
	line_numbers?: boolean;
	/** `-C`: lines of context either side. */
	context?: number;
	/** `-m`: stop after this many matches per file. */
	max_count?: number;
}

export interface GrepExecutorOptions {
	cwd?: string;
	receipts?: ReadReceipts;
	maxOutputChars?: number;
	/** A delegated agent's overlay; grep walks and reads the merged view. */
	overlay?: AgentOverlay;
}

async function collectFiles(
	target: string,
	overlay?: AgentOverlay,
): Promise<string[]> {
	let stat: Stats;
	try {
		stat = overlay ? await overlay.stat(target) : await fs.stat(target);
	} catch {
		return [];
	}
	if (stat.isFile()) {
		return [target];
	}
	if (!stat.isDirectory()) {
		return [];
	}
	const found: string[] = [];
	// With an overlay, walk the merged listing (overlay-only files included,
	// deleted files excluded) and stat each entry through the overlay. Without
	// one, the fast withFileTypes path.
	const walkOverlay = async (directory: string): Promise<void> => {
		let names: string[];
		try {
			names = await (overlay as AgentOverlay).readdir(directory);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(directory, name);
			let st: Stats;
			try {
				st = await (overlay as AgentOverlay).stat(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (SKIP_DIRECTORIES.has(name)) continue;
				await walkOverlay(full);
			} else if (st.isFile()) {
				found.push(full);
			}
		}
	};
	const walk = async (directory: string): Promise<void> => {
		// Typed explicitly: inferring from `fs.readdir` picks the Buffer
		// overload, which then makes every `entry.name` a Buffer.
		let entries: Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORIES.has(entry.name)) {
					continue;
				}
				await walk(join(directory, entry.name));
				continue;
			}
			if (entry.isFile()) {
				found.push(join(directory, entry.name));
			}
		}
	};
	await (overlay ? walkOverlay(target) : walk(target));
	return found.sort();
}

function looksBinary(content: string): boolean {
	// A NUL in the first few KB, which is how grep decides. The escape matters:
	// writing the byte itself puts a real NUL in this source file, and then grep
	// declines to print matches from its own implementation.
	return content.slice(0, BINARY_SNIFF_BYTES).includes("\u0000");
}

export function createGrepExecutor(options: GrepExecutorOptions = {}) {
	const limit = options.maxOutputChars ?? MAX_SEARCH_OUTPUT_CHARS;

	// `cwd` is taken per call, the way `EditorExecutor` takes it: the tool
	// layer knows the workspace root and the executor is built before it is
	// known. The creation-time one is the fallback, not the authority.
	return async (input: GrepInput, callCwd?: string): Promise<string> => {
		const cwd = callCwd || options.cwd || process.cwd();
		if (!input.pattern) {
			throw new Error("`pattern` is required.");
		}

		const regex = compilePosixRegex(input.pattern, {
			extended: input.extended === true,
			ignoreCase: input.ignore_case === true,
			wordBoundary: input.word === true,
			fixed: input.fixed === true,
		});

		const targets = input.paths && input.paths.length > 0 ? input.paths : ["."];
		const files: string[] = [];
		for (const target of targets) {
			const absolute = isAbsolute(target) ? target : resolve(cwd, target);
			const found = await collectFiles(absolute, options.overlay);
			if (found.length === 0) {
				files.push(absolute);
			} else {
				files.push(...found);
			}
		}

		const showLineNumbers = input.line_numbers !== false;
		const contextLines = Math.max(0, input.context ?? 0);
		const lines: string[] = [];
		let totalMatches = 0;
		let filesWithMatches = 0;
		let truncated = false;
		let charCount = 0;

		const push = (text: string): void => {
			if (truncated) {
				return;
			}
			if (charCount + text.length > limit) {
				truncated = true;
				return;
			}
			charCount += text.length + 1;
			lines.push(text);
		};

		for (const filePath of files) {
			let content: string;
			try {
				content = options.overlay
					? (await options.overlay.read(filePath)).toString("utf8")
					: await fs.readFile(filePath, "utf8");
			} catch (error) {
				// A named file that cannot be read is worth saying; one found by
				// walking a directory is not.
				if (files.length === 1) {
					const reason = error instanceof Error ? error.message : String(error);
					return `${relative(cwd, filePath) || filePath}: could not be read: ${reason}`;
				}
				continue;
			}
			if (looksBinary(content)) {
				continue;
			}
			options.receipts?.noteRead(filePath, 1, Number.POSITIVE_INFINITY);
			// Stamped with the read, so a later edit can tell a file that
			// moved under the session from one it has simply never seen.
			options.receipts?.noteStamp(filePath, await readFileStamp(filePath));

			const shown = relative(cwd, filePath) || filePath;
			const fileLines = content.split("\n");
			if (content.endsWith("\n")) {
				fileLines.pop();
			}

			const hits: number[] = [];
			for (let index = 0; index < fileLines.length; index++) {
				// `test` on a non-global regex has no lastIndex to reset, which is
				// why `global` is deliberately not set when compiling above.
				const matched = regex.test(fileLines[index]);
				if (matched === (input.invert !== true)) {
					hits.push(index);
					if (input.max_count !== undefined && hits.length >= input.max_count) {
						break;
					}
				}
			}

			if (hits.length === 0) {
				if (input.count) {
					push(`${shown}:0`);
				}
				continue;
			}
			filesWithMatches += 1;
			totalMatches += hits.length;

			if (input.files_with_matches) {
				push(shown);
				continue;
			}
			if (input.count) {
				push(`${shown}:${hits.length}`);
				continue;
			}

			// Context turns a list of hits into a set of ranges, so overlapping
			// windows are printed once rather than repeating shared lines.
			const wanted = new Set<number>();
			for (const hit of hits) {
				for (
					let index = Math.max(0, hit - contextLines);
					index <= Math.min(fileLines.length - 1, hit + contextLines);
					index++
				) {
					wanted.add(index);
				}
			}
			const ordered = [...wanted].sort((a, b) => a - b);
			let previous = -2;
			for (const index of ordered) {
				if (contextLines > 0 && previous >= 0 && index > previous + 1) {
					push("--");
				}
				previous = index;
				const isHit = hits.includes(index);
				// grep separates a context line with `-` and a match with `:`.
				const separator = isHit ? ":" : "-";
				push(
					showLineNumbers
						? `${shown}${separator}${index + 1}${separator}${fileLines[index]}`
						: `${shown}${separator}${fileLines[index]}`,
				);
			}
		}

		if (lines.length === 0) {
			// An empty result is an answer, not a failure — saying so stops a model
			// re-running the same search expecting a different outcome.
			return `No match for ${input.fixed ? "the text" : "the pattern"} \`${input.pattern}\` in ${
				files.length === 1
					? relative(cwd, files[0]) || files[0]
					: `${files.length} files`
			}.`;
		}

		const header = input.files_with_matches
			? `${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"} with a match`
			: input.count
				? `Counts per file`
				: `${totalMatches} matching line${totalMatches === 1 ? "" : "s"} in ${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"}`;

		return [
			header,
			"",
			...lines,
			...(truncated
				? [
						"",
						`(output stopped at ${limit} characters — narrow the pattern, or pass fewer paths)`,
					]
				: []),
		].join("\n");
	};
}
