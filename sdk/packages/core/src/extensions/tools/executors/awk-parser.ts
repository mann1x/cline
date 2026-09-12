/**
 * A lexer and parser for the POSIX awk language.
 *
 * Split from the interpreter because the two fail for entirely different
 * reasons and a model needs to be told which: a parse error means the program
 * it wrote is not awk, and a run error means the program is awk but did
 * something impossible. Reporting both as "awk failed" would teach it nothing.
 *
 * The subset is the one a coding model actually writes: `{print $1}`,
 * `-F, '$3>10 {print $1}'`, `NR>1 {sum+=$2} END {print sum}`,
 * `/ERROR/ {print NR": "$0}`. User-defined functions and `getline` are not
 * supported and are refused by name — see the interpreter's note on why
 * refusing beats silently doing nothing.
 */

export type Token =
	| { kind: "number"; value: number }
	| { kind: "string"; value: string }
	| { kind: "regex"; value: string }
	| { kind: "name"; value: string }
	| { kind: "builtin"; value: string }
	| { kind: "keyword"; value: string }
	| { kind: "punct"; value: string }
	| { kind: "newline" }
	| { kind: "eof" };

const KEYWORDS = new Set([
	"BEGIN",
	"END",
	"if",
	"else",
	"while",
	"for",
	"do",
	"break",
	"continue",
	"next",
	"exit",
	"print",
	"printf",
	"delete",
	"in",
	"function",
	"getline",
	"return",
]);

const BUILTINS = new Set([
	"length",
	"substr",
	"index",
	"split",
	"sub",
	"gsub",
	"match",
	"sprintf",
	"toupper",
	"tolower",
	"int",
	"sqrt",
	"exp",
	"log",
	"sin",
	"cos",
	"atan2",
	"rand",
	"srand",
	"system",
	"tolower",
]);

/** Multi-character operators, longest first so `<=` is not read as `<` then `=`. */
const PUNCT = [
	">>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"^=",
	"!~",
	"{",
	"}",
	"(",
	")",
	"[",
	"]",
	";",
	",",
	"+",
	"-",
	"*",
	"/",
	"%",
	"^",
	"<",
	">",
	"=",
	"!",
	"~",
	"?",
	":",
	"$",
	// After `||`, so the two-character operator still wins the longest match.
	"|",
];

/**
 * Whether a `/` at this point starts a regex or is division.
 *
 * awk resolves this the way every such language does — by what came before.
 * After a value (a name, a number, `)`, `]`, `$0`) a slash is division; in any
 * other position it opens a regex. Getting it wrong turns `a / b / c` into a
 * regex literal and is the classic lexer bug for this language.
 */
function regexAllowed(previous: Token | undefined): boolean {
	if (!previous) {
		return true;
	}
	if (previous.kind === "number" || previous.kind === "string") {
		return false;
	}
	if (previous.kind === "name" || previous.kind === "builtin") {
		return false;
	}
	if (previous.kind === "punct") {
		return ![")", "]", "++", "--"].includes(previous.value);
	}
	return true;
}

