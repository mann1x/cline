/**
 * Pipeline expressions: `{{ … }}` in a pipeline's strings.
 *
 * A small language, not JavaScript. It has member access and indexing,
 * comparison, `&&` `||` `!`, arithmetic, `? :`, string, number and list
 * literals, and a fixed set of functions. There is no `eval`, no
 * `Function`, no prototype access and no assignment, so a pipeline file
 * cannot run code through an expression: code runs only in a `command`
 * node, under the shell's approval.
 *
 * A string that is one expression and nothing else gives its value (a list
 * stays a list); text with expressions in it gives text, with each value
 * written in (objects as JSON).
 */

export class ExpressionError extends Error {}

type Node =
	| { k: "lit"; v: unknown }
	| { k: "id"; name: string }
	| { k: "list"; items: Node[] }
	| { k: "member"; obj: Node; prop: string }
	| { k: "index"; obj: Node; index: Node }
	| { k: "call"; name: string; args: Node[] }
	| { k: "unary"; op: string; arg: Node }
	| { k: "binary"; op: string; left: Node; right: Node }
	| { k: "cond"; test: Node; then: Node; else: Node };

interface Token {
	t: "num" | "str" | "id" | "op" | "end";
	v: string;
	at: number;
}

const OPERATORS = [
	"===",
	"!==",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"<",
	">",
	"+",
	"-",
	"*",
	"/",
	"%",
	"!",
	"?",
	":",
	".",
	",",
	"(",
	")",
	"[",
	"]",
];

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const c = source[i] as string;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (/[0-9]/.test(c)) {
			const m = /^\d+(?:\.\d+)?/.exec(source.slice(i)) as RegExpExecArray;
			tokens.push({ t: "num", v: m[0], at: i });
			i += m[0].length;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			let out = "";
			while (j < source.length && source[j] !== c) {
				if (source[j] === "\\" && j + 1 < source.length) {
					const next = source[j + 1] as string;
					out += next === "n" ? "\n" : next === "t" ? "\t" : next;
					j += 2;
				} else {
					out += source[j];
					j++;
				}
			}
			if (j >= source.length) {
				throw new ExpressionError(`unclosed string at ${i}`);
			}
			tokens.push({ t: "str", v: out, at: i });
			i = j + 1;
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			const m = /^[A-Za-z_$][\w$]*/.exec(source.slice(i)) as RegExpExecArray;
			tokens.push({ t: "id", v: m[0], at: i });
			i += m[0].length;
			continue;
		}
		const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
		if (!op) throw new ExpressionError(`unexpected "${c}" at ${i}`);
		tokens.push({ t: "op", v: op, at: i });
		i += op.length;
	}
	tokens.push({ t: "end", v: "", at: source.length });
	return tokens;
}

const BINARY: Record<string, number> = {
	"??": 1,
	"||": 2,
	"&&": 3,
	"==": 4,
	"!=": 4,
	"===": 4,
	"!==": 4,
	"<": 5,
	"<=": 5,
	">": 5,
	">=": 5,
	"+": 6,
	"-": 6,
	"*": 7,
	"/": 7,
	"%": 7,
};

