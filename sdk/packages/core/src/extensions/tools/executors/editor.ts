/**
 * Editor Executor
 *
 * Built-in implementation for filesystem editing operations.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import type { EditFileInput } from "../schemas";
import type { EditorExecutor } from "../types";

/**
 * Options for the editor executor
 */
export interface EditorExecutorOptions {
	/**
	 * File encoding used for read/write operations
	 * @default "utf-8"
	 */
	encoding?: BufferEncoding;

	/**
	 * Restrict relative-path file operations to paths inside cwd.
	 * Absolute paths are always accepted as-is.
	 * @default true
	 */
	restrictToCwd?: boolean;

	/**
	 * Maximum number of diff lines in str_replace output
	 * @default 200
	 */
	maxDiffLines?: number;
}

function resolveFilePath(
	cwd: string,
	inputPath: string,
	restrictToCwd: boolean,
): string {
	const isAbsoluteInput = path.isAbsolute(inputPath);
	const resolved = isAbsoluteInput
		? path.normalize(inputPath)
		: path.resolve(cwd, inputPath);
	if (!restrictToCwd) {
		return resolved;
	}

	// Absolute paths are accepted directly; cwd restriction applies to relative inputs.
	if (isAbsoluteInput) {
		return resolved;
	}

	const rel = path.relative(cwd, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Path must stay within cwd: ${inputPath}`);
	}
	return resolved;
}

function countOccurrences(content: string, needle: string): number {
	if (needle.length === 0) return 0;
	return content.split(needle).length - 1;
}

/**
 * Returns "\r\n" if "\r\n" appears anywhere in the content, otherwise "\n" —
 * including for content with no line breaks at all. Files are uniformly CRLF
 * or uniformly LF in practice; the mixed case that matters is a CRLF file
 * with LF-only lines inserted by earlier releases of this tool, and any
 * surviving "\r\n" — wherever it sits — should pull such a file back to
 * CRLF, which is why this checks for "\r\n" anywhere rather than looking at
 * the first line break. Reads produced via readline strip "\r", so models
 * emit LF-only text even for CRLF files; edits must be normalized to the
 * file's own EOL or they create mixed line endings and break subsequent
 * exact-match replacements.
 */
function detectLineEnding(content: string): "\r\n" | "\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string, eol: "\r\n" | "\n"): string {
	return text.split(/\r\n|\n/).join(eol);
}

function createLineDiff(
	oldContent: string,
	newContent: string,
	maxLines: number,
): string {
	const oldLines = oldContent.split(/\r\n|\n/);
	const newLines = newContent.split(/\r\n|\n/);

	// Trim the common prefix and suffix so only the changed region is emitted;
	// a naive positional compare would mispair every line after an edit that
	// changes the line count.
	let start = 0;
	while (
		start < oldLines.length &&
		start < newLines.length &&
		oldLines[start] === newLines[start]
	) {
		start++;
	}
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (
		oldEnd > start &&
		newEnd > start &&
		oldLines[oldEnd - 1] === newLines[newEnd - 1]
	) {
		oldEnd--;
		newEnd--;
	}

	// Split the line budget between removals and additions so neither side is
	// silently dropped when the other alone would exhaust maxLines.
	const removedCount = oldEnd - start;
	const addedCount = newEnd - start;
	let removedBudget = removedCount;
	let addedBudget = addedCount;
	if (removedCount + addedCount > maxLines) {
		removedBudget = Math.min(
			removedCount,
			Math.max(Math.ceil(maxLines / 2), maxLines - addedCount),
		);
		addedBudget = Math.min(addedCount, maxLines - removedBudget);
	}

	const out: string[] = ["```diff"];
	for (let i = start; i < start + removedBudget; i++) {
		out.push(`-${i + 1}: ${oldLines[i]}`);
	}
	for (let i = start; i < start + addedBudget; i++) {
		out.push(`+${i + 1}: ${newLines[i]}`);
	}

	const omittedRemoved = removedCount - removedBudget;
	const omittedAdded = addedCount - addedBudget;
	if (omittedRemoved > 0 || omittedAdded > 0) {
		out.push(
			`... diff truncated (${omittedRemoved} more removed, ${omittedAdded} more added lines) ...`,
		);
	}

	out.push("```");
	return out.join("\n");
}

async function createFile(
	filePath: string,
	fileText: string,
	encoding: BufferEncoding,
): Promise<string> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, fileText, { encoding });
	return `File created successfully at: ${filePath}`;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Replace the nth occurrence, counting from one, leaving the rest alone.
 *
 * An index walk rather than a regex or split/join: a regex would need the
 * needle escaped, and `String.replace` would expand `$&` and friends in the
 * replacement text.
 */