export function tokenizeAwk(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;

	const previous = (): Token | undefined => tokens[tokens.length - 1];

	while (index < source.length) {
		const char = source[index];

		if (char === "\\" && source[index + 1] === "\n") {
			index += 2;
			continue;
		}
		if (char === "\n") {
			tokens.push({ kind: "newline" });
			index += 1;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			index += 1;
			continue;
		}
		if (char === "#") {
			while (index < source.length && source[index] !== "\n") {
				index += 1;
			}
			continue;
		}

		if (char === '"') {
			let value = "";
			index += 1;
			while (index < source.length && source[index] !== '"') {
				if (source[index] === "\\") {
					const next = source[index + 1];
					const escapes: Record<string, string> = {
						n: "\n",
						t: "\t",
						r: "\r",
						"\\": "\\",
						'"': '"',
						"/": "/",
					};
					value += escapes[next] ?? next ?? "";
					index += 2;
					continue;
				}
				value += source[index];
				index += 1;
			}
			if (source[index] !== '"') {
				throw new Error('Unterminated string: a `"` has no closing quote.');
			}
			index += 1;
			tokens.push({ kind: "string", value });
			continue;
		}

		if (char === "/" && regexAllowed(previous())) {
			let value = "";
			index += 1;
			while (index < source.length && source[index] !== "/") {
				if (source[index] === "\\") {
					value += source[index] + (source[index + 1] ?? "");
					index += 2;
					continue;
				}
				value += source[index];
				index += 1;
			}
			if (source[index] !== "/") {
				throw new Error("Unterminated regex: a `/` has no closing slash.");
			}
			index += 1;
			tokens.push({ kind: "regex", value });
			continue;
		}

		if (
			/[0-9]/.test(char) ||
			(char === "." && /[0-9]/.test(source[index + 1] ?? ""))
		) {
			let text = "";
			while (index < source.length && /[0-9.eE]/.test(source[index])) {
				// An `e` only belongs to the number when it is an exponent.
				if (/[eE]/.test(source[index])) {
					const next = source[index + 1];
					if (!next || !/[0-9+-]/.test(next)) {
						break;
					}
					text += source[index];
					index += 1;
					text += source[index];
					index += 1;
					continue;
				}
				text += source[index];
				index += 1;
			}
			tokens.push({ kind: "number", value: Number(text) });
			continue;
		}

		if (/[A-Za-z_]/.test(char)) {
			let name = "";
			while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) {
				name += source[index];
				index += 1;
			}
			if (KEYWORDS.has(name)) {
				tokens.push({ kind: "keyword", value: name });
			} else if (BUILTINS.has(name)) {
				tokens.push({ kind: "builtin", value: name });
			} else {
				tokens.push({ kind: "name", value: name });
			}
			continue;
		}

		const punct = PUNCT.find((candidate) =>
			source.startsWith(candidate, index),
		);
		if (punct) {
			tokens.push({ kind: "punct", value: punct });
			index += punct.length;
			continue;
		}

		throw new Error(`Unexpected character \`${char}\` in the program.`);
	}

	tokens.push({ kind: "eof" });
	return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Expr =
	| { type: "number"; value: number }
	| { type: "string"; value: string }
	| { type: "regex"; value: string }
	| { type: "var"; name: string }
	| { type: "field"; index: Expr }
	| { type: "index"; name: string; keys: Expr[] }
	| { type: "assign"; op: string; target: Expr; value: Expr }
	| { type: "binary"; op: string; left: Expr; right: Expr }
	| { type: "unary"; op: string; operand: Expr }
	| { type: "postfix"; op: string; target: Expr }
	| { type: "prefix"; op: string; target: Expr }
	| { type: "ternary"; test: Expr; then: Expr; other: Expr }
	| { type: "match"; negated: boolean; left: Expr; right: Expr }
	| { type: "in"; key: Expr; array: string }
	| { type: "call"; name: string; args: Expr[] }
	| { type: "concat"; parts: Expr[] }
	| { type: "grouping"; inner: Expr };

export type Stmt =
	| { type: "print"; args: Expr[] }
	| { type: "printf"; args: Expr[] }
	| { type: "expr"; expr: Expr }
	| { type: "if"; test: Expr; then: Stmt; other?: Stmt }
	| { type: "while"; test: Expr; body: Stmt }
	| { type: "for"; init?: Stmt; test?: Expr; update?: Stmt; body: Stmt }
	| { type: "forIn"; name: string; array: string; body: Stmt }
	| { type: "block"; body: Stmt[] }
	| { type: "next" }
	| { type: "exit"; code?: Expr }
	| { type: "break" }
	| { type: "continue" }
	| { type: "delete"; name: string; keys: Expr[] };

export interface Rule {
	kind: "begin" | "end" | "pattern";
	pattern?: Expr;
	/** For a range pattern: `/a/,/b/`. */
	patternEnd?: Expr;
	action?: Stmt;
	/** Range state while executing. */
	active?: boolean;
}

class Parser {
	private position = 0;

	constructor(private readonly tokens: Token[]) {}

	private peek(offset = 0): Token {
		return this.tokens[this.position + offset] ?? { kind: "eof" };
	}

	private next(): Token {
		const token = this.peek();
		this.position += 1;
		return token;
	}

	private isPunct(value: string, offset = 0): boolean {
		const token = this.peek(offset);
		return token.kind === "punct" && token.value === value;
	}

	private isKeyword(value: string, offset = 0): boolean {
		const token = this.peek(offset);
		return token.kind === "keyword" && token.value === value;
	}

	private expectPunct(value: string): void {
		if (!this.isPunct(value)) {
			throw new Error(`Expected \`${value}\` in the program.`);
		}
		this.position += 1;
	}

	private skipNewlines(): void {
		while (this.peek().kind === "newline" || this.isPunct(";")) {
			this.position += 1;
		}
	}

	private skipOptionalNewlines(): void {
		while (this.peek().kind === "newline") {
			this.position += 1;
		}
	}

	parseProgram(): Rule[] {
		const rules: Rule[] = [];
		this.skipNewlines();
		while (this.peek().kind !== "eof") {
			rules.push(this.parseRule());
			this.skipNewlines();
		}
		return rules;
	}