/** Parse one expression (the text between `{{` and `}}`). */
export function parseExpression(source: string): Node {
	const tokens = tokenize(source);
	let p = 0;
	const peek = () => tokens[p] as Token;
	const next = () => tokens[p++] as Token;
	const expect = (v: string) => {
		const token = next();
		if (token.t !== "op" || token.v !== v) {
			throw new ExpressionError(
				`expected "${v}" at ${token.at}, found "${token.v || "the end"}"`,
			);
		}
	};

	const primary = (): Node => {
		const token = next();
		if (token.t === "num") return { k: "lit", v: Number(token.v) };
		if (token.t === "str") return { k: "lit", v: token.v };
		if (token.t === "id") {
			if (token.v === "true") return { k: "lit", v: true };
			if (token.v === "false") return { k: "lit", v: false };
			if (token.v === "null") return { k: "lit", v: null };
			if (peek().t === "op" && peek().v === "(") {
				next();
				const args: Node[] = [];
				if (!(peek().t === "op" && peek().v === ")")) {
					do args.push(expression(0));
					while (peek().t === "op" && peek().v === "," && next());
				}
				expect(")");
				if (!(token.v in FUNCTIONS)) {
					throw new ExpressionError(
						`unknown function "${token.v}" (known: ${Object.keys(FUNCTIONS).join(", ")})`,
					);
				}
				return { k: "call", name: token.v, args };
			}
			return { k: "id", name: token.v };
		}
		if (token.t === "op" && token.v === "(") {
			const inner = expression(0);
			expect(")");
			return inner;
		}
		if (token.t === "op" && token.v === "[") {
			const items: Node[] = [];
			if (!(peek().t === "op" && peek().v === "]")) {
				do items.push(expression(0));
				while (peek().t === "op" && peek().v === "," && next());
			}
			expect("]");
			return { k: "list", items };
		}
		if (token.t === "op" && (token.v === "!" || token.v === "-")) {
			return { k: "unary", op: token.v, arg: postfix(primary()) };
		}
		throw new ExpressionError(
			`unexpected "${token.v || "end of expression"}" at ${token.at}`,
		);
	};

	const postfix = (node: Node): Node => {
		let current = node;
		for (;;) {
			const token = peek();
			if (token.t === "op" && token.v === ".") {
				next();
				const name = next();
				if (name.t !== "id" && name.t !== "num") {
					throw new ExpressionError(`expected a field name at ${name.at}`);
				}
				current = { k: "member", obj: current, prop: name.v };
			} else if (token.t === "op" && token.v === "[") {
				next();
				const index = expression(0);
				expect("]");
				current = { k: "index", obj: current, index };
			} else {
				return current;
			}
		}
	};

	const expression = (min: number): Node => {
		let left = postfix(primary());
		for (;;) {
			const token = peek();
			if (token.t !== "op") break;
			if (token.v === "?" && min === 0) {
				next();
				const then = expression(0);
				expect(":");
				const otherwise = expression(0);
				left = { k: "cond", test: left, then, else: otherwise };
				continue;
			}
			const precedence = BINARY[token.v];
			if (precedence === undefined || precedence <= min) break;
			next();
			const right = expression(precedence);
			left = { k: "binary", op: token.v, left, right };
		}
		return left;
	};

	const tree = expression(0);
	if (peek().t !== "end") {
		throw new ExpressionError(
			`unexpected "${peek().v}" at ${peek().at} after a complete expression`,
		);
	}
	return tree;
}

const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);

function read(value: unknown, key: string | number): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof key === "string" && BLOCKED.has(key)) return undefined;
	if (typeof value === "string") {
		if (key === "length") return value.length;
		return typeof key === "number" ? value[key] : undefined;
	}
	if (Array.isArray(value)) {
		if (key === "length") return value.length;
		const index = typeof key === "number" ? key : Number(key);
		if (!Number.isInteger(index)) return undefined;
		return value[index < 0 ? value.length + index : index];
	}
	if (typeof value === "object") {
		return Object.hasOwn(value, key)
			? (value as Record<string, unknown>)[key]
			: undefined;
	}
	return undefined;
}

function text(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return JSON.stringify(value);
}

function list(value: unknown, fn: string): unknown[] {
	if (Array.isArray(value)) return value;
	throw new ExpressionError(
		`${fn}() needs a list, got ${text(value).slice(0, 40) || typeof value}`,
	);
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
	len: (value) =>
		typeof value === "string" || Array.isArray(value)
			? value.length
			: value && typeof value === "object"
				? Object.keys(value).length
				: 0,
	join: (value, separator) =>
		list(value, "join")
			.map(text)
			.join(separator === undefined ? "," : text(separator)),
	split: (value, separator) =>
		text(value).split(separator === undefined ? "," : text(separator)),
	json: (value) => JSON.stringify(value),
	parse: (value) => {
		try {
			return JSON.parse(text(value));
		} catch {
			throw new ExpressionError(
				`parse() got text that is not JSON: ${text(value).slice(0, 40)}`,
			);
		}
	},
	default: (value, fallback) =>
		value === undefined || value === null || value === "" ? fallback : value,
	contains: (haystack, needle) =>
		Array.isArray(haystack)
			? haystack.some((entry) => equal(entry, needle))
			: text(haystack).includes(text(needle)),
	lower: (value) => text(value).toLowerCase(),
	upper: (value) => text(value).toUpperCase(),
	trim: (value) => text(value).trim(),
	keys: (value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.keys(value)
			: [],
	number: (value) => Number(value),
	string: (value) => text(value),
	lines: (value) =>
		text(value)
			.split(/\r?\n/)
			.filter((line) => line.length > 0),
};

/** The functions an expression may call, for the catalog. */
export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);

function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === "object" || typeof b === "object") {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	// "1" == 1, as a comparison written in a pipeline means it.
	return (
		a !== undefined &&
		b !== undefined &&
		a !== null &&
		b !== null &&
		String(a) === String(b)
	);
}

function truthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return !!value;
}

export type ExpressionScope = Record<string, unknown>;

