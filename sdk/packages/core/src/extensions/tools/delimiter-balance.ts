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
		return "this line's own brackets do balance, so one is in the wrong place rather than missing or spare";
	}
	return `counting only code, this line has ${surplus.join(" and ")} — that is the edit`;
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
	return offset + column - (row === 0 ? origin.column : 1);
}

/**
 * An edit that makes one crossing go away, found by trying and re-scanning.
 *
 * The scan says which brackets cross. It cannot say whether to delete one, add
 * one or move one, and that is the question the model burns its thinking on:
 * one measured turn spent 33,350 tokens deciding between a swap and a deletion
 * on a 500-column line, reached the budget wall, and picked the wrong one. A
 * parse is microseconds, so the honest answer is to try each single-character
 * edit and report the one that verifies rather than reason about it.
 *
 * A candidate is accepted only when the crossing it targets is gone *and* it
 * introduced nothing new at or before that point — a repair that merely pushes
 * the trouble earlier in the file is not a repair. Among those that pass, the
 * one leaving fewest crossings wins, and simpler edits break the tie.
 */
function proposeRepair(
	body: string,
	origin: Cursor,
	finding: DelimiterFinding,
	baseline: number,
): string | null {
	if (body.length > MAX_REPAIR_BYTES) {
		return null;
	}
	const at = offsetIn(body, origin, finding.line, finding.column);
	if (at < 0 || at >= body.length || body[at] !== finding.found) {
		return null;
	}
	const expected = finding.opener ? PAIRS[finding.opener] : undefined;
	const cut = body.slice(0, at) + body.slice(at + 1);

	// Each candidate carries the `editor` call that performs it, because naming
	// the edit in prose was not enough. Measured: the model was told to delete
	// the `}` at column 382, restated that correctly, and then composed an
	// `old_text` match for a 500-column minified line and got back "No
	// replacement performed: text not found". The editor already addresses a
	// character by line and column; the scan already knows both. Saying it in
	// the tool's own arguments removes the step that failed.
	const line = finding.line;
	const at1 = finding.column;
	const candidates: Array<{ text: string; say: string; call: string }> = [
		{
			text: cut,
			say: `delete the \`${finding.found}\` at column ${at1}`,
			call: `start_line: ${line}, start_column: ${at1}, new_text: ""`,
		},
	];
	if (expected && expected !== finding.found) {
		candidates.push({
			text: body.slice(0, at) + expected + body.slice(at + 1),
			say: `replace the \`${finding.found}\` at column ${at1} with \`${expected}\``,
			call: `start_line: ${line}, start_column: ${at1}, new_text: "${expected}"`,
		});
		candidates.push({
			text: body.slice(0, at) + expected + body.slice(at),
			say: `insert a \`${expected}\` before the \`${finding.found}\` at column ${at1}`,
			call: `insert_line: ${line}, insert_column: ${at1}, new_text: "${expected}"`,
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
		if (
			target < 0 ||
			target >= body.length ||
			(!PAIRS[body[target]] && !CLOSERS[body[target]])
		) {
			continue;
		}
		const into = target - (column > finding.column ? 1 : 0);
		// Two calls, and the deletion goes second: doing it first would shift
		// every column after it, including the one the insert names.
		candidates.push({
			text: cut.slice(0, into) + finding.found + cut.slice(into),
			say: `move the \`${finding.found}\` at column ${at1} to column ${column}`,
			call:
				`insert_line: ${line}, insert_column: ${column}, new_text: "${finding.found}"` +
				`, then a second call with start_line: ${line}, start_column: ${at1 > column ? at1 + 1 : at1}, new_text: ""`,
		});
	}

	let best: { say: string; call: string; left: number } | null = null;
	for (const candidate of candidates) {
		const after = scanDelimiters(candidate.text, origin);
		const cleared = !after.some(
			(other) =>
				other.line === finding.line &&
				Math.abs(other.column - finding.column) <= 3,
		);
		const earlier = after.some(
			(other) =>
				other.line < finding.line ||
				(other.line === finding.line && other.column <= finding.column),
		);
		if (cleared && !earlier && (best === null || after.length < best.left)) {
			best = { say: candidate.say, call: candidate.call, left: after.length };
		}
	}
	if (!best) {
		return null;
	}

	const rest =
		best.left === 0
			? "and nothing else in this file crosses after that"
			: `and leaves ${best.left} of the ${baseline} crossings, all further down the file`;
	return (
		`${best.say} — checked: that clears this line ${rest}.\n` +
		`      that edit is \`editor\` with ${best.call} — send it as it stands; there is no text to match on.`
	);
}

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
		try {
			new Function(body);
		} catch (error) {
			if (error instanceof SyntaxError) {
				return `SyntaxError: ${error.message}`;
			}
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
	text: string,
): string | null {
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

	let findings: DelimiterFinding[];
	const balance = new Map<number, LineBalance>();
	// Which span each finding came out of, so a repair can be tried against
	// the same text the scan walked rather than against the whole file.
	const sources: Array<{
		body: string;
		origin: Cursor;
		findings: DelimiterFinding[];
	}> = [];
	const absorb = (scan: DelimiterScan) => {
		for (const [at, counts] of scan.balance) {
			const entry = balance.get(at) ?? { round: 0, square: 0, curly: 0 };
			entry.round += counts.round;
			entry.square += counts.square;
			entry.curly += counts.curly;
			balance.set(at, entry);
		}
		return scan.findings;
	};

	const record = (body: string, origin: Cursor) => {
		const found = absorb(scanWithBalance(body, origin));
		sources.push({ body, origin, findings: found });
		return found;
	};

	if (C_FAMILY.has(extension)) {
		findings = record(text, { line: 1, column: 1 });
	} else if (EMBEDS_SCRIPT.has(extension)) {
		// One line can hold the end of one `<script>` and the start of the next,
		// so the tallies are summed rather than replaced.
		findings = scriptSpans(text).flatMap((span) =>
			record(span.body, span.origin),
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
	// edit, reload the page, read, edit — once per line. Worse, it fixed a line
	// the report had not named and then had to work out for itself why the
	// error had not moved.
	//
	// Two findings on one line say less than two findings on two lines, so the
	// list is deduplicated by line rather than truncated by count.
	const seen = new Set<number>();
	const distinct = findings.filter((finding) => {
		// The line the fix goes on: the opener for a crossing or an unclosed
		// bracket, and the stray character itself when nothing was open.
		const line = finding.openLine ?? finding.line;
		if (seen.has(line)) {
			return false;
		}
		seen.add(line);
		return true;
	});

	const shown = distinct.slice(0, MAX_REPORTED_LINES);

	// Line number first, then the tally, then the pairing in brackets.
	//
	// The order is the whole point. Led by the pairing, a real report read "the
	// `(` opened at line 90, column 30 is closed by `}` at line 90, column
	// 382; counting only code, this line has 1 more `}` than `{` — that is the
	// edit". The model quoted that first clause back and spent the rest of the
	// turn trying to make sense of a `(` being closed by a `}` — six turns of
	// it, four of them ending at the thinking budget — while the clause that
	// told it what to change sat behind a semicolon. A crossing is how the
	// scanner noticed; the tally is what the model can act on, so the tally
	// leads and the crossing explains.
	const lines = shown.map((finding) => {
		switch (finding.kind) {
			case "mismatch": {
				// Only when the crossing opens and closes on the same line: that
				// span has to balance within itself, so the tally is a verdict.
				const sameLine = finding.openLine === finding.line;
				const note = sameLine ? surplusNote(finding.line, balance) : "";
				const crossing = sameLine
					? `the \`${finding.opener}\` at column ${finding.openColumn} is closed by \`${finding.found}\` at column ${finding.column}`
					: `the \`${finding.opener}\` at column ${finding.openColumn} is closed by \`${finding.found}\` at line ${finding.line}, column ${finding.column}`;
				return note
					? `  line ${finding.openLine}: ${note} (${crossing})`
					: `  line ${finding.openLine}: ${crossing}`;
			}
			case "unmatched-close": {
				const note = surplusNote(finding.line, balance);
				const stray = `the \`${finding.found}\` at column ${finding.column} closes nothing that is open`;
				return note
					? `  line ${finding.line}: ${note} (${stray})`
					: `  line ${finding.line}: ${stray}`;
			}
			default:
				return `  line ${finding.openLine}: the \`${finding.opener}\` at column ${finding.openColumn} is never closed`;
		}
	});

	// Everything below goes to the first line only. It is the one the parser
	// stopped on, so it is the one that is certain; the rest are scanned past a
	// disturbed stack. Saying this much about all six would cost more of the
	// model's attention than the five leads are worth.
	const first = shown[0];
	if (first) {
		// One voice or none. An earlier draft said what the parser expected at
		// the column *and* named the verified edit, and on the real file those
		// read as contradictory instructions — "a `)` belongs at column 382"
		// next to "delete the `}` at column 382", when the `)` it wants is
		// already sitting at 383. Whichever is said, the other has to stay out.
		const detail: string[] = [];
		const source = sources.find((candidate) =>
			candidate.findings.includes(first),
		);
		// Whether the search ran at all, which is not the same as it finding
		// nothing — a file over the size guard is never tried, and a report that
		// said "no single edit clears it" there would be stating a result it
		// never measured.
		const searched =
			source !== undefined && source.body.length <= MAX_REPAIR_BYTES;
		const repair = source
			? proposeRepair(source.body, source.origin, first, findings.length)
			: null;
		if (repair) {
			detail.push(`      ${repair}`);
		} else {
			const expected = first.opener ? PAIRS[first.opener] : undefined;
			if (first.kind === "mismatch" && expected) {
				detail.push(
					`      a \`${expected}\` is what belongs at column ${first.column} — that is what the \`${first.opener}\` from column ${first.openColumn} is waiting for.`,
				);
			} else if (first.kind === "unmatched-close") {
				detail.push(
					`      nothing was open at column ${first.column}, so the \`${first.found}\` there is spare rather than misplaced.`,
				);
			}
			if (first.enclosing?.length) {
				// Hand over the chain the model would otherwise rebuild by hand.
				const chain = first.enclosing
					.map((open) => `\`${open.opener}\` ${open.line}:${open.column}`)
					.join(", ");
				const lead = searched
					? "no single-character edit clears it, and s"
					: "S";
				detail.push(`      ${lead}till open there, innermost first: ${chain}.`);
			}
		}
		lines.splice(1, 0, ...detail);
	}

	const hidden = distinct.length - shown.length;
	const heading =
		shown.length === 1
			? "Delimiter scan:"
			: `Delimiter scan — ${distinct.length} line(s) do not balance${hidden > 0 ? `, first ${shown.length} shown` : ""}:`;

	// The first line is certain: it is where the parser gave up. The rest are
	// scanned with a stack the first crossing already disturbed, so they are
	// leads rather than verdicts — which is why the closing line says to fix
	// them together and re-check rather than trusting the list wholesale.
	const closing =
		shown.length === 1
			? "  This scan skips strings, comments and regex literals, so it is counting real code — edit the line named above rather than re-deriving the balance yourself. It is the line the parse error could not name."
			: "  This scan skips strings, comments and regex literals, so it is counting real code — edit the lines named above rather than re-deriving the balance yourself. The first is where the parser gave up; the others are scanned past it and may shift once it is fixed. Fix them in one edit, then re-check.";

	return [heading, ...lines, closing].join("\n");
}