	private parseRule(): Rule {
		// These are rule-level constructs, so they never reach the statement
		// parser that also refuses them — and an unhandled keyword there surfaces
		// as "the program is not valid awk", which says nothing useful.
		if (this.isKeyword("function")) {
			throw new Error(
				"User-defined functions are not supported. Write the logic inline, or use several rules.",
			);
		}
		if (this.isKeyword("BEGIN")) {
			this.position += 1;
			this.skipOptionalNewlines();
			return { kind: "begin", action: this.parseBlock() };
		}
		if (this.isKeyword("END")) {
			this.position += 1;
			this.skipOptionalNewlines();
			return { kind: "end", action: this.parseBlock() };
		}
		if (this.isPunct("{")) {
			return { kind: "pattern", action: this.parseBlock() };
		}
		const pattern = this.parseExpr();
		let patternEnd: Expr | undefined;
		if (this.isPunct(",")) {
			this.position += 1;
			this.skipOptionalNewlines();
			patternEnd = this.parseExpr();
		}
		if (this.isPunct("{")) {
			return {
				kind: "pattern",
				pattern,
				...(patternEnd ? { patternEnd } : {}),
				action: this.parseBlock(),
			};
		}
		// A bare pattern prints the line.
		return {
			kind: "pattern",
			pattern,
			...(patternEnd ? { patternEnd } : {}),
		};
	}

	private parseBlock(): Stmt {
		this.expectPunct("{");
		const body: Stmt[] = [];
		this.skipNewlines();
		while (!this.isPunct("}") && this.peek().kind !== "eof") {
			body.push(this.parseStatement());
			this.skipNewlines();
		}
		this.expectPunct("}");
		return { type: "block", body };
	}

	private parseStatement(): Stmt {
		const token = this.peek();

		if (token.kind === "punct" && token.value === "{") {
			return this.parseBlock();
		}

		if (token.kind === "keyword") {
			switch (token.value) {
				case "print":
				case "printf": {
					this.position += 1;
					const args: Expr[] = [];
					const wasInPrintArgs = this.inPrintArgs;
					this.inPrintArgs = true;
					// `print` with nothing after it prints $0.
					if (
						!this.isPunct(";") &&
						this.peek().kind !== "newline" &&
						!this.isPunct("}") &&
						this.peek().kind !== "eof" &&
						!this.isPunct(">")
					) {
						args.push(this.parseExpr());
						while (this.isPunct(",")) {
							this.position += 1;
							this.skipOptionalNewlines();
							args.push(this.parseExpr());
						}
					}
					this.inPrintArgs = wasInPrintArgs;
					if (this.isPunct(">") || this.isPunct(">>")) {
						throw new Error(
							"Redirecting output to a file is not supported. Let the program print, and use `sed` or `editor` to write a file.",
						);
					}
					if (this.isPunct("|")) {
						throw new Error(
							"Piping output to a command is not supported. Let the program print, and use `run_commands` if you need a pipeline.",
						);
					}
					return token.value === "print"
						? { type: "print", args }
						: { type: "printf", args };
				}
				case "if": {
					this.position += 1;
					this.expectPunct("(");
					const test = this.parseExpr();
					this.expectPunct(")");
					this.skipOptionalNewlines();
					const then = this.parseStatement();
					// `else` may sit after a newline or a `;`.
					const mark = this.position;
					this.skipNewlines();
					if (this.isKeyword("else")) {
						this.position += 1;
						this.skipOptionalNewlines();
						return { type: "if", test, then, other: this.parseStatement() };
					}
					this.position = mark;
					return { type: "if", test, then };
				}
				case "while": {
					this.position += 1;
					this.expectPunct("(");
					const test = this.parseExpr();
					this.expectPunct(")");
					this.skipOptionalNewlines();
					return { type: "while", test, body: this.parseStatement() };
				}
				case "for": {
					this.position += 1;
					this.expectPunct("(");
					// `for (k in a)` against `for (i = 0; i < n; i++)`.
					if (
						this.peek().kind === "name" &&
						this.isKeyword("in", 1) &&
						this.peek(2).kind === "name"
					) {
						const name = (this.next() as { value: string }).value;
						this.position += 1;
						const array = (this.next() as { value: string }).value;
						this.expectPunct(")");
						this.skipOptionalNewlines();
						return {
							type: "forIn",
							name,
							array,
							body: this.parseStatement(),
						};
					}
					const init = this.isPunct(";")
						? undefined
						: { type: "expr" as const, expr: this.parseExpr() };
					this.expectPunct(";");
					const test = this.isPunct(";") ? undefined : this.parseExpr();
					this.expectPunct(";");
					const update = this.isPunct(")")
						? undefined
						: { type: "expr" as const, expr: this.parseExpr() };
					this.expectPunct(")");
					this.skipOptionalNewlines();
					return {
						...(init ? { init } : {}),
						...(test ? { test } : {}),
						...(update ? { update } : {}),
						type: "for",
						body: this.parseStatement(),
					};
				}
				case "next":
					this.position += 1;
					return { type: "next" };
				case "break":
					this.position += 1;
					return { type: "break" };
				case "continue":
					this.position += 1;
					return { type: "continue" };
				case "exit": {
					this.position += 1;
					const done =
						this.isPunct(";") ||
						this.isPunct("}") ||
						this.peek().kind === "newline" ||
						this.peek().kind === "eof";
					return done
						? { type: "exit" }
						: { type: "exit", code: this.parseExpr() };
				}
				case "delete": {
					this.position += 1;
					const name = this.next();
					if (name.kind !== "name") {
						throw new Error("`delete` needs an array name.");
					}
					const keys: Expr[] = [];
					if (this.isPunct("[")) {
						this.position += 1;
						keys.push(this.parseExpr());
						while (this.isPunct(",")) {
							this.position += 1;
							keys.push(this.parseExpr());
						}
						this.expectPunct("]");
					}
					return { type: "delete", name: name.value, keys };
				}
				case "function":
					throw new Error(
						"User-defined functions are not supported. Write the logic inline, or use several rules.",
					);
				case "getline":
					throw new Error(
						"`getline` is not supported. The program is run over the files given to the tool.",
					);
				case "do":
					throw new Error(
						"`do ... while` is not supported. Use `while` instead.",
					);
			}
		}

		return { type: "expr", expr: this.parseExpr() };
	}

