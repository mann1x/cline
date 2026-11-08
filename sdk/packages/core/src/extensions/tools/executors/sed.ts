/**
 * POSIX `sed`, in process.
 *
 * Offered because a coding model already knows it. Small models in particular
 * do badly with a bespoke editing tool they have to learn from a description,
 * and well with `s/foo/bar/g` — which they have seen a hundred thousand times.
 * The value is entirely in the dialect being the real one, so this implements
 * the script language rather than approximating it.
 *
 * It is in process rather than shelled out for two reasons. Windows has no
 * `sed`, and the two test hosts would otherwise disagree about what the same
 * tool call does. And an external `sed -i` writes a file behind the back of the
 * read guard, which is the one thing that must not happen: an in-place edit
 * here answers to exactly the same receipts as `editor`.
 *
 * What is supported: addresses (line number, `$`, `/regex/`, ranges, `!`), and
 * the commands `s`, `y`, `d`, `p`, `q`, `a`, `i`, `c` and `=`. Flow control
 * (`b`, `t`, `n`, `N`, hold space) is not, and is refused by name rather than
 * ignored — a script that silently does nothing is worse than one that says it
 * cannot run.
 */
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentOverlay } from "../../../runtime/sandbox/overlay-fs";
import { splitBom } from "./bom";
import { withFileLock } from "./file-locks";
import { detectLineEnding } from "./line-endings";
import { compilePosixRegex } from "./posix-regex";
import { creditShown, type ReadReceipts, readFileStamp } from "./read-receipts";
import { wholeFileRefusal } from "./whole-file";

/** Commands whose absence would otherwise be silent. */
const UNSUPPORTED_COMMANDS: Record<string, string> = {
	b: "branching",
	t: "conditional branching",
	T: "conditional branching",
	n: "next-line flow control",
	N: "next-line flow control",
	D: "pattern-space flow control",
	P: "pattern-space flow control",
	h: "the hold space",
	H: "the hold space",
	g: "the hold space",
	G: "the hold space",
	x: "the hold space",
	r: "reading another file",
	w: "writing another file",
	l: "unambiguous printing",
};

type Address =
	| { kind: "line"; line: number }
	| { kind: "last" }
	| { kind: "regex"; regex: RegExp }
	| { kind: "every" }
	/** `first~step`: every step-th line from first (GNU). */
	| { kind: "step"; first: number; step: number }
	/** `0` as a range start: the range is open before line 1 (GNU `0,/re/`). */
	| { kind: "zero" }
	/** `+N` as a range end: N lines after the line that opened it (GNU). */
	| { kind: "relative"; count: number }
	/** `~N` as a range end: up to the next line that is a multiple of N (GNU). */
	| { kind: "multiple"; of: number };

interface Command {
	start?: Address;
	end?: Address;
	negated: boolean;
	name: string;
	/** For `s`: the compiled match. For `y`: unused. */
	regex?: RegExp;
	replacement?: string;
	/** For `s`: replace every occurrence. */
	global?: boolean;
	/** For `s`: print the line when a substitution happened. */
	print?: boolean;
	/** For `s`: replace only the Nth occurrence. */
	occurrence?: number;
	/** For `y`: the from/to character maps. */
	from?: string;
	to?: string;
	/** For `a`, `i`, `c`: the text. */
	text?: string;
	/** Range state while executing. */
	active?: boolean;
	/** For a range whose end is a line count: the line it closes on. */
	closesAt?: number;
	/** Set by `selects`: this line is the last one of the command's range. */
	closing?: boolean;
}

/** Read a delimited section of an `s` or `y` command, honouring `\` escapes. */
function readDelimited(
	script: string,
	start: number,
	delimiter: string,
): { text: string; next: number } {
	let out = "";
	let index = start;
	while (index < script.length) {
		const char = script[index];
		if (char === "\\" && script[index + 1] !== undefined) {
			// A backslash-escaped delimiter is a literal one; every other escape
			// is handed on untouched for the regex layer to interpret.
			if (script[index + 1] === delimiter) {
				out += delimiter;
			} else {
				out += char + script[index + 1];
			}
			index += 2;
			continue;
		}
		if (char === delimiter) {
			return { text: out, next: index + 1 };
		}
		out += char;
		index += 1;
	}
	throw new Error(
		`Unterminated \`${delimiter}\` in the script: every s/// and y/// needs its closing delimiter.`,
	);
}

