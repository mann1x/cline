import {
	type CheckedScript,
	findParseStop,
	parseCheckedScripts,
} from "./delimiter-balance";

/**
 * Say when an edit gave a JavaScript class a second method of a name it
 * already had -- the one mistake in this family nothing else reports.
 *
 * Measured on pandorum (2026-11-14, v9-agentic, manic_miner): the model meant
 * to rewrite `dIt` on line 91 and sent the edit for line 90, which held
 * `dDec`. `dDec` was gone, and `Level` now had two `dIt`s: the model's at 90
 * and the original at 121. A class keeps the last definition of a name, so the
 * rewrite could never run. It is legal JavaScript, so neither the parser nor
 * the editor's diagnostics said a word; the model only worked it out after a
 * 16,815-character think. TypeScript ("Duplicate function implementation")
 * and Pyright ("obscured by a declaration of the same name") already report
 * the same mistake in their languages, which is why this covers JavaScript
 * and the scripts in an HTML page only.
 *
 * Nothing here is inferred. Every claim is proved before it is made, and when
 * any proof fails the note says nothing:
 *
 * - That both are methods of one class body is proved by the engine itself.
 *   Both names are renamed to one private name and the script is parsed;
 *   JavaScript refuses a private name declared twice in one class body, and
 *   only there. A call, an object-literal method, a nested class, a getter
 *   paired with a setter, or anything broken before the second one, gives a
 *   different answer or none (checked against V8, 2026-11-14).
 * - Private names also clash between a static method and an instance one,
 *   which ordinary names do not, so the static modifier is read from the text
 *   and the two must agree. Anything but plain modifiers before the name --
 *   a decorator, a comment, `get`, `set` -- and the pair is not considered.
 * - "Which this call wrote": the line lies in what the edit changed, and its
 *   text is in the call's own arguments.
 * - The replaced lines are checked for the name, as a whole word; if it was
 *   there the edit may have moved the definition rather than added one, and
 *   nothing is said.
 *
 * A note, never a refusal: a model may mean to add the copy and remove the
 * other one next, and an edit that has landed cannot be refused anyway.
 */

/** The private name the probe uses; refused if the file already holds it. */
const PROBE_NAME = "#__cerebriline_redefinition_probe";
/** The engine's words for a private name declared twice (V8). */
const DUPLICATE_MESSAGE = `Identifier '${PROBE_NAME}' has already been declared`;
/** Parses one edit may spend on probes. Each is one parse of one script. */
const MAX_PROBES = 8;

/**
 * A method head: the end of whatever came before (start of text, a newline,
 * `;`, `{`, `}`), then only the modifiers a method may carry, then the name
 * and its opening parenthesis. Over-matches -- every call statement fits --
 * and the parse decides; what it must never do is miss a modifier, so
 * anything else in front of the name (`get`, `set`, `@decorator`, a comment)
 * fails to match at all.
 */
const METHOD_HEAD =
	/(?:^|[\n;{}])[ \t\r]*(static[ \t\r\n]+)?(?:async[ \t]+)?(?:\*[ \t\r\n]*)?([A-Za-z_$][\w$]*)[ \t]*\(/g;

/** Words that fit the head and are never a method worth probing. */
const NOT_METHODS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"function",
	"return",
	"typeof",
	"await",
	"yield",
	"new",
	"delete",
	"void",
	"super",
	"constructor",
]);

interface Head {
	name: string;
	/** Offset of the name in the text. */
	offset: number;
	/** 1-based. */
	line: number;
	isStatic: boolean;
}

/** The lines an edit changed, 1-based and inclusive; empty when `first > last`. */
interface Changed {
	oldFirst: number;
	oldLast: number;
	newFirst: number;
	newLast: number;
}

function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/**
 * Trim the lines both texts share at the start and the end. Every line
 * outside the result is identical before and after, so whatever this misses
 * cannot be this edit's -- and anything another writer changed in between is
 * included, which only widens what is searched for the name.
 */
function changedLines(before: string[], after: string[]): Changed | undefined {
	let prefix = 0;
	const most = Math.min(before.length, after.length);
	while (prefix < most && before[prefix] === after[prefix]) {
		prefix++;
	}
	if (prefix === before.length && prefix === after.length) {
		return undefined;
	}
	let suffix = 0;
	while (
		suffix < most - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}
	return {
		oldFirst: prefix + 1,
		oldLast: before.length - suffix,
		newFirst: prefix + 1,
		newLast: after.length - suffix,
	};
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = text.indexOf("\n"); index !== -1; ) {
		starts.push(index + 1);
		index = text.indexOf("\n", index + 1);
	}
	return starts;
}

function lineOf(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= offset) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low + 1;
}

function methodHeads(text: string, starts: number[]): Head[] {
	const heads: Head[] = [];
	METHOD_HEAD.lastIndex = 0;
	for (
		let match = METHOD_HEAD.exec(text);
		match;
		match = METHOD_HEAD.exec(text)
	) {
		const name = match[2] ?? "";
		// After the name come only blanks and `(`, so its last occurrence in
		// the match is the name itself.
		const offset = match.index + match[0].lastIndexOf(name);
		const memberStart = match.index + match[0].search(/[^\n;{}\s]/);
		// What stands before the member must end the one before it, open the
		// class, or be nothing. A newline alone is not enough: `static` on the
		// line above, with a comment between, makes this a static method the
		// head above cannot see -- so anything else there and it is skipped.
		const preceding = text.slice(0, memberStart).trimEnd();
		const ends = preceding === "" || /[;{}]$/.test(preceding);
		if (ends && !NOT_METHODS.has(name)) {
			heads.push({
				name,
				offset,
				line: lineOf(starts, offset),
				isStatic: match[1] !== undefined,
			});
		}
	}
	return heads;
}

