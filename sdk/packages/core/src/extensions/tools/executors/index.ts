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
import { createShellExecutor, type ShellExecutorOptions } from "./bash";
import { createEditorExecutor, type EditorExecutorOptions } from "./editor";
import {
	createFileReadExecutor,
	type FileReadExecutorOptions,
} from "./file-read";
import { createReadReceipts, type ReadReceipts } from "./read-receipts";
import { createSearchExecutor, type SearchExecutorOptions } from "./search";
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
export { createReadReceipts, type ReadReceipts } from "./read-receipts";
export {
	RunCommandExecutionController,
	type RunningCommandRegistration,
} from "./run-command-execution-controller";
export { createSearchExecutor, type SearchExecutorOptions } from "./search";
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
	return {
		readFile: createFileReadExecutor({ ...options.fileRead, receipts }),
		search: createSearchExecutor(options.search),
		bash: createDefaultShellExecutor(options.bash),
		webFetch: createWebFetchExecutor(options.webFetch),
		applyPatch: createApplyPatchExecutor(options.applyPatch),
		editor: createEditorExecutor({ ...options.editor, receipts }),
	};
}
