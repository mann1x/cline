import {
	diagnosticsToProblemsString as coreDiagnosticsToProblemsString,
	singleFileDiagnosticsToProblemsString as coreSingleFileDiagnosticsToProblemsString,
	type DiagnosticSeverityName,
	type HostDiagnostic,
	type HostFileDiagnostics,
	sameDiagnostic,
} from "@cline/core"
import { Diagnostic, DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.cline"
import { getCwd } from "@/utils/path"

/**
 * The editor's diagnostics, written for a model.
 *
 * The rendering lives in core (`@cline/core`'s diagnostics renderer), shared
 * with every host that reads diagnostics from language servers of its own.
 * This module is the VS Code side of it: the host bridge hands over its proto
 * `FileDiagnostics`, which are converted at this boundary, and paths are
 * written relative to the workspace root.
 */

/** The proto's severity, named as core names it. */
export function toHostSeverity(severity: DiagnosticSeverity): DiagnosticSeverityName {
	switch (severity) {
		case DiagnosticSeverity.DIAGNOSTIC_ERROR:
			return "error"
		case DiagnosticSeverity.DIAGNOSTIC_WARNING:
			return "warning"
		case DiagnosticSeverity.DIAGNOSTIC_HINT:
			return "hint"
		default:
			// Information, and anything the proto adds later: never reported
			// as a problem with the edit.
			return "information"
	}
}

export function toHostDiagnostic(diagnostic: Diagnostic): HostDiagnostic {
	return {
		message: diagnostic.message,
		severity: toHostSeverity(diagnostic.severity),
		...(diagnostic.range
			? {
					range: {
						...(diagnostic.range.start ? { start: diagnostic.range.start } : {}),
						...(diagnostic.range.end ? { end: diagnostic.range.end } : {}),
					},
				}
			: {}),
		...(diagnostic.source ? { source: diagnostic.source } : {}),
	}
}

export function toHostFileDiagnostics(file: FileDiagnostics): HostFileDiagnostics {
	return { filePath: file.filePath, diagnostics: file.diagnostics.map(toHostDiagnostic) }
}

/** The diagnostics in `newDiagnostics` that were not in `oldDiagnostics`, per file. */
export function getNewDiagnostics(oldDiagnostics: FileDiagnostics[], newDiagnostics: FileDiagnostics[]): FileDiagnostics[] {
	const oldMap = new Map<string, HostDiagnostic[]>()
	for (const file of oldDiagnostics) {
		oldMap.set(file.filePath, file.diagnostics.map(toHostDiagnostic))
	}

	const newProblems: FileDiagnostics[] = []
	for (const file of newDiagnostics) {
		const old = oldMap.get(file.filePath) ?? []
		const fresh = file.diagnostics.filter((candidate) => {
			const converted = toHostDiagnostic(candidate)
			return !old.some((existing) => sameDiagnostic(existing, converted))
		})
		if (fresh.length > 0) {
			newProblems.push({ filePath: file.filePath, diagnostics: fresh })
		}
	}
	return newProblems
}

// will return empty string if no problems with the given severity are found
export async function diagnosticsToProblemsString(
	diagnostics: FileDiagnostics[],
	severities?: DiagnosticSeverity[],
): Promise<string> {
	return coreDiagnosticsToProblemsString(
		await getCwd(),
		diagnostics.map((file) => ({
			filePath: file.filePath,
			// Filtered on the proto's own severities, so a severity core names
			// the same as another (anything unrecognised) is not let through.
			diagnostics: file.diagnostics.filter((d) => !severities || severities.includes(d.severity)).map(toHostDiagnostic),
		})),
	)
}

export async function singleFileDiagnosticsToProblemsString(filePath: string, diagnostics: Diagnostic[]): Promise<string> {
	return coreSingleFileDiagnosticsToProblemsString(await getCwd(), filePath, diagnostics.map(toHostDiagnostic))
}
