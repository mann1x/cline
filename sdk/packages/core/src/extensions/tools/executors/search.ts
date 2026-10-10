/**
 * Search Executor
 *
 * Built-in implementation for searching the codebase using ripgrep (if available) or regex.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { getFileIndex } from "../../../services/workspace";
import type { SearchExecutor, SearchQueryOptions } from "../types";
import { MAX_SEARCH_OUTPUT_CHARS } from "./output-limits";

/**
 * Cap on buffered `rg --json` stdout. Each event embeds the full text of its
 * matched line, so one match in a giant single-line file (e.g. a serialized
 * trace dump) can produce a multi-hundred-MB event; buffering unbounded can
 * exceed the engine's max string length and crash the whole process with an
 * uncaught RangeError from the stream data handler. Results are capped to
 * MAX_SEARCH_OUTPUT_CHARS anyway, so output past this is never shown.
 */
const MAX_RG_STDOUT_CHARS = 10 * 1024 * 1024;

/** The most of one line that is printed. */
const MAX_SHOWN_LINE_CHARS = 400;

/**
 * One line cut to what a reader can use: the matching line around its match
 * (`column`, from 1), a neighbour from its start.
 *
 * A minified script is a few lines of tens of thousands of characters, and a
 * match with two lines of context either side is five of them. One search for
 * `question` in a scraped site returned 49,782 characters, twice, each line
 * cut from its start so that the match at column 3,110 was not in it
 * (pandorum, 2026-10-10).
 */