function replaceNthOccurrence(
	content: string,
	needle: string,
	replacement: string,
	occurrence: number,
): string {
	let index = -1;
	for (let seen = 0; seen < occurrence; seen++) {
		index = content.indexOf(needle, index + 1);
		if (index < 0) {
			return content;
		}
	}
	return (
		content.slice(0, index) + replacement + content.slice(index + needle.length)
	);
}

/** Where the occurrences sit, as one-based line numbers, for the error text. */
function occurrenceLines(content: string, needle: string): number[] {
	const lines: number[] = [];
	let index = content.indexOf(needle);
	while (index >= 0) {
		lines.push(content.slice(0, index).split(/\r\n|\n/).length);
		index = content.indexOf(needle, index + 1);
	}
	return lines;
}

async function replaceInFile(
	filePath: string,
	oldStr: string,
	newStr: string | null | undefined,
	encoding: BufferEncoding,
	maxDiffLines: number,
	options: { occurrence?: number | null; replaceAll?: boolean | null } = {},
): Promise<string> {
	if (options.occurrence != null && options.replaceAll) {
		throw new Error(
			"No replacement performed: `occurrence` picks one match and `replace_all` takes every match. Send one or the other.",
		);
	}

	const content = await fs.readFile(filePath, encoding);
	const eol = detectLineEnding(content);
	const normalizedOldStr = normalizeLineEndings(oldStr, eol);
	const normalizedNewStr = normalizeLineEndings(newStr ?? "", eol);
	const occurrences = countOccurrences(content, normalizedOldStr);

	if (occurrences === 0) {
		// The commonest cause, measured on a live session: `read_files` renders
		// content as `  92 | <text>` and the model pastes the gutter back in.
		// Naming it turns a dead end into a retry that works.
		const looksNumbered = /(^|\n)\s*\d+\s\|\s/.test(normalizedOldStr);
		throw new Error(
			`No replacement performed: text not found in ${filePath}.${
				looksNumbered
					? " `old_text` still carries the `123 | ` line-number gutter from the read output; send the file's own text without it."
					: " Re-read the region and copy the text exactly, or replace by line number with `start_line`/`end_line` instead."
			}`,
		);
	}

	let updated: string;
	if (options.replaceAll) {
		updated = content.split(normalizedOldStr).join(normalizedNewStr);
	} else if (options.occurrence != null) {
		if (options.occurrence < 1 || options.occurrence > occurrences) {
			throw new Error(
				`No replacement performed: occurrence ${options.occurrence} is out of range; the text appears ${occurrences} time(s) in ${filePath}.`,
			);
		}
		updated = replaceNthOccurrence(
			content,
			normalizedOldStr,
			normalizedNewStr,
			options.occurrence,
		);
	} else if (occurrences > 1) {
		// Refusing ambiguity with no way to resolve it is a dead end, and the
		// measured exit from it was PowerShell. Say where they are and how to
		// choose.
		throw new Error(
			`No replacement performed: the text appears ${occurrences} times in ${filePath}, on lines ${occurrenceLines(content, normalizedOldStr).join(", ")}. Extend \`old_text\` until it is unique, pass \`occurrence\` to pick one, pass \`replace_all\` to change every one, or replace by line number with \`start_line\`/\`end_line\`.`,
		);
	} else {
		// Replacer function so "$"-sequences in new_text ($&, $', $`, $$, $n)
		// are inserted literally instead of being expanded by String.replace.
		updated = content.replace(normalizedOldStr, () => normalizedNewStr);
	}

	await fs.writeFile(filePath, updated, { encoding });

	const diff = createLineDiff(content, updated, maxDiffLines);
	const scope = options.replaceAll ? ` (${occurrences} occurrence(s))` : "";
	return `Edited ${filePath}${scope}\n${diff}`;
}

/**
 * Replace a whole line range — the operation that had no tool.
 *
 * Measured on a live session: twelve shell commands existed only to do
 * `$lines[91] = "..."` and write the file back, because `editor` could insert
 * at a line but never replace one. On a minified file — one 293-character
 * line — exact-match replacement is barely usable, while the line number is
 * exactly what every diagnostic already reports.
 */
