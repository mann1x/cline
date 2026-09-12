/**
 * POSIX `awk`, in process.
 *
 * The third of grep/sed/awk, and the one with the most language in it. See
 * `sed.ts` for why these exist at all and why they are not shelled out.
 *
 * awk is read-only here. It has no in-place mode, `getline` is refused and
 * output redirection (`print > "file"`) is refused, so there is no path by
 * which a program can modify a file — which is why it needs no write guard,
 * only a record that it read what it read. A model that wants to change a file
 * uses `sed` or `editor`, both of which do answer to the read-before-change
 * rule.
 *
 * Values follow awk's own loose typing: a field that looks like a number
 * compares as one, everything else compares as a string. Getting that wrong
 * makes `$3 > 10` sort lexically and quietly return the wrong rows, which is
 * exactly the kind of silent wrongness these tools are meant to avoid.
 */
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type Expr, parseAwk, type Rule, type Stmt } from "./awk-parser";
import { compilePosixRegex } from "./posix-regex";
import type { ReadReceipts } from "./read-receipts";

/** An awk value: a number, a string, or a string that looks like a number. */
type Value = string | number;

class NextSignal extends Error {}
class ExitSignal extends Error {
	constructor(readonly code: number) {
		super("exit");
	}
}
class BreakSignal extends Error {}
class ContinueSignal extends Error {}

/** Whether a string should be compared as a number, per awk's strnum rule. */
function looksNumeric(text: string): boolean {
	return text.trim() !== "" && Number.isFinite(Number(text.trim()));
}

function toNumber(value: Value): number {
	if (typeof value === "number") {
		return value;
	}
	// awk takes the longest numeric prefix: "12abc" is 12, "abc" is 0.
	const match = /^[ \t]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(value);
	return match ? Number(match[0]) : 0;
}

function toStringValue(value: Value, convfmt = "%.6g"): string {
	if (typeof value === "string") {
		return value;
	}
	if (Number.isInteger(value)) {
		return String(value);
	}
	return formatOne(convfmt, value);
}

function truthy(value: Value): boolean {
	if (typeof value === "number") {
		return value !== 0;
	}
	// An unset or empty field is false; a string that looks numeric is judged
	// by its value, so `$1` of "0" is false exactly as awk has it.
	if (value === "") {
		return false;
	}
	return looksNumeric(value) ? Number(value) !== 0 : true;
}

