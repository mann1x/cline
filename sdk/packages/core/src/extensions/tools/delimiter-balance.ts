/**
 * Where a file's brackets stop matching.
 *
 * A language server reports a parse error at the point the parser gave up,
 * which for a crossed bracket is the closer — never the opener it failed to
 * match. That leaves the one question a model actually needs answered
 * unanswered: *which* opening bracket does this belong to.
 *
 * Measured on a 265-message session: 23 of 29 shell commands were a
 * brace-counting Python script the model wrote itself, because nothing here
 * answered the question. It then declared the two remaining errors "parser
 * artifacts from the very long single line" and stopped. They were not — the
 * scan below locates both in one pass:
 *
 *   MISMATCH: '{' opened at column 2352 closed by ')' at column 2707
 *   MISMATCH: '(' opened at column 2348 closed by '}' at column 3744
 *
 * which is exactly where `node --check` fails.
 */

/** Openers, and what each must be closed by. */
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Extensions this scanner is known to be correct for.
 *
 * Deliberately narrow. JSX is excluded: `.tsx` mixes `<`, `/` and braces in
 * ways a C-family scanner cannot follow, and running this over 365 known-good
 * `.tsx` files produced 49 confident and entirely wrong reports. A false
 * report here is worse than silence, because it sends a model to edit a line
 * that was correct. Languages with their own raw-string forms — Go's
 * backticks, Rust's `r#""#`, PHP's HTML interleaving — are out for the same
 * reason until they are actually verified.
 *
 * Verified: 400 known-good `.ts`/`.js` files report nothing, and the one
 * genuinely broken file reports the two crossings `node --check` agrees with.
 */
const C_FAMILY = new Set([
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".cts",
	".json",
	".jsonc",
	".css",
	".scss",
	".less",
]);

/** Files whose `<script>` bodies are plain JavaScript. */
const EMBEDS_SCRIPT = new Set([".html", ".htm"]);

import { compileFunction } from "node:vm";
import { splitBom } from "./executors/bom";

export interface DelimiterFinding {
	kind: "mismatch" | "unmatched-close" | "unclosed";
	/** 1-based position of the delimiter that is wrong. */
	line: number;
	column: number;
	/** The character at that position, when there is one. */
	found?: string;
	/** 1-based position of the opener involved, for a mismatch or unclosed. */
	openLine?: number;
	openColumn?: number;
	opener?: string;
	/**
	 * What was still open around this point, innermost first — the chain a
	 * model otherwise rebuilds by hand. Recorded with the opener this finding
	 * names already taken off, so it reads as the context the fix sits in.
	 */
	enclosing?: Array<{ opener: string; line: number; column: number }>;
}

interface Cursor {
	line: number;
	column: number;
}

/**
 * Whether a `/` at this point starts a regex rather than a division.
 *
 * The usual heuristic: a regex can only appear where a value is expected, so
 * look back at the last meaningful character. Getting this wrong in the
 * cautious direction (reading a regex as division) can only produce a false
 * report, so the word list errs towards treating `/` as a regex.
 */
function startsRegex(text: string, slashIndex: number): boolean {
	let index = slashIndex - 1;
	while (index >= 0 && /\s/.test(text[index])) {
		index -= 1;
	}
	if (index < 0) {
		return true;
	}
	const previous = text[index];
	if ("(,=:[!&|?{};+-*%^~<>".includes(previous)) {
		return true;
	}
	// `return /re/`, `typeof /re/`, `case /re/` and friends.
	const word = /[A-Za-z_$]+$/.exec(
		text.slice(Math.max(0, index - 11), index + 1),
	);
	if (word) {
		return [
			"return",
			"typeof",
			"case",
			"in",
			"of",
			"delete",
			"void",
			"instanceof",
			"new",
			"do",
			"else",
			"yield",
		].includes(word[0]);
	}
	return false;
}

/** Opens minus closes on one line, per bracket kind, counting code only. */
export interface LineBalance {
	round: number;
	square: number;
	curly: number;
}

export interface DelimiterScan {
	findings: DelimiterFinding[];
	/** Keyed by 1-based line number. Absent means the line held no brackets. */
	balance: Map<number, LineBalance>;
}

/**
 * Scan one span of C-family source and report where its delimiters cross.
 *
 * Strings, template literals, comments and regex literals are skipped, so a
 * brace inside `"}"` does not count — which is the difference between this and
 * counting characters, and the reason a hand-rolled counter misleads.
 */
export function scanDelimiters(
	text: string,
	origin: Cursor = { line: 1, column: 1 },
): DelimiterFinding[] {
	return scanWithBalance(text, origin).findings;
}

/**
 * The same scan, keeping the per-line tally it passes over anyway.
 *
 * The tally is what turns a crossing into an instruction. A report can say
 * where two brackets cross, but not whether the fix is to delete one, add one
 * or move one — and on a minified line those are very different edits. The
 * counts settle it, and they are free: the walk already visits every bracket
 * in code and skips every one in a string.
 */
