/**
 * Built-in Executor Implementations
 *
 * This module provides ready-to-use implementations of the tool executors
 * using Node.js built-in modules. These can be used directly or as references
 * for custom implementations.
 */

import type { ToolExecutors } from "../types";
import {
	type ApplyPatchExecutorOptions,
	createApplyPatchExecutor,
} from "./apply-patch";
import { type AwkExecutorOptions, createAwkExecutor } from "./awk";
import { createShellExecutor, type ShellExecutorOptions } from "./bash";
import { createEditorExecutor, type EditorExecutorOptions } from "./editor";
import {
	createFileReadExecutor,
	type FileReadExecutorOptions,
} from "./file-read";
import { createGrepExecutor, type GrepExecutorOptions } from "./grep";
import { createReadReceipts, type ReadReceipts } from "./read-receipts";
import { createSearchExecutor, type SearchExecutorOptions } from "./search";
import { createSedExecutor, type SedExecutorOptions } from "./sed";
import {
	createWebFetchExecutor,
	type WebFetchExecutorOptions,
} from "./web-fetch";

// Re-export individual executors and their options types
export {
	type ApplyPatchExecutorOptions,
	computePatchChanges,
	createApplyPatchExecutor,
	type PatchFileChange,
} from "./apply-patch";
export { PATCH_MARKERS, PatchActionType } from "./apply-patch-parser";
export { type AwkExecutorOptions, createAwkExecutor } from "./awk";
export {
	CommandExitError,
	createShellExecutor,
	type ShellExecutorOptions,
} from "./bash";
export { createEditorExecutor, type EditorExecutorOptions } from "./editor";
export {
	createFileReadExecutor,
	type FileReadExecutorOptions,
} from "./file-read";
export { createGrepExecutor, type GrepExecutorOptions } from "./grep";
export { createReadReceipts, type ReadReceipts } from "./read-receipts";
export {
	RunCommandExecutionController,
	type RunningCommandRegistration,
} from "./run-command-execution-controller";
export { createSearchExecutor, type SearchExecutorOptions } from "./search";
export { createSedExecutor, type SedExecutorOptions } from "./sed";
export {
	createReadLedger,
	REFRESH_EVERY,
	type ReadLedger,
} from "./unchanged-reads";
export {
	createWebFetchExecutor,
	type WebFetchExecutorOptions,
} from "./web-fetch";

/**
 * Options for creating default executors
 */
export interface DefaultExecutorsOptions {
	fileRead?: FileReadExecutorOptions;
	search?: SearchExecutorOptions;
	bash?: ShellExecutorOptions;
	webFetch?: WebFetchExecutorOptions;
	applyPatch?: ApplyPatchExecutorOptions;
	editor?: EditorExecutorOptions;
	grep?: GrepExecutorOptions;
	sed?: SedExecutorOptions;
	awk?: AwkExecutorOptions;

	/**
	 * Record of what has been read, shared by the reader and the editor.
	 * Supply one to observe it or to span several executor sets; omit it and
	 * each set gets its own, which is the right scope for a session.
	 */
	receipts?: ReadReceipts;
}

/**
 * Create the default shell executor for the current platform.
 *
 * This is factored out from {@link createDefaultExecutors} so host integrations
 * can reuse the SDK's cross-platform shell selection while supplying their own
 * tool wrapper.
 */
export function createDefaultShellExecutor(options: ShellExecutorOptions = {}) {
	return createShellExecutor(options);
}

/**
 * Create all default executors with optional configuration
 *
 * @example
 * ```typescript
 * import { createDefaultTools, createDefaultExecutors } from "@cline/core"
 *
 * const executors = createDefaultExecutors({
 *   bash: { timeoutMs: 60000 },
 *   search: { maxResults: 50 },
 * })
 *
 * const tools = createDefaultTools({
 *   executors,
 *   cwd: "/path/to/project",
 * })
 * ```
 */
export function createDefaultExecutors(
	options: DefaultExecutorsOptions = {},
): ToolExecutors {
	// One registry, shared by the reader and the writer: the reader records
	// what was seen and the writer refuses to edit anything that was not. They
	// are useless apart, so they are wired together here rather than left to
	// each caller to remember.
	const receipts = options.receipts ?? createReadReceipts();
	// The read ledger is NOT wired by default, deliberately. Suppressing a copy
	// on the grounds that the model "already has it" is a claim about the
	// conversation that compaction can falsify, and re-reading is part of how
	// these models work. A host that wants it passes its own through
	// `fileRead.readLedger`; without one, every read returns the content.
	return {
		readFile: createFileReadExecutor({ ...options.fileRead, receipts }),
		search: createSearchExecutor(options.search),
		// Receipts reach the shell too, so a command that rewrites a file the
		// model has read says so. Nothing else about the shell changes.
		bash: createDefaultShellExecutor({ ...options.bash, receipts }),
		webFetch: createWebFetchExecutor(options.webFetch),
		applyPatch: createApplyPatchExecutor(options.applyPatch),
		editor: createEditorExecutor({ ...options.editor, receipts }),
		// The same registry as the reader and the editor, deliberately: a model
		// that greps a file has read it, and `sed -i` is an edit and is refused
		// on a file nobody read. Give these their own and both halves break
		// quietly — grep would stop counting as a read, and sed would guard
		// against a history it cannot see.
		grep: createGrepExecutor({ ...options.grep, receipts }),
		sed: createSedExecutor({ ...options.sed, receipts }),
		awk: createAwkExecutor({ ...options.awk, receipts }),
	};
}
