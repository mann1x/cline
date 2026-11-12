import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	DiagnosticSeverityName,
	HostDiagnostic,
	HostFileDiagnostics,
	ReadText,
} from "./types";

/**
 * How a file's diagnostics are written for a model.
 *
 * One renderer for every host: `check_file` and the post-edit report say the
 * same thing about the same file whether VS Code or a language server the CLI
 * started produced it. Moved here from the extension's
 * `integrations/diagnostics`, which now delegates to it.
 */

/** The disk, read as text. */
export const defaultReadText: ReadText = (filePath) =>
	fs.readFile(filePath, "utf8");

/** Two diagnostics are the same claim when every field they carry matches. */
export function sameDiagnostic(a: HostDiagnostic, b: HostDiagnostic): boolean {
	return (
		a.message === b.message &&
		a.severity === b.severity &&
		(a.source ?? "") === (b.source ?? "") &&
		a.range?.start?.line === b.range?.start?.line &&
		a.range?.start?.character === b.range?.start?.character &&
		a.range?.end?.line === b.range?.end?.line &&
		a.range?.end?.character === b.range?.end?.character
	);
}

/** The diagnostics in `after` that were not in `before`, per file. */
export function getNewDiagnostics(
	before: readonly HostFileDiagnostics[],
	after: readonly HostFileDiagnostics[],
): HostFileDiagnostics[] {
	const previous = new Map<string, HostDiagnostic[]>();
	for (const file of before) {
		previous.set(file.filePath, file.diagnostics);
	}
	const introduced: HostFileDiagnostics[] = [];
	for (const file of after) {
		const old = previous.get(file.filePath) ?? [];
		const fresh = file.diagnostics.filter(
			(candidate) =>
				!old.some((existing) => sameDiagnostic(existing, candidate)),
		);
		if (fresh.length > 0) {
			introduced.push({ filePath: file.filePath, diagnostics: fresh });
		}
	}
	return introduced;
}

/**
 * Every file's problems of the given severities, or an empty string when there
 * are none. `cwd` is what the paths are written relative to.
 */
export async function diagnosticsToProblemsString(
	cwd: string,
	diagnostics: readonly HostFileDiagnostics[],
	severities?: readonly DiagnosticSeverityName[],
): Promise<string> {
	const results: string[] = [];
	for (const file of diagnostics) {
		const problems = file.diagnostics.filter(
			(entry) => !severities || severities.includes(entry.severity),
		);
		const section = await singleFileDiagnosticsToProblemsString(
			cwd,
			file.filePath,
			problems,
		);
		if (section) {
			results.push(section);
		}
	}
	return results.join("\n\n");
}

/**
 * Messages that name an unclosed delimiter, across the language servers that
 * phrase it differently. Deliberately narrow: `',' expected` and `';' expected`
 * are the cascade, not the cause, and must not match.
 */
const UNBALANCED_DELIMITER_PATTERNS = [
	/^'[)\]}>]' expected/i, // TypeScript / JavaScript
	/expected '[)\]}]'/i, // clang, gcc
	/unclosed delimiter/i, // Rust
	/unmatched '[([{]'/i, // Python
	/unexpected (?:eof|end of file|end of input)/i,
	/unterminated (?:string|template|comment|block)/i,
] as const;

function isUnbalancedDelimiter(message: string): boolean {
	return UNBALANCED_DELIMITER_PATTERNS.some((pattern) =>
		pattern.test(message.trim()),
	);
}

/**
 * A parse error cascades: one unclosed brace makes every construct after it
 * unparseable, and the language server reports each of those separately. The
 * root cause is reported where the parser gave up, which for a class body is
 * the end of the file -- so it arrives last, behind everything it caused.
 *
 * Measured on a 156-message session: `check_file` returned 17 errors on a
 * minified file, sixteen of them `',' expected` / `':' expected` on lines
 * 90-92, and the seventeenth was `Line 177, column 1: '}' expected.` The model
 * worked the list from the top for many turns, editing lines that were never
 * wrong, and then asked the user whether it should give up. Point at the cause
 * before the list rather than leaving it at the bottom.
 */
