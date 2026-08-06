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

	if (updated === content) {
		return noChangeMessage(filePath, "the text already reads exactly this way");
	}

	await fs.writeFile(filePath, updated, { encoding });

	const diff = createLineDiff(content, updated, maxDiffLines);
	const scope = options.replaceAll ? ` (${occurrences} occurrence(s))` : "";
	return `Edited ${filePath}${scope}\n${diff}`;
}

/**
 * What to say when an edit changed nothing.
 *
 * Measured on a live session: 24 of 45 successful `editor` results carried an
 * empty ```diff fence. The tool had reported `Replaced line 108 in ...` — the
 * success wording — for a replacement identical to what was already there, so
 * the model had to infer "no-op" from an absence. It re-sent the same edit,
 * then six identical inserts at the same line. An outcome a model has to
 * deduce from missing output is one it will deduce wrong.
 *
 * Saying so in prose was not enough either. A later session sent one identical
 * call twelve times, each answered "The file was not modified — do not retry
 * this edit", because the envelope around that sentence still said
 * `success: true`. A model weighing a structured flag against a paragraph
 * takes the flag, and the flag was telling it the edit had worked.
 *
 * So it throws. The tool wrapper turns that into `success: false` with the
 * reason in `error`, which is exactly what the tool's own description already
 * promises a failed edit looks like — and it is the truth: an edit that
 * changed nothing did not do what it was asked to do.
 *
 * The wording names the thing the model actually had wrong, which was not
 * "retrying is unwise" but "the text you sent is the text already there". It
 * kept re-deriving the same replacement because it believed it was sending a
 * fix.
 */
function noChangeMessage(filePath: string, why: string): never {
	throw new Error(
		`No change: ${why} in ${filePath}. The file was not modified. What you sent as \`new_text\` is character-for-character what that part of the file already holds, so this edit asks for nothing and sending it again cannot help. If you meant to change something there, work out how the text you want differs from the text quoted back to you and send that; if the fix belongs on a different line, edit that line instead.`,
	);
}

/**
 * How many lines actually differ, using the same prefix/suffix trim as the
 * diff renderer so the two can never disagree about what changed.
 */
