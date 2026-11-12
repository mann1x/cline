import {
	buildLintCommand,
	CHECK_FILE_TOOL_NAME,
	createDiagnosticsCheckFileTool,
	DIAGNOSTICS_CHECK_FILE_TOOL_DESCRIPTION,
	DIAGNOSTICS_CHECK_FILE_TOOL_INPUT_SCHEMA,
	LINT_COMMAND_FILE_PLACEHOLDER,
	type LintCommandResult,
	type LoadedDocument,
	readRequestedPaths,
} from "@cline/core"
import type { AgentTool } from "@cline/shared"
import * as fs from "fs/promises"
import type { FileDiagnostics } from "@/shared/proto/index.cline"
import { Logger } from "@/shared/services/Logger"
import { getCwd } from "@/utils/path"
import { readHostDiagnostics, toHostReader } from "./editor-diagnostics"

/**
 * A tool that answers "is this file broken?" from the editor's language
 * servers.
 *
 * The tool lives in core (`createDiagnosticsCheckFileTool`), so the CLI and
 * automaticum's runner offer the same one over the servers they start. This is
 * the VS Code side: the editor's diagnostics from the host bridge, the editor
 * loading a file it has not opened, the user's `cline.lintCommand`, and paths
 * written relative to the workspace root.
 */

export {
	buildLintCommand,
	CHECK_FILE_TOOL_NAME,
	LINT_COMMAND_FILE_PLACEHOLDER,
	type LintCommandResult,
	type LoadedDocument,
	readRequestedPaths,
}

/** Written at the model that reaches for `run_commands`; see core for why. */
export const CHECK_FILE_TOOL_DESCRIPTION = DIAGNOSTICS_CHECK_FILE_TOOL_DESCRIPTION

/**
 * Exported so the template generator can state this tool's real call shape:
 * an example call is copied more readily than a schema is read.
 */
export const CHECK_FILE_TOOL_INPUT_SCHEMA = DIAGNOSTICS_CHECK_FILE_TOOL_INPUT_SCHEMA

export interface CheckFileToolOptions {
	cwd: string
	/** Injection point for tests; defaults to the host bridge. */
	readDiagnostics?: () => Promise<FileDiagnostics[]>
	/**
	 * Make the language server aware of a file it may never have opened.
	 * Optional: without it the tool still reports whatever the editor knows.
	 * What it returns is compared with the disk; nothing returned skips that.
	 */
	loadDocument?: (filePath: string) => Promise<LoadedDocument | undefined>
	/** The user's `cline.lintCommand`, if they set one. */
	resolveLintCommand?: () => string | undefined
	/** Runs the configured command. Injected so tests never spawn anything. */
	runLintCommand?: (template: string, filePath: string, signal?: AbortSignal) => Promise<LintCommandResult>
	/** Injection point for tests; defaults to a real timer. */
	delay?: (ms: number) => Promise<void>
}

export function createCheckFileTool(options: CheckFileToolOptions): AgentTool {
	return createDiagnosticsCheckFileTool({
		cwd: options.cwd,
		readDiagnostics: toHostReader(options.readDiagnostics ?? readHostDiagnostics),
		...(options.loadDocument ? { loadDocument: options.loadDocument } : {}),
		...(options.resolveLintCommand ? { resolveLintCommand: options.resolveLintCommand } : {}),
		...(options.runLintCommand ? { runLintCommand: options.runLintCommand } : {}),
		...(options.delay ? { delay: options.delay } : {}),
		displayCwd: getCwd,
		readFile: (filePath) => fs.readFile(filePath, "utf-8"),
		onError: (message, error) => Logger.error(message, error),
	})
}