function rootCauseHint(
	diagnostics: readonly HostDiagnostic[],
	shape: FileShape | null,
): string | null {
	if (diagnostics.length < 3) {
		return null;
	}
	const structural = diagnostics.filter((entry) =>
		isUnbalancedDelimiter(entry.message),
	);
	if (structural.length === 0 || structural.length === diagnostics.length) {
		return null;
	}
	const where = structural
		.slice(0, 2)
		.map((entry) => {
			const start = entry.range?.start;
			const at = start ? describePosition(start, shape) : "an unknown position";
			return `${entry.message.trim().replace(/\.$/, "")} at ${at}`;
		})
		.join("; ");
	const rest = diagnostics.length - structural.length;
	return (
		`- Start here: ${where}. An unclosed delimiter is reported where the parser gave up, so the delimiter itself ` +
		`belongs somewhere above that point. The other ${rest} error${rest === 1 ? "" : "s"} below are usually cascade ` +
		`from it and clear on their own once it is fixed — fix this one first and re-check before editing the rest.`
	);
}

/**
 * What the renderer needs of the file to name a position the language server
 * puts past its last line: how many lines it has, counted the way
 * `read_files` and the revision list count them, and where each `</script>`
 * of a page closes.
 */
interface FileShape {
	lines: number;
	/** 1-based lines of the `</script>` tags, in order. Empty for a file that is not a page. */
	scriptEnds: number[];
}

async function readFileShape(
	filePath: string,
	readText: ReadText = defaultReadText,
): Promise<FileShape | null> {
	let text: string;
	try {
		text = await readText(filePath);
	} catch {
		return null;
	}
	const lines = text === "" ? [] : text.split(/\r\n|\r|\n/);
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	const scriptEnds: number[] = [];
	if (/\.html?$/i.test(filePath)) {
		for (const match of text.matchAll(/<\/script\s*>/gi)) {
			scriptEnds.push(text.slice(0, match.index).split(/\r\n|\r|\n/).length);
		}
	}
	return { lines: lines.length, scriptEnds };
}

/**
 * `line 90, column 382`, or, for a position past the last line, the end of
 * the file said in the file's own count.
 *
 * A language server counts the empty line after the final line break, which
 * no other tool does: the parser gives up on an unclosed brace there, so a
 * file `read_files` calls 136 lines long gets `Line 137, column 1: '}'
 * expected`. Measured on pandorum (session ydiox): the model took the line
 * that did not exist as the check reading an old copy, said so for ten turns,
 * re-ran the check after every edit and stopped believing it. For a page the
 * JavaScript is checked as the whole page with the markup blanked out, so the
 * end of the script is its `</script>`, and that is said too.
 */
function describePosition(
	start: { line: number; character?: number },
	shape: FileShape | null,
): string {
	const line = start.line + 1;
	// The column is the part that makes a diagnostic actionable on a long
	// line. Measured on a minified file: the one error that mattered was at
	// line 92 *column 293*, and "Line 92" alone sent the model into fifteen
	// shell commands counting braces by hand.
	const column =
		start.character !== undefined ? `, column ${start.character + 1}` : "";
	if (!shape || line <= shape.lines) {
		return `line ${line}${column}`;
	}
	const end =
		`the end of the file (after line ${shape.lines}, its last; the editor numbers the empty line after ` +
		`the final line break ${line})`;
	const script = shape.scriptEnds[shape.scriptEnds.length - 1];
	return script
		? `${end}, which for the script is its \`</script>\` on line ${script}`
		: end;
}

const SEVERITY_LABELS: Record<DiagnosticSeverityName, string> = {
	error: "Error",
	warning: "Warning",
	information: "Information",
	hint: "Hint",
};

/** A path written for a model: relative to the workspace, forward slashes. */
function displayPath(cwd: string, filePath: string): string {
	return path.relative(cwd, filePath).split(path.sep).join("/");
}

/**
 * One file's problems, or an empty string when the list is empty. `cwd` is
 * what the path is written relative to.
 */
export async function singleFileDiagnosticsToProblemsString(
	cwd: string,
	filePath: string,
	diagnostics: readonly HostDiagnostic[],
	readText?: ReadText,
): Promise<string> {
	if (!diagnostics.length) {
		return "";
	}
	let result = displayPath(cwd, filePath);
	const shape = await readFileShape(filePath, readText);

	const hint = rootCauseHint(diagnostics, shape);
	if (hint) {
		result += `\n${hint}`;
	}

	for (const diagnostic of diagnostics) {
		const label = SEVERITY_LABELS[diagnostic.severity] ?? "Diagnostic";
		// Lines and characters are both 0-indexed in the protocol.
		const start = diagnostic.range?.start;
		const at = start ? describePosition(start, shape) : "line ";
		const source = diagnostic.source ? `${diagnostic.source} ` : "";
		result += `\n- [${source}${label}] ${at.charAt(0).toUpperCase()}${at.slice(1)}: ${diagnostic.message}`;
	}
	return result;
}