function changedLineCounts(
	oldContent: string,
	newContent: string,
): { removed: number; added: number } {
	const oldLines = oldContent.split(/\r\n|\n/);
	const newLines = newContent.split(/\r\n|\n/);
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
	return { removed: oldEnd - start, added: newEnd - start };
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
	if (endLineOneBased < startLineOneBased) {
		throw new Error(
			`Invalid end_line: ${endLineOneBased}. It must be at least start_line (${startLineOneBased}).`,
		);
	}

	// An end_line past the last line can only mean "to the end of the file",
	// so honour that rather than rejecting it. Measured: a model sent
	// `end_line: 9999` twice as a stand-in for EOF — it had no way to know the
	// line count — and both calls failed. Clamping removes the need to know
	// the count at all, which matters because replacing lines 1..count is the
	// route we point at for rewriting a file whole.
	const effectiveEndLine = Math.min(endLineOneBased, lines.length);

	// An empty new_text deletes the range outright, which is the natural
	// reading and what a caller removing a bad line wants.
	const replacement =
		newStr == null || newStr === "" ? [] : newStr.split(/\r\n|\n/);
	lines.splice(
		startLineOneBased - 1,
		effectiveEndLine - startLineOneBased + 1,
		...replacement,
	);
	const updated = lines.join(eol);
	const range =
		startLineOneBased === effectiveEndLine
			? `line ${startLineOneBased}`
			: `lines ${startLineOneBased}-${effectiveEndLine}`;

	if (updated === content) {
		return noChangeMessage(filePath, `${range} already reads exactly this way`);
	}

	await fs.writeFile(filePath, updated, { encoding });

	const diff = createLineDiff(content, updated, maxDiffLines);
	// The diff trims lines that are identical on both sides, so replacing two
	// lines where one was already correct shows a single line and reads like a
	// half-applied edit. Measured: a model spent a turn asking whether line 90
	// had been touched. Say it instead of leaving it to be inferred.
	const requestedLines = effectiveEndLine - startLineOneBased + 1;
	const { removed } = changedLineCounts(content, updated);
	const unchanged = requestedLines - removed;
	const note =
		unchanged > 0
			? ` (${unchanged} of the ${requestedLines} line(s) in the range were already identical, so the diff below does not show them)`
			: "";
	return `Replaced ${range} in ${filePath}${note}\n${diff}`;
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
 * Replace an inclusive character range — the operation 73 shell commands were
 * emulating.
 *
 * Measured on a live session against a minified file: after line-range replace
 * existed, the model stopped retyping lines and started doing this instead —
 *
 *   $c = [System.IO.File]::ReadAllText($p)
 *   $idx = $c.IndexOf('collectGem();})')
 *   $c = $c.Substring(0,$idx) + 'collectGem();}})' + $c.Substring($idx+15)
 *
 * — seventy-three times, hand-rolled, to move one bracket. It was not evading
 * the tool; it was reaching for a position the tool could not name. Every
 * diagnostic already reports `line, column`, so a column is the one coordinate
 * the model is holding and could not spend.
 *
 * Columns are one-based and inclusive on both ends, matching `start_line` /
 * `end_line` rather than LSP's half-open ranges: one convention per tool beats
 * fidelity to a spec the model never reads.
 */
async function replaceColumnRange(
	filePath: string,
	startLineOneBased: number,
	startColumnOneBased: number,
	endLineOneBased: number,
	endColumnOneBased: number,
	newStr: string | null | undefined,
	encoding: BufferEncoding,
	maxDiffLines: number,
): Promise<string> {
	const content = await fs.readFile(filePath, encoding);
	const eol = detectLineEnding(content);
	const lines = content.split(/\r\n|\n/);

	assertLineInRange(startLineOneBased, lines.length, "start_line");
	assertLineInRange(endLineOneBased, lines.length, "end_line");
	if (endLineOneBased < startLineOneBased) {
		throw new Error(
			`Invalid end_line: ${endLineOneBased}. It must be at least start_line (${startLineOneBased}).`,
		);
	}

	const startLineText = lines[startLineOneBased - 1] ?? "";
	const endLineText = lines[endLineOneBased - 1] ?? "";
	assertColumnInRange(
		startColumnOneBased,
		startLineText,
		startLineOneBased,
		"start_column",
	);
	assertColumnInRange(
		endColumnOneBased,
		endLineText,
		endLineOneBased,
		"end_column",
	);
	if (
		startLineOneBased === endLineOneBased &&
		endColumnOneBased < startColumnOneBased
	) {
		throw new Error(
			`Invalid end_column: ${endColumnOneBased}. On a single line it must be at least start_column (${startColumnOneBased}). To insert without replacing anything, use insert_line with insert_column.`,
		);
	}

	const head = startLineText.slice(0, startColumnOneBased - 1);
	const tail = endLineText.slice(endColumnOneBased);
	const replaced = `${head}${newStr ?? ""}${tail}`;
	lines.splice(
		startLineOneBased - 1,
		endLineOneBased - startLineOneBased + 1,
		...replaced.split(/\r\n|\n/),
	);
	const updated = lines.join(eol);

	const span =
		startLineOneBased === endLineOneBased
			? `line ${startLineOneBased}, columns ${startColumnOneBased}-${endColumnOneBased}`
			: `line ${startLineOneBased} column ${startColumnOneBased} through line ${endLineOneBased} column ${endColumnOneBased}`;

	if (updated === content) {
		return noChangeMessage(filePath, `${span} already reads exactly this way`);
	}

	await fs.writeFile(filePath, updated, { encoding });
	const diff = createLineDiff(content, updated, maxDiffLines);
	return `Replaced ${span} in ${filePath}\n${diff}`;
}

/**
 * Insert text at a column without replacing anything.
 *
 * Adding one missing bracket is the whole reason this exists, and it is not
 * expressible as an inclusive range: `columns 385-385` replaces the character
 * at 385. Insertion needs its own verb.
 */
async function insertAtColumn(
	filePath: string,
	lineOneBased: number,
	columnOneBased: number,
	newStr: string,
	encoding: BufferEncoding,
	maxDiffLines: number,
): Promise<string> {
	const content = await fs.readFile(filePath, encoding);
	const eol = detectLineEnding(content);
	const lines = content.split(/\r\n|\n/);

	assertLineInRange(lineOneBased, lines.length, "insert_line");
	const lineText = lines[lineOneBased - 1] ?? "";
	// One past the last character is the append position, so the bound here is
	// length + 1 rather than length.
	if (columnOneBased < 1 || columnOneBased > lineText.length + 1) {
		throw new Error(
			`Invalid insert_column: ${columnOneBased}. Line ${lineOneBased} has ${lineText.length} character(s), so insert_column must be between 1 and ${lineText.length + 1}. Use ${lineText.length + 1} to append at the end of the line.`,
		);
	}

	lines[lineOneBased - 1] =
		`${lineText.slice(0, columnOneBased - 1)}${newStr}${lineText.slice(columnOneBased - 1)}`;
	const updated = lines.join(eol);

	if (updated === content) {
		return noChangeMessage(
			filePath,
			`inserting nothing at line ${lineOneBased} column ${columnOneBased} leaves it unchanged`,
		);
	}

	await fs.writeFile(filePath, updated, { encoding });
	const diff = createLineDiff(content, updated, maxDiffLines);
	return `Inserted ${newStr.length} character(s) at line ${lineOneBased} column ${columnOneBased} in ${filePath}\n${diff}`;
}

function assertLineInRange(
	lineOneBased: number,
	lineCount: number,
	field: string,
): void {
	if (lineOneBased < 1 || lineOneBased > lineCount) {
		throw new Error(
			`Invalid ${field}: ${lineOneBased}. The file has ${lineCount} line(s), so ${field} must be between 1 and ${lineCount}.`,
		);
	}
}

function assertColumnInRange(
	columnOneBased: number,
	lineText: string,
	lineOneBased: number,
	field: string,
): void {
	if (columnOneBased < 1 || columnOneBased > lineText.length) {
		throw new Error(
			`Invalid ${field}: ${columnOneBased}. Line ${lineOneBased} has ${lineText.length} character(s), so ${field} must be between 1 and ${lineText.length}.`,
		);
	}
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
			// A column turns the boundary insert into an in-line one: the same
			// verb, addressed one level finer.
			if (input.insert_column != null) {
				if (!(await fileExists(filePath))) {
					throw new Error(
						`Cannot insert into ${filePath}: the file does not exist. Omit insert_line and insert_column to create it.`,
					);
				}
				return insertAtColumn(
					filePath,
					input.insert_line,
					input.insert_column,
					input.new_text,
					encoding,
					maxDiffLines,
				);
			}
			return insertInFile(
				filePath,
				input.insert_line, // One-based index
				input.new_text,
				encoding,
			);
		}

		if (input.insert_column != null) {
			throw new Error(
				"`insert_column` needs `insert_line` to say which line it is a column of.",
			);
		}

		if (input.start_line != null) {
			if (!(await fileExists(filePath))) {
				throw new Error(
					`Cannot replace lines in ${filePath}: the file does not exist. Omit start_line to create it.`,
				);
			}
			if (input.start_column != null) {
				return replaceColumnRange(
					filePath,
					input.start_line,
					input.start_column,
					input.end_line ?? input.start_line,
					input.end_column ?? input.start_column,
					input.new_text,
					encoding,
					maxDiffLines,
				);
			}
			if (input.end_column != null) {
				throw new Error(
					"`end_column` needs `start_column`: without it the tool replaces whole lines and the column has nothing to bound.",
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

		if (input.start_column != null || input.end_column != null) {
			throw new Error(
				"`start_column`/`end_column` need `start_line` to say which line they are columns of.",
			);
		}

		if (!(await fileExists(filePath))) {
			return createFile(filePath, input.new_text, encoding);
		}
		if (input.old_text == null) {
			// `new_text` alone against an existing file is a model asking to
			// rewrite it wholesale. That is a legitimate move once incremental
			// edits have failed, and the route exists — it is a line range
			// covering the file — so name it rather than only naming what is
			// missing.
			//
			// Every argument of the working call is spelled out, `path`
			// included. An earlier version of this message named only the two
			// line numbers to add, and a model rebuilt the call from the
			// sentence instead of amending its own: it sent `start_line`,
			// `end_line` and `new_text` with no `path` at all, three times in
			// a row. A message that lists some of the arguments will be read
			// as listing all of them.
			const lineCount = (await fs.readFile(filePath, encoding)).split(
				/\r\n|\n/,
			).length;
			throw new Error(
				`Parameter \`old_text\` is required when editing an existing file without \`insert_line\` or \`start_line\`. To replace ${filePath} in full, send this call again with every argument it already has — \`path: "${filePath}"\` and the same \`new_text\` — plus \`start_line: 1\` and \`end_line: ${lineCount}\`.`,
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
