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
import type { AgentOverlay } from "../../../runtime/sandbox/overlay-fs";
import { type Expr, parseAwk, type Rule, type Stmt } from "./awk-parser";
import { splitBom } from "./bom";
import { compilePosixRegex } from "./posix-regex";
import { creditShown, type ReadReceipts, readFileStamp } from "./read-receipts";
import { wholeFileRefusal } from "./whole-file";

/**
 * Input that looks like a number: a field, a `split` part, a `-v` value.
 *
 * awk's strnum. It tests and compares as a number and prints as it was
 * written. A string *constant* is never one: `x = "0"` is true and
 * `$1 == "1.0"` compares text. With the two the same, both were judged by
 * whether the text looked numeric (automaticum audit 2026-11-08, readers 21).
 */
class StrNum {
	constructor(readonly text: string) {}
}

/** An awk value: a number, a string, or input that looks like a number. */
type Value = string | number | StrNum;

/**
 * A variable or array element nothing has set: "" and 0 at once, so both
 * `x == 0` and `x == ""` hold, as in awk.
 */
const UNSET = new StrNum("");

/** Input text as awk types it: a strnum when it looks numeric. */
function fromInput(text: string): Value {
	return looksNumeric(text) ? new StrNum(text) : text;
}

class NextSignal extends Error {}
class ExitSignal extends Error {
	constructor(readonly code: number) {
		super("exit");
	}
}
class BreakSignal extends Error {}
class ContinueSignal extends Error {}

/**
 * Whether input text is a strnum: a decimal number, blanks either side.
 *
 * Not `Number()`, which also takes "0x1A", "0b1", "Infinity" and "" -- none of
 * which awk reads as a number.
 */
function looksNumeric(text: string): boolean {
	return /^[ \t\n]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[ \t\n]*$/.test(text);
}

function toNumber(value: Value): number {
	if (typeof value === "number") {
		return value;
	}
	if (value instanceof StrNum) {
		return toNumber(value.text);
	}
	// awk takes the longest numeric prefix: "12abc" is 12, "abc" is 0.
	const match = /^[ \t]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(value);
	return match ? Number(match[0]) : 0;
}

function toStringValue(value: Value, convfmt = "%.6g"): string {
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof StrNum) {
		return value.text;
	}
	if (!Number.isFinite(value)) {
		return nonFinite(value);
	}
	if (Number.isInteger(value)) {
		return String(value);
	}
	return formatOne(convfmt, value);
}

/** inf, -inf and nan, as awk prints them (JavaScript says "Infinity"). */
function nonFinite(value: number): string {
	return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
}

function truthy(value: Value): boolean {
	if (typeof value === "number") {
		return value !== 0;
	}
	// Input that looks numeric is judged by its value, so `$1` of "0" is
	// false; a string constant by whether it is empty, so `"0"` is true.
	if (value instanceof StrNum) {
		return toNumber(value) !== 0;
	}
	return value !== "";
}

/** C's %e: at least two exponent digits ("1.5e+0" is JavaScript's). */
function cExponential(value: number, precision: number): string {
	const [mantissa, exponent = "+0"] = value.toExponential(precision).split("e");
	const sign = exponent.startsWith("-") ? "-" : "+";
	const digits = exponent.replace(/^[+-]/, "").padStart(2, "0");
	return `${mantissa}e${sign}${digits}`;
}

/**
 * C's %g: %e when the exponent is below -4 or at least the precision, %f
 * otherwise, trailing zeros removed unless `#`. It was toPrecision read back
 * as a number, so 1234567 printed as 1234570 -- digits lost, silently.
 */
function cGeneral(
	value: number,
	precision: number,
	alternate: boolean,
): string {
	const digits = precision === 0 ? 1 : precision;
	if (value === 0) {
		return alternate ? (0).toFixed(digits - 1) : "0";
	}
	const exponent = Number(value.toExponential(digits - 1).split("e")[1]);
	let text =
		exponent < -4 || exponent >= digits
			? cExponential(value, digits - 1)
			: value.toFixed(Math.max(0, digits - 1 - exponent));
	if (!alternate) {
		const [mantissa = "", power] = text.split("e");
		const trimmed = mantissa.includes(".")
			? mantissa.replace(/\.?0+$/, "")
			: mantissa;
		text = power === undefined ? trimmed : `${trimmed}e${power}`;
	}
	return text;
}