function parseAddress(
	script: string,
	start: number,
	extended: boolean,
): { address?: Address; next: number } {
	const index = start;
	const char = script[index];
	if (char === "$") {
		return { address: { kind: "last" }, next: index + 1 };
	}
	const digitsAt = (from: number): { value: string; next: number } => {
		let at = from;
		let value = "";
		while (at < script.length && /[0-9]/.test(script[at])) {
			value += script[at];
			at += 1;
		}
		return { value, next: at };
	};
	if ((char === "+" || char === "~") && /[0-9]/.test(script[index + 1] ?? "")) {
		const count = digitsAt(index + 1);
		return {
			address:
				char === "+"
					? { kind: "relative", count: Number(count.value) }
					: { kind: "multiple", of: Number(count.value) },
			next: count.next,
		};
	}
	if (char !== undefined && /[0-9]/.test(char)) {
		const digits = digitsAt(index);
		if (
			script[digits.next] === "~" &&
			/[0-9]/.test(script[digits.next + 1] ?? "")
		) {
			const step = digitsAt(digits.next + 1);
			return {
				address: {
					kind: "step",
					first: Number(digits.value),
					step: Number(step.value),
				},
				next: step.next,
			};
		}
		const line = Number(digits.value);
		return {
			address: line === 0 ? { kind: "zero" } : { kind: "line", line },
			next: digits.next,
		};
	}
	if (char === "/") {
		const body = readDelimited(script, index + 1, "/");
		let next = body.next;
		let ignoreCase = false;
		if (script[next] === "I") {
			ignoreCase = true;
			next += 1;
		}
		return {
			address: {
				kind: "regex",
				regex: compilePosixRegex(body.text, { extended, ignoreCase }),
			},
			next,
		};
	}
	return { next: index };
}

/**
 * Parse a sed script into commands.
 *
 * Commands are separated by `;` or a newline, except inside a delimited
 * section — `s/a;b/c/` is one command, and splitting on `;` first would break
 * it. So the script is walked rather than split.
 */
