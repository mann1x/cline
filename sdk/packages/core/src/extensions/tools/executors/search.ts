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
import { wholeFileRefusal } from "./whole-file";

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
	 * File extensions the built-in search is limited to (without dot).
	 * @default every text file; ripgrep is never limited by this
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

const DEFAULT_EXCLUDE_DIRS = [
	"node_modules",
	"vendor",
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

/** What one ripgrep run said, kept apart so "no match" is never an error. */
type RipgrepOutcome =
	| { kind: "matches"; matches: SearchMatch[]; capped: boolean }
	| { kind: "none" }
	| { kind: "error"; message: string }
	| { kind: "timeout" }
	| { kind: "aborted" };

/**
 * A ripgrep byte offset into a line, as a column a reader counts: UTF-16
 * units, from 1. rg reports bytes, so every character before the match that
 * is not ASCII moved the column right (readers 19).
 */
function columnOf(lineText: string, byteOffset: number): number {
	return (
		Buffer.from(lineText, "utf8").subarray(0, byteOffset).toString("utf8")
			.length + 1
	);
}

function searchWithRipgrep(
	query: string,
	cwd: string,
	maxResults: number,
	contextLines: number,
	maxPerFile: number,
	timeoutMs: number = 5000,
	abortSignal?: AbortSignal,
): Promise<RipgrepOutcome> {
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
				// `$` before a CRLF. Without it a pattern ending in `$` found
				// nothing in a Windows file, and the "no match" was wrong.
				"--crlf",
				// After `--`, so a pattern starting with `-` is a pattern.
				"--",
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
		let stderr = "";
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
				resolve({ kind: "timeout" });
			}
		}, timeoutMs);

		const finalize = (result: RipgrepOutcome) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				cleanup();
				resolve(result);
			}
		};

		if (abortSignal?.aborted) {
			cleanup();
			resolve({ kind: "aborted" });
			return;
		}

		abortSignal?.addEventListener("abort", () => {
			finalize({ kind: "aborted" });
		});

		child.stdout.on("data", (chunk: Buffer | string) => {
			if (stdout.length > MAX_RG_STDOUT_CHARS) {
				return;
			}
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			if (stderr.length < 4000) stderr += chunk.toString();
		});

		child.on("close", (code: number | null) => {
			// 1 is ripgrep's "searched, found nothing": an answer, not a reason
			// to fall back to a narrower search and report its silence instead
			// (readers 7).
			if (code === 1) {
				finalize({ kind: "none" });
				return;
			}
			if (code !== 0) {
				finalize({
					kind: "error",
					message:
						stderr.trim() ||
						`ripgrep exited with ${code === null ? "a signal" : `code ${code}`}`,
				});
				return;
			}
			try {
				const matches: SearchMatch[] = [];
				// Context lines arrive before their match. They belong to the
				// next match of the same file, never to the last match of the
				// file before it.
				let before: string[] = [];
				let lastInFile: SearchMatch | undefined;
				let inFile = 0;
				let capped = false;
				// Drop the trailing partial event left behind by the stdout cap.
				const lines = stdout
					.slice(0, stdout.lastIndexOf("\n") + 1)
					.split("\n")
					.filter((line) => line.trim());

				const asContext = (lineNumber: number, text: string) => {
					const shown = `  ${lineNumber}: ${fitLine(text)}`;
					if (
						lastInFile &&
						lineNumber > lastInFile.line &&
						lineNumber - lastInFile.line <= contextLines
					) {
						lastInFile.context.push(shown);
					} else {
						before.push(shown);
					}
				};

				for (const line of lines) {
					const json = JSON.parse(line);
					if (json.type === "begin") {
						before = [];
						lastInFile = undefined;
						inFile = 0;
					} else if (json.type === "match") {
						const matchData = json.data;
						const matched = String(matchData.lines?.text ?? "").replace(
							/\r?\n$/,
							"",
						);
						// ripgrep reports a matching line inside the trailing context
						// of the last counted match as a match, past --max-count:
						// it is context here, as the cap asked (readers 7).
						if (inFile >= maxPerFile) {
							asContext(matchData.line_number, matched);
							continue;
						}
						if (matches.length >= maxResults) {
							capped = true;
							break;
						}
						const shownLines: string[] = before;
						before = [];

						if (json.data.submatches && json.data.submatches.length > 0) {
							const submatch = json.data.submatches[0];
							const column = columnOf(matched, submatch?.start ?? 0);
							// The matching line itself, around its match.
							if (matched) {
								shownLines.push(
									`> ${matchData.line_number}: ${fitLine(matched, column)}`,
								);
							}
							lastInFile = {
								file: matchData.path.text,
								line: matchData.line_number,
								column,
								match: submatch?.match?.text ?? "",
								context: shownLines,
							};
							matches.push(lastInFile);
							inFile += 1;
						}
					} else if (json.type === "context") {
						asContext(
							json.data.line_number,
							String(
								json.data.lines?.text ?? json.data.line?.text ?? "",
							).replace(/\r?\n$/, ""),
						);
					}
				}

				finalize(
					matches.length > 0
						? { kind: "matches", matches, capped }
						: { kind: "none" },
				);
			} catch (error) {
				finalize({
					kind: "error",
					message: `ripgrep's output could not be read: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		});

		child.on("error", (error) => {
			finalize({ kind: "error", message: error.message });
		});
	});
}

function shouldIncludeFile(
	relativePath: string,
	excludeDirs: Set<string>,
	/** Every file when absent: binaries are passed by when they are read. */
	includeExtensions: Set<string> | undefined,
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

	if (includeExtensions === undefined) {
		return true;
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
		includeExtensions,
		excludeDirs = DEFAULT_EXCLUDE_DIRS,
		maxResults = 100,
		contextLines = 2,
		maxDepth = 20,
	} = options;
	const excludeDirsSet = new Set(excludeDirs);
	// Only a list someone passed narrows the built-in search. The default list
	// left out C#, Lua, Dart and the rest, and the fallback's "No results"
	// over them was taken for ripgrep's (readers 7).
	const includeExtensionsSet = includeExtensions
		? new Set(includeExtensions.map((extension) => extension.toLowerCase()))
		: undefined;

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
		// Why the built-in search is answering, said with its answer: its
		// "No results" used to stand in for ripgrep's, over a narrower set of
		// files, whatever had gone wrong (readers 7).
		let fallbackReason: string;
		if (isRgAvailable) {
			const outcome = await searchWithRipgrep(
				query,
				cwd,
				maxResults,
				effectiveContextLines,
				effectiveMaxPerFile,
				5000,
				context.signal,
			);
			if (outcome.kind === "aborted") {
				throw new Error("Search operation aborted");
			}
			if (outcome.kind === "none") {
				return `No results found for pattern: ${query}\n(ripgrep searched every file it does not skip by default: hidden files, binaries and whatever .gitignore lists.)`;
			}
			if (outcome.kind === "matches") {
				return formatMatches(
					query,
					outcome.matches,
					outcome.capped || outcome.matches.length >= maxResults,
					maxResults,
				);
			}
			if (outcome.kind === "error") {
				// A pattern ripgrep's engine refuses but JavaScript's reads
				// (look-around, backreferences) is still a pattern; anything
				// else is the answer, and is said.
				if (
					!/regex parse error|look-?around|backreference/i.test(
						outcome.message,
					) ||
					!compiles(query)
				) {
					throw new Error(`ripgrep could not search: ${outcome.message}`);
				}
				fallbackReason =
					"ripgrep cannot read this pattern (it has no look-around or backreferences), so the built-in search answered instead";
			} else {
				fallbackReason =
					"ripgrep did not finish within 5 seconds, so the built-in search answered instead";
			}
		} else {
			fallbackReason =
				"ripgrep is not installed, so the built-in search answered";
		}

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
		let passedBy = 0;
		let capped = false;

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

			if (matches.length >= maxResults) {
				capped = true;
				break;
			}

			const filePath = path.join(cwd, relativePath);

			// Read whole below: a binary or a file too large to hold is passed by,
			// and counted as passed by rather than as searched.
			if (await wholeFileRefusal(filePath, "search_codebase")) {
				passedBy += 1;
				continue;
			}

			try {
				const content = await fs.readFile(filePath, "utf-8");
				totalFilesSearched++;
				const lines = content.split(/\r?\n/);
				let inFile = 0;

				for (
					let lineIdx = 0;
					lineIdx < lines.length && inFile < effectiveMaxPerFile;
					lineIdx++
				) {
					const line = lines[lineIdx] as string;
					regex.lastIndex = 0;
					const match = regex.exec(line);
					if (match === null) continue;
					if (matches.length >= maxResults) {
						capped = true;
						break;
					}
					// One entry per matching line, as ripgrep reports them, with
					// the context the query asked for (it used the default).
					const contextStart = Math.max(0, lineIdx - effectiveContextLines);
					const contextEnd = Math.min(
						lines.length - 1,
						lineIdx + effectiveContextLines,
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
					inFile += 1;
				}
			} catch {
				passedBy += 1;
			}
		}

		const searched = `Searched ${totalFilesSearched} file${totalFilesSearched === 1 ? "" : "s"}${passedBy > 0 ? `; ${passedBy} binary, unreadable or too large to search were passed by` : ""}. (${fallbackReason}.)`;
		if (matches.length === 0) {
			return `No results found for pattern: ${query}\n${searched}`;
		}
		return formatMatches(query, matches, capped, maxResults, searched);
	};
}

function compiles(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function formatMatches(
	query: string,
	matches: readonly SearchMatch[],
	capped: boolean,
	maxResults: number,
	note?: string,
): string {
	const resultLines: string[] = [
		`Found ${matches.length} result${matches.length === 1 ? "" : "s"} for pattern: ${query}`,
		...(note ? [note] : []),
		"",
	];
	for (const match of matches) {
		resultLines.push(`${match.file}:${match.line}:${match.column}`);
		resultLines.push(...match.context);
		resultLines.push("");
	}
	if (capped) {
		resultLines.push(
			`(Showing first ${maxResults} results. Refine your search for more specific results.)`,
		);
	}
	return capSearchOutput(resultLines.join("\n"));
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