	// --- expressions, lowest precedence first -------------------------------

	parseExpr(): Expr {
		return this.parseTernary();
	}

	private parseTernary(): Expr {
		const test = this.parseOr();
		if (this.isPunct("?")) {
			this.position += 1;
			const then = this.parseTernary();
			this.expectPunct(":");
			const other = this.parseTernary();
			return { type: "ternary", test, then, other };
		}
		// Assignment binds looser than `?:` in practice for what models write,
		// and is handled here so `x = a ? b : c` parses as one assignment.
		if (
			this.peek().kind === "punct" &&
			["=", "+=", "-=", "*=", "/=", "%=", "^="].includes(
				(this.peek() as { value: string }).value,
			) &&
			(test.type === "var" || test.type === "field" || test.type === "index")
		) {
			const op = (this.next() as { value: string }).value;
			const value = this.parseTernary();
			return { type: "assign", op, target: test, value };
		}
		return test;
	}

	private parseOr(): Expr {
		let left = this.parseAnd();
		while (this.isPunct("||")) {
			this.position += 1;
			this.skipOptionalNewlines();
			left = { type: "binary", op: "||", left, right: this.parseAnd() };
		}
		return left;
	}

	private parseAnd(): Expr {
		let left = this.parseIn();
		while (this.isPunct("&&")) {
			this.position += 1;
			this.skipOptionalNewlines();
			left = { type: "binary", op: "&&", left, right: this.parseIn() };
		}
		return left;
	}

	private parseIn(): Expr {
		let left = this.parseMatch();
		while (this.isKeyword("in") && this.peek(1).kind === "name") {
			this.position += 1;
			const array = (this.next() as { value: string }).value;
			left = { type: "in", key: left, array };
		}
		return left;
	}

	private parseMatch(): Expr {
		let left = this.parseComparison();
		while (this.isPunct("~") || this.isPunct("!~")) {
			const negated = this.isPunct("!~");
			this.position += 1;
			left = {
				type: "match",
				negated,
				left,
				right: this.parseComparison(),
			};
		}
		return left;
	}

	/**
	 * Set while parsing `print`/`printf` arguments.
	 *
	 * In awk an unparenthesised `>` after `print` is redirection, not a
	 * comparison — `print $1 > "out"` writes a file. Parsing it as a comparison
	 * makes the program mean something entirely different and run silently, so
	 * the operator is withheld here and the caller refuses the redirect.
	 */
	private inPrintArgs = false;

	private parseComparison(): Expr {
		let left = this.parseConcat();
		while (
			this.peek().kind === "punct" &&
			["<", "<=", ">", ">=", "==", "!="].includes(
				(this.peek() as { value: string }).value,
			) &&
			!(
				this.inPrintArgs &&
				[">", ">>"].includes((this.peek() as { value: string }).value)
			)
		) {
			const op = (this.next() as { value: string }).value;
			left = { type: "binary", op, left, right: this.parseConcat() };
		}
		return left;
	}