export function parseSedScript(script: string, extended = false): Command[] {
	const commands: Command[] = [];
	let index = 0;

	while (index < script.length) {
		// Skip separators and whitespace between commands.
		while (index < script.length && /[;\s]/.test(script[index])) {
			index += 1;
		}
		if (index >= script.length) {
			break;
		}
		if (script[index] === "#") {
			while (index < script.length && script[index] !== "\n") {
				index += 1;
			}
			continue;
		}

		const first = parseAddress(script, index, extended);
		index = first.next;
		let end: Address | undefined;
		if (script[index] === ",") {
			const second = parseAddress(script, index + 1, extended);
			if (!second.address) {
				throw new Error(
					"A `,` needs a second address after it: a line number, `$`, `/regex/`, `+N` or `~N`.",
				);
			}
			end = second.address;
			index = second.next;
		}
		// The same errors GNU sed gives, rather than a guess at what was meant.
		if (first.address?.kind === "zero" && end?.kind !== "regex") {
			throw new Error(
				"Line 0 is only valid as `0,/regex/`, where the regex may match on line 1. Lines are numbered from 1.",
			);
		}
		if (
			first.address?.kind === "relative" ||
			first.address?.kind === "multiple"
		) {
			throw new Error(
				"`+N` and `~N` are only valid after a comma, as the end of a range (`/re/,+2`).",
			);
		}
		if (end?.kind === "zero" || end?.kind === "step") {
			throw new Error(
				"That is not a valid end for a range. Use a line number, `$`, `/regex/`, `+N` or `~N`.",
			);
		}
		while (index < script.length && /\s/.test(script[index])) {
			index += 1;
		}
		let negated = false;
		while (script[index] === "!") {
			negated = !negated;
			index += 1;
		}
		while (index < script.length && /\s/.test(script[index])) {
			index += 1;
		}

		const name = script[index];
		if (name === undefined) {
			break;
		}
		index += 1;

		const base = {
			...(first.address ? { start: first.address } : {}),
			...(end ? { end } : {}),
			negated,
			name,
		};

		if (name === "s" || name === "y") {
			const delimiter = script[index];
			if (delimiter === undefined) {
				throw new Error(`\`${name}\` needs a delimiter, as in s/foo/bar/.`);
			}
			index += 1;
			const pattern = readDelimited(script, index, delimiter);
			const replacement = readDelimited(script, pattern.next, delimiter);
			index = replacement.next;

			if (name === "y") {
				if (pattern.text.length !== replacement.text.length) {
					throw new Error(
						`\`y\` needs both sides the same length: \`${pattern.text}\` is ${pattern.text.length} characters and \`${replacement.text}\` is ${replacement.text.length}.`,
					);
				}
				commands.push({
					...base,
					from: pattern.text,
					to: replacement.text,
				});
				continue;
			}

			let global = false;
			let print = false;
			let ignoreCase = false;
			let occurrence: number | undefined;
			let digits = "";
			while (index < script.length && /[gpiIl0-9]/.test(script[index])) {
				const flag = script[index];
				if (flag === "g") {
					global = true;
				} else if (flag === "p") {
					print = true;
				} else if (flag === "i" || flag === "I") {
					ignoreCase = true;
				} else if (/[0-9]/.test(flag)) {
					digits += flag;
				}
				index += 1;
			}
			if (digits !== "") {
				occurrence = Number(digits);
			}
			commands.push({
				...base,
				regex: compilePosixRegex(pattern.text, {
					extended,
					ignoreCase,
					global: global || occurrence !== undefined,
				}),
				replacement: replacement.text,
				global,
				print,
				...(occurrence === undefined ? {} : { occurrence }),
			});
			continue;
		}

		if (name === "a" || name === "i" || name === "c") {
			// GNU allows `a text`; POSIX wants `a\` then a line. Both are accepted
			// because a model writes whichever it saw most. Whitespace before the
			// text is dropped only in the `a text` form: after `a\` it is the
			// text's own indentation, and GNU keeps it -- skipping it lost the
			// indentation of every line a model inserted into Python or YAML.
			while (index < script.length && /[ \t]/.test(script[index])) {
				index += 1;
			}
			if (script[index] === "\\") {
				index += 1;
				if (script[index] === "\n") {
					index += 1;
				}
			}
			let text = "";
			while (index < script.length && script[index] !== "\n") {
				if (script[index] === "\\" && index + 1 < script.length) {
					const next = script[index + 1];
					text += next === "t" ? "\t" : next;
					index += 2;
					continue;
				}
				text += script[index];
				index += 1;
			}
			commands.push({ ...base, text });
			continue;
		}

		if (name === "d" || name === "p" || name === "q" || name === "=") {
			commands.push(base);
			continue;
		}

		if (name === "{" || name === "}") {
			throw new Error(
				"Command grouping with `{ }` is not supported. Write the commands separately, each with its own address.",
			);
		}

		const why = UNSUPPORTED_COMMANDS[name];
		throw new Error(
			why
				? `\`${name}\` (${why}) is not supported. Supported commands are s, y, d, p, q, a, i, c and =.`
				: `\`${name}\` is not a sed command this tool knows. Supported commands are s, y, d, p, q, a, i, c and =.`,
		);
	}

	return commands;
}

/**
 * Expand `\1`..`\9` and `&` in a replacement.
 *
 * JavaScript spells these `$1` and `$&`, and a `$` in the user's replacement
 * must not be read as one of them — `s/a/$5/` replaces with a literal `$5`.
 */
