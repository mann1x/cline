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
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

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
const C_FAMILY = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json", ".jsonc", ".css", ".scss", ".less"])

/** Files whose `<script>` bodies are plain JavaScript. */
const EMBEDS_SCRIPT = new Set([".html", ".htm"])

export interface DelimiterFinding {
	kind: "mismatch" | "unmatched-close" | "unclosed"
	/** 1-based position of the delimiter that is wrong. */
	line: number
	column: number
	/** The character at that position, when there is one. */
	found?: string
	/** 1-based position of the opener involved, for a mismatch or unclosed. */
	openLine?: number
	openColumn?: number
	opener?: string
}

interface Cursor {
	line: number
	column: number
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
	let index = slashIndex - 1
	while (index >= 0 && /\s/.test(text[index])) {
		index -= 1
	}
	if (index < 0) {
		return true
	}
	const previous = text[index]
	if ("(,=:[!&|?{};+-*%^~<>".includes(previous)) {
		return true
	}
	// `return /re/`, `typeof /re/`, `case /re/` and friends.
	const word = /[A-Za-z_$]+$/.exec(text.slice(Math.max(0, index - 11), index + 1))
	if (word) {
		return ["return", "typeof", "case", "in", "of", "delete", "void", "instanceof", "new", "do", "else", "yield"].includes(
			word[0],
		)
	}
	return false
}

/**
 * Scan one span of C-family source and report where its delimiters cross.
 *
 * Strings, template literals, comments and regex literals are skipped, so a
 * brace inside `"}"` does not count — which is the difference between this and
 * counting characters, and the reason a hand-rolled counter misleads.
 */
export function scanDelimiters(text: string, origin: Cursor = { line: 1, column: 1 }): DelimiterFinding[] {
	const findings: DelimiterFinding[] = []
	// `resumesTemplate` marks the `{` of a `${...}` substitution: closing it
	// puts the scanner back inside the template literal rather than in code.
	// Without it the tail of every template — the part after the last `}` —
	// gets scanned as source, and one stray quote or brace in ordinary prose
	// corrupts every finding after it.
	const stack: Array<{ opener: string; line: number; column: number; resumesTemplate?: boolean }> = []

	let line = origin.line
	let column = origin.column
	let index = 0
	let inTemplate = false

	const advance = (count: number) => {
		for (let step = 0; step < count && index < text.length; step += 1) {
			if (text[index] === "\n") {
				line += 1
				column = 1
			} else {
				column += 1
			}
			index += 1
		}
	}

	while (index < text.length) {
		const char = text[index]

		// Inside a template literal: only an escape, a `${` or the closing
		// backtick mean anything. Everything else is prose.
		if (inTemplate) {
			if (char === "\\") {
				advance(2)
				continue
			}
			if (char === "`") {
				inTemplate = false
				advance(1)
				continue
			}
			if (char === "$" && text[index + 1] === "{") {
				advance(1)
				stack.push({ opener: "{", line, column, resumesTemplate: true })
				inTemplate = false
				advance(1)
				continue
			}
			advance(1)
			continue
		}

		// Line comment.
		if (char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") {
				advance(1)
			}
			continue
		}

		// Block comment.
		if (char === "/" && text[index + 1] === "*") {
			const end = text.indexOf("*/", index + 2)
			advance(end === -1 ? text.length - index : end + 2 - index)
			continue
		}

		// Regex literal.
		if (char === "/" && startsRegex(text, index)) {
			advance(1)
			let inClass = false
			while (index < text.length) {
				const current = text[index]
				if (current === "\\") {
					advance(2)
					continue
				}
				if (current === "\n") {
					break // Unterminated; let the language server say so.
				}
				if (current === "[") {
					inClass = true
				} else if (current === "]") {
					inClass = false
				} else if (current === "/" && !inClass) {
					advance(1)
					break
				}
				advance(1)
			}
			continue
		}

		// Template literal: hand the body to the branch above, which knows how
		// to come back here for each `${...}`.
		if (char === "`") {
			inTemplate = true
			advance(1)
			continue
		}

		// Ordinary string.
		if (char === '"' || char === "'") {
			const quote = char
			advance(1)
			while (index < text.length) {
				const current = text[index]
				if (current === "\\") {
					advance(2)
					continue
				}
				if (current === quote) {
					advance(1)
					break
				}
				if (current === "\n") {
					break // Unterminated; let the language server say so.
				}
				advance(1)
			}
			continue
		}

		if (PAIRS[char]) {
			stack.push({ opener: char, line, column })
			advance(1)
			continue
		}

		if (CLOSERS[char]) {
			const open = stack.pop()
			if (open?.resumesTemplate && char === "}") {
				inTemplate = true
				advance(1)
				continue
			}
			if (!open) {
				findings.push({ kind: "unmatched-close", line, column, found: char })
			} else if (PAIRS[open.opener] !== char) {
				findings.push({
					kind: "mismatch",
					line,
					column,
					found: char,
					opener: open.opener,
					openLine: open.line,
					openColumn: open.column,
				})
			}
			advance(1)
			continue
		}

		advance(1)
	}

	for (const open of stack) {
		findings.push({
			kind: "unclosed",
			line: open.line,
			column: open.column,
			opener: open.opener,
			openLine: open.line,
			openColumn: open.column,
		})
	}

	return findings
}

