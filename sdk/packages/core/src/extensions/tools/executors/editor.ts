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
import type { ReadReceipts } from "./read-receipts";

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

	/**
	 * Shared record of what has been read, used to refuse an edit aimed at
	 * lines the model has never seen.
	 *
	 * Optional, and the guard is off when it is absent: an executor built on
	 * its own has no reader to pair with, and failing every edit would be the
	 * wrong default for an embedder wiring the tools up one at a time.
	 */
	receipts?: ReadReceipts;
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
	let normalizedOldStr = normalizeLineEndings(oldStr, eol);
	let normalizedNewStr = normalizeLineEndings(newStr ?? "", eol);
	let occurrences = countOccurrences(content, normalizedOldStr);

	// `read_files` renders content as `  92 | <text>` and the model pastes the
	// gutter back in. Naming the mistake was not enough: mined from real
	// sessions, one model made this exact error ten times in a row against an
	// error message that explains it precisely, and every attempt cost a full
	// generation of the replacement text. So recover instead of refusing.
	//
	// Safe because the file decides. The gutter is only stripped when the
	// stripped text then actually occurs in the file — that match is the
	// evidence, not the shape of the input, so a file that genuinely contains
	// `123 | ` text is unaffected. `new_text` is stripped on the same condition
	// it is detected on: a model in "gutter mode" numbers both, and writing the
	// gutter *into* the file is the worse failure of the two.
	if (occurrences === 0 && hasLineNumberGutter(normalizedOldStr)) {
		const strippedOld = stripLineNumberGutter(normalizedOldStr);
		const strippedOccurrences = countOccurrences(content, strippedOld);
		if (strippedOccurrences > 0) {
			normalizedOldStr = strippedOld;
			occurrences = strippedOccurrences;
			if (hasLineNumberGutter(normalizedNewStr)) {
				normalizedNewStr = stripLineNumberGutter(normalizedNewStr);
			}
		}
	}

	if (occurrences === 0) {
		const looksNumbered = hasLineNumberGutter(normalizedOldStr);
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
/** Beyond this the quote stops being readable and starts being the file. */
const MAX_NO_CHANGE_QUOTE_CHARS = 4_000;

/**
 * A file's lines, counted the way `read_files` counts them.
 *
 * Splitting on newlines yields one element more than the file has lines
 * whenever it ends with a newline, because the text after the last separator is
 * empty. `read_files` counts with `readline`, which does not emit that element,
 * so the two tools described the same file as 270 lines and 271 lines. Measured
 * live: a model was told "lines 1-270 is 270 of the file's 271 lines", could
 * only see 270 in the read output, and spent its turns alternating between the
 * two numbers trying to find the one that meant "the whole file".
 *
 * The trailing newline is kept and re-applied on write; it is a property of the
 * file, not a line of it.
 */
function splitFileLines(content: string): {
	lines: string[];
	trailingNewline: boolean;
} {
	const lines = content.split(/\r\n|\n/);
	const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
	if (trailingNewline) {
		lines.pop();
	}
	return { lines, trailingNewline };
}

/** Reassemble what {@link splitFileLines} took apart. */
function joinFileLines(
	lines: readonly string[],
	eol: string,
	trailingNewline: boolean,
): string {
	return lines.join(eol) + (trailingNewline ? eol : "");
}

/**
 * The lines as they stand, numbered the way `read_files` numbers them.
 *
 * Width is taken from the last line number in the span, matching the read
 * renderer, so the two agree about how far the gutter is indented for the same
 * range.
 */
function quoteCurrentLines(
	content: string,
	startOneBased: number,
	endOneBased: number,
): string | undefined {
	const { lines } = splitFileLines(content);
	const first = Math.max(1, startOneBased);
	const last = Math.min(lines.length, endOneBased);
	if (last < first) {
		return undefined;
	}
	const width = String(last).length;
	const rendered: string[] = [];
	for (let n = first; n <= last; n++) {
		rendered.push(`${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`);
	}
	const text = rendered.join("\n");
	return text.length > MAX_NO_CHANGE_QUOTE_CHARS
		? `${text.slice(0, MAX_NO_CHANGE_QUOTE_CHARS)}\n… truncated`
		: text;
}

/**
 * Marker that opens every "this edit asks for nothing" refusal.
 *
 * Imported rather than copied wherever the outcome has to be recognised, so the
 * detector cannot drift from the message. The loop tracker uses it: a call the
 * tool has compared against the file and found identical is the one kind of
 * failure that provably cannot succeed on a retry.
 */
export const NO_CHANGE_ERROR_PREFIX = "No change: ";

function noChangeMessage(
	filePath: string,
	why: string,
	quoted?: string,
): never {
	// The instruction to compare used to end "differs from the text quoted back
	// to you" while quoting nothing at all. Measured on a live session: the
	// model read that, went looking for the quote, found none, and fell back to
	// re-reading the file — "the editor said No change but then showed a diff …
	// let me read those lines VERY carefully". An instruction to diff against
	// something has to carry the something.
	const comparison = quoted
		? ` If you meant to change something there, work out how the text you want differs from what those lines hold now — shown below — and send that; if the fix belongs on a different line, edit that line instead.\n\n${quoted}`
		: ` If you meant to change something there, work out how the text you want differs from what is already in the file at that spot and send that; if the fix belongs on a different line, edit that line instead.`;
	throw new Error(
		`${NO_CHANGE_ERROR_PREFIX}${why} in ${filePath}. The file was not modified. What you sent as \`new_text\` is character-for-character what that part of the file already holds, so this edit asks for nothing and sending it again cannot help.${comparison}`,
	);
}

/**
 * Refuse a "replacement" that removed nothing and grew the range instead.
 *
 * Measured on a live session, on a dense single-file game: the model asked to
 * replace lines 84-98 with a block that opened with those same fifteen lines
 * and then restated the rest of the class. Nothing was removed, ~140 lines were
 * added, and the class ended up in the file three times over. The result read
 * `success: true` with the note "15 of the 15 line(s) in the range were already
 * identical", which is true and reassuring and describes a file that had just
 * been corrupted. Diagnostics went from 3 to 14 on that one call.
 *
 * The signature is exact: a range replacement that deletes none of the range it
 * names, while adding more lines than the range holds, did not replace anything
 * — it appended a second copy. Wrapping a block (try/catch, an if) removes
 * nothing either, but adds a handful of lines rather than more than the block
 * itself, so it stays under this.
 */
function duplicatedRangeMessage(
	filePath: string,
	range: string,
	requestedLines: number,
	added: number,
	/** Set when the stripped gutter numbered past `end_line` — the cause, named. */
	gutterSpan?: { firstLine: number; lastLine: number },
): never {
	const gutterHint = gutterSpan
		? ` The gutter on your \`new_text\` covers lines ${gutterSpan.firstLine}-${gutterSpan.lastLine}, but the call names only ${range}: if you meant to replace ${gutterSpan.firstLine}-${gutterSpan.lastLine}, send \`end_line: ${gutterSpan.lastLine}\`.`
		: "";
	throw new Error(
		`Duplicated instead of replaced: the edit to ${range} in ${filePath} was not applied. None of the ${requestedLines} line(s) you named were removed, yet ${added} new line(s) were added — so what you sent as \`new_text\` opens with the text already at ${range} and then continues, which appends a second copy rather than replacing anything.${gutterHint} If you meant to rewrite that range, send only the text that should end up there, without restating the lines that are already at ${range}. If you meant to add code, insert it at the line it belongs on instead. Re-read the file first: after earlier edits the line numbers you are working from may no longer point at what you think.`,
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
	const { lines, trailingNewline } = splitFileLines(content);

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

	// A range edit with no `old_text` asserts nothing about the file: the model
	// names two numbers and trusts its memory of what lives between them.
	// Anchored edits are self-verifying — the file must actually contain the
	// text — so the larger an *unanchored* range grows, the more it is a
	// whole-file rewrite wearing a range's clothing.
	//
	// Measured: `start_line: 30, end_line: 134` with 101 replacement lines in a
	// 138-line file, which left 278 problems behind. Every existing guard
	// passed it — read-before-edit was satisfied, and the "adds more lines than
	// the range holds" check passes because 101 < 105. Telling the model in
	// prose that whole-file rewrites are a last resort did not stop it either,
	// so this is the enforcement.
	const spanned = effectiveEndLine - startLineOneBased + 1;
	// Lines 1..count is not a range wearing a rewrite's clothing — it *is* the
	// rewrite, stated plainly, and it is the shape this tool's own errors send
	// the model to when the create form is refused on an existing file. Refusing
	// it too left no reachable way to rewrite a file at all: measured, the model
	// was bounced between three guards for five calls and ~52,000 characters of
	// generated text before giving up and editing in pieces. A partial range
	// that merely covers most of the file is still refused below — that is the
	// case the guard was written for, where the model believes it is touching
	// part of the file and is not.
	const isFullSpanRewrite =
		startLineOneBased === 1 && effectiveEndLine === lines.length;
	if (
		!isFullSpanRewrite &&
		spanned > MAX_UNANCHORED_RANGE_LINES &&
		spanned > lines.length * MAX_UNANCHORED_RANGE_SHARE
	) {
		throw new Error(
			`No replacement performed: lines ${startLineOneBased}-${effectiveEndLine} is ${spanned} of the file's ${lines.length} lines, and the call carries no \`old_text\` to check it against. An unanchored replacement this large is a whole-file rewrite, and one that is slightly wrong duplicates or drops the parts it did not mean to touch. Make the edit in smaller pieces, each anchored with the \`old_text\` it replaces, or send \`old_text\` for this range so the file can verify it — or, if you do mean to rewrite the file, say so exactly with \`start_line: 1\` and \`end_line: ${lines.length}\`. ${lines.length} is the file's length right now, counted a moment ago; if your last read said otherwise, the file has changed since — most often because of your own edits — and this number is the current one. Anything larger works too: an \`end_line\` past the end of the file means "to the end of the file", so you never have to know the count exactly.`,
		);
	}

	// Strip the read gutter the model pasted back in.
	//
	// The `old_text` form recovers from this already, and can, because the file
	// itself decides: strip, and see whether the text now occurs. A range edit
	// has no such anchor, so nothing stopped a gutter from being written *into*
	// the file. Measured live: `new_text` of "  135 | </body>\n  136 | </html>"
	// against `start_line: 135` was accepted verbatim, and the file's last two
	// lines became the read output that described them.
	//
	// The numbers are the evidence instead. Text whose gutter counts up from
	// exactly `start_line` came from a read of exactly this range; content that
	// happens to begin "  135 | " on line 135, then "  136 | " on line 136, does
	// not occur. So the check is narrow, and silence is the failure it prevents:
	// a refusal would cost a turn, but a gutter written into a file is a
	// corruption that reads as success.
	const hadSequentialGutter =
		newStr != null && newStr !== "" && hasSequentialGutter(newStr, startLineOneBased);
	const replacementText = hadSequentialGutter
		? stripLineNumberGutter(normalizeLineEndings(newStr as string, eol))
		: newStr;

	// The gutter also says which lines the text was read from, and that is worth
	// keeping: when its last number runs past `end_line`, the call names a
	// narrower range than the text it carries. Measured: `start_line: 129,
	// end_line: 129` with a gutter of 129, 130, 131 — one line named, three
	// pasted. The duplication guard below catches the consequence, but it
	// describes the damage rather than the cause, leaving the model to work
	// backwards from "2 new line(s) were added" to "I named one line".
	//
	// Said, never acted on. The gutter records where the text came FROM, not
	// where it should go: a model rewriting one line into three could number
	// them 129, 130, 131 just as legitimately, and widening the range for it
	// would delete two lines nobody asked to touch.
	const gutterLastLine = hadSequentialGutter
		? startLineOneBased + countNonBlankLines(newStr as string) - 1
		: undefined;
	const gutterOverrunsRange =
		gutterLastLine !== undefined && gutterLastLine > effectiveEndLine;

	// An empty new_text deletes the range outright, which is the natural
	// reading and what a caller removing a bad line wants.
	//
	// Split the way the file itself is split, trailing empty element and all.
	// A plain split treats `new_text` ending in a newline -- which is how a
	// model normally terminates a block of text -- as one more line than it
	// wrote, and that phantom line is appended to the file on every edit.
	//
	// Measured, and it is the reason the editor looked unusable tonight: six
	// consecutive whole-file rewrites of the same file, each refused with the
	// model's `end_line` exactly one short of the file's length --
	// "lines 1-136 is 136 of the file's 137 lines", then 125 of 126, then 186
	// of 187, then 190 of 191. The file was growing a blank line per rewrite
	// and the model's own read could never name the right number, because the
	// number only became right after it had already been used. It shelled out
	// to `(Get-Content).Count` to check, and the count it got was already stale.
	const replacement =
		replacementText == null || replacementText === ""
			? []
			: splitFileLines(replacementText).lines;
	lines.splice(
		startLineOneBased - 1,
		effectiveEndLine - startLineOneBased + 1,
		...replacement,
	);
	const updated = joinFileLines(lines, eol, trailingNewline);
	const range =
		startLineOneBased === effectiveEndLine
			? `line ${startLineOneBased}`
			: `lines ${startLineOneBased}-${effectiveEndLine}`;

	if (updated === content) {
		return noChangeMessage(
			filePath,
			`${range} already reads exactly this way`,
			quoteCurrentLines(content, startLineOneBased, effectiveEndLine),
		);
	}

	// Everything that can refuse the edit has to run before the write, or a
	// rejected edit still lands on disk and the model is told it failed.
	const requestedLines = effectiveEndLine - startLineOneBased + 1;
	const { removed, added } = changedLineCounts(content, updated);
	if (removed === 0 && added > requestedLines) {
		duplicatedRangeMessage(
			filePath,
			range,
			requestedLines,
			added,
			gutterOverrunsRange ? { firstLine: startLineOneBased, lastLine: gutterLastLine as number } : undefined,
		);
	}

	await fs.writeFile(filePath, updated, { encoding });

	const diff = createLineDiff(content, updated, maxDiffLines);
	// The diff trims lines that are identical on both sides, so replacing two
	// lines where one was already correct shows a single line and reads like a
	// half-applied edit. Measured: a model spent a turn asking whether line 90
	// had been touched. Say it instead of leaving it to be inferred.
	const unchanged = requestedLines - removed;
	const note =
		unchanged > 0
			? ` (${unchanged} of the ${requestedLines} line(s) in the range were already identical, so the diff below does not show them)`
			: "";
	return `Replaced ${range} in ${filePath}${note}\n${diff}${lineCountNote(content, updated, effectiveEndLine, filePath)}`;
}


/**
 * How large an unanchored range replacement may be before it is refused.
 *
 * Both bounds must be exceeded. The absolute floor keeps small files editable —
 * replacing 20 lines of a 25-line file is a normal rewrite of something tiny —
 * while the share is what catches a "range" that is really the whole file.
 */
const MAX_UNANCHORED_RANGE_LINES = 60;
const MAX_UNANCHORED_RANGE_SHARE = 0.5;

/** `  92 | text` — the gutter `read_files` renders, on every non-empty line. */
const LINE_NUMBER_GUTTER = /^\s*\d+\s\|\s?/;

/**
 * Whether every non-empty line carries the read gutter.
 *
 * Uniformity is the test rather than "any line matches": a single line that
 * happens to start with a number and a pipe is ordinary source (a table row, a
 * regex alternation), and stripping it would corrupt the text.
 */
function hasLineNumberGutter(text: string): boolean {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) {
		return false;
	}
	return lines.every((line) => LINE_NUMBER_GUTTER.test(line));
}

/**
 * Whether the gutter on this text numbers consecutively from `firstLine`.
 *
 * The narrow test that makes stripping safe without a file to match against.
 * Every non-blank line must carry a gutter, and the numbers must run
 * 1-by-1 from the line the edit starts at -- which is what a paste of a read
 * of that range looks like, and what ordinary content does not.
 */
function hasSequentialGutter(text: string, firstLine: number): boolean {
	if (!hasLineNumberGutter(text)) {
		return false;
	}
	const numbered = text
		.split(/\r\n|\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => Number.parseInt(line.trim(), 10));
	return numbered.every(
		(value, index) => Number.isFinite(value) && value === firstLine + index,
	);
}

/** Remove the read gutter, leaving the source's own indentation intact. */
/** How many lines the gutter actually numbers — blank lines carry none. */
function countNonBlankLines(text: string): number {
	return text.split(/\r\n|\n/).filter((line) => line.trim() !== "").length;
}

function stripLineNumberGutter(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? line : line.replace(LINE_NUMBER_GUTTER, "")))
		.join("\n");
}