function applyReplacement(
	replacement: string,
	match: RegExpMatchArray,
): string {
	let out = "";
	let index = 0;
	// GNU case conversion: `\U`/`\L` until `\E`, `\u`/`\l` for the next
	// character only. They were written out as the literal letters, in place.
	let mode: "U" | "L" | undefined;
	let once: "u" | "l" | undefined;
	const emit = (text: string) => {
		for (const char of text) {
			let next =
				mode === "U"
					? char.toUpperCase()
					: mode === "L"
						? char.toLowerCase()
						: char;
			if (once) {
				next = once === "u" ? next.toUpperCase() : next.toLowerCase();
				once = undefined;
			}
			out += next;
		}
	};
	while (index < replacement.length) {
		const char = replacement[index];
		if (char === "\\") {
			const next = replacement[index + 1];
			if (next !== undefined && /[0-9]/.test(next)) {
				emit(match[Number(next)] ?? "");
				index += 2;
				continue;
			}
			if (next === "U" || next === "L") {
				mode = next;
				once = undefined;
				index += 2;
				continue;
			}
			if (next === "E") {
				mode = undefined;
				once = undefined;
				index += 2;
				continue;
			}
			if (next === "u" || next === "l") {
				once = next;
				index += 2;
				continue;
			}
			if (next === "n") {
				emit("\n");
				index += 2;
				continue;
			}
			if (next === "t") {
				emit("\t");
				index += 2;
				continue;
			}
			if (next !== undefined) {
				emit(next);
				index += 2;
				continue;
			}
		}
		if (char === "&") {
			emit(match[0]);
			index += 1;
			continue;
		}
		emit(char);
		index += 1;
	}
	return out;
}

function matchesAddress(
	address: Address,
	lineNumber: number,
	line: string,
	lastLine: number,
): boolean {
	switch (address.kind) {
		case "line":
			return lineNumber === address.line;
		case "last":
			return lineNumber === lastLine;
		case "regex":
			return address.regex.test(line);
		case "every":
			return true;
		case "step":
			return address.step <= 0
				? lineNumber === address.first
				: lineNumber >= address.first &&
						(lineNumber - address.first) % address.step === 0;
		// Only meaningful as one end of a range, which `selects` handles.
		case "zero":
		case "relative":
		case "multiple":
			return false;
	}
}

/**
 * Whether a command applies to this line, with GNU sed's range rules.
 *
 * Sets `command.closing` when this line is the last of its range, which `c`
 * needs to print its text once per range rather than once per line.
 *
 * The rules, each of which the old loop got wrong somewhere:
 * - An end that is a line number at or before the opening line selects the
 *   opening line alone. Treated as "never reached", `7,3d` and `/x/,3d` ran to
 *   the end of the file -- in place, that deleted the rest of it.
 * - A regex end is looked for from the line after the opening one.
 * - `0,/re/` is open before line 1, so `re` may close it on line 1.
 * - `+N` closes N lines after the opening one; `~N` on the next multiple of N.
 */
function selects(
	command: Command,
	lineNumber: number,
	line: string,
	lastLine: number,
): boolean {
	command.closing = false;
	let hit: boolean;
	const end = command.end;
	if (!command.start) {
		hit = true;
	} else if (!end) {
		hit = matchesAddress(command.start, lineNumber, line, lastLine);
	} else if (command.active) {
		hit = true;
		const closes =
			command.closesAt !== undefined
				? lineNumber >= command.closesAt
				: end.kind === "line"
					? lineNumber >= end.line
					: matchesAddress(end, lineNumber, line, lastLine);
		if (closes) {
			command.active = false;
			command.closing = true;
		}
	} else if (
		command.start.kind === "zero"
			? lineNumber === 1
			: matchesAddress(command.start, lineNumber, line, lastLine)
	) {
		hit = true;
		command.closesAt = undefined;
		let closesHere: boolean;
		switch (end.kind) {
			case "line":
				closesHere = end.line <= lineNumber;
				break;
			case "last":
				closesHere = lineNumber === lastLine;
				break;
			case "relative":
				command.closesAt = lineNumber + end.count;
				closesHere = end.count <= 0;
				break;
			case "multiple":
				// The next multiple after this line: GNU runs `4,~4` to line 8.
				closesHere = end.of <= 0;
				if (!closesHere) {
					command.closesAt = lineNumber + (end.of - (lineNumber % end.of));
				}
				break;
			default:
				// A regex end is tried on the opening line only for `0,/re/`.
				closesHere =
					command.start.kind === "zero" &&
					matchesAddress(end, lineNumber, line, lastLine);
		}
		command.active = !closesHere;
		command.closing = closesHere;
	} else {
		hit = false;
	}
	return command.negated ? !hit : hit;
}

