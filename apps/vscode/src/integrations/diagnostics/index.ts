import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import * as path from "path"
import { Diagnostic, DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.cline"
import { Logger } from "@/shared/services/Logger"
import { getCwd } from "@/utils/path"

export function getNewDiagnostics(oldDiagnostics: FileDiagnostics[], newDiagnostics: FileDiagnostics[]): FileDiagnostics[] {
	const oldMap = new Map<string, Diagnostic[]>()
	for (const diag of oldDiagnostics) {
		oldMap.set(diag.filePath, diag.diagnostics)
	}

	const newProblems: FileDiagnostics[] = []
	for (const newDiags of newDiagnostics) {
		const oldDiags = oldMap.get(newDiags.filePath) || []
		const newProblemsForFile = newDiags.diagnostics.filter(
			(newDiag) => !oldDiags.some((oldDiag) => deepEqual(oldDiag, newDiag)),
		)

		if (newProblemsForFile.length > 0) {
			newProblems.push({ filePath: newDiags.filePath, diagnostics: newProblemsForFile })
		}
	}

	return newProblems
}

// will return empty string if no problems with the given severity are found
export async function diagnosticsToProblemsString(
	diagnostics: FileDiagnostics[],
	severities?: DiagnosticSeverity[],
): Promise<string> {
	const results = []
	for (const fileDiagnostics of diagnostics) {
		const problems = fileDiagnostics.diagnostics.filter((d) => !severities || severities.includes(d.severity))
		const problemString = await singleFileDiagnosticsToProblemsString(fileDiagnostics.filePath, problems)
		if (problemString) {
			results.push(problemString)
		}
	}
	return results.join("\n\n")
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
] as const

function isUnbalancedDelimiter(message: string): boolean {
	return UNBALANCED_DELIMITER_PATTERNS.some((pattern) => pattern.test(message.trim()))
}

/**
 * A parse error cascades: one unclosed brace makes every construct after it
 * unparseable, and the language server reports each of those separately. The
 * root cause is reported where the parser gave up, which for a class body is
 * the end of the file — so it arrives last, behind everything it caused.
 *
 * Measured on a 156-message session: `check_file` returned 17 errors on a
 * minified file, sixteen of them `',' expected` / `':' expected` on lines
 * 90-92, and the seventeenth was `Line 177, column 1: '}' expected.` The model
 * worked the list from the top for many turns, editing lines that were never
 * wrong, and then asked the user whether it should give up. Point at the cause
 * before the list rather than leaving it at the bottom.
 */
function rootCauseHint(diagnostics: Diagnostic[], shape: FileShape | null): string | null {
	if (diagnostics.length < 3) {
		return null
	}
	const structural = diagnostics.filter((d) => isUnbalancedDelimiter(d.message))
	if (structural.length === 0 || structural.length === diagnostics.length) {
		return null
	}
	const where = structural
		.slice(0, 2)
		.map((d) => {
			const start = d.range?.start
			const at = start ? describePosition(start, shape) : "an unknown position"
			return `${d.message.trim().replace(/\.$/, "")} at ${at}`
		})
		.join("; ")
	const rest = diagnostics.length - structural.length
	return (
		`- Start here: ${where}. An unclosed delimiter is reported where the parser gave up, so the delimiter itself ` +
		`belongs somewhere above that point. The other ${rest} error${rest === 1 ? "" : "s"} below are usually cascade ` +
		`from it and clear on their own once it is fixed — fix this one first and re-check before editing the rest.`
	)
}

/**
 * What the renderer needs of the file to name a position the language server
 * puts past its last line: how many lines it has, counted the way
 * `read_files` and the revision list count them, and where each `</script>`
 * of a page closes.
 */
interface FileShape {
	lines: number
	/** 1-based lines of the `</script>` tags, in order. Empty for a file that is not a page. */
	scriptEnds: number[]
}

async function readFileShape(filePath: string): Promise<FileShape | null> {
	let text: string
	try {
		text = await fs.readFile(filePath, "utf8")
	} catch {
		return null
	}
	const lines = text === "" ? [] : text.split(/\r\n|\r|\n/)
	if (lines[lines.length - 1] === "") {
		lines.pop()
	}
	const scriptEnds: number[] = []
	if (/\.html?$/i.test(filePath)) {
		for (const match of text.matchAll(/<\/script\s*>/gi)) {
			scriptEnds.push(text.slice(0, match.index).split(/\r\n|\r|\n/).length)
		}
	}
	return { lines: lines.length, scriptEnds }
}

/**
 * `line 90, column 382`, or, for a position past the last line, the end of
 * the file said in the file's own count.
 *
 * A language server counts the empty line after the final line break, which
 * no other tool does: the parser gives up on an unclosed brace there, so a
 * file `read_files` calls 136 lines long gets `Line 137, column 1: '}'
 * expected`. Measured on pandorum (jackodf-9b, session ydiox): the model took
 * the line that did not exist as the check reading an old copy, said so for
 * ten turns, re-ran the check after every edit and stopped believing it. For
 * a page the JavaScript is checked as the whole page with the markup blanked
 * out, so the end of the script is its `</script>`, and that is said too.
 */
function describePosition(start: { line: number; character: number }, shape: FileShape | null): string {
	const line = start.line + 1
	// The column is the part that makes a diagnostic actionable on a long
	// line, and it was being dropped. Measured on a minified file: the one
	// error that mattered was at line 92 *column 293*, and "Line 92" alone
	// sent the model into fifteen shell commands counting braces by hand to
	// find what the language server had already located exactly. The
	// browser's own console said `manic_miner.html:92:293`.
	const column = start.character !== undefined ? `, column ${start.character + 1}` : ""
	if (!shape || line <= shape.lines) {
		return `line ${line}${column}`
	}
	const end =
		`the end of the file (after line ${shape.lines}, its last; the editor numbers the empty line after ` +
		`the final line break ${line})`
	const script = shape.scriptEnds[shape.scriptEnds.length - 1]
	return script ? `${end}, which for the script is its \`</script>\` on line ${script}` : end
}

export async function singleFileDiagnosticsToProblemsString(filePath: string, diagnostics: Diagnostic[]): Promise<string> {
	if (!diagnostics.length) {
		return ""
	}
	const cwd = await getCwd()
	const relPath = path.relative(cwd, filePath).toPosix()
	let result = `${relPath}`
	const shape = await readFileShape(filePath)

	const hint = rootCauseHint(diagnostics, shape)
	if (hint) {
		result += `\n${hint}`
	}

	for (const diagnostic of diagnostics) {
		const label = severityToString(diagnostic.severity)
		// Lines and characters are both 0-indexed in the protocol.
		const start = diagnostic.range?.start
		const at = start ? describePosition(start, shape) : "line "
		const source = diagnostic.source ? `${diagnostic.source} ` : ""
		result += `\n- [${source}${label}] ${at.charAt(0).toUpperCase()}${at.slice(1)}: ${diagnostic.message}`
	}
	return result
}

function severityToString(severity: DiagnosticSeverity): string {
	switch (severity) {
		case DiagnosticSeverity.DIAGNOSTIC_ERROR:
			return "Error"
		case DiagnosticSeverity.DIAGNOSTIC_WARNING:
			return "Warning"
		case DiagnosticSeverity.DIAGNOSTIC_INFORMATION:
			return "Information"
		case DiagnosticSeverity.DIAGNOSTIC_HINT:
			return "Hint"
		default:
			Logger.warn("Unhandled diagnostic severity level:", severity)
			return "Diagnostic"
	}
}