function fitLine(text: string, column?: number): string {
	if (text.length <= MAX_SHOWN_LINE_CHARS) {
		return text;
	}
	const start =
		column === undefined
			? 0
			: Math.max(0, column - 1 - Math.floor(MAX_SHOWN_LINE_CHARS / 3));
	const end = Math.min(text.length, start + MAX_SHOWN_LINE_CHARS);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}  [a line of ${text.length.toLocaleString("en-US")} characters; ${(start + 1).toLocaleString("en-US")}-${end.toLocaleString("en-US")} shown]`;
}

/**
 * Options for the search executor
 */
export interface SearchExecutorOptions {
	/**
	 * File extensions to include in search (without dot)
	 * @default common code extensions
	 */
	includeExtensions?: string[];

	/**
	 * Directories to exclude from search
	 * @default ["node_modules", ".git", "dist", "build", ".next", "coverage"]
	 */
	excludeDirs?: string[];

	/**
	 * Maximum number of results to return
	 * @default 100
	 */
	maxResults?: number;

	/**
	 * Number of context lines before and after match
	 * @default 2
	 */
	contextLines?: number;

	/**
	 * Maximum depth to traverse
	 * @default 20
	 */
	maxDepth?: number;
}

const DEFAULT_INCLUDE_EXTENSIONS = [
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"md",
	"mdx",
	"txt",
	"yaml",
	"yml",
	"toml",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"swift",
	"c",
	"cpp",
	"h",
	"hpp",
	"css",
	"scss",
	"less",
	"html",
	"vue",
	"svelte",
	"sql",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"env",
	"gitignore",
	"dockerignore",
	"editorconfig",
];

const DEFAULT_EXCLUDE_DIRS = [
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
	"bin",
	"obj",
];

/**
 * Search result for a single file match
 */
interface SearchMatch {
	file: string;
	line: number;
	column: number;
	match: string;
	context: string[];
}

let rgAvailable: boolean | null = null;

function checkRipgrepAvailable(): Promise<boolean> {
	if (rgAvailable !== null) {
		return Promise.resolve(rgAvailable);
	}

	return new Promise((resolve) => {
		const child = spawn("rg", ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			// Prevent a console window from flashing on Windows.
			windowsHide: true,
		});

		child.on("close", (code) => {
			rgAvailable = code === 0;
			resolve(rgAvailable);
		});

		child.on("error", () => {
			rgAvailable = false;
			resolve(false);
		});

		setTimeout(() => {
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			if (rgAvailable === null) {
				rgAvailable = false;
				resolve(false);
			}
		}, 1000);
	});
}

function searchWithRipgrep(
	query: string,
	cwd: string,
	maxResults: number,
	contextLines: number,
	maxPerFile: number,
	timeoutMs: number = 5000,
	abortSignal?: AbortSignal,
): Promise<SearchMatch[] | null> {
	return new Promise((resolve) => {
		const child = spawn(
			"rg",
			[
				"--json",
				`--context=${contextLines}`,
				// One per file by default. That answers "which files mention
				// this" and cannot answer "how many times, and where" — the
				// question that sent a measured session into twenty shell
				// commands walking IndexOf by hand.
				`--max-count=${maxPerFile}`,
				"-i",
				query,
			],
			{
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				// Prevent a console window from flashing on Windows.
				windowsHide: true,
			},
		);

		let stdout = "";
		let resolved = false;

		const cleanup = () => {
			if (!child.killed) {
				child.kill("SIGTERM");
			}
		};

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				cleanup();
				resolve(null);
			}
		}, timeoutMs);

		const finalize = (result: SearchMatch[] | null) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				cleanup();
				resolve(result);
			}
		};

		if (abortSignal?.aborted) {
			cleanup();
			resolve(null);
			return;
		}

		abortSignal?.addEventListener("abort", () => {
			finalize(null);
		});

		child.stdout.on("data", (chunk: Buffer | string) => {
			if (stdout.length > MAX_RG_STDOUT_CHARS) {
				return;
			}
			stdout += chunk.toString();
		});

		child.stderr.on("data", () => {
			// Ignore stderr
		});

		child.on("close", (code: number | null) => {
			if (code === 0 || code === 1) {
				try {
					const matches: SearchMatch[] = [];
					// Context lines arrive before their match. They belong to the
					// next match of the same file, never to the last match of the
					// file before it.
					let before: string[] = [];
					let lastInFile: SearchMatch | undefined;
					// Drop the trailing partial event left behind by the stdout cap.
					const lines = stdout
						.slice(0, stdout.lastIndexOf("\n") + 1)
						.split("\n")
						.filter((line) => line.trim());

					for (const line of lines) {
						if (matches.length >= maxResults) break;

						const json = JSON.parse(line);
						if (json.type === "begin") {
							before = [];
							lastInFile = undefined;
						} else if (json.type === "match") {
							const matchData = json.data;
							const shownLines: string[] = before;
							before = [];

							if (json.data.submatches && json.data.submatches.length > 0) {
								const submatch = json.data.submatches[0];
								// The matching line itself, around its match.
								const matched = String(matchData.lines?.text ?? "").replace(
									/\r?\n$/,
									"",
								);
								if (matched) {
									shownLines.push(
										`> ${matchData.line_number}: ${fitLine(matched, (submatch?.start ?? 0) + 1)}`,
									);
								}
								lastInFile = {
									file: matchData.path.text,
									line: matchData.line_number,
									column: (submatch?.start ?? 0) + 1,
									match: submatch?.match?.text ?? "",
									context: shownLines,
								};
								matches.push(lastInFile);
							}
						} else if (json.type === "context") {
							const shown = `  ${json.data.line_number}: ${fitLine(String(json.data.lines?.text ?? json.data.line?.text ?? "").replace(/\r?\n$/, ""))}`;
							if (
								lastInFile &&
								json.data.line_number > lastInFile.line &&
								json.data.line_number - lastInFile.line <= contextLines
							) {
								lastInFile.context.push(shown);
							} else {
								before.push(shown);
							}
						}
					}

					finalize(matches.length > 0 ? matches : null);
				} catch {
					finalize(null);
				}
				return;
			}

			finalize(null);
		});

		child.on("error", () => {
			finalize(null);
		});
	});
}

function shouldIncludeFile(
	relativePath: string,
	excludeDirs: Set<string>,
	includeExtensions: Set<string>,
	maxDepth: number,
): boolean {
	const segments = relativePath.split("/");
	const fileName = segments[segments.length - 1] ?? "";
	const directoryDepth = segments.length - 1;

	if (directoryDepth > maxDepth) {
		return false;
	}

	for (let i = 0; i < segments.length - 1; i++) {
		if (excludeDirs.has(segments[i] ?? "")) {
			return false;
		}
	}

	const ext = path.posix.extname(fileName).slice(1).toLowerCase();
	return includeExtensions.has(ext) || (!ext && !fileName.startsWith("."));
}

/**
 * Create a search executor using regex pattern matching
 *
 * @example
 * ```typescript
 * const search = createSearchExecutor({
 *   maxResults: 50,
 *   contextLines: 3,
 * })
 *
 * const results = await search("function\\s+handleClick", "/path/to/project", context)
 * ```
 */
export function createSearchExecutor(
	options: SearchExecutorOptions = {},
): SearchExecutor {
	const {
		includeExtensions = DEFAULT_INCLUDE_EXTENSIONS,
		excludeDirs = DEFAULT_EXCLUDE_DIRS,
		maxResults = 100,
		contextLines = 2,
		maxDepth = 20,
	} = options;
	const excludeDirsSet = new Set(excludeDirs);
	const includeExtensionsSet = new Set(
		includeExtensions.map((extension) => extension.toLowerCase()),
	);

	return async (
		query: string,
		cwd: string,
		context: AgentToolContext,
		queryOptions?: SearchQueryOptions,
	): Promise<string> => {
		const effectiveContextLines = queryOptions?.contextLines ?? contextLines;
		const effectiveMaxPerFile = queryOptions?.maxPerFile ?? 1;
		// Check for abort before starting
		if (context.signal?.aborted) {
			throw new Error("Search operation aborted");
		}

		// Try ripgrep first if available
		const isRgAvailable = await checkRipgrepAvailable();
		let rgMatches: SearchMatch[] | null = null;
		if (isRgAvailable) {
			rgMatches = await searchWithRipgrep(
				query,
				cwd,
				maxResults,
				effectiveContextLines,
				effectiveMaxPerFile,
				5000,
				context.signal,
			);
		}

		if (rgMatches) {
			const resultLines: string[] = [
				`Found ${rgMatches.length} result${rgMatches.length === 1 ? "" : "s"} for pattern: ${query}`,
				"",
			];

			for (const match of rgMatches) {
				resultLines.push(`${match.file}:${match.line}:${match.column}`);
				resultLines.push(...match.context);
				resultLines.push("");
			}

			if (rgMatches.length >= maxResults) {
				resultLines.push(
					`(Showing first ${maxResults} results. Refine your search for more specific results.)`,
				);
			}

			return capSearchOutput(resultLines.join("\n"));
		}

		// Fallback to manual regex search
		let regex: RegExp;
		try {
			regex = new RegExp(query, "gim");
		} catch (error) {
			throw new Error(
				`Invalid regex pattern: ${query}. ${error instanceof Error ? error.message : ""}`,
			);
		}

		const matches: SearchMatch[] = [];
		let totalFilesSearched = 0;

		const fileList = await getFileIndex(cwd);

		// Search files from the fast index.
		for (const relativePath of fileList) {
			// Check for abort signal
			if (context.signal?.aborted) {
				throw new Error("Search operation aborted");
			}

			if (
				!shouldIncludeFile(
					relativePath,
					excludeDirsSet,
					includeExtensionsSet,
					maxDepth,
				)
			) {
				continue;
			}

			if (matches.length >= maxResults) break;

			totalFilesSearched++;
			const filePath = path.join(cwd, relativePath);

			try {
				const content = await fs.readFile(filePath, "utf-8");
				const lines = content.split("\n");

				for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
					const line = lines[lineIdx];
					regex.lastIndex = 0; // Reset regex state

					let match = regex.exec(line);
					while (match !== null) {
						if (matches.length >= maxResults) break;

						// Get context lines
						const contextStart = Math.max(0, lineIdx - contextLines);
						const contextEnd = Math.min(
							lines.length - 1,
							lineIdx + contextLines,
						);
						const contextLinesArr: string[] = [];

						for (let i = contextStart; i <= contextEnd; i++) {
							const prefix = i === lineIdx ? ">" : " ";
							contextLinesArr.push(
								`${prefix} ${i + 1}: ${fitLine(lines[i] as string, i === lineIdx ? match.index + 1 : undefined)}`,
							);
						}

						matches.push({
							file: relativePath,
							line: lineIdx + 1,
							column: match.index + 1,
							match: match[0],
							context: contextLinesArr,
						});

						// Prevent infinite loop on zero-length matches
						if (match.index === regex.lastIndex) {
							regex.lastIndex++;
						}
						match = regex.exec(line);
					}
				}
			} catch {}
		}

		// Format results
		if (matches.length === 0) {
			return `No results found for pattern: ${query}\nSearched ${totalFilesSearched} files.`;
		}

		const resultLines: string[] = [
			`Found ${matches.length} result${matches.length === 1 ? "" : "s"} for pattern: ${query}`,
			`Searched ${totalFilesSearched} files.`,
			"",
		];

		for (const match of matches) {
			resultLines.push(`${match.file}:${match.line}:${match.column}`);
			resultLines.push(...match.context);
			resultLines.push("");
		}

		if (matches.length >= maxResults) {
			resultLines.push(
				`(Showing first ${maxResults} results. Refine your search for more specific results.)`,
			);
		}

		return capSearchOutput(resultLines.join("\n"));
	};
}

/**
 * Middle-truncate oversized search output. Matches with long context lines
 * can blow past the per-query cap even within the maxResults bound; the
 * head (earliest matches plus the result count) and tail (the refine hint)
 * are preserved and the middle is elided with a notice teaching the model
 * to narrow the pattern instead of retrying.
 */
function capSearchOutput(text: string): string {
	if (text.length <= MAX_SEARCH_OUTPUT_CHARS) {
		return text;
	}
	const headLimit = Math.ceil(MAX_SEARCH_OUTPUT_CHARS / 2);
	const tailLimit = Math.max(1, MAX_SEARCH_OUTPUT_CHARS - headLimit);
	return (
		`${text.slice(0, headLimit)}\n` +
		`[... search output truncated: ${text.length} chars total. ` +
		"Narrow the pattern or scope to view the elided matches ...]\n" +
		text.slice(-tailLimit)
	);
}