export interface RunSedResult {
	output: string;
	/** Whether any command changed the text. */
	changed: boolean;
	/**
	 * Whether any command selected a line and acted on it: an `s` that matched
	 * but wrote the same text back matched something, and "matched nothing"
	 * was a false account of it.
	 */
	matched: boolean;
	/**
	 * Input lines whose text reached the output, in order and once each: what
	 * a read-only run showed, and so what it may credit as read.
	 */
	shown: number[];
	/**
	 * Input lines the script changed: rewritten, deleted, replaced, or with
	 * text put before or after them. What an in-place run must have seen.
	 */
	touched: number[];
}

/** Run a parsed script over text. Pure: no filesystem, so it is easy to test. */
export function runSedScript(
	input: string,
	commands: Command[],
	quiet = false,
): RunSedResult {
	// A trailing newline is a line terminator, not an empty last line.
	const hadTrailingNewline = input.endsWith("\n");
	// A CRLF file's lines end "\r\n", and every reader strips the "\r" — so
	// the model writes its script against text without it. Splitting on
	// "\n" alone left the "\r" on every line, and a "$" anchor after a
	// "\r" never matches: the tool kept answering "no change — the script
	// matched nothing" for text the model could see (csf-19). Split on the
	// pair first, then on a bare "\n" for the mixed-EOL files older
	// releases of these tools produced, and join with the file's own EOL so
	// an edit never rewrites a CRLF file to LF wholesale.
	const eol = detectLineEnding(input);
	const lines = input.split(/\r\n|\n/);
	if (hadTrailingNewline) {
		lines.pop();
	}
	const lastLine = lines.length;
	const out: string[] = [];
	let changed = false;
	let matched = false;
	const shown = new Set<number>();
	const touched = new Set<number>();

	for (const command of commands) {
		command.active = false;
		command.closesAt = undefined;
		command.closing = false;
	}

	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		let line: string | undefined = lines[index];
		const before: string[] = [];
		const after: string[] = [];
		let deleted = false;
		let quit = false;

		for (const command of commands) {
			if (line === undefined) {
				break;
			}
			if (!selects(command, lineNumber, line, lastLine)) {
				continue;
			}
			if (command.name !== "s") {
				matched = true;
			}
			switch (command.name) {
				case "s": {
					const regex = command.regex as RegExp;
					if (
						new RegExp(regex.source, regex.flags.replace("g", "")).test(line)
					) {
						matched = true;
					}
					let replaced: string;
					if (command.occurrence !== undefined) {
						let seen = 0;
						replaced = line.replace(regex, (...args) => {
							seen += 1;
							const groups = args.slice(0, -2) as unknown as RegExpMatchArray;
							return seen === command.occurrence
								? applyReplacement(command.replacement ?? "", groups)
								: groups[0];
						});
					} else if (command.global) {
						replaced = line.replace(regex, (...args) =>
							applyReplacement(
								command.replacement ?? "",
								args.slice(0, -2) as unknown as RegExpMatchArray,
							),
						);
					} else {
						const single = new RegExp(
							regex.source,
							regex.flags.replace("g", ""),
						);
						replaced = line.replace(single, (...args) =>
							applyReplacement(
								command.replacement ?? "",
								args.slice(0, -2) as unknown as RegExpMatchArray,
							),
						);
					}
					if (replaced !== line) {
						changed = true;
						touched.add(lineNumber);
						line = replaced;
						if (command.print) {
							out.push(line);
							shown.add(lineNumber);
						}
					}
					break;
				}
				case "y": {
					const from = command.from ?? "";
					const to = command.to ?? "";
					const mapped = [...line]
						.map((char) => {
							const at = from.indexOf(char);
							return at === -1 ? char : to[at];
						})
						.join("");
					if (mapped !== line) {
						changed = true;
						touched.add(lineNumber);
						line = mapped;
					}
					break;
				}
				case "d":
					deleted = true;
					changed = true;
					touched.add(lineNumber);
					line = undefined;
					break;
				case "p":
					out.push(line);
					shown.add(lineNumber);
					break;
				case "=":
					out.push(String(lineNumber));
					break;
				case "a":
					after.push(command.text ?? "");
					changed = true;
					touched.add(lineNumber);
					break;
				case "i":
					before.push(command.text ?? "");
					changed = true;
					touched.add(lineNumber);
					break;
				case "c":
					// Over a range, GNU replaces the whole range with one copy of
					// the text, printed on its last line; it was printed per line.
					deleted = true;
					changed = true;
					touched.add(lineNumber);
					if (!command.end || command.negated || command.closing) {
						before.push(command.text ?? "");
					}
					line = undefined;
					break;
				case "q":
					quit = true;
					break;
			}
			if (deleted || quit) {
				break;
			}
		}

		out.push(...before);
		if (!quiet && !deleted && line !== undefined) {
			out.push(line);
			shown.add(lineNumber);
		}
		out.push(...after);
		if (quit) {
			break;
		}
	}

	const text = out.join(eol);
	return {
		output: text === "" ? "" : hadTrailingNewline ? `${text}${eol}` : text,
		changed,
		matched,
		shown: [...shown].sort((a, b) => a - b),
		touched: [...touched].sort((a, b) => a - b),
	};
}