export function evaluate(node: Node, scope: ExpressionScope): unknown {
	switch (node.k) {
		case "lit":
			return node.v;
		case "id":
			if (!Object.hasOwn(scope, node.name)) {
				throw new ExpressionError(
					`unknown name "${node.name}" (known: ${Object.keys(scope).join(", ")})`,
				);
			}
			return scope[node.name];
		case "list":
			return node.items.map((item) => evaluate(item, scope));
		case "member":
			return read(evaluate(node.obj, scope), node.prop);
		case "index": {
			const index = evaluate(node.index, scope);
			return read(
				evaluate(node.obj, scope),
				typeof index === "number" ? index : text(index),
			);
		}
		case "call":
			return (FUNCTIONS[node.name] as (...args: unknown[]) => unknown)(
				...node.args.map((arg) => evaluate(arg, scope)),
			);
		case "unary": {
			const value = evaluate(node.arg, scope);
			return node.op === "!" ? !truthy(value) : -Number(value);
		}
		case "cond":
			return truthy(evaluate(node.test, scope))
				? evaluate(node.then, scope)
				: evaluate(node.else, scope);
		case "binary": {
			if (node.op === "&&") {
				const left = evaluate(node.left, scope);
				return truthy(left) ? evaluate(node.right, scope) : left;
			}
			if (node.op === "||") {
				const left = evaluate(node.left, scope);
				return truthy(left) ? left : evaluate(node.right, scope);
			}
			if (node.op === "??") {
				const left = evaluate(node.left, scope);
				return left === undefined || left === null
					? evaluate(node.right, scope)
					: left;
			}
			const left = evaluate(node.left, scope);
			const right = evaluate(node.right, scope);
			switch (node.op) {
				case "==":
				case "===":
					return equal(left, right);
				case "!=":
				case "!==":
					return !equal(left, right);
				case "<":
					return (left as number) < (right as number);
				case "<=":
					return (left as number) <= (right as number);
				case ">":
					return (left as number) > (right as number);
				case ">=":
					return (left as number) >= (right as number);
				case "+":
					if (Array.isArray(left) && Array.isArray(right))
						return [...left, ...right];
					return typeof left === "number" && typeof right === "number"
						? left + right
						: text(left) + text(right);
				case "-":
					return Number(left) - Number(right);
				case "*":
					return Number(left) * Number(right);
				case "/":
					return Number(left) / Number(right);
				case "%":
					return Number(left) % Number(right);
			}
			throw new ExpressionError(`unknown operator ${node.op}`);
		}
	}
}

const WHOLE = /^\s*\{\{([\s\S]*?)\}\}\s*$/;
const ANY = /\{\{([\s\S]*?)\}\}/g;

/** The expressions in a string, as their source text. */
export function expressionsIn(value: string): string[] {
	return [...value.matchAll(ANY)].map((match) => match[1] as string);
}

/** Fill one string: a lone expression gives its value, text gives text. */
export function fillString(value: string, scope: ExpressionScope): unknown {
	const whole = WHOLE.exec(value);
	if (whole && expressionsIn(value).length === 1) {
		return evaluate(parseExpression(whole[1] as string), scope);
	}
	return value.replace(ANY, (_, source: string) =>
		text(evaluate(parseExpression(source), scope)),
	);
}

/** Fill every string inside a value: objects and lists are walked. */
export function fill(value: unknown, scope: ExpressionScope): unknown {
	if (typeof value === "string")
		return value.includes("{{") ? fillString(value, scope) : value;
	if (Array.isArray(value)) return value.map((entry) => fill(entry, scope));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, fill(entry, scope)]),
		);
	}
	return value;
}

/** A condition: the expression's value as true or false. */
export function test(source: string, scope: ExpressionScope): boolean {
	const value = source.includes("{{")
		? fillString(source, scope)
		: evaluate(parseExpression(source), scope);
	return truthy(value);
}

/** Every expression in a value that does not parse, with why. */
export function expressionErrors(value: unknown, where: string): string[] {
	const errors: string[] = [];
	const visit = (entry: unknown, path: string) => {
		if (typeof entry === "string") {
			for (const source of expressionsIn(entry)) {
				try {
					parseExpression(source);
				} catch (error) {
					errors.push(`${path}: {{${source}}}: ${(error as Error).message}`);
				}
			}
		} else if (Array.isArray(entry)) {
			entry.forEach((item, index) => {
				visit(item, `${path}[${index}]`);
			});
		} else if (entry && typeof entry === "object") {
			for (const [key, item] of Object.entries(entry))
				visit(item, `${path}.${key}`);
		}
	};
	visit(value, where);
	return errors;
}
