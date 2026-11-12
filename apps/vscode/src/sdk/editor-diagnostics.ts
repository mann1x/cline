// Hands the model the editor's verdict on the file it just wrote.
//
// The behaviour -- snapshot before an edit, report only what the edit
// introduced, flag an edit that made the file worse, attach the delimiter scan
// -- lives in core (`createEditorDiagnosticsHooks`), shared with every host
// that reads diagnostics from language servers of its own. This module is the
// VS Code side: the editor's diagnostics come from the host bridge as proto
// `FileDiagnostics` and are converted here, paths are written relative to the
// workspace root, failures go to the extension's logger, and each edit leaves
// a line in `<tmpdir>/cline-editor-diagnostics.jsonl`.

import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import {
	appendToOutput,
	comparablePath,
	createEditorDiagnosticsHooks as coreCreateEditorDiagnosticsHooks,
	formatIntroducedDiagnostics as coreFormatIntroducedDiagnostics,
	isReportableDiagnostic as coreIsReportableDiagnostic,
	readSettledDiagnostics as coreReadSettledDiagnostics,
	renderFileDiagnostics as coreRenderFileDiagnostics,
	type HostFileDiagnostics,
	isLintableFile,
	MAX_DIAGNOSTICS_PER_FILE,
	markRegressed,
	readTargetPaths,
	SETTLE_POLL_MS,
	SETTLE_TIMEOUT_MS,
	samePath,
} from "@cline/core"
import type { AgentHooks } from "@cline/shared"
import { toHostDiagnostic, toHostFileDiagnostics } from "@integrations/diagnostics"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { type Diagnostic, DiagnosticSeverity, type FileDiagnostics } from "@/shared/proto/index.cline"
import { Logger } from "@/shared/services/Logger"
import { getCwd } from "@/utils/path"

export {
	appendToOutput,
	comparablePath,
	isLintableFile,
	MAX_DIAGNOSTICS_PER_FILE,
	markRegressed,
	readTargetPaths,
	SETTLE_POLL_MS,
	SETTLE_TIMEOUT_MS,
	samePath,
}

/** The severities reported, in the proto's terms (core reports errors and warnings). */
export const REPORTED_SEVERITIES = [DiagnosticSeverity.DIAGNOSTIC_ERROR, DiagnosticSeverity.DIAGNOSTIC_WARNING]

export interface EditorDiagnosticsOptions {
	cwd: string
	/** Injection point for tests; defaults to the host bridge. */
	readDiagnostics?: () => Promise<FileDiagnostics[]>
	/** Injection point for tests; defaults to a real timer. */
	delay?: (ms: number) => Promise<void>
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The editor's current verdict on the whole workspace. */
export async function readHostDiagnostics(): Promise<FileDiagnostics[]> {
	return (await HostProvider.workspace.getDiagnostics({})).fileDiagnostics
}

/** A proto reader, as core reads diagnostics. */
export function toHostReader(read: () => Promise<FileDiagnostics[]>): () => Promise<HostFileDiagnostics[]> {
	return async () => (await read()).map(toHostFileDiagnostics)
}

export function isReportableDiagnostic(diagnostic: Diagnostic): boolean {
	return coreIsReportableDiagnostic(toHostDiagnostic(diagnostic))
}

/**
 * Render one file's reportable diagnostics, or an empty string when there are
 * none -- silence is the correct output for a clean edit, and the cheapest.
 */
export async function renderFileDiagnostics(filePath: string, diagnostics: readonly Diagnostic[]): Promise<string> {
	return coreRenderFileDiagnostics(await getCwd(), filePath, diagnostics.map(toHostDiagnostic))
}

export async function formatIntroducedDiagnostics(before: FileDiagnostics[], after: FileDiagnostics[]): Promise<string> {
	return coreFormatIntroducedDiagnostics(await getCwd(), before.map(toHostFileDiagnostics), after.map(toHostFileDiagnostics))
}

/**
 * Read the touched files' diagnostics once the language server has stopped
 * changing its mind, or once the budget runs out -- whichever comes first.
 */
export async function readSettledDiagnostics(
	absolutePaths: Set<string>,
	read: () => Promise<FileDiagnostics[]>,
	delay: (ms: number) => Promise<void>,
	budget: { pollMs?: number; timeoutMs?: number } = {},
): Promise<HostFileDiagnostics[]> {
	return coreReadSettledDiagnostics(absolutePaths, toHostReader(read), delay, budget)
}

/**
 * Append one line per edit to `<tmpdir>/cline-editor-diagnostics.jsonl`.
 *
 * Silence from this feature is ambiguous by design -- a clean edit and a broken
 * lookup both produce nothing -- so this records what the editor was asked
 * about, how many diagnostics it held before and after, and whether anything
 * was new. Best-effort and never throws.
 */
function appendEditorDiagnosticsTrace(entry: Record<string, unknown>): void {
	try {
		appendFileSync(
			path.join(tmpdir(), "cline-editor-diagnostics.jsonl"),
			`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
			"utf8",
		)
	} catch {
		// ignored
	}
}

/**
 * Hooks that report an edit's new diagnostics back to the model.
 *
 * Composed with the file-based hook adapter rather than folded into it: that
 * one bridges user-authored hook scripts and is disabled when the user has
 * none, and this is not optional in the same way.
 */
export function createEditorDiagnosticsHooks(options: EditorDiagnosticsOptions): AgentHooks {
	return coreCreateEditorDiagnosticsHooks({
		cwd: options.cwd,
		readDiagnostics: toHostReader(options.readDiagnostics ?? readHostDiagnostics),
		...(options.delay ? { delay: options.delay } : {}),
		displayCwd: getCwd,
		trace: appendEditorDiagnosticsTrace,
		onError: (message, error) => Logger.error(message, error),
	})
}