export function scanWithBalance(
	text: string,
	origin: Cursor = { line: 1, column: 1 },
): DelimiterScan {
	const findings: DelimiterFinding[] = [];
	const balance = new Map<number, LineBalance>();
	const tally = (at: number, kind: keyof LineBalance, delta: number) => {
		const entry = balance.get(at) ?? { round: 0, square: 0, curly: 0 };
		entry[kind] += delta;
		balance.set(at, entry);
	};
	const kindOf: Record<string, keyof LineBalance> = {
		"(": "round",
		")": "round",
		"[": "square",
		"]": "square",
		"{": "curly",
		"}": "curly",
	};
	// `resumesTemplate` marks the `{` of a `${...}` substitution: closing it
	// puts the scanner back inside the template literal rather than in code.
	// Without it the tail of every template — the part after the last `}` —
	// gets scanned as source, and one stray quote or brace in ordinary prose
	// corrupts every finding after it.
	const stack: Array<{
		opener: string;
		line: number;
		column: number;
		resumesTemplate?: boolean;
	}> = [];

	// The innermost few of what is still open, for a finding to carry. Capped
	// because the report is read on every edit: the fix sits in the innermost
	// scopes, and the outer ones are the file's shape rather than the problem.
	const enclosing = () => {
		if (stack.length === 0) {
			return undefined;
		}
		return stack
			.slice(-ENCLOSING_REPORTED)
			.reverse()
			.map((open) => ({
				opener: open.opener,
				line: open.line,
				column: open.column,
			}));
	};

	let line = origin.line;
	let column = origin.column;
	let index = 0;
	let inTemplate = false;

	const advance = (count: number) => {
		for (let step = 0; step < count && index < text.length; step += 1) {
			if (text[index] === "\n") {
				line += 1;
				column = 1;
			} else {
				column += 1;
			}
			index += 1;
		}
	};

	while (index < text.length) {
		const char = text[index];

		// Inside a template literal: only an escape, a `${` or the closing
		// backtick mean anything. Everything else is prose.
		if (inTemplate) {
			if (char === "\\") {
				advance(2);
				continue;
			}
			if (char === "`") {
				inTemplate = false;
				advance(1);
				continue;
			}
			if (char === "$" && text[index + 1] === "{") {
				advance(1);
				tally(line, "curly", 1);
				stack.push({ opener: "{", line, column, resumesTemplate: true });
				inTemplate = false;
				advance(1);
				continue;
			}
			advance(1);
			continue;
		}

		// Line comment.
		if (char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") {
				advance(1);
			}
			continue;
		}

		// Block comment.
		if (char === "/" && text[index + 1] === "*") {
			const end = text.indexOf("*/", index + 2);
			advance(end === -1 ? text.length - index : end + 2 - index);
			continue;
		}

		// Regex literal.
		if (char === "/" && startsRegex(text, index)) {
			advance(1);
			let inClass = false;
			while (index < text.length) {
				const current = text[index];
				if (current === "\\") {
					advance(2);
					continue;
				}
				if (current === "\n") {
					break; // Unterminated; let the language server say so.
				}
				if (current === "[") {
					inClass = true;
				} else if (current === "]") {
					inClass = false;
				} else if (current === "/" && !inClass) {
					advance(1);
					break;
				}
				advance(1);
			}
			continue;
		}

		// Template literal: hand the body to the branch above, which knows how
		// to come back here for each `${...}`.
		if (char === "`") {
			inTemplate = true;
			advance(1);
			continue;
		}

		// Ordinary string.
		if (char === '"' || char === "'") {
			const quote = char;
			advance(1);
			while (index < text.length) {
				const current = text[index];
				if (current === "\\") {
					advance(2);
					continue;
				}
				if (current === quote) {
					advance(1);
					break;
				}
				if (current === "\n") {
					break; // Unterminated; let the language server say so.
				}
				advance(1);
			}
			continue;
		}

		if (PAIRS[char]) {
			tally(line, kindOf[char], 1);
			stack.push({ opener: char, line, column });
			advance(1);
			continue;
		}

		if (CLOSERS[char]) {
			tally(line, kindOf[char], -1);
			const open = stack.pop();
			if (open?.resumesTemplate && char === "}") {
				inTemplate = true;
				advance(1);
				continue;
			}
			if (!open) {
				findings.push({
					kind: "unmatched-close",
					line,
					column,
					found: char,
					enclosing: enclosing(),
				});
			} else if (PAIRS[open.opener] !== char) {
				findings.push({
					kind: "mismatch",
					line,
					column,
					found: char,
					opener: open.opener,
					openLine: open.line,
					openColumn: open.column,
					enclosing: enclosing(),
				});
			}
			advance(1);
			continue;
		}

		advance(1);
	}

	for (const open of stack) {
		findings.push({
			kind: "unclosed",
			line: open.line,
			column: open.column,
			opener: open.opener,
			openLine: open.line,
			openColumn: open.column,
		});
	}

	return { findings, balance };
}