export interface SedExecutorOptions {
	cwd?: string;
	/**
	 * The same registry `editor` and `read_files` use.
	 *
	 * An in-place `sed` is an edit, and must answer to the read-before-change
	 * rule exactly as `editor` does. Without this the tool would be a way to
	 * modify a file the model has never looked at, which is the failure the
	 * receipts exist to stop.
	 */
	receipts?: ReadReceipts;
	/** A delegated agent's overlay; an in-place sed writes into it, not the workspace. */
	overlay?: AgentOverlay;
}

export interface SedInput {
	script: string;
	files: string[];
	in_place?: boolean;
	quiet?: boolean;
	extended?: boolean;
}

function countLines(text: string): number {
	if (text === "") {
		return 0;
	}
	return text.endsWith("\n")
		? text.split("\n").length - 1
		: text.split("\n").length;
}

/**
 * What happened to one file.
 *
 * One `sed` call names a list of files, and they do not share a fate: an
 * in-place run can write the first and be refused on the second for never
 * having been read. Joining that into one string made a refusal indexable only
 * by reading the prose — and the tool layer above reported the whole call as a
 * success, which is the one thing a blocked write must never look like.
 */
export interface SedFileOutcome {
	/** The file as the caller named it, not as it was resolved. */
	file: string;
	/** The script's output for this file, or a sentence describing the write. */
	output: string;
	/** False only when the file was NOT touched: a guard, or an unreadable file. */
	ok: boolean;
	/** Why, when `ok` is false. */
	error?: string;
}