/** Every string anywhere in the call's arguments. */
function argumentStrings(input: unknown, into: string[] = []): string[] {
	if (typeof input === "string") {
		into.push(input);
	} else if (Array.isArray(input)) {
		for (const item of input) {
			argumentStrings(item, into);
		}
	} else if (input && typeof input === "object") {
		for (const value of Object.values(input)) {
			argumentStrings(value, into);
		}
	}
	return into;
}

function mentions(lines: string[], name: string): boolean {
	const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
	return lines.some((line) => word.test(line));
}

/**
 * Whether the engine refuses the two heads as one private name declared
 * twice in one class body.
 */
function sameClassBody(
	script: CheckedScript,
	first: Head,
	second: Head,
): boolean {
	const renamed = [second, first]
		.sort((a, b) => b.offset - a.offset)
		.reduce(
			(body, head) =>
				body.slice(0, head.offset - script.start) +
				PROBE_NAME +
				body.slice(head.offset - script.start + head.name.length),
			script.body,
		);
	const stop = findParseStop(renamed, script.origin, script.goal);
	// Only these two carry the probe's name, so the engine refusing it as
	// declared twice is the proof on its own. V8 reports it where the second
	// method ends, so the line is checked only for not coming before it.
	return (
		!!stop &&
		stop.message === DUPLICATE_MESSAGE &&
		(stop.line === undefined || stop.line >= Math.max(first.line, second.line))
	);
}

/**
 * The note for an edit that left a JavaScript class with two methods of one
 * name, or undefined when there is nothing it can prove.
 */
export function describeRedefinition(
	filePath: string,
	before: string,
	after: string,
	input: unknown,
): string | undefined {
	const scripts = parseCheckedScripts(filePath, after);
	if (!scripts || scripts.length === 0 || after.includes(PROBE_NAME)) {
		return undefined;
	}
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const changed = changedLines(beforeLines, afterLines);
	if (!changed || changed.newFirst > changed.newLast) {
		return undefined;
	}
	const replaced = beforeLines.slice(changed.oldFirst - 1, changed.oldLast);
	const written = argumentStrings(input);
	const starts = lineStarts(after);
	const heads = methodHeads(after, starts);

	const isWritten = (head: Head): boolean => {
		if (head.line < changed.newFirst || head.line > changed.newLast) {
			return false;
		}
		const text = (afterLines[head.line - 1] ?? "").trim();
		return text !== "" && written.some((value) => value.includes(text));
	};
	const scriptOf = (head: Head): CheckedScript | undefined =>
		scripts.find(
			(script) =>
				head.offset >= script.start &&
				head.offset + head.name.length <= script.start + script.body.length,
		);

	let probes = 0;
	const found = new Set<string>();
	const notes: string[] = [];
	for (const added of heads) {
		if (
			found.has(added.name) ||
			!isWritten(added) ||
			mentions(replaced, added.name)
		) {
			continue;
		}
		const script = scriptOf(added);
		if (!script) {
			continue;
		}
		for (const other of heads) {
			if (
				other.name !== added.name ||
				other.isStatic !== added.isStatic ||
				// Outside what changed, so it was there before this call.
				(other.line >= changed.newFirst && other.line <= changed.newLast) ||
				// "At line N and at line N" tells the model nothing it can act on.
				other.line === added.line ||
				scriptOf(other) !== script
			) {
				continue;
			}
			if (probes >= MAX_PROBES) {
				return notes.length > 0 ? notes.join("\n") : undefined;
			}
			probes++;
			if (!sameClassBody(script, added, other)) {
				continue;
			}
			// "Twice" has to be the count. A third head of the name anywhere
			// in the script -- another class's method, a call statement -- and
			// the sentence could be wrong, so nothing is said.
			const sameName = heads.filter(
				(head) =>
					head.name === added.name &&
					head.isStatic === added.isStatic &&
					scriptOf(head) === script,
			);
			if (sameName.length !== 2) {
				found.add(added.name);
				break;
			}
			found.add(added.name);
			const kind = added.isStatic ? "static method" : "method";
			const runs =
				added.line > other.line
					? `the one this call wrote is the one that runs, and the one at line ${other.line} no longer does`
					: `the one at line ${other.line} is the one that runs, and the one this call wrote never does`;
			const replacedNote =
				replaced.length > 0
					? ` The lines this call replaced did not mention \`${added.name}\`.`
					: "";
			notes.push(
				`Note: the edit left \`${added.name}\` defined twice as a ${kind} of the same class — at line ${added.line}, which this call wrote, and at line ${other.line}, which was already there. JavaScript keeps only the last definition of a method, so ${runs}. It is valid JavaScript, so no syntax error will point to it.${replacedNote}`,
			);
			break;
		}
	}
	return notes.length > 0 ? notes.join("\n") : undefined;
}