/** Every `<script>` body in an HTML-ish file, with where each one starts. */
function scriptSpans(
	text: string,
): Array<{ body: string; origin: Cursor; module: boolean }> {
	const spans: Array<{ body: string; origin: Cursor; module: boolean }> = [];
	const opening = /<script\b([^>]*)>/gi;
	let match = opening.exec(text);
	while (match) {
		const attributes = match[1] ?? "";
		const bodyStart = match.index + match[0].length;
		const closing = text.toLowerCase().indexOf("</script", bodyStart);
		const bodyEnd = closing === -1 ? text.length : closing;
		// A `src=` script has no body worth scanning, and a non-JS `type=` may
		// not be JavaScript at all.
		if (
			!/\bsrc\s*=/i.test(attributes) &&
			!/\btype\s*=\s*["']?(?!text\/javascript|module|application\/javascript)/i.test(
				attributes,
			)
		) {
			const before = text.slice(0, bodyStart);
			const lineIndex = before.split("\n").length;
			const lastNewline = before.lastIndexOf("\n");
			spans.push({
				body: text.slice(bodyStart, bodyEnd),
				origin: { line: lineIndex, column: bodyStart - lastNewline },
				module: /\btype\s*=\s*["']?module\b/i.test(attributes),
			});
		}
		opening.lastIndex = bodyEnd;
		match = opening.exec(text);
	}
	return spans;
}

/** Lines named in one report. Past this it is a rewrite, not a fix. */
const MAX_REPORTED_LINES = 6;

/** How much of the text before a bracket a report quotes to point at it. */
const QUOTE_CHARS = 12;

/** How deep the enclosing chain goes. Four covers a method inside a class. */
const ENCLOSING_REPORTED = 4;

/**
 * What the counts on one line say about the fix.
 *
 * A crossing says two brackets do not match. It does not say whether to delete
 * one, add one, or move one — and on a minified line those are very different
 * edits. Measured: a model was told `(` opened at 94:29 was closed by `}` at
 * 94:289, and answered by sending back the line it already had, twelve times,
 * because "these two cross" is a description and not an instruction. The line
 * held four `{` against five `}`. Saying so is the whole fix.
 *
 * It speaks up only where the tally is sound. A line that opens a block and
 * leaves it open is perfectly ordinary code, so this is used only when the
 * trouble is confined to one line: a crossing that both begins and ends there,
 * or a closer that matched nothing at all.
 */
function surplusNote(line: number, balance: Map<number, LineBalance>): string {
	const counts = balance.get(line);
	if (!counts) {
		return "";
	}

	const surplus: string[] = [];
	for (const [net, open, close] of [
		[counts.curly, "{", "}"],
		[counts.round, "(", ")"],
		[counts.square, "[", "]"],
	] as const) {
		if (net > 0) {
			surplus.push(`${net} more \`${open}\` than \`${close}\``);
		} else if (net < 0) {
			surplus.push(`${-net} more \`${close}\` than \`${open}\``);
		}
	}

	if (surplus.length === 0) {
		return "this line's own brackets balance in number, so if they are wrong here one is in the wrong place rather than missing or spare";
	}
	// A count, and nothing more. It used to end "— that is the edit", which
	// claimed the line's intent as well as its tally: brackets cannot say which
	// block a closer was meant to end, and a model told the edit as fact
	// disbelieved the count when the fix it tried did not hold (pandorum b46hx,
	// 2026-10-22, three restores of the same line).
	return `counting only code, this line has ${surplus.join(" and ")}`;
}

/** How far along the line to look for somewhere a misplaced closer belongs. */
const MOVE_WINDOW = 12;

/** A ceiling on the search, so a pathological line cannot stall an edit. */
const MAX_CANDIDATES = 24;

/**
 * Past this the search is not worth the wait.
 *
 * Every candidate is a full re-scan of the span, and a scan runs at roughly a
 * megabyte in 70ms. Two dozen candidates against a 2 MB file is three seconds
 * bolted onto an edit that took 40 — so a large file gets the reading of its
 * structure and no proposal. Measured: the 14 KB file this exists for takes
 * 16ms end to end, search included.
 */
const MAX_REPAIR_BYTES = 100_000;

/** Where a 1-based line and column land inside a scanned span. */
function offsetIn(
	body: string,
	origin: Cursor,
	line: number,
	column: number,
): number {
	const lines = body.split("\n");
	const row = line - origin.line;
	if (row < 0 || row >= lines.length) {
		return -1;
	}
	let offset = 0;
	for (let index = 0; index < row; index += 1) {
		offset += lines[index].length + 1;
	}
	// Only the first line of a span starts anywhere but column 1.
	const within = column - (row === 0 ? origin.column : 1);
	// The editor splits on /\r\n|\n/, so a CRLF line is one column narrower
	// than a `\n` split makes it: the `\r` is not a column the model can
	// address. Bounding against the raw line let the scan name a column one
	// past the append position on every CRLF file -- a call `insertAtColumn`
	// refuses -- which is bug 4's class on the line endings a Windows host
	// writes. The offset stays the raw one: the `\r` sits at the end of the
	// line, so every position inside it is the same offset either way.
	const lineText = lines[row].endsWith("\r")
		? lines[row].slice(0, -1)
		: lines[row];
	// On the line, or just past its last character -- where an append goes,
	// and the last column the editor accepts. Anything further ran on into
	// the next line: pandorum, 2026-10-18 (e97h3) was told to move a `)` on
	// a 388-column line "to column 393", which was four characters into the
	// line below, and the model, sending half of it, broke the line.
	if (within < 0 || within > lineText.length) {
		return -1;
	}
	return offset + within;
}

/**
 * Where a real parser stops on one script, in the file's own coordinates.
 *
 * The scan counts brackets. It cannot say which one is wrong, and an edit it
 * worked out from the count alone was offered as checked when it fixed
 * nothing. Measured on the manic_miner seed: line 95 holds a spare `}` that
 * closes `class Level` early. Once line 90 was fixed the count no longer saw
 * line 95 at all -- the class's own closing brace on line 97 was the one left
 * over -- and the scan offered to delete that brace, with the exact editor
 * call. The parser had stopped at line 96 the whole time, and the edit left it
 * there. Every manic_miner gate from 2026-10-25 on was handed that edit.
 *
 * So no edit is offered unless the parser agrees it helped, and the line the
 * parser stops on is named whatever the count says.
 *
 * `line` and `column` are absent where the runtime does not say: Bun 1.3
 * names the line and no column, and a parse that only succeeds or fails, such
 * as top-level `await` or JSON, names neither. On the same line without a
 * column, an edit is offered only when the whole script parses after it.
 */
export interface ParseStop {
	message: string;
	line?: number;
	column?: number;
}

/** The name the parser is given for the source, to find its stack line. */
const PARSE_FILENAME = "delimiter-scan";

/** Top-level `import` or `export`: module code, which nothing here parses. */
const MODULE_SYNTAX = /^[ \t]*(?:import\s*[\w{*"'.]|export\s)/m;

const AsyncFunction = Object.getPrototypeOf(async () => {})
	.constructor as FunctionConstructor;

/**
 * Parse one classic script and say where the parser stops: nothing when it
 * parses, and null when this cannot tell.
 *
 * Parsed as a function body, so a top-level `return` passes as it does in a
 * CommonJS file. Three things a real file holds are not classic script, and
 * calling them "does not parse" told the model a correct file was broken:
 *
 * - a `#!` line, which Node runs and no parser here accepts, is blanked with
 *   the line count kept;
 * - top-level `await` is parsed as an async function body, which accepts it;
 * - `import` or `export` makes the file a module, which no parser here reads,
 *   so the answer is null -- cannot check -- and never a stop.
 *
 * `vm.compileFunction` throws on a broken body under Node and Bun alike (Bun's
 * `vm.Script` parses lazily and throws nothing), and names the line in its
 * stack: V8 and Bun 1.4 as `<filename>:<line>` over the source line and a
 * caret, Bun 1.3 as `at <parse> (<filename>:<line>)`.
 */
export function findParseStop(
	body: string,
	origin: Cursor = { line: 1, column: 1 },
): ParseStop | null | undefined {
	const source = body.startsWith("#!") ? body.replace(/^#![^\n]*/, "") : body;
	let stop: ParseStop;
	try {
		compileFunction(source, [], { filename: PARSE_FILENAME });
		return undefined;
	} catch (error) {
		if (!isSyntaxError(error)) {
			return null;
		}
		stop = {
			message: error.message,
			...locateStop(error.stack ?? "", source, origin),
		};
	}
	if (/\bawait\b/.test(source)) {
		try {
			new AsyncFunction(source);
			return undefined;
		} catch (error) {
			if (!isSyntaxError(error)) {
				return null;
			}
			// The classic parse may have stopped at the `await` itself, so its
			// position is not the fault's; the async parse gives none.
			stop = { message: error.message };
		}
	}
	return MODULE_SYNTAX.test(source) ? null : stop;
}

/** By name: a `SyntaxError` from `vm` need not be this realm's class. */
function isSyntaxError(error: unknown): error is SyntaxError {
	return error instanceof Error && error.name === "SyntaxError";
}

/**
 * The stop's line and column, read off the parser's stack.
 *
 * V8 prints the source line with its leading whitespace trimmed and puts the
 * caret under that, so the caret is placed back on the untrimmed line. When the
 * printed line cannot be found on the real one, only the line is given: a
 * column that might be wrong is worse than none.
 */
function locateStop(
	stack: string,
	body: string,
	origin: Cursor,
): { line?: number; column?: number } {
	const rows = stack.split("\n");
	const v8 = new RegExp(`^${PARSE_FILENAME}:(\\d+)$`).exec(rows[0] ?? "");
	if (!v8) {
		const jsc = new RegExp(`at <parse> \\(${PARSE_FILENAME}:(\\d+)\\)`).exec(
			stack,
		);
		return jsc ? { line: origin.line + Number(jsc[1]) - 1 } : {};
	}
	const row = Number(v8[1]);
	const line = origin.line + row - 1;
	const raw = body.split("\n")[row - 1];
	if (raw === undefined) {
		return { line };
	}
	const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
	const shown = rows[1] ?? "";
	const caret = (rows[2] ?? "").indexOf("^");
	const lead = shown === "" ? -1 : text.indexOf(shown);
	if (caret < 0 || lead < 0) {
		return { line };
	}
	// Only the first line of a span starts anywhere but column 1.
	return {
		line,
		column: lead + caret + 1 + (row === 1 ? origin.column - 1 : 0),
	};
}

/**
 * A parser the scan can check an edit against, and how to name it. `parse`
 * gives nothing when the span parses and null when it cannot tell.
 */
interface Parser {
	name: string;
	parse: (body: string, origin: Cursor) => ParseStop | null | undefined;
}

const JAVASCRIPT: Parser = {
	name: "the JavaScript parser",
	parse: findParseStop,
};

/** JSON says no position the same way on every runtime, so it gives none. */
const JSON_PARSER: Parser = {
	name: "the JSON parser",
	parse: (body) => {
		try {
			JSON.parse(body);
			return undefined;
		} catch (error) {
			return {
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

/**
 * The parser for one span, or none.
 *
 * None is the answer for TypeScript, CSS, JSONC and module scripts: nothing
 * here parses them, so the scan names their lines and offers no edit.
 */
function parserFor(extension: string, module: boolean): Parser | undefined {
	if (extension === ".json") {
		return JSON_PARSER;
	}
	if (module) {
		return undefined;
	}
	return PARSE_CHECKED.has(extension) ? JAVASCRIPT : undefined;
}

/**
 * Whether an edit got the parser past the point it stopped at.
 *
 * Past means the script now parses, or the parser stops strictly later than
 * before. An edit that leaves the stop where it was, or moves it earlier, did
 * not fix what the parser refused, whatever it did to the count.
 */
function gotPast(
	after: ParseStop | null | undefined,
	stop: ParseStop,
): boolean {
	if (after === null) {
		return false;
	}
	if (after === undefined) {
		return true;
	}
	if (stop.line === undefined || after.line === undefined) {
		return false;
	}
	if (after.line !== stop.line) {
		return after.line > stop.line;
	}
	return (
		stop.column !== undefined &&
		after.column !== undefined &&
		after.column > stop.column
	);
}

/** One single-character edit to try, and how to say it. */
interface Candidate {
	text: string;
	say: string;
	call: string;
	/** The line the edit is on, whose count it is judged by. */
	line: number;
	/** Offset of the edit in the span, for its distance from the stop. */
	at: number;
}

/**
 * The edits that might clear one finding: delete the bracket, swap it for what
 * its opener wanted, add that before it, or move it along the line.
 *
 * Each carries the `editor` call that performs it, because naming the edit in
 * prose was not enough. Measured: the model was told to delete the `}` at
 * column 382, restated that correctly, and then composed an `old_text` match
 * for a 500-column minified line and got back "No replacement performed: text
 * not found". The editor already addresses a character by line and column.
 */
function findingCandidates(
	body: string,
	origin: Cursor,
	finding: DelimiterFinding,
): Candidate[] {
	const at = offsetIn(body, origin, finding.line, finding.column);
	if (at < 0 || at >= body.length || body[at] !== finding.found) {
		return [];
	}
	const expected = finding.opener ? PAIRS[finding.opener] : undefined;
	const cut = body.slice(0, at) + body.slice(at + 1);
	const line = finding.line;
	const at1 = finding.column;
	const candidates: Candidate[] = [
		{
			text: cut,
			say: `delete the \`${finding.found}\` at line ${line}, column ${at1}`,
			call: `start_line: ${line}, start_column: ${at1}, new_text: ""`,
			line,
			at,
		},
	];
	if (expected && expected !== finding.found) {
		candidates.push({
			text: body.slice(0, at) + expected + body.slice(at + 1),
			say: `replace the \`${finding.found}\` at line ${line}, column ${at1} with \`${expected}\``,
			call: `start_line: ${line}, start_column: ${at1}, new_text: "${expected}"`,
			line,
			at,
		});
		candidates.push({
			text: body.slice(0, at) + expected + body.slice(at),
			say: `insert a \`${expected}\` before the \`${finding.found}\` at line ${line}, column ${at1}`,
			call: `insert_line: ${line}, insert_column: ${at1}, new_text: "${expected}"`,
			line,
			at,
		});
	}
	// A closer in the wrong place, which is neither spare nor missing. Only
	// bracket positions are tried: nowhere else can a closer belong.
	for (
		let column = finding.column - MOVE_WINDOW;
		column <= finding.column + MOVE_WINDOW;
		column += 1
	) {
		if (column === finding.column || candidates.length >= MAX_CANDIDATES) {
			continue;
		}
		const target = offsetIn(body, origin, finding.line, column);
		// The end of the line counts as a bracket position: a closer that
		// belongs after the last one on the line goes there, and on e97h3's
		// line 111 that was the only move that fixed it.
		// A CRLF line ends at its `\r`, and that is the append position too.
		const lineEnd =
			target === body.length || body[target] === "\n" || body[target] === "\r";
		if (
			target < 0 ||
			target > body.length ||
			(!lineEnd && !PAIRS[body[target]] && !CLOSERS[body[target]])
		) {
			continue;
		}
		const into = target - (column > finding.column ? 1 : 0);
		// Two calls, and the deletion goes second: doing it first would shift
		// every column after it, including the one the insert names.
		candidates.push({
			text: cut.slice(0, into) + finding.found + cut.slice(into),
			say: `move the \`${finding.found}\` at line ${line}, column ${at1} to column ${column}`,
			call:
				`insert_line: ${line}, insert_column: ${column}, new_text: "${finding.found}"` +
				`, then a second call with start_line: ${line}, start_column: ${at1 > column ? at1 + 1 : at1}, new_text: ""`,
			line,
			at,
		});
	}
	return candidates;
}

/** How many lines above the parser's stop are searched for the edit. */
const STOP_LOOKBACK = 3;

/** A ceiling on the edits tried around the stop, so a long line cannot stall. */
const MAX_STOP_CANDIDATES = 160;

/**
 * The edits that might clear the parser's stop, wherever the count is.
 *
 * A spare closer is usually just before where the parser gives up, and the
 * count may not name its line at all: on the seed, the parser stopped at line
 * 96 and the spare `}` was the last one on line 95, a line the count had
 * absorbed into the class. So the lines at and just above the stop are tried
 * directly: on a line with more closers than openers, deleting each closer of
 * that kind; with more openers, each opener; and at the stop itself, each
 * closer the parser may be missing.
 */
function stopCandidates(
	body: string,
	origin: Cursor,
	stop: ParseStop,
	balance: Map<number, LineBalance>,
): Candidate[] {
	if (stop.line === undefined) {
		return [];
	}
	const lines = body.split("\n");
	const candidates: Candidate[] = [];
	const add = (candidate: Candidate) => {
		if (candidates.length < MAX_STOP_CANDIDATES) {
			candidates.push(candidate);
		}
	};
	if (stop.column !== undefined) {
		const at = offsetIn(body, origin, stop.line, stop.column);
		if (at >= 0) {
			for (const closer of [")", "]", "}"]) {
				add({
					text: body.slice(0, at) + closer + body.slice(at),
					say: `insert a \`${closer}\` at line ${stop.line}, column ${stop.column}`,
					call: `insert_line: ${stop.line}, insert_column: ${stop.column}, new_text: "${closer}"`,
					line: stop.line,
					at,
				});
			}
		}
	}
	for (
		let line = stop.line;
		line >= Math.max(origin.line, stop.line - STOP_LOOKBACK);
		line -= 1
	) {
		const counts = balance.get(line);
		const raw = lines[line - origin.line];
		if (!counts || raw === undefined) {
			continue;
		}
		const first = line === origin.line ? origin.column : 1;
		const start = offsetIn(body, origin, line, first);
		if (start < 0) {
			continue;
		}
		const spare = new Set<string>();
		for (const [net, open, close] of [
			[counts.curly, "{", "}"],
			[counts.round, "(", ")"],
			[counts.square, "[", "]"],
		] as const) {
			if (net < 0) {
				spare.add(close);
			} else if (net > 0) {
				spare.add(open);
			}
		}
		// From the end of the line back: the nearer the stop, the likelier.
		for (let index = raw.length - 1; index >= 0; index -= 1) {
			if (!spare.has(raw[index])) {
				continue;
			}
			const at = start + index;
			const column = first + index;
			add({
				text: body.slice(0, at) + body.slice(at + 1),
				say: `delete the \`${raw[index]}\` at line ${line}, column ${column}`,
				call: `start_line: ${line}, start_column: ${column}, new_text: ""`,
				line,
				at,
			});
		}
	}
	return candidates;
}

/**
 * The edit to offer, chosen by the parser and never by the count alone.
 *
 * Every candidate is parsed. Only those that get the parser past its stop are
 * kept, and among them the line's own count comes first -- a move cannot
 * change a count, so on a line one `}` short the edit that adds it beats one
 * that borrows a spare further down (pandorum g5tmt line 93) -- then an edit
 * after which the script parses, then the edit nearest the stop, then the
 * order tried. Nearest, not furthest: a wrong deletion can carry the parser
 * further by letting a later spare closer balance it.
 */
function chooseRepair(
	body: string,
	origin: Cursor,
	candidates: Candidate[],
	parser: Parser,
	stop: ParseStop,
): string | null {
	if (body.length > MAX_REPAIR_BYTES) {
		return null;
	}
	const stopAt =
		stop.line === undefined
			? -1
			: offsetIn(
					body,
					origin,
					stop.line,
					stop.column ?? (stop.line === origin.line ? origin.column : 1),
				);
	const tried = new Set<string>();
	let best: {
		candidate: Candidate;
		after: ParseStop | undefined;
		off: number;
		distance: number;
	} | null = null;
	for (const candidate of candidates) {
		if (tried.has(candidate.text)) {
			continue;
		}
		tried.add(candidate.text);
		const after = parser.parse(candidate.text, origin);
		if (after === null || !gotPast(after, stop)) {
			continue;
		}
		// Measured in the original text. An inserted `}` moves everything
		// after it one column on, so a parser stopping at the very same `{`
		// read as one column further and the edit was offered as progress
		// that it was not.
		if (after !== undefined && stopAt >= 0 && after.line !== undefined) {
			const afterAt = offsetIn(
				candidate.text,
				origin,
				after.line,
				after.column ?? 1,
			);
			const delta = candidate.text.length - body.length;
			const inOriginal = afterAt > candidate.at ? afterAt - delta : afterAt;
			if (afterAt >= 0 && inOriginal <= stopAt) {
				continue;
			}
		}
		const counts = scanWithBalance(candidate.text, origin).balance.get(
			candidate.line,
		);
		const off = counts
			? Math.abs(counts.curly) +
				Math.abs(counts.round) +
				Math.abs(counts.square)
			: 0;
		const distance = stopAt < 0 ? 0 : Math.abs(candidate.at - stopAt);
		const better =
			best === null ||
			off < best.off ||
			(off === best.off &&
				((after === undefined && best.after !== undefined) ||
					((after === undefined) === (best.after === undefined) &&
						distance < best.distance)));
		if (better) {
			best = { candidate, after, off, distance };
		}
	}
	if (!best) {
		return null;
	}

	const where = (at: ParseStop) =>
		`line ${at.line}${at.column === undefined ? "" : `, column ${at.column}`}`;
	const outcome =
		best.after === undefined
			? `after it, ${parser.name} accepts this script`
			: `after it, ${parser.name} gets past ${where(stop)} and next stops at ${where(best.after)} (${best.after.message})`;
	// Offered, not prescribed. The parser says the edit gets it further; which
	// block was meant to close is the code's meaning, and only that says it.
	// "Accepts" only when it does: an edit that gets the parser further but not
	// through was introduced as one the parser accepts.
	const lead =
		best.after === undefined
			? `one edit ${parser.name} accepts`
			: `one edit that gets ${parser.name} further`;
	return (
		`${lead}: ${best.candidate.say} — checked: ${outcome}. ` +
		"Brackets cannot tell which block was meant to close here, so make sure it is this one.\n" +
		`      ${PRESCRIPTION_MARKER}${best.candidate.call} — if that is the change you mean; there is no text to match on.`
	);
}

/**
 * How a prescribed repair opens, so a caller can tell a scan that names the
 * exact call from one that only names the line.
 *
 * Exported rather than matched by hand: the editor appends to this line, and a
 * reworded prescription that silently stopped being recognised would take the
 * follow-up with it.
 */
export const PRESCRIPTION_MARKER = "that edit is `editor` with ";

/**
 * Whether this scanner reads the given file's language at all.
 *
 * `describeDelimiterBalance` returns null for two different reasons — nothing
 * is wrong, and nothing was looked at — and a caller that reports the result
 * has to tell them apart. Saying "no problems" about a file no checker opened
 * is the one output worse than silence.
 */
export function canScanDelimiters(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	return C_FAMILY.has(extension) || EMBEDS_SCRIPT.has(extension);
}

/** Classic scripts only: a module body is parsed under different rules. */
const PARSE_CHECKED = new Set([".js", ".cjs", ".html", ".htm"]);

/**
 * Whether a file's scripts parse at all, asked of a real parser.
 *
 * Not a second delimiter scan. The scan is a heuristic and is here to *place*
 * a parse error the browser could only name; this answers the prior question —
 * is there one — with the engine's own answer, so it can be trusted where a
 * heuristic cannot: to contradict a browser that reported a clean page.
 *
 * Measured, and this is why it exists: a run edited a 14 KB page into a state
 * where `forEach(e=>{…};` left a `;` inside an argument list, opened it in the
 * browser, and was told "Console: nothing. The page printed no messages and
 * threw no errors." The page had never run. The model reported the task
 * finished on that evidence, and the transaction was kept over a file that
 * does not parse.
 *
 * `new Function` rather than `vm.Script`, which parses lazily under Bun and
 * throws nothing at all on broken source. The body is wrapped in a function,
 * so a `return` at the top level passes here and would not in a real script —
 * a miss, which is the safe direction: this only ever speaks up when a parser
 * has actually refused the source.
 */
export function findScriptSyntaxError(
	filePath: string,
	text: string,
): string | undefined {
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	if (!PARSE_CHECKED.has(extension)) {
		return undefined;
	}
	const bodies = EMBEDS_SCRIPT.has(extension)
		? scriptSpans(text)
				.filter((span) => !span.module)
				.map((span) => span.body)
		: [text];
	for (const body of bodies) {
		if (body.trim() === "") {
			continue;
		}
		// The same parse the scan gates its edits on, so the two never disagree:
		// a module, a `#!` line or top-level `await` is not a syntax error.
		const stop = findParseStop(body);
		if (stop) {
			return `SyntaxError: ${stop.message}`;
		}
	}
	return undefined;
}

/**
 * Render the balance findings for a file, or null when there is nothing
 * useful to say — the file's language is not one this understands, or its
 * delimiters match.
 */
export function describeDelimiterBalance(
	filePath: string,
	withBom: string,
): string | null {
	// Line 1's columns as the checker and the editor number them.
	const text = splitBom(withBom).body;
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

	const balance = new Map<number, LineBalance>();
	// Which span each finding came out of, so a repair can be tried against
	// the same text the scan walked rather than against the whole file, and
	// what a real parser said about that span.
	interface Source {
		body: string;
		origin: Cursor;
		findings: DelimiterFinding[];
		balance: Map<number, LineBalance>;
		parser?: Parser;
		stop?: ParseStop;
	}
	const sources: Source[] = [];

	const record = (body: string, origin: Cursor, module = false) => {
		const scan = scanWithBalance(body, origin);
		const candidate = parserFor(extension, module);
		const verdict = candidate?.parse(body, origin);
		// A parser that cannot tell -- module code, say -- is no parser here:
		// the count is reported and no edit is offered.
		const parser = verdict === null ? undefined : candidate;
		const stop = verdict ?? undefined;
		// A parser that accepts the span outranks the count: whatever the scan
		// found there is the scan's own mistake, and reporting it would send an
		// edit to code that is correct.
		const findings = parser && stop === undefined ? [] : scan.findings;
		for (const [at, counts] of scan.balance) {
			const entry = balance.get(at) ?? { round: 0, square: 0, curly: 0 };
			entry.round += counts.round;
			entry.square += counts.square;
			entry.curly += counts.curly;
			balance.set(at, entry);
		}
		sources.push({
			body,
			origin,
			findings,
			balance: scan.balance,
			parser,
			stop,
		});
		return findings;
	};

	let findings: DelimiterFinding[];
	if (C_FAMILY.has(extension)) {
		findings = record(text, { line: 1, column: 1 });
	} else if (EMBEDS_SCRIPT.has(extension)) {
		// One line can hold the end of one `<script>` and the start of the next,
		// so the tallies are summed rather than replaced.
		findings = scriptSpans(text).flatMap((span) =>
			record(span.body, span.origin, span.module),
		);
	} else {
		return null;
	}

	if (findings.length === 0) {
		return null;
	}

	// One finding per line the trouble starts on.
	//
	// Reporting the first two findings was wrong on a real file. It had five
	// separately broken lines, each a minified one-liner ending `}})` where it
	// should end `});`, and naming two of them sent the model round the loop —
	// edit, reload the page, read, edit — once per line.
	//
	// Two findings on one line say less than two findings on two lines, so the
	// list is deduplicated by line rather than truncated by count.
	const seen = new Set<number>();
	const lineOf = (finding: DelimiterFinding) =>
		finding.openLine ?? finding.line;
	const distinct = findings.filter((finding) => {
		// The line the fix goes on: the opener for a crossing or an unclosed
		// bracket, and the stray character itself when nothing was open.
		const line = lineOf(finding);
		if (seen.has(line)) {
			return false;
		}
		seen.add(line);
		return true;
	});

	const shown = distinct.slice(0, MAX_REPORTED_LINES);

	// The first span a parser refused. Its stop is the one position in this
	// report that is certain; everything else is a count.
	const stopped = sources.find((source) => source.stop !== undefined);
	const stop = stopped?.stop;
	const stopLine = stop?.line;
	// A count after the stop was taken past a bracket the parser could not
	// place, so it can name a line that is correct. Measured on the seed: the
	// count named line 97, the class's own closing brace, while the spare `}`
	// was on line 95 and the parser stopped on line 96.
	const pastStop = (finding: DelimiterFinding) =>
		stopped !== undefined &&
		stopLine !== undefined &&
		stopped.findings.includes(finding) &&
		lineOf(finding) > stopLine;

	// A bracket by its position and by the text just before it. The column
	// alone was not enough: pandorum, 2026-10-23, a model told the `(` at
	// column 30 "is still open" counted the line by hand, landed on the `(` at
	// column 5, found it balanced and decided the scan was confused -- then
	// that it must be counting some other line. The quote lets the bracket be
	// found by searching rather than by counting.
	const fileLines = text.split(/\r?\n/);
	const bracket = (
		char: string,
		line: number,
		column: number,
		sameLine = false,
	) => {
		const position = sameLine
			? `column ${column}`
			: `line ${line}, column ${column}`;
		const row = fileLines[line - 1];
		if (row === undefined || row[column - 1] !== char) {
			return `the \`${char}\` at ${position}`;
		}
		if (column === 1) {
			return `the \`${char}\` at ${position}, which starts the line,`;
		}
		const start = Math.max(0, column - 1 - QUOTE_CHARS);
		const before = row.slice(start, column - 1);
		const quoted = before.includes("`") ? `"${before}"` : `\`${before}\``;
		return `the \`${char}\` at ${position} that follows ${start > 0 ? "…" : ""}${quoted}`;
	};

	// Line number first, then the tally, then the pairing in brackets.
	//
	// The order is the whole point. Led by the pairing, a real report read "the
	// `(` opened at line 90, column 30 is closed by `}` at line 90, column
	// 382". The model quoted that first clause back and spent the rest of the
	// turn trying to make sense of a `(` being closed by a `}` — six turns of
	// it, four of them ending at the thinking budget — while the clause that
	// told it what to change sat behind a semicolon. A crossing is how the
	// scanner noticed; the tally is what the model can act on, so the tally
	// leads and the crossing explains.
	const lines = shown.map((finding) => {
		const after = pastStop(finding)
			? ` — this is after where ${stopped?.parser?.name} stops, so it may be correct code that only looks unpaired until that is fixed`
			: "";
		switch (finding.kind) {
			case "mismatch": {
				// Only when the crossing opens and closes on the same line: that
				// span has to balance within itself, so the tally is a verdict.
				const sameLine = finding.openLine === finding.line;
				const note = sameLine ? surplusNote(finding.line, balance) : "";
				// Both ends get their own position: "the `(` at column 30" under a
				// line heading was read as a column of whatever line the model had
				// in mind.
				const crossing = `${bracket(finding.found ?? "", finding.line, finding.column, sameLine)} comes while ${bracket(finding.opener ?? "", finding.openLine ?? finding.line, finding.openColumn ?? 0, sameLine)} is still open${sameLine ? `, both on line ${finding.line}` : ""}`;
				return note
					? `  line ${finding.openLine}: ${note} (${crossing})${after}`
					: `  line ${finding.openLine}: ${crossing}${after}`;
			}
			case "unmatched-close": {
				const note = surplusNote(finding.line, balance);
				// "Closes nothing that is open" read as a verdict that the closer
				// is spare. It is only what the count found: a closer earlier
				// that ended its block too soon leaves a correct one here with
				// nothing to close, which is exactly the seed's line 97.
				const stray = `${bracket(finding.found ?? "", finding.line, finding.column)} finds nothing open to close in the count — either it is spare or a closer before it ended its block too soon`;
				return note
					? `  line ${finding.line}: ${note} (${stray})${after}`
					: `  line ${finding.line}: ${stray}${after}`;
			}
			default:
				return `  line ${finding.openLine}: ${bracket(finding.opener ?? "", finding.openLine ?? 0, finding.openColumn ?? 0)} is never closed${after}`;
		}
	});

	// The parser's own answer leads when it named a line, and it is named
	// whatever the count found there: it is the line the fix has to get past.
	if (stopped?.parser && stop && stopLine !== undefined) {
		const column = stop.column === undefined ? "" : `, column ${stop.column}`;
		lines.unshift(
			`  line ${stopLine}: ${stopped.parser.name} stops here${column} — ${stop.message.replace(/\.+$/, "")}. This is the parser's own answer, not a count.`,
		);
	} else if (stopped?.parser && stop) {
		lines.unshift(
			`  ${stopped.parser.name} refuses this file — ${stop.message.replace(/\.+$/, "")}. It does not say where here, so the lines below are counts only.`,
		);
	}

	// Everything below goes to one place only: the parser's stop when there is
	// one, the first line otherwise. Saying this much about all six would cost
	// more of the model's attention than the five leads are worth.
	const detail: string[] = [];
	if (stopped?.parser && stop) {
		// Edits come from the count's findings near the stop and from the lines
		// at and just above it, and the parser picks among them. Under Bun,
		// where the stop has no line, only the first finding is tried, and only
		// an edit after which the script parses survives.
		const near = stopped.findings.filter((finding) =>
			stopLine === undefined
				? finding === stopped.findings[0]
				: lineOf(finding) <= stopLine &&
					lineOf(finding) >= stopLine - STOP_LOOKBACK,
		);
		const candidates = [
			...near.flatMap((finding) =>
				findingCandidates(stopped.body, stopped.origin, finding),
			),
			...stopCandidates(stopped.body, stopped.origin, stop, stopped.balance),
		];
		const repair = chooseRepair(
			stopped.body,
			stopped.origin,
			candidates,
			stopped.parser,
			stop,
		);
		if (repair) {
			detail.push(`      ${repair}`);
		} else if (stopped.body.length <= MAX_REPAIR_BYTES) {
			// Whether the search ran at all, which is not the same as it finding
			// nothing — a file over the size guard is never tried, and a report
			// that said "no single edit gets past it" there would be stating a
			// result it never measured.
			detail.push(
				stopLine === undefined
					? `      no single-character edit at the first line named makes ${stopped.parser.name} accept this script, so none is offered.`
					: `      no single-character edit near here gets ${stopped.parser.name} past this point, so none is offered.`,
			);
		}
	} else {
		const first = shown[0];
		if (first) {
			detail.push(
				`      no edit is offered: nothing here parses ${extension} files to check one against, and a count of brackets cannot say which one is wrong.`,
			);
		}
		if (first?.enclosing?.length) {
			// Hand over the chain the model would otherwise rebuild by hand.
			const chain = first.enclosing
				.map((open) => `\`${open.opener}\` ${open.line}:${open.column}`)
				.join(", ");
			detail.push(`      Still open there, innermost first: ${chain}.`);
		}
	}
	lines.splice(1, 0, ...detail);

	const hidden = distinct.length - shown.length;
	// The scope is said up front: the same model took a report on the whole
	// file for a report on the one line it was looking at.
	const heading =
		shown.length === 1
			? "Delimiter scan of the whole file, read from line 1:"
			: `Delimiter scan of the whole file, read from line 1 — ${distinct.length} line(s) do not balance${hidden > 0 ? `, first ${shown.length} shown` : ""}:`;

	// What the counts are and what they are not. An earlier closing line said
	// the first line named "is where the parser gave up"; on the seed it was
	// line 97 and the parser had stopped at 96.
	const counts =
		"  This scan skips strings, comments and regex literals, so its counts are of real code. A count says where brackets stop pairing up, not which bracket is wrong: a spare closer earlier can leave a correct one later looking spare.";
	const closing =
		stopLine !== undefined
			? `${counts} Start from line ${stopLine}, where the parser stops, and check again after each fix.`
			: shown.length === 1
				? `${counts} Fix the line named above, then check again.`
				: `${counts} Fix the first line named, then check again: the others are counted past it and may shift once it is fixed.`;

	return [heading, ...lines, closing].join("\n");
}
