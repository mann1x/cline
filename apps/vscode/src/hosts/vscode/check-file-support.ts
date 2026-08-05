import { exec } from "child_process"
import * as vscode from "vscode"
import type { LintCommandResult } from "@/sdk/check-file-tool"
import { buildLintCommand } from "@/sdk/check-file-tool"

/**
 * The VS Code half of `check_file`.
 *
 * The tool itself takes every side effect as an injected function so it can be
 * tested without an editor. These are the real ones, and they live here
 * because this is the layer that is allowed to import `vscode`.
 */

/** Anything slower than this is not the "quick check" the tool promises. */
const LINT_COMMAND_TIMEOUT_MS = 20_000

/** A lint command that prints more than this is reporting on a project. */
const LINT_OUTPUT_MAX_CHARS = 8_000

/**
 * Make the language server aware of a file.
 *
 * `openTextDocument` loads the document into the editor's model without
 * showing it, which is what makes a check on a file the user never opened
 * possible without stealing their focus. VS Code caches it, so the second call
 * for the same file costs nothing.
 */
export async function loadDocumentForDiagnostics(filePath: string): Promise<void> {
	await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
}

/**
 * The command to fall back on when the editor has nothing to say about a file.
 *
 * Unset for almost everyone, and that is the intended default: the editor is
 * already right about TypeScript, Python, Go and Rust. This exists for the
 * project where it is not — a bespoke linter, a language with no server
 * installed — and costs nothing until someone sets it.
 */
export function resolveLintCommand(): string | undefined {
	const configured = vscode.workspace.getConfiguration("cline").get<string>("lintCommand")
	const trimmed = configured?.trim()
	return trimmed ? trimmed : undefined
}

/**
 * Run the configured command against one file.
 *
 * A linter says what it found on stdout, on stderr, or through its exit code,
 * depending on which linter it is — so all three are captured and a non-zero
 * exit is not treated as a failure to run. Only an error from the spawn itself
 * is.
 */
export function runLintCommand(template: string, filePath: string, signal?: AbortSignal): Promise<LintCommandResult> {
	const command = buildLintCommand(template, filePath)
	const cwd = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath

	return new Promise<LintCommandResult>((resolve, reject) => {
		const child = exec(
			command,
			{ cwd, timeout: LINT_COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const output = truncate(`${stdout ?? ""}${stderr ?? ""}`)
				// `error.code` is the exit status for a command that ran and
				// failed, which is the normal way a linter reports findings.
				// Only a command that could not run at all has no code.
				const code = (error as { code?: unknown } | null)?.code
				if (error && typeof code !== "number") {
					reject(error)
					return
				}
				resolve({ exitCode: typeof code === "number" ? code : 0, output })
			},
		)

		signal?.addEventListener("abort", () => child.kill(), { once: true })
	})
}

function truncate(output: string): string {
	if (output.length <= LINT_OUTPUT_MAX_CHARS) {
		return output
	}
	return `${output.slice(0, LINT_OUTPUT_MAX_CHARS)}\n…(truncated)`
}