/** An integer conversion's operand as C's unsigned 64-bit reads a negative. */
function unsigned(value: number): bigint {
	return BigInt.asUintN(64, BigInt(Math.trunc(value)));
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
	const number = toNumber(value);

	if ("dioxXueEfgG".includes(kind as string) && !Number.isFinite(number)) {
		text = nonFinite(number);
		if (kind === "E" || kind === "G" || kind === "X") text = text.toUpperCase();
	} else
		switch (kind) {
			case "d":
			case "i":
				text = String(Math.trunc(number));
				break;
			// Unsigned, as C prints them: %x of -1 is ffffffffffffffff, not -1.
			case "o":
				text = unsigned(number).toString(8);
				if (flags.includes("#") && text !== "0") text = `0${text}`;
				break;
			case "x":
			case "X":
				text = unsigned(number).toString(16);
				if (flags.includes("#") && text !== "0") text = `0x${text}`;
				if (kind === "X") text = text.toUpperCase();
				break;
			case "u":
				text = unsigned(number).toString(10);
				break;
			case "e":
			case "E": {
				text = cExponential(number, precision ?? 6);
				if (kind === "E") {
					text = text.toUpperCase();
				}
				break;
			}
			case "f":
				text = number.toFixed(precision ?? 6);
				break;
			case "g":
			case "G": {
				text = cGeneral(number, precision ?? 6, flags.includes("#"));
				if (kind === "G") {
					text = text.toUpperCase();
				}
				break;
			}
			case "c": {
				// A number, strnum input included, is a character code.
				text =
					typeof value === "number" || value instanceof StrNum
						? String.fromCodePoint(Math.max(0, Math.trunc(number)))
						: toStringValue(value).charAt(0);
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

	if ("difeEgG".includes(kind as string) && !text.startsWith("-")) {
		if (flags.includes("+")) {
			text = `+${text}`;
		} else if (flags.includes(" ")) {
			text = ` ${text}`;
		}
	}
	if (width !== undefined && text.length < width) {
		if (flags.includes("-")) {
			text = text.padEnd(width, " ");
		} else if (
			flags.includes("0") &&
			"dioxXufeEgG".includes(kind as string) &&
			Number.isFinite(number)
		) {
			const sign = /^[-+ ]/.test(text) ? text[0] : "";
			const body = sign ? text.slice(1) : text;
			text = sign + body.padStart(width - sign.length, "0");
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

/**
 * The input as records, by RS (read after BEGIN, which is where it is set).
 *
 * RS was read and ignored: `RS=""` (paragraph mode) counted lines, not
 * paragraphs (automaticum audit 2026-11-08, readers 21).
 */
function splitRecords(input: string, separator: string): string[] {
	if (separator === "\n") {
		// Split on "\r\n" before "\n", as the reader and the editor do: a
		// CRLF file's records otherwise kept their trailing "\r", so a
		// "$"-anchored rule never matched and "$NF" carried the "\r"
		// (csf-19). A bare "\n" is still split on for the mixed-EOL files
		// older releases of these tools produced.
		const lines = input.split(/\r\n|\n/);
		if (input.endsWith("\n")) {
			lines.pop();
		}
		return lines;
	}
	if (separator === "") {
		// Paragraphs: one or more blank lines between records, leading and
		// trailing newlines ignored.
		const text = input.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
		return text === "" ? [] : text.split(/\n\n+/);
	}
	const parts =
		separator.length === 1
			? input.split(separator)
			: input.split(
					compilePosixRegex(separator, { extended: true, global: true }),
				);
	if (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}
	return parts;
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
		state.globals.set(name, fromInput(value));
	}

	const getVar = (name: string): Value => state.globals.get(name) ?? UNSET;
	const setVar = (name: string, value: Value): void => {
		state.globals.set(name, value);
	};

	const setRecord = (line: string): void => {
		state.record = line;
		const separator = toStringValue(getVar("FS"));
		// In paragraph mode a newline separates fields whatever FS is.
		state.fields =
			toStringValue(getVar("RS")) === "" && separator !== " "
				? line.split("\n").flatMap((part) => splitFields(part, separator))
				: splitFields(line, separator);
		setVar("NF", state.fields.length);
	};

	const rebuildRecord = (): void => {
		state.record = state.fields.join(toStringValue(getVar("OFS")));
	};

	const getField = (index: number): Value => {
		if (index === 0) {
			return fromInput(state.record);
		}
		const value = state.fields[index - 1];
		if (value === undefined) {
			return "";
		}
		return fromInput(value);
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
		// Numbers and strnum input compare as numbers; a string constant on
		// either side makes it a comparison of text.
		const leftNumeric = typeof left === "number" || left instanceof StrNum;
		const rightNumeric = typeof right === "number" || right instanceof StrNum;
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
					array.set(String(at + 1), fromInput(part));
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
					return UNSET;
				}
				return getVar(expr.name);
			}
			case "field":
				return getField(Math.trunc(toNumber(evaluate(expr.index))));
			case "index": {
				// Referring to an element creates it, as in awk: `k in a` is true
				// afterwards and `length(a)` counts it.
				const array = arrayFor(expr.name);
				const key = keyOf(expr.keys);
				const held = array.get(key);
				if (held !== undefined) return held;
				array.set(key, UNSET);
				return UNSET;
			}
			case "in":
				return arrayFor(expr.array).has(
					expr.key.type === "exprList"
						? keyOf(expr.key.items)
						: toStringValue(evaluate(expr.key)),
				)
					? 1
					: 0;
			case "exprList":
				throw new Error(
					"A parenthesised list `(a, b)` means something only after `print` or before `in`.",
				);
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
					// Subscripts are strings, as in awk.
					setVar(statement.name, key);
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
			const lines = splitRecords(input, toStringValue(getVar("RS")));
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
	/** A delegated agent's overlay; awk reads the agent's version of a file. */
	overlay?: AgentOverlay;
}

export interface AwkInput {
	program: string;
	files?: string[];
	field_separator?: string;
	variables?: Record<string, string>;
}

export function createAwkExecutor(options: AwkExecutorOptions = {}) {
	// `cwd` is taken per call, the way `EditorExecutor` takes it: the tool
	// layer knows the workspace root and the executor is built before it is
	// known. The creation-time one is the fallback, not the authority.
	return async (input: AwkInput, callCwd?: string): Promise<string> => {
		const cwd = callCwd || options.cwd || process.cwd();
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
			const resolvedInput = isAbsolute(file) ? file : resolve(cwd, file);
			const filePath = options.overlay
				? await options.overlay.resolveRead(resolvedInput)
				: resolvedInput;
			// The whole file is read into one string: not one too large to hold.
			const refusal = await wholeFileRefusal(filePath, "awk");
			if (refusal) {
				sections.push(`${file}: ${refusal.message}`);
				continue;
			}
			let content: string;
			try {
				content = splitBom(await fs.readFile(filePath, "utf8")).body;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				sections.push(`${file}: could not be read: ${reason}`);
				continue;
			}
			// Stamped, so a later edit can tell a file that moved under the
			// session from one it has simply never seen.
			options.receipts?.noteStamp(filePath, await readFileStamp(filePath));
			// Each file is a fresh run so NR and FNR agree, which is what a model
			// expects when it passes one file at a time.
			const result = runAwkProgram(rules, content, {
				...(input.field_separator
					? { fieldSeparator: input.field_separator }
					: {}),
				...(input.variables ? { variables: input.variables } : {}),
				fileName: file,
			});
			// Credited as read: the input lines that came out verbatim. The
			// whole file was credited, so `print $1` -- which shows none of a
			// line -- let an edit by line number land on lines never seen.
			const printed = new Set(result.output.split(/\r?\n/));
			const inputLines = content.split(/\r\n|\n/);
			if (content.endsWith("\n")) inputLines.pop();
			creditShown(
				options.receipts,
				filePath,
				inputLines.flatMap((line, index) =>
					printed.has(line) ? [index + 1] : [],
				),
			);
			sections.push(
				files.length === 1
					? result.output
					: `==> ${file} <==\n${result.output}`,
			);
		}
		return sections.join("");
	};
}