/**
 * Say how the file's length changed, and by how much the lines below the edit
 * moved.
 *
 * Every line number the model holds — from a diagnostic, from an earlier read,
 * from its own plan — refers to the file as it was. An edit that changes the
 * line count silently invalidates all of them below it. Measured: eight
 * consecutive edits addressed lines 84-98 of a file that had meanwhile grown
 * from ~120 lines to 440, so by the end the range named unrelated code and the
 * edits landed on it.
 *
 * Only reported when the count actually changed; a same-size edit shifts
 * nothing and the note would be noise — and it also leaves the read receipt
 * intact, so the instruction to read again would be wrong as well as noisy.
 *
 * The note names the next action rather than only the fact, because stating
 * the fact was not enough. Measured: a model read this, composed a large
 * replacement anyway, and had it refused for editing from a retired read —
 * minutes of generation thrown away. The cost of skipping the read is the
 * part it needs to know, so the note says it.
 */
function lineCountNote(
	oldContent: string,
	newContent: string,
	editedThroughLine: number,
	filePathForNote = "this file",
): string {
	const before = splitFileLines(oldContent).lines.length;
	const after = splitFileLines(newContent).lines.length;
	if (before === after) {
		return "";
	}
	const shift = after - before;
	const direction = shift > 0 ? `+${shift}` : `${shift}`;
	return `\n\nThe file is now ${after} lines (was ${before}). Every line after ${editedThroughLine} has moved by ${direction}, so line numbers you read before this edit no longer point at the same code. Your earlier read of ${filePathForNote} no longer counts as having read it: call \`read_files\` for the lines you intend to change next, before you compose that edit. An edit built on the old numbers is refused — and it is refused only after you have written the replacement out in full, so reading first is the cheaper path.`;
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
	// Same convention as everywhere else here: a trailing newline terminates
	// the text rather than adding a line to it. Without this, inserting "foo\n"
	// -- the normal way to write one line -- inserts foo *and* a blank line, and
	// the file drifts a line at a time exactly as it did on the range path.
	lines.splice(insertLine, 0, ...splitFileLines(newStr).lines);
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
		return noChangeMessage(
			filePath,
			`${span} already reads exactly this way`,
			quoteCurrentLines(content, startLineOneBased, endLineOneBased),
		);
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
		receipts,
	} = options;

	/** How many lines the file holds right now, or null if it has none to count. */
	const countLines = async (filePath: string): Promise<number | null> => {
		try {
			return splitFileLines(await fs.readFile(filePath, encoding)).lines.length;
		} catch {
			return null;
		}
	};

	/**
	 * Refuse an edit aimed at lines the model has not read.
	 *
	 * The message names the exact call that would satisfy it, because the
	 * measured failure was not refusal to read but never considering it: in
	 * 111,790 characters of reasoning across eight edits, `read_files` was
	 * mentioned nine times and called zero.
	 */
	const requireRead = async (
		filePath: string,
		first: number,
		last: number,
	): Promise<void> => {
		if (!receipts) {
			return;
		}
		// Clamped to the file. A range that runs past the last line cannot be
		// read -- `read_files` returns what exists and records a receipt for
		// that -- so requiring a receipt covering the overshoot is a demand no
		// read can satisfy, and the message telling the model to go and read it
		// sends it round again. Measured: an edit aimed at lines 101-200 of a
		// 198-line file, read correctly three times, refused three times, with
		// the model doing exactly as instructed each time.
		const lineCount = await countLines(filePath);
		const end =
			lineCount != null && lineCount > 0 ? Math.min(last, lineCount) : last;
		const wanted = Math.max(first, end);
		if (receipts.covers(filePath, first, wanted)) {
			return;
		}
		const range = first === wanted ? `line ${first}` : `lines ${first}-${wanted}`;
		const why = receipts.wasRetired(filePath)
			? `${range} of ${filePath} has not been read in its current state — either it was never read, or an earlier edit changed the file's length and moved every line below it`
			: `${filePath} has not been read in this session`;
		throw new Error(
			`Read before editing: ${why}. The file was not modified. Call \`read_files\` for ${filePath} covering ${range} — with \`start_line\` and \`end_line\` around it, not the whole file — then send this edit again using the line numbers that read reports. Editing lines you have not seen is how a correct-looking edit lands on the wrong code.`,
		);
	};

	return async (
		input: EditFileInput,
		cwd: string,
		_context: AgentToolContext,
	): Promise<string> => {
		const filePath = resolveFilePath(cwd, input.path, restrictToCwd);
		const linesBefore = receipts ? await countLines(filePath) : null;
		const noteWrite = async (): Promise<void> => {
			if (!receipts || linesBefore == null) {
				return;
			}
			const linesAfter = await countLines(filePath);
			if (linesAfter != null) {
				receipts.noteWrite(filePath, linesBefore, linesAfter);
			}
		};

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
				await requireRead(filePath, input.insert_line, input.insert_line);
				const result = await insertAtColumn(
					filePath,
					input.insert_line,
					input.insert_column,
					input.new_text,
					encoding,
					maxDiffLines,
				);
				await noteWrite();
				return result;
			}
			// A boundary insert only shifts lines; it never overwrites one. The
			// line it is anchored to still has to have been seen, or the text
			// lands next to something other than what the model thinks.
			if (linesBefore != null) {
				await requireRead(filePath, input.insert_line, input.insert_line);
			}
			const result = await insertInFile(
				filePath,
				input.insert_line, // One-based index
				input.new_text,
				encoding,
			);
			await noteWrite();
			return result;
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
				await requireRead(
					filePath,
					input.start_line,
					input.end_line ?? input.start_line,
				);
				const result = await replaceColumnRange(
					filePath,
					input.start_line,
					input.start_column,
					input.end_line ?? input.start_line,
					input.end_column ?? input.start_column,
					input.new_text,
					encoding,
					maxDiffLines,
				);
				await noteWrite();
				return result;
			}
			if (input.end_column != null) {
				throw new Error(
					"`end_column` needs `start_column`: without it the tool replaces whole lines and the column has nothing to bound.",
				);
			}
			await requireRead(
				filePath,
				input.start_line,
				input.end_line ?? input.start_line,
			);
			const result = await replaceLineRange(
				filePath,
				input.start_line,
				input.end_line ?? input.start_line,
				input.new_text,
				encoding,
				maxDiffLines,
			);
			await noteWrite();
			return result;
		}

		if (input.start_column != null || input.end_column != null) {
			throw new Error(
				"`start_column`/`end_column` need `start_line` to say which line they are columns of.",
			);
		}

		if (!(await fileExists(filePath))) {
			const created = await createFile(filePath, input.new_text, encoding);
			// A file the model just wrote is a file the model has seen: it
			// supplied every line of it. Without a receipt here, the very next
			// edit to that file is refused for not having been read, and the
			// model reads back text it authored one call earlier.
			//
			// Measured across one atomic run: 79 edits refused as unread, 68 of
			// them on files created in the same session — a refused call and the
			// read that answered it, twice per occurrence, out of 837 turns. The
			// guard exists for edits aimed at lines nobody has looked at, and
			// this is the one case where the model wrote them itself.
			receipts?.noteRead(filePath, 1, Number.POSITIVE_INFINITY);
			return created;
		}
		if (input.old_text == null) {
			// `new_text` alone against an existing file is a model asking to
			// rewrite it wholesale. The route exists and has to be named, but
			// naming it *first* turned it into the instruction: a model that
			// could not get `old_text` to match read this message as sanctioning
			// a full rewrite, took it on every retry, and grew a 138-line file
			// to 440 lines carrying three copies of the same class. It quoted
			// this sentence back while doing it. So the targeted route leads,
			// and the wholesale one is named as what it is — the fallback, with
			// the reason it is a fallback attached.
			//
			// Every argument of the working call is spelled out, `path`
			// included, on both routes. An earlier version of this message named
			// only the two line numbers to add, and a model rebuilt the call
			// from the sentence instead of amending its own: it sent
			// `start_line`, `end_line` and `new_text` with no `path` at all,
			// three times in a row. A message that lists some of the arguments
			// will be read as listing all of them.
			// Counted the way every other message in this tool counts, and the
			// way `read_files` does. Splitting on newlines here yielded one more
			// line than the file has whenever it ends with a newline, so this
			// message and the whole-file-rewrite refusal a few lines above named
			// two different numbers for the same file -- which is precisely the
			// pair of numbers a model was measured alternating between, trying
			// to find the one that meant "the whole file".
			const { lines: fileLines } = splitFileLines(
				await fs.readFile(filePath, encoding),
			);
			const lineCount = fileLines.length;
			throw new Error(
				`Parameter \`old_text\` is required when editing an existing file without \`insert_line\` or \`start_line\`. ` +
					`Edit the lines you mean to change: call \`read_files\` for ${filePath} around them, then send this call again with \`path: "${filePath}"\`, the \`new_text\` for just those lines, and the \`start_line\`/\`end_line\` that read reports. ` +
					`Replacing the file in full is the same call with \`start_line: 1\` and \`end_line: ${lineCount}\` — or any larger number, since an \`end_line\` past the end of the file means "to the end of the file" — but it rewrites every line, and a whole-file rewrite that is slightly wrong duplicates the parts it did not mean to touch, so reach for it only after a targeted edit has failed.`,
			);
		}

		// A text-matched edit does not name a line, so there is no range to
		// insist on — but editing a file sight-unseen is the same mistake at a
		// coarser grain, and the match itself can land on a repeat the model
		// never saw.
		if (receipts && !receipts.hasAny(filePath)) {
			throw new Error(
				`Read before editing: ${filePath} has not been read in this session. The file was not modified. Call \`read_files\` for it first — narrow it with \`start_line\`/\`end_line\` around the text you mean to change — then send this edit again.`,
			);
		}

		const result = await replaceInFile(
			filePath,
			input.old_text,
			input.new_text,
			encoding,
			maxDiffLines,
			{ occurrence: input.occurrence, replaceAll: input.replace_all },
		);
		await noteWrite();
		return result;
	};
}