/** printf for a single conversion, enough for the specifiers awk programs use. */
function formatOne(spec: string, value: Value): string {
	const match = /^%([-+ 0#]*)(\d+)?(?:\.(\d+))?([diouxXeEfgGcs%])$/.exec(spec);
	if (!match) {
		return spec;
	}
	const [, flags, widthText, precisionText, kind] = match;
	const width = widthText ? Number(widthText) : undefined;
	const precision = precisionText ? Number(precisionText) : undefined;
	let text: string;

	switch (kind) {
		case "d":
		case "i":
			text = String(Math.trunc(toNumber(value)));
			break;
		case "o":
			text = Math.trunc(toNumber(value)).toString(8);
			break;
		case "x":
			text = Math.trunc(toNumber(value)).toString(16);
			break;
		case "X":
			text = Math.trunc(toNumber(value)).toString(16).toUpperCase();
			break;
		case "u":
			text = String(Math.abs(Math.trunc(toNumber(value))));
			break;
		case "e":
		case "E": {
			text = toNumber(value).toExponential(precision ?? 6);
			if (kind === "E") {
				text = text.toUpperCase();
			}
			break;
		}
		case "f":
			text = toNumber(value).toFixed(precision ?? 6);
			break;
		case "g":
		case "G": {
			const digits = precision ?? 6;
			const number = toNumber(value);
			text = number === 0 ? "0" : Number(number.toPrecision(digits)).toString();
			if (kind === "G") {
				text = text.toUpperCase();
			}
			break;
		}
		case "c": {
			const asString = toStringValue(value);
			text =
				typeof value === "number"
					? String.fromCharCode(value)
					: asString.charAt(0);
			break;
		}
		case "s":
			text = toStringValue(value);
			if (precision !== undefined) {
				text = text.slice(0, precision);
			}
			break;
		case "%":
			return "%";
		default:
			text = toStringValue(value);
	}

	if (
		flags.includes("+") &&
		"dioufeEgG".includes(kind) &&
		toNumber(value) >= 0
	) {
		text = `+${text}`;
	}
	if (width !== undefined && text.length < width) {
		if (flags.includes("-")) {
			text = text.padEnd(width, " ");
		} else if (flags.includes("0") && "dioxXufeEgG".includes(kind)) {
			const negative = text.startsWith("-");
			const body = negative ? text.slice(1) : text;
			text =
				(negative ? "-" : "") + body.padStart(width - (negative ? 1 : 0), "0");
		} else {
			text = text.padStart(width, " ");
		}
	}
	return text;
}

export function awkSprintf(format: string, args: Value[]): string {
	let out = "";
	let argIndex = 0;
	let index = 0;
	while (index < format.length) {
		const char = format[index];
		if (char !== "%") {
			out += char;
			index += 1;
			continue;
		}
		const spec = /^%[-+ 0#]*\d*(?:\.\d+)?[diouxXeEfgGcs%]/.exec(
			format.slice(index),
		);
		if (!spec) {
			out += char;
			index += 1;
			continue;
		}
		if (spec[0] === "%%") {
			out += "%";
			index += 2;
			continue;
		}
		out += formatOne(spec[0], args[argIndex] ?? "");
		argIndex += 1;
		index += spec[0].length;
	}
	return out;
}

export interface RunAwkOptions {
	/** `-F`: the field separator. */
	fieldSeparator?: string;
	/** `-v`: variables set before BEGIN. */
	variables?: Record<string, string>;
	/** Named so FILENAME can answer. */
	fileName?: string;
}

interface RunState {
	globals: Map<string, Value>;
	arrays: Map<string, Map<string, Value>>;
	fields: string[];
	record: string;
	out: string[];
	exitCode?: number;
}

/**
 * Split a record into fields the way awk does.
 *
 * The default — a single space — means "any run of whitespace, ignoring leading
 * and trailing", which is not the same as splitting on a space character and is
 * the difference between `$1` being the first word and being empty.
 */
function splitFields(record: string, separator: string): string[] {
	if (separator === " ") {
		const trimmed = record.trim();
		return trimmed === "" ? [] : trimmed.split(/[ \t\n]+/);
	}
	if (separator.length === 1 && separator !== "\\") {
		// A single character is literal, except that awk treats a single-char FS
		// as a literal even when it is a regex metacharacter.
		return record.split(separator);
	}
	return record.split(
		compilePosixRegex(separator, { extended: true, global: true }),
	);
}

export function runAwkProgram(
	rules: Rule[],
	input: string,
	options: RunAwkOptions = {},
): { output: string; exitCode: number } {
	const state: RunState = {
		globals: new Map<string, Value>([
			["FS", options.fieldSeparator ?? " "],
			["OFS", " "],
			["ORS", "\n"],
			["NR", 0],
			["NF", 0],
			["FNR", 0],
			["FILENAME", options.fileName ?? ""],
			["RS", "\n"],
			["SUBSEP", ""],
			["CONVFMT", "%.6g"],
			["OFMT", "%.6g"],
		]),
		arrays: new Map(),
		fields: [],
		record: "",
		out: [],
	};

	for (const [name, value] of Object.entries(options.variables ?? {})) {
		state.globals.set(name, looksNumeric(value) ? Number(value) : value);
	}

	const getVar = (name: string): Value => state.globals.get(name) ?? "";
	const setVar = (name: string, value: Value): void => {
		state.globals.set(name, value);
	};

	const setRecord = (line: string): void => {
		state.record = line;
		state.fields = splitFields(line, toStringValue(getVar("FS")));
		setVar("NF", state.fields.length);
	};

	const rebuildRecord = (): void => {
		state.record = state.fields.join(toStringValue(getVar("OFS")));
	};

	const getField = (index: number): Value => {
		if (index === 0) {
			return state.record;
		}
		const value = state.fields[index - 1];
		if (value === undefined) {
			return "";
		}
		return looksNumeric(value) ? value : value;
	};

	const setField = (index: number, value: Value): void => {
		if (index === 0) {
			setRecord(toStringValue(value));
			return;
		}
		while (state.fields.length < index) {
			state.fields.push("");
		}
		state.fields[index - 1] = toStringValue(value);
		setVar("NF", state.fields.length);
		rebuildRecord();
	};

	const arrayFor = (name: string): Map<string, Value> => {
		let array = state.arrays.get(name);
		if (!array) {
			array = new Map();
			state.arrays.set(name, array);
		}
		return array;
	};

	const keyOf = (keys: Expr[]): string =>
		keys
			.map((key) => toStringValue(evaluate(key)))
			.join(toStringValue(getVar("SUBSEP")));

	/** Compare per awk: numerically when both sides look numeric. */
	const compare = (left: Value, right: Value): number => {
		const leftNumeric =
			typeof left === "number" ||
			(typeof left === "string" && looksNumeric(left));
		const rightNumeric =
			typeof right === "number" ||
			(typeof right === "string" && looksNumeric(right));
		if (leftNumeric && rightNumeric) {
			const a = toNumber(left);
			const b = toNumber(right);
			return a < b ? -1 : a > b ? 1 : 0;
		}
		const a = toStringValue(left);
		const b = toStringValue(right);
		return a < b ? -1 : a > b ? 1 : 0;
	};

	function regexFrom(expr: Expr): RegExp {
		if (expr.type === "regex") {
			return compilePosixRegex(expr.value, { extended: true });
		}
		return compilePosixRegex(toStringValue(evaluate(expr)), { extended: true });
	}

	function callBuiltin(name: string, args: Expr[]): Value {
		switch (name) {
			case "length": {
				if (args.length === 0) {
					return state.record.length;
				}
				const target = args[0];
				if (target.type === "var" && state.arrays.has(target.name)) {
					return arrayFor(target.name).size;
				}
				return toStringValue(evaluate(target)).length;
			}
			case "substr": {
				const text = toStringValue(evaluate(args[0]));
				// awk is 1-based and clamps, which is why this is not a slice.
				const start = Math.trunc(toNumber(evaluate(args[1])));
				const from = Math.max(1, start);
				if (args.length < 3) {
					return text.slice(from - 1);
				}
				const count = Math.trunc(toNumber(evaluate(args[2])));
				const end = start + count;
				return end <= from ? "" : text.slice(from - 1, end - 1);
			}
			case "index": {
				const haystack = toStringValue(evaluate(args[0]));
				const needle = toStringValue(evaluate(args[1]));
				return haystack.indexOf(needle) + 1;
			}
			case "split": {
				const text = toStringValue(evaluate(args[0]));
				const target = args[1];
				if (target.type !== "var" && target.type !== "index") {
					throw new Error("`split` needs an array as its second argument.");
				}
				const arrayName = target.type === "var" ? target.name : target.name;
				const separator =
					args.length > 2
						? args[2].type === "regex"
							? args[2].value
							: toStringValue(evaluate(args[2]))
						: toStringValue(getVar("FS"));
				const parts = splitFields(text, separator);
				const array = arrayFor(arrayName);
				array.clear();
				parts.forEach((part, at) => {
					array.set(String(at + 1), part);
				});
				return parts.length;
			}
			case "sub":
			case "gsub": {
				const regex = compilePosixRegex(
					args[0].type === "regex"
						? args[0].value
						: toStringValue(evaluate(args[0])),
					{ extended: true, global: name === "gsub" },
				);
				const replacement = toStringValue(evaluate(args[1]));
				const target: Expr = args[2] ?? {
					type: "field",
					index: { type: "number", value: 0 },
				};
				const before = toStringValue(evaluate(target));
				let count = 0;
				const after = before.replace(regex, (matched: string) => {
					count += 1;
					// `&` is the matched text; `\&` is a literal ampersand.
					let out = "";
					let index = 0;
					while (index < replacement.length) {
						if (replacement[index] === "\\" && replacement[index + 1] === "&") {
							out += "&";
							index += 2;
							continue;
						}
						if (replacement[index] === "&") {
							out += matched;
							index += 1;
							continue;
						}
						out += replacement[index];
						index += 1;
					}
					return out;
				});
				if (count > 0) {
					assign(target, after);
				}
				return count;
			}
			case "match": {
				const text = toStringValue(evaluate(args[0]));
				const regex = regexFrom(args[1]);
				const found = regex.exec(text);
				setVar("RSTART", found ? found.index + 1 : 0);
				setVar("RLENGTH", found ? found[0].length : -1);
				return found ? found.index + 1 : 0;
			}
			case "sprintf":
				return awkSprintf(
					toStringValue(evaluate(args[0])),
					args.slice(1).map((arg) => evaluate(arg)),
				);
			case "toupper":
				return toStringValue(evaluate(args[0])).toUpperCase();
			case "tolower":
				return toStringValue(evaluate(args[0])).toLowerCase();
			case "int":
				return Math.trunc(toNumber(evaluate(args[0])));
			case "sqrt":
				return Math.sqrt(toNumber(evaluate(args[0])));
			case "exp":
				return Math.exp(toNumber(evaluate(args[0])));
			case "log":
				return Math.log(toNumber(evaluate(args[0])));
			case "sin":
				return Math.sin(toNumber(evaluate(args[0])));
			case "cos":
				return Math.cos(toNumber(evaluate(args[0])));
			case "atan2":
				return Math.atan2(
					toNumber(evaluate(args[0])),
					toNumber(evaluate(args[1])),
				);
			case "rand":
				return Math.random();
			case "srand":
				return 0;
			case "system":
				throw new Error(
					"`system()` is not supported: awk here cannot run commands. Use `run_commands` for that.",
				);
			default:
				throw new Error(`\`${name}\` is not a function this awk knows.`);
		}
	}

	function assign(target: Expr, value: Value): void {
		if (target.type === "var") {
			setVar(target.name, value);
			if (target.name === "FS" || target.name === "OFS") {
				// Reassigning OFS affects only rebuilt records, as in awk.
			}
			return;
		}
		if (target.type === "field") {
			setField(Math.trunc(toNumber(evaluate(target.index))), value);
			return;
		}
		if (target.type === "index") {
			arrayFor(target.name).set(keyOf(target.keys), value);
			return;
		}
		if (target.type === "grouping") {
			assign(target.inner, value);
			return;
		}
		throw new Error("That is not something a value can be assigned to.");
	}

	function evaluate(expr: Expr): Value {
		switch (expr.type) {
			case "number":
				return expr.value;
			case "string":
				return expr.value;
			case "regex":
				// A bare regex is a match against the whole record.
				return compilePosixRegex(expr.value, { extended: true }).test(
					state.record,
				)
					? 1
					: 0;
			case "grouping":
				return evaluate(expr.inner);
			case "var": {
				if (state.arrays.has(expr.name) && !state.globals.has(expr.name)) {
					return "";
				}
				return getVar(expr.name);
			}
			case "field":
				return getField(Math.trunc(toNumber(evaluate(expr.index))));
			case "index":
				return arrayFor(expr.name).get(keyOf(expr.keys)) ?? "";
			case "in":
				return arrayFor(expr.array).has(toStringValue(evaluate(expr.key)))
					? 1
					: 0;
			case "concat":
				return expr.parts
					.map((part) =>
						toStringValue(evaluate(part), toStringValue(getVar("CONVFMT"))),
					)
					.join("");
			case "call":
				return callBuiltin(expr.name, expr.args);
			case "match": {
				const text = toStringValue(evaluate(expr.left));
				const hit = regexFrom(expr.right).test(text);
				return (expr.negated ? !hit : hit) ? 1 : 0;
			}
			case "ternary":
				return truthy(evaluate(expr.test))
					? evaluate(expr.then)
					: evaluate(expr.other);
			case "unary": {
				if (expr.op === "!") {
					return truthy(evaluate(expr.operand)) ? 0 : 1;
				}
				const number = toNumber(evaluate(expr.operand));
				return expr.op === "-" ? -number : number;
			}
			case "prefix": {
				const next =
					toNumber(evaluate(expr.target)) + (expr.op === "++" ? 1 : -1);
				assign(expr.target, next);
				return next;
			}
			case "postfix": {
				const current = toNumber(evaluate(expr.target));
				assign(expr.target, current + (expr.op === "++" ? 1 : -1));
				return current;
			}
			case "assign": {
				if (expr.op === "=") {
					const value = evaluate(expr.value);
					assign(expr.target, value);
					return value;
				}
				const current = toNumber(evaluate(expr.target));
				const operand = toNumber(evaluate(expr.value));
				const result =
					expr.op === "+="
						? current + operand
						: expr.op === "-="
							? current - operand
							: expr.op === "*="
								? current * operand
								: expr.op === "/="
									? current / operand
									: expr.op === "%="
										? current % operand
										: current ** operand;
				assign(expr.target, result);
				return result;
			}
			case "binary": {
				if (expr.op === "&&") {
					return truthy(evaluate(expr.left)) && truthy(evaluate(expr.right))
						? 1
						: 0;
				}
				if (expr.op === "||") {
					return truthy(evaluate(expr.left)) || truthy(evaluate(expr.right))
						? 1
						: 0;
				}
				const left = evaluate(expr.left);
				const right = evaluate(expr.right);
				switch (expr.op) {
					case "<":
						return compare(left, right) < 0 ? 1 : 0;
					case "<=":
						return compare(left, right) <= 0 ? 1 : 0;
					case ">":
						return compare(left, right) > 0 ? 1 : 0;
					case ">=":
						return compare(left, right) >= 0 ? 1 : 0;
					case "==":
						return compare(left, right) === 0 ? 1 : 0;
					case "!=":
						return compare(left, right) !== 0 ? 1 : 0;
					case "+":
						return toNumber(left) + toNumber(right);
					case "-":
						return toNumber(left) - toNumber(right);
					case "*":
						return toNumber(left) * toNumber(right);
					case "/": {
						const divisor = toNumber(right);
						if (divisor === 0) {
							throw new Error("Division by zero.");
						}
						return toNumber(left) / divisor;
					}
					case "%": {
						const divisor = toNumber(right);
						if (divisor === 0) {
							throw new Error("Division by zero in `%`.");
						}
						return toNumber(left) % divisor;
					}
					case "^":
						return toNumber(left) ** toNumber(right);
					default:
						throw new Error(`Unknown operator \`${expr.op}\`.`);
				}
			}
		}
	}

	function emit(text: string): void {
		state.out.push(text);
	}

	function execute(statement: Stmt): void {
		switch (statement.type) {
			case "block":
				for (const inner of statement.body) {
					execute(inner);
				}
				return;
			case "print": {
				const parts =
					statement.args.length === 0
						? [state.record]
						: statement.args.map((arg) =>
								toStringValue(evaluate(arg), toStringValue(getVar("OFMT"))),
							);
				emit(
					parts.join(toStringValue(getVar("OFS"))) +
						toStringValue(getVar("ORS")),
				);
				return;
			}
			case "printf": {
				if (statement.args.length === 0) {
					throw new Error("`printf` needs a format string.");
				}
				emit(
					awkSprintf(
						toStringValue(evaluate(statement.args[0])),
						statement.args.slice(1).map((arg) => evaluate(arg)),
					),
				);
				return;
			}
			case "expr":
				evaluate(statement.expr);
				return;
			case "if":
				if (truthy(evaluate(statement.test))) {
					execute(statement.then);
				} else if (statement.other) {
					execute(statement.other);
				}
				return;
			case "while":
				while (truthy(evaluate(statement.test))) {
					try {
						execute(statement.body);
					} catch (error) {
						if (error instanceof BreakSignal) {
							break;
						}
						if (error instanceof ContinueSignal) {
							continue;
						}
						throw error;
					}
				}
				return;
			case "for": {
				if (statement.init) {
					execute(statement.init);
				}
				while (statement.test ? truthy(evaluate(statement.test)) : true) {
					try {
						execute(statement.body);
					} catch (error) {
						if (error instanceof BreakSignal) {
							break;
						}
						if (!(error instanceof ContinueSignal)) {
							throw error;
						}
					}
					if (statement.update) {
						execute(statement.update);
					}
				}
				return;
			}
			case "forIn": {
				for (const key of [...arrayFor(statement.array).keys()]) {
					setVar(statement.name, looksNumeric(key) ? key : key);
					try {
						execute(statement.body);
					} catch (error) {
						if (error instanceof BreakSignal) {
							break;
						}
						if (!(error instanceof ContinueSignal)) {
							throw error;
						}
					}
				}
				return;
			}
			case "delete": {
				const array = arrayFor(statement.name);
				if (statement.keys.length === 0) {
					array.clear();
				} else {
					array.delete(keyOf(statement.keys));
				}
				return;
			}
			case "next":
				throw new NextSignal();
			case "break":
				throw new BreakSignal();
			case "continue":
				throw new ContinueSignal();
			case "exit":
				throw new ExitSignal(
					statement.code ? Math.trunc(toNumber(evaluate(statement.code))) : 0,
				);
		}
	}

	const beginRules = rules.filter((rule) => rule.kind === "begin");
	const endRules = rules.filter((rule) => rule.kind === "end");
	const mainRules = rules.filter((rule) => rule.kind === "pattern");
	let exitCode = 0;

	try {
		for (const rule of beginRules) {
			if (rule.action) {
				execute(rule.action);
			}
		}

		// A program that is only BEGIN never reads input, which is how
		// `awk 'BEGIN{print 1+1}'` works with no file at all.
		if (mainRules.length > 0 || endRules.length > 0) {
			const hadTrailingNewline = input.endsWith("\n");
			const lines = input.split("\n");
			if (hadTrailingNewline) {
				lines.pop();
			}
			for (const line of lines) {
				setVar("NR", toNumber(getVar("NR")) + 1);
				setVar("FNR", toNumber(getVar("FNR")) + 1);
				setRecord(line);
				try {
					for (const rule of mainRules) {
						let selected: boolean;
						if (!rule.pattern) {
							selected = true;
						} else if (rule.patternEnd) {
							if (rule.active) {
								selected = true;
								if (truthy(evaluate(rule.patternEnd))) {
									rule.active = false;
								}
							} else if (truthy(evaluate(rule.pattern))) {
								selected = true;
								rule.active = !truthy(evaluate(rule.patternEnd));
							} else {
								selected = false;
							}
						} else {
							selected = truthy(evaluate(rule.pattern));
						}
						if (!selected) {
							continue;
						}
						if (rule.action) {
							execute(rule.action);
						} else {
							emit(state.record + toStringValue(getVar("ORS")));
						}
					}
				} catch (error) {
					if (error instanceof NextSignal) {
						continue;
					}
					throw error;
				}
			}
		}
	} catch (error) {
		if (error instanceof ExitSignal) {
			exitCode = error.code;
		} else {
			throw error;
		}
	}

	// END runs even after `exit`, which is a real awk behaviour a program can
	// depend on for its summary line.
	try {
		for (const rule of endRules) {
			if (rule.action) {
				execute(rule.action);
			}
		}
	} catch (error) {
		if (error instanceof ExitSignal) {
			exitCode = error.code;
		} else {
			throw error;
		}
	}

	return { output: state.out.join(""), exitCode };
}

export interface AwkExecutorOptions {
	cwd?: string;
	/**
	 * Recorded, not enforced.
	 *
	 * awk here cannot write a file — there is no in-place mode, `getline` and
	 * output redirection are both refused — so there is nothing for a write
	 * guard to guard. What it does do is note that the file was read, so a
	 * later `sed -i` or `editor` call on the same file is not refused for a
	 * file the model has in fact just been through.
	 */
	receipts?: ReadReceipts;
}

export interface AwkInput {
	program: string;
	files?: string[];
	field_separator?: string;
	variables?: Record<string, string>;
}

export function createAwkExecutor(options: AwkExecutorOptions = {}) {
	return async (input: AwkInput): Promise<string> => {
		const cwd = options.cwd ?? process.cwd();
		const rules = parseAwk(input.program);
		if (rules.length === 0) {
			throw new Error(
				"The program is empty. Write something like `{print $1}` or `NR>1 {sum+=$2} END {print sum}`.",
			);
		}

		const files = input.files ?? [];
		if (files.length === 0) {
			// BEGIN-only programs are legitimate with no input at all.
			const result = runAwkProgram(rules, "", {
				...(input.field_separator
					? { fieldSeparator: input.field_separator }
					: {}),
				...(input.variables ? { variables: input.variables } : {}),
			});
			return result.output;
		}

		const sections: string[] = [];
		for (const file of files) {
			const filePath = isAbsolute(file) ? file : resolve(cwd, file);
			let content: string;
			try {
				content = await fs.readFile(filePath, "utf8");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				sections.push(`${file}: could not be read: ${reason}`);
				continue;
			}
			options.receipts?.noteRead(filePath, 1, Number.POSITIVE_INFINITY);
			// Each file is a fresh run so NR and FNR agree, which is what a model
			// expects when it passes one file at a time.
			const result = runAwkProgram(rules, content, {
				...(input.field_separator
					? { fieldSeparator: input.field_separator }
					: {}),
				...(input.variables ? { variables: input.variables } : {}),
				fileName: file,
			});
			sections.push(
				files.length === 1
					? result.output
					: `==> ${file} <==\n${result.output}`,
			);
		}
		return sections.join("");
	};
}
