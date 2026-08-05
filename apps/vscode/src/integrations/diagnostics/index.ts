import deepEqual from "fast-deep-equal"
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

export async function singleFileDiagnosticsToProblemsString(filePath: string, diagnostics: Diagnostic[]): Promise<string> {
	if (!diagnostics.length) {
		return ""
	}
	const cwd = await getCwd()
	const relPath = path.relative(cwd, filePath).toPosix()
	let result = `${relPath}`

	for (const diagnostic of diagnostics) {
		const label = severityToString(diagnostic.severity)
		// Lines and characters are both 0-indexed in the protocol.
		const start = diagnostic.range?.start
		const line = start ? `${start.line + 1}` : ""
		// The column is the part that makes a diagnostic actionable on a long
		// line, and it was being dropped. Measured on a minified file: the one
		// error that mattered was at line 92 *column 293*, and "Line 92" alone
		// sent the model into fifteen shell commands counting braces by hand to
		// find what the language server had already located exactly. The
		// browser's own console said `manic_miner.html:92:293`.
		const column = start?.character !== undefined ? `, column ${start.character + 1}` : ""

		const source = diagnostic.source ? `${diagnostic.source} ` : ""
		result += `\n- [${source}${label}] Line ${line}${column}: ${diagnostic.message}`
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
