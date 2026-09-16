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
import { compilePosixRegex } from "./posix-regex";
import { type ReadReceipts, readFileStamp } from "./read-receipts";

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
	| { kind: "every" };

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
	let index = start;
	const char = script[index];
	if (char === "$") {
		return { address: { kind: "last" }, next: index + 1 };
	}
	if (char !== undefined && /[0-9]/.test(char)) {
		let digits = "";
		while (index < script.length && /[0-9]/.test(script[index])) {
			digits += script[index];
			index += 1;
		}
		return { address: { kind: "line", line: Number(digits) }, next: index };
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
			end = second.address;
			index = second.next;
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
			// because a model writes whichever it saw most.
			while (index < script.length && /[\s\\]/.test(script[index])) {
				if (script[index] === "\n") {
					index += 1;
					break;
				}
				index += 1;
			}
			let text = "";
			while (index < script.length && script[index] !== "\n") {
				if (script[index] === "\\" && script[index + 1] === "\n") {
					text += "\n";
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
	while (index < replacement.length) {
		const char = replacement[index];
		if (char === "\\") {
			const next = replacement[index + 1];
			if (next !== undefined && /[1-9]/.test(next)) {
				out += match[Number(next)] ?? "";
				index += 2;
				continue;
			}
			if (next === "n") {
				out += "\n";
				index += 2;
				continue;
			}
			if (next === "t") {
				out += "\t";
				index += 2;
				continue;
			}
			if (next !== undefined) {
				out += next;
				index += 2;
				continue;
			}
		}
		if (char === "&") {
			out += match[0];
			index += 1;
			continue;
		}
		out += char;
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
	}
}

function selects(
	command: Command,
	lineNumber: number,
	line: string,
	lastLine: number,
): boolean {
	let hit: boolean;
	if (!command.start) {
		hit = true;
	} else if (!command.end) {
		hit = matchesAddress(command.start, lineNumber, line, lastLine);
	} else {
		// A range stays on from the line that opens it until one closes it.
		if (command.active) {
			hit = true;
			if (matchesAddress(command.end, lineNumber, line, lastLine)) {
				command.active = false;
			}
		} else if (matchesAddress(command.start, lineNumber, line, lastLine)) {
			hit = true;
			command.active = !matchesAddress(command.end, lineNumber, line, lastLine);
		} else {
			hit = false;
		}
	}
	return command.negated ? !hit : hit;
}

export interface RunSedResult {
	output: string;
	/** Whether any command changed the text. */
	changed: boolean;
}

/** Run a parsed script over text. Pure: no filesystem, so it is easy to test. */
export function runSedScript(
	input: string,
	commands: Command[],
	quiet = false,
): RunSedResult {
	// A trailing newline is a line terminator, not an empty last line.
	const hadTrailingNewline = input.endsWith("\n");
	const lines = input.split("\n");
	if (hadTrailingNewline) {
		lines.pop();
	}
	const lastLine = lines.length;
	const out: string[] = [];
	let changed = false;

	for (const command of commands) {
		command.active = false;
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
			switch (command.name) {
				case "s": {
					const regex = command.regex as RegExp;
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
						line = replaced;
						if (command.print) {
							out.push(line);
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
						line = mapped;
					}
					break;
				}
				case "d":
					deleted = true;
					changed = true;
					line = undefined;
					break;
				case "p":
					out.push(line);
					break;
				case "=":
					out.push(String(lineNumber));
					break;
				case "a":
					after.push(command.text ?? "");
					changed = true;
					break;
				case "i":
					before.push(command.text ?? "");
					changed = true;
					break;
				case "c":
					deleted = true;
					changed = true;
					before.push(command.text ?? "");
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
		}
		out.push(...after);
		if (quit) {
			break;
		}
	}

	const text = out.join("\n");
	return {
		output: text === "" ? "" : hadTrailingNewline ? `${text}\n` : text,
		changed,
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
}

export interface SedInput {
	script: string;
	files: string[];
	in_place?: boolean;
	quiet?: boolean;
	extended?: boolean;
}

/**
 * Which lines a script is aimed at, when it is aimed at lines at all.
 *
 * A script addressed purely by line number is checked against those lines, the
 * way a line-anchored `editor` call is. One with a regex address, or none, is
 * text-anchored: the file is searched at the moment it runs, so a read whose
 * line numbers went stale is still a model that has seen the file.
 */
function addressedLines(
	commands: Command[],
): { first: number; last: number } | undefined {
	let first = Number.POSITIVE_INFINITY;
	let last = 0;
	for (const command of commands) {
		for (const address of [command.start, command.end]) {
			if (!address) {
				continue;
			}
			if (address.kind !== "line") {
				return undefined;
			}
			first = Math.min(first, address.line);
			last = Math.max(last, address.line);
		}
		if (!command.start) {
			// An unaddressed command applies to every line.
			return undefined;
		}
	}
	return Number.isFinite(first) && last > 0 ? { first, last } : undefined;
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
	const { receipts } = options;

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
			const filePath = isAbsolute(file) ? file : resolve(cwd, file);
			let original: string;
			try {
				original = await fs.readFile(filePath, "utf8");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				outcomes.push({
					file,
					output: "",
					ok: false,
					error: `could not be read: ${reason}`,
				});
				continue;
			}

			if (input.in_place) {
				// Exactly the rule `editor` applies, and for the same reason: an
				// edit aimed at lines nobody has looked at lands on whatever
				// happens to be there now.
				const range = addressedLines(commands);
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
							error: `not modified. ${file} changed since you last read it, and not because of anything you did — something outside this session wrote to it. Call \`read_files\` for it to see what it says now, then decide whether this script is still right.`,
						});
						continue;
					}
					if (range) {
						if (!receipts.covers(filePath, range.first, range.last)) {
							const why = receipts.wasRetired(filePath)
								? "an earlier edit moved the lines that were read"
								: "those lines have not been read in this session";
							outcomes.push({
								file,
								output: "",
								ok: false,
								error: `not modified. Read before editing: ${why}. Call \`read_files\` for ${file} covering lines ${range.first}-${range.last}, then run this again.`,
							});
							continue;
						}
					} else if (!receipts.hasEverRead(filePath)) {
						outcomes.push({
							file,
							output: "",
							ok: false,
							error: `not modified. Read before editing: ${file} has not been read in this session. Call \`read_files\` for it first, then run this again.`,
						});
						continue;
					}
				}
			}

			const result = runSedScript(original, commands, input.quiet === true);

			if (input.in_place) {
				if (!result.changed) {
					// Not a failure: the script ran and this is what it did. Saying
					// otherwise invites the model to run it again unchanged.
					outcomes.push({
						file,
						output: "no change — the script matched nothing.",
						ok: true,
					});
					continue;
				}
				await fs.writeFile(filePath, result.output, "utf8");
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
				continue;
			}

			// A read-only run is a read: record it, so a later edit to the same
			// file is not refused for a file the model has just been through.
			receipts?.noteRead(filePath, 1, Number.POSITIVE_INFINITY);
			receipts?.noteStamp(filePath, await readFileStamp(filePath));
			outcomes.push({ file, output: result.output, ok: true });
		}

		return outcomes;
	};
}