async function replaceLineRange(
	filePath: string,
	startLineOneBased: number,
	endLineOneBased: number,
	newStr: string | null | undefined,
	encoding: BufferEncoding,
	maxDiffLines: number,
): Promise<string> {
	const content = await fs.readFile(filePath, encoding);
	const eol = detectLineEnding(content);
	const lines = content.split(/\r\n|\n/);

	if (startLineOneBased < 1 || startLineOneBased > lines.length) {
		throw new Error(
			`Invalid start_line: ${startLineOneBased}. The file has ${lines.length} line(s), so start_line must be between 1 and ${lines.length}.`,
		);
	}
	if (endLineOneBased < startLineOneBased || endLineOneBased > lines.length) {
		throw new Error(
			`Invalid end_line: ${endLineOneBased}. It must be at least start_line (${startLineOneBased}) and at most ${lines.length}.`,
		);
	}

	// An empty new_text deletes the range outright, which is the natural
	// reading and what a caller removing a bad line wants.
	const replacement =
		newStr == null || newStr === "" ? [] : newStr.split(/\r\n|\n/);
	lines.splice(
		startLineOneBased - 1,
		endLineOneBased - startLineOneBased + 1,
		...replacement,
	);
	const updated = lines.join(eol);
	await fs.writeFile(filePath, updated, { encoding });

	const diff = createLineDiff(content, updated, maxDiffLines);
	const range =
		startLineOneBased === endLineOneBased
			? `line ${startLineOneBased}`
			: `lines ${startLineOneBased}-${endLineOneBased}`;
	return `Replaced ${range} in ${filePath}\n${diff}`;
}

async function insertInFile(
	filePath: string,
	insertLineOneBased: number,
	newStr: string,
	encoding: BufferEncoding,
): Promise<string> {
	const content = await fs.readFile(filePath, encoding);
	const eol = detectLineEnding(content);
	const lines = content.split(/\r\n|\n/);
	const maxBoundaryLine = lines.length + 1;

	if (insertLineOneBased < 1 || insertLineOneBased > maxBoundaryLine) {
		throw new Error(
			`Invalid insert_line: ${insertLineOneBased}. insert_line must be a positive one-based boundary line in the range 1-${maxBoundaryLine}. Use ${maxBoundaryLine} to append at EOF.`,
		);
	}

	const insertLine = insertLineOneBased - 1;
	lines.splice(insertLine, 0, ...newStr.split(/\r\n|\n/));
	await fs.writeFile(filePath, lines.join(eol), { encoding });

	return `Inserted content at line ${insertLineOneBased} in ${filePath}.`;
}

/**
 * Create an editor executor using Node.js fs module
 */
export function createEditorExecutor(
	options: EditorExecutorOptions = {},
): EditorExecutor {
	const {
		encoding = "utf-8",
		restrictToCwd = true,
		maxDiffLines = 200,
	} = options;

	return async (
		input: EditFileInput,
		cwd: string,
		_context: AgentToolContext,
	): Promise<string> => {
		const filePath = resolveFilePath(cwd, input.path, restrictToCwd);

		if (input.insert_line != null) {
			if (input.start_line != null) {
				throw new Error(
					"`insert_line` adds text at a boundary and `start_line` replaces existing lines. Send one or the other.",
				);
			}
			return insertInFile(
				filePath,
				input.insert_line, // One-based index
				input.new_text,
				encoding,
			);
		}

		if (input.start_line != null) {
			if (!(await fileExists(filePath))) {
				throw new Error(
					`Cannot replace lines in ${filePath}: the file does not exist. Omit start_line to create it.`,
				);
			}
			return replaceLineRange(
				filePath,
				input.start_line,
				input.end_line ?? input.start_line,
				input.new_text,
				encoding,
				maxDiffLines,
			);
		}

		if (!(await fileExists(filePath))) {
			return createFile(filePath, input.new_text, encoding);
		}
		if (input.old_text == null) {
			throw new Error(
				"Parameter `old_text` is required when editing an existing file without `insert_line` or `start_line`",
			);
		}

		return replaceInFile(
			filePath,
			input.old_text,
			input.new_text,
			encoding,
			maxDiffLines,
			{ occurrence: input.occurrence, replaceAll: input.replace_all },
		);
	};
}
