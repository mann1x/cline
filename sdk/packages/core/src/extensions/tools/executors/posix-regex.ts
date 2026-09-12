/**
 * Translate POSIX regular expressions into JavaScript ones.
 *
 * `grep`, `sed` and `awk` are being offered because a coding model already
 * knows them — that is the whole reason they exist here rather than a bespoke
 * search tool. Which means the *dialect* has to be the one it knows. A model
 * that writes `sed 's/\(foo\)bar/\1/'` and gets a JavaScript regex error has
 * learned that the tool is unreliable, and will go back to guessing with
 * `editor`.
 *
 * Three dialects are in play and they disagree in ways that silently change
 * what a pattern means, rather than failing loudly:
 *
 *   BRE (grep, sed by default)   `\(group\)`  `\{2,3\}`  `\|`  and a literal
 *                                `(`, `)`, `{`, `}`, `+`, `?`, `|`
 *   ERE (grep -E, sed -E, awk)   `(group)`    `{2,3}`    `|`   and a literal
 *                                `\(`, `\)`
 *   JavaScript                   ERE-like, but with no POSIX classes and
 *                                different rules for an unescaped `{`
 *
 * So BRE's `a+` matches "a+" literally while ERE's matches one or more "a" —
 * the same three characters, two different answers, no error either way. That
 * is the class of bug this module exists to prevent.
 */

/**
 * POSIX character classes, which JavaScript has none of.
 *
 * Written as the character sets they stand for rather than as Unicode property
 * escapes: `[[:alpha:]]` in a tool a model reached for because it knows `grep`
 * means the C-locale class it learned, not `\p{Alphabetic}`.
 */
const POSIX_CLASSES: Record<string, string> = {
	alpha: "A-Za-z",
	digit: "0-9",
	alnum: "A-Za-z0-9",
	upper: "A-Z",
	lower: "a-z",
	space: " \\t\\r\\n\\v\\f",
	blank: " \\t",
	punct: "!-/:-@\\[-`{-~",
	print: " -~",
	graph: "!-~",
	cntrl: "\\x00-\\x1f\\x7f",
	xdigit: "0-9A-Fa-f",
};

/**
 * Rewrite a bracket expression, which has its own grammar.
 *
 * Inside `[...]` almost nothing is special, so the translation is narrow on
 * purpose: expand `[:class:]`, and leave every other character alone apart from
 * the escaping JavaScript insists on. Returns the JS text and the index just
 * past the closing bracket.
 */
function translateBracket(
	source: string,
	start: number,
): { text: string; next: number } {
	let index = start + 1;
	let out = "[";
	if (source[index] === "^") {
		out += "^";
		index += 1;
	}
	// A `]` in the first position is a literal `]`, not the end of the set.
	if (source[index] === "]") {
		out += "\\]";
		index += 1;
	}
	while (index < source.length && source[index] !== "]") {
		if (source.startsWith("[:", index)) {
			const end = source.indexOf(":]", index + 2);
			if (end !== -1) {
				const name = source.slice(index + 2, end);
				const expansion = POSIX_CLASSES[name];
				if (expansion !== undefined) {
					out += expansion;
					index = end + 2;
					continue;
				}
			}
		}
		const char = source[index];
		// `\` inside a bracket is literal in POSIX but an escape in JavaScript.
		out += char === "\\" ? "\\\\" : char;
		index += 1;
	}
	out += "]";
	return { text: out, next: index + 1 };
}

export interface PosixRegexOptions {
	/** ERE (grep -E, sed -E, awk) rather than BRE (grep, sed). */
	extended?: boolean;
	/** Case-insensitive matching (`-i`, or an `I` flag on a sed `s///`). */
	ignoreCase?: boolean;
	/** Match whole words only (`grep -w`). */
	wordBoundary?: boolean;
	/** Treat the pattern as literal text (`grep -F`). */
	fixed?: boolean;
	/** Replace every occurrence rather than the first. */
	global?: boolean;
}

/** Characters JavaScript treats as special, for `-F` and for literal output. */
function escapeLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a POSIX pattern to JavaScript regex source.
 *
 * The two dialects are handled in one pass because they differ only in which
 * characters carry the special meaning and which carry the literal one — in BRE
 * a backslash *adds* meaning to `(){}|`, in ERE it *removes* it. Writing it
 * twice would be two places for that inversion to drift.
 */
export function posixToJsSource(
	pattern: string,
	options: PosixRegexOptions = {},
): string {
	if (options.fixed) {
		const literal = escapeLiteral(pattern);
		return options.wordBoundary ? `\\b(?:${literal})\\b` : literal;
	}

	const extended = options.extended === true;
	let out = "";
	let index = 0;

	while (index < pattern.length) {
		const char = pattern[index];

		if (char === "[") {
			const bracket = translateBracket(pattern, index);
			out += bracket.text;
			index = bracket.next;
			continue;
		}

		if (char === "\\") {
			const next = pattern[index + 1];
			if (next === undefined) {
				out += "\\\\";
				index += 1;
				continue;
			}
			// In BRE these are the *special* forms and the bare characters are
			// literal; in ERE it is the other way round.
			if (!extended && "(){}|+?".includes(next)) {
				out += next;
				index += 2;
				continue;
			}
			if (extended && "(){}|+?".includes(next)) {
				out += `\\${next}`;
				index += 2;
				continue;
			}
			// `\1`..`\9` are backreferences in both, and JavaScript agrees.
			if (/[1-9]/.test(next)) {
				out += `\\${next}`;
				index += 2;
				continue;
			}
			// GNU word-boundary and class shorthands a model is likely to use.
			if (next === "<" || next === ">") {
				out += "\\b";
				index += 2;
				continue;
			}
			if ("bBwWsSdDnrtfv\\^$.*[]/".includes(next)) {
				out += `\\${next}`;
				index += 2;
				continue;
			}
			out += escapeLiteral(next);
			index += 2;
			continue;
		}

		if (!extended && "(){}|+?".includes(char)) {
			// Literal in BRE. `{` especially: JavaScript would read `a{2` as a
			// broken quantifier in some engines and a literal in others.
			out += `\\${char}`;
			index += 1;
			continue;
		}

		out += char;
		index += 1;
	}

	return options.wordBoundary ? `\\b(?:${out})\\b` : out;
}

/**
 * Compile a POSIX pattern, reporting failures in the tool's own terms.
 *
 * A JavaScript `SyntaxError` quoting a translated pattern is unreadable to a
 * model that wrote a POSIX one — it would be shown source it never typed.
 */
export function compilePosixRegex(
	pattern: string,
	options: PosixRegexOptions = {},
): RegExp {
	const source = posixToJsSource(pattern, options);
	let flags = "";
	if (options.ignoreCase) {
		flags += "i";
	}
	if (options.global) {
		flags += "g";
	}
	try {
		return new RegExp(source, flags);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`The pattern \`${pattern}\` is not a valid ${
				options.extended ? "extended" : "basic"
			} regular expression: ${reason}`,
		);
	}
}