export function createSedExecutor(options: SedExecutorOptions = {}) {
	const { receipts, overlay } = options;

	// `cwd` is taken per call, the way `EditorExecutor` takes it: the tool
	// layer knows the workspace root and the executor is built before it is
	// known. The creation-time one is the fallback, not the authority.
	return async (
		input: SedInput,
		callCwd?: string,
	): Promise<SedFileOutcome[]> => {
		const cwd = callCwd || options.cwd || process.cwd();
		if (!input.files || input.files.length === 0) {
			throw new Error("`files` is required: name at least one file to run on.");
		}
		const commands = parseSedScript(input.script, input.extended === true);
		if (commands.length === 0) {
			throw new Error(
				"The script is empty. Write something like `s/foo/bar/g` or `/pattern/d`.",
			);
		}

		const outcomes: SedFileOutcome[] = [];
		for (const file of input.files) {
			const resolvedInput = isAbsolute(file) ? file : resolve(cwd, file);
			// Looked at where a read would open it, before the write path copies
			// it up: the whole file is read into one string below.
			const refusal = await wholeFileRefusal(
				overlay ? await overlay.resolveRead(resolvedInput) : resolvedInput,
				"sed",
			);
			if (refusal) {
				outcomes.push({ file, output: "", ok: false, error: refusal.message });
				continue;
			}
			const filePath = overlay
				? await overlay.resolveWrite(resolvedInput)
				: resolvedInput;
			// One file at a time, and the whole read-modify-write inside the
			// lock: `sed -i` reads, transforms and writes back exactly as
			// `editor` does, so it loses an update in exactly the same way.
			await withFileLock(filePath, async () => {
				let original: string;
				// Kept off line 1's text, as every reader shows it, and put back.
				let bom = "";
				try {
					({ bom, body: original } = splitBom(
						await fs.readFile(filePath, "utf8"),
					));
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					outcomes.push({
						file,
						output: "",
						ok: false,
						error: `could not be read: ${reason}`,
					});
					return;
				}

				// Run first: it is pure, and what it changes is what has to have
				// been read.
				const result = runSedScript(original, commands, input.quiet === true);

				if (input.in_place) {
					// Exactly the rule `editor` applies, and for the same reason: an
					// edit aimed at lines nobody has looked at lands on whatever
					// happens to be there now. Judged on the lines the script
					// changes, not on its addresses: a regex or negated address used
					// to need only "read at some point", so `5!d` or `s/x/y/g` after a
					// read of one line rewrote every line nobody had seen.
					if (receipts) {
						// And the other half of it: whether what was read is still
						// what is there. `sed -i` on a file a parallel agent has
						// rewritten applies the script to code the model has never
						// seen, silently and to every match.
						const stamp = await readFileStamp(filePath);
						if (receipts.changedSince(filePath, stamp)) {
							receipts.noteStamp(filePath, stamp);
							receipts.retire(filePath);
							outcomes.push({
								file,
								output: "",
								ok: false,
								error: `not modified. ${file} changed since you last read it, and not through an edit this session recorded — a command (yours included, in the foreground or the background), another agent, or something outside this session wrote to it. Call \`read_files\` for it to see what it says now, then decide whether this script is still right.`,
							});
							return;
						}
						const touched = result.touched;
						let runStart: number | undefined;
						let runEnd = 0;
						const runs: Array<{ first: number; last: number }> = [];
						for (const line of touched) {
							if (runStart !== undefined && line === runEnd + 1) {
								runEnd = line;
								continue;
							}
							if (runStart !== undefined)
								runs.push({ first: runStart, last: runEnd });
							runStart = line;
							runEnd = line;
						}
						if (runStart !== undefined)
							runs.push({ first: runStart, last: runEnd });
						const unseen = runs.filter(
							(run) => !receipts.covers(filePath, run.first, run.last),
						);
						if (unseen.length > 0) {
							const why = !receipts.hasEverRead(filePath)
								? `${file} has not been read in this session`
								: receipts.wasRetired(filePath)
									? "an earlier edit moved the lines that were read"
									: "no read of it since it last changed covers them";
							const named = unseen
								.slice(0, 5)
								.map((run) =>
									run.first === run.last
										? `${run.first}`
										: `${run.first}-${run.last}`,
								)
								.join(", ");
							const single =
								unseen.length === 1 && unseen[0].first === unseen[0].last;
							const more =
								unseen.length > 5 ? ` and ${unseen.length - 5} more` : "";
							outcomes.push({
								file,
								output: "",
								ok: false,
								error: `not modified. This script would change ${single ? "line" : "lines"} ${named}${more}, and ${why}. Read before editing: call \`read_files\` for ${file} covering ${single ? "it" : "them"}, then run this again.`,
							});
							return;
						}
					}
				}

				if (input.in_place) {
					if (!result.changed) {
						// Not a failure: the script ran and this is what it did. Saying
						// otherwise invites the model to run it again unchanged.
						outcomes.push({
							file,
							output: result.matched
								? "no change — the script matched, but what it wrote is what was already there."
								: "no change — the script matched nothing.",
							ok: true,
						});
						return;
					}
					await fs.writeFile(filePath, bom + result.output, "utf8");
					receipts?.noteWrite(
						filePath,
						countLines(original),
						countLines(result.output),
					);
					// After the write, so this session's own change is not read back
					// as somebody else's on the next call.
					receipts?.noteStamp(filePath, await readFileStamp(filePath));
					const delta = countLines(result.output) - countLines(original);
					outcomes.push({
						file,
						output: `written. ${
							delta === 0
								? "Line count unchanged."
								: `${delta > 0 ? "+" : ""}${delta} line${Math.abs(delta) === 1 ? "" : "s"}.`
						}`,
						ok: true,
					});
					return;
				}

				// A read-only run is a read of what it printed: recorded, so a later
				// edit to those lines is not refused. Only those lines -- the whole
				// file was credited, so `sed -n '/x/p'` let an edit by line number
				// land on every line it had not shown.
				creditShown(receipts, filePath, result.shown);
				receipts?.noteStamp(filePath, await readFileStamp(filePath));
				outcomes.push({ file, output: result.output, ok: true });
			});
		}

		return outcomes;
	};
}