/** Every `<script>` body in an HTML-ish file, with where each one starts. */
function scriptSpans(text: string): Array<{ body: string; origin: Cursor }> {
	const spans: Array<{ body: string; origin: Cursor }> = []
	const opening = /<script\b([^>]*)>/gi
	let match = opening.exec(text)
	while (match) {
		const attributes = match[1] ?? ""
		const bodyStart = match.index + match[0].length
		const closing = text.toLowerCase().indexOf("</script", bodyStart)
		const bodyEnd = closing === -1 ? text.length : closing
		// A `src=` script has no body worth scanning, and a non-JS `type=` may
		// not be JavaScript at all.
		if (
			!/\bsrc\s*=/i.test(attributes) &&
			!/\btype\s*=\s*["']?(?!text\/javascript|module|application\/javascript)/i.test(attributes)
		) {
			const before = text.slice(0, bodyStart)
			const lineIndex = before.split("\n").length
			const lastNewline = before.lastIndexOf("\n")
			spans.push({
				body: text.slice(bodyStart, bodyEnd),
				origin: { line: lineIndex, column: bodyStart - lastNewline },
			})
		}
		opening.lastIndex = bodyEnd
		match = opening.exec(text)
	}
	return spans
}

/**
 * Render the balance findings for a file, or null when there is nothing
 * useful to say — the file's language is not one this understands, or its
 * delimiters match.
 */
export function describeDelimiterBalance(filePath: string, text: string): string | null {
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()

	let findings: DelimiterFinding[]
	if (C_FAMILY.has(extension)) {
		findings = scanDelimiters(text)
	} else if (EMBEDS_SCRIPT.has(extension)) {
		findings = scriptSpans(text).flatMap((span) => scanDelimiters(span.body, span.origin))
	} else {
		return null
	}

	if (findings.length === 0) {
		return null
	}

	// Only the first two are worth reporting: after the first crossing every
	// subsequent pairing is suspect, exactly as the parser's own cascade is.
	const lines = findings.slice(0, 2).map((finding) => {
		switch (finding.kind) {
			case "mismatch":
				return `  the \`${finding.opener}\` opened at line ${finding.openLine}, column ${finding.openColumn} is closed by \`${finding.found}\` at line ${finding.line}, column ${finding.column}`
			case "unmatched-close":
				return `  \`${finding.found}\` at line ${finding.line}, column ${finding.column} closes nothing that is open`
			default:
				return `  the \`${finding.opener}\` opened at line ${finding.openLine}, column ${finding.openColumn} is never closed`
		}
	})

	const more = findings.length > 2 ? ` (${findings.length - 2} further crossing(s) follow from these)` : ""
	return [
		`Delimiter scan${more}:`,
		...lines,
		"  This scan skips strings, comments and regex literals, so it is counting real code. Fix the first one and re-check — it is the opener the parse error could not name.",
	].join("\n")
}