	/**
	 * String concatenation, which awk spells as juxtaposition.
	 *
	 * `print NR": "$0` is three expressions with no operator between them. The
	 * rule is that anything which can start a value, appearing where an operator
	 * could have been, continues a concatenation.
	 */
	private parseConcat(): Expr {
		const parts: Expr[] = [this.parseAdditive()];
		while (this.startsValue()) {
			parts.push(this.parseAdditive());
		}
		return parts.length === 1 ? parts[0] : { type: "concat", parts };
	}

	private startsValue(): boolean {
		const token = this.peek();
		if (token.kind === "number" || token.kind === "string") {
			return true;
		}
		if (token.kind === "name" || token.kind === "builtin") {
			return true;
		}
		if (token.kind === "regex") {
			return true;
		}
		if (token.kind === "punct") {
			return ["$", "(", "!", "-", "+"].includes(token.value)
				? // A `-` here is ambiguous with subtraction; additive already
					// consumed those, so reaching one means concatenation.
					["$", "("].includes(token.value)
				: false;
		}
		return false;
	}

	private parseAdditive(): Expr {
		let left = this.parseMultiplicative();
		while (this.isPunct("+") || this.isPunct("-")) {
			const op = (this.next() as { value: string }).value;
			left = {
				type: "binary",
				op,
				left,
				right: this.parseMultiplicative(),
			};
		}
		return left;
	}

	private parseMultiplicative(): Expr {
		let left = this.parseUnary();
		while (this.isPunct("*") || this.isPunct("/") || this.isPunct("%")) {
			const op = (this.next() as { value: string }).value;
			left = { type: "binary", op, left, right: this.parseUnary() };
		}
		return left;
	}

	private parseUnary(): Expr {
		if (this.isPunct("!") || this.isPunct("-") || this.isPunct("+")) {
			const op = (this.next() as { value: string }).value;
			return { type: "unary", op, operand: this.parseUnary() };
		}
		if (this.isPunct("++") || this.isPunct("--")) {
			const op = (this.next() as { value: string }).value;
			return { type: "prefix", op, target: this.parseUnary() };
		}
		return this.parsePower();
	}

	private parsePower(): Expr {
		const base = this.parsePostfix();
		if (this.isPunct("^")) {
			this.position += 1;
			// Right-associative, as in awk.
			return { type: "binary", op: "^", left: base, right: this.parseUnary() };
		}
		return base;
	}

	private parsePostfix(): Expr {
		const value = this.parsePrimary();
		if (this.isPunct("++") || this.isPunct("--")) {
			const op = (this.next() as { value: string }).value;
			return { type: "postfix", op, target: value };
		}
		return value;
	}

	private parsePrimary(): Expr {
		const token = this.next();

		if (token.kind === "number") {
			return { type: "number", value: token.value };
		}
		if (token.kind === "string") {
			return { type: "string", value: token.value };
		}
		if (token.kind === "regex") {
			return { type: "regex", value: token.value };
		}
		if (token.kind === "punct" && token.value === "$") {
			return { type: "field", index: this.parsePostfix() };
		}
		if (token.kind === "punct" && token.value === "(") {
			const inner = this.parseExpr();
			this.expectPunct(")");
			return { type: "grouping", inner };
		}
		if (token.kind === "builtin") {
			const args: Expr[] = [];
			if (this.isPunct("(")) {
				this.position += 1;
				if (!this.isPunct(")")) {
					args.push(this.parseExpr());
					while (this.isPunct(",")) {
						this.position += 1;
						args.push(this.parseExpr());
					}
				}
				this.expectPunct(")");
			}
			return { type: "call", name: token.value, args };
		}
		if (token.kind === "name") {
			if (this.isPunct("[")) {
				this.position += 1;
				const keys: Expr[] = [this.parseExpr()];
				while (this.isPunct(",")) {
					this.position += 1;
					keys.push(this.parseExpr());
				}
				this.expectPunct("]");
				return { type: "index", name: token.value, keys };
			}
			if (this.isPunct("(")) {
				throw new Error(
					`\`${token.value}(...)\` looks like a user-defined function, which is not supported.`,
				);
			}
			return { type: "var", name: token.value };
		}

		throw new Error(
			`Unexpected ${
				token.kind === "eof"
					? "end of program"
					: `\`${(token as { value?: string }).value ?? token.kind}\``
			} — the program is not valid awk.`,
		);
	}
}

export function parseAwk(source: string): Rule[] {
	return new Parser(tokenizeAwk(source)).parseProgram();
}
