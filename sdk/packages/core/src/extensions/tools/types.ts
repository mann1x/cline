/**
 * Types for Default Tools
 *
 * Type definitions for executors, configuration, and results.
 */

import type {
	AgentToolContext,
	ImageContent,
	ITelemetryService,
	TextContent,
} from "@cline/shared";
import type {
	ApplyPatchInput,
	EditFileInput,
	ReadFileRequest,
	StructuredCommandInput,
} from "./schemas";
import type { QaCredential } from "./qa-credentials";
import type { TaskProgressTracker } from "./task-progress";

// =============================================================================
// Tool Result Types
// =============================================================================

/**
 * Result from a single tool operation
 */
export interface ToolOperationResult {
	/** The query/input that was executed */
	query: string;
	/** The result content (if successful) */
	result: unknown;
	/** Error message (if failed) */
	error?: string;
	/** Whether the operation succeeded */
	success: boolean;
	/** Duration in MS */
	duration?: number;
}

export type FileReadResultContent = string | Array<TextContent | ImageContent>;

// =============================================================================
// Executor Interfaces
// =============================================================================

/**
 * Executor for reading files
 *
 * @param request - File path and optional inclusive line range to read
 * @param context - Tool execution context
 * @returns The file content as a string
 */
export type FileReadExecutor = (
	request: ReadFileRequest,
	context: AgentToolContext,
) => Promise<FileReadResultContent>;

/**
 * Executor for searching the codebase
 *
 * @param query - Regex pattern to search for
 * @param cwd - Current working directory for the search
 * @param context - Tool execution context
 * @returns Search results as a formatted string
 */
/** Per-call overrides for one search, on top of the executor's defaults. */
export interface SearchQueryOptions {
	/** Lines shown either side of a match. */
	contextLines?: number;
	/**
	 * Matches reported per file. One by default, which answers "which files
	 * mention this" and cannot answer "how many times, and where".
	 */
	maxPerFile?: number;
}

export type SearchExecutor = (
	query: string,
	cwd: string,
	context: AgentToolContext,
	options?: SearchQueryOptions,
) => Promise<string>;

/**
 * Per-call execution options for a shell executor.
 */
export interface ShellExecutionOptions {
	/**
	 * Environment for this command and no other.
	 *
	 * Separate from the executor's own `env` because it carries QA credentials,
	 * which are scoped to the single command that asked for them. An executor
	 * that cannot honour per-command environment -- a persistent terminal, where
	 * anything exported outlives the command -- must not silently ignore this;
	 * see the VS Code `run_commands` tool, which routes such a command to a
	 * child process instead.
	 */
	env?: Record<string, string>;
	/**
	 * Names to strip from the inherited environment before `env` is applied.
	 *
	 * Without this the gate is decorative wherever the host itself holds the
	 * secret: the CLI is started with `QA_PASSWORD` exported, `spawn` inherits
	 * the parent environment, and every command in the run sees it whether it
	 * asked or not. Withholding the declared names and re-adding only the ones a
	 * command asked for gives that host the same guarantee as one with a secret
	 * store.
	 */
	withhold?: readonly string[];
}

/**
 * Executor for running shell commands
 *
 * @param command - Shell command to execute
 * @param cwd - Current working directory for execution
 * @param context - Tool execution context
 * @param options - Per-call options, currently the command's own environment
 * @returns Command output (stdout)
 */
export type ShellExecutor = (
	command: string | StructuredCommandInput,
	cwd: string,
	context: AgentToolContext,
	options?: ShellExecutionOptions,
) => Promise<string>;

/**
 * Executor for fetching web content
 *
 * @param url - URL to fetch
 * @param prompt - Analysis prompt for the content
 * @param context - Tool execution context
 * @returns Analyzed/extracted content
 */
export type WebFetchExecutor = (
	url: string,
	prompt: string,
	context: AgentToolContext,
) => Promise<string>;

/**
 * Executor for editing files
 *
 * @param input - Editor command input
 * @param cwd - Current working directory for filesystem operations
 * @param context - Tool execution context
 * @returns A formatted operation result string
 */
export type EditorExecutor = (
	input: EditFileInput,
	cwd: string,
	context: AgentToolContext,
) => Promise<string>;

/**
 * Executor for apply_patch operations
 *
 * @param input - apply_patch command payload
 * @param cwd - Current working directory for filesystem operations
 * @param context - Tool execution context
 * @returns A formatted operation result string
 */
export type ApplyPatchExecutor = (
	input: ApplyPatchInput,
	cwd: string,
	context: AgentToolContext,
) => Promise<string>;

/**
 * Executor for invoking configured skills
 *
 * @param skill - Skill name to invoke
 * @param args - Optional arguments for the skill
 * @param context - Tool execution context
 * @returns Skill loading/invocation result
 */
export type SkillsExecutor = (
	skill: string,
	args: string | undefined,
	context: AgentToolContext,
) => Promise<string>;

/**
 * Executor for asking a single follow-up question with selectable options
 *
 * @param question - Single clarifying question for the user
 * @param options - 2-5 selectable answer options
 * @param context - Tool execution context
 * @returns Executor-specific result payload
 */
export type AskQuestionExecutor = (
	question: string,
	options: string[],
	context: AgentToolContext,
) => Promise<string>;

/**
 * Skill metadata exposed by SkillsExecutor for clients/UI
 */
export interface SkillsExecutorSkillMetadata {
	/** Normalized skill id (usually lowercased name) */
	id: string;
	/** Display name for the skill */
	name: string;
	/** Optional short description */
	description?: string;
	/** True when configured but intentionally disabled */
	disabled: boolean;
}

/**
 * A callable executor that can also expose configured skill metadata.
 */
export interface SkillsExecutorWithMetadata {
	(
		skill: string,
		args: string | undefined,
		context: AgentToolContext,
	): Promise<string>;
	configuredSkills?: SkillsExecutorSkillMetadata[];
}

/**
 * Executor for verifying a user's response to a question
 *
 * @param summary - Summary of the solution ans steps taken
 * @param verified - Boolean indicating if the solution has been verified
 * @param context - Tool execution context
 * @returns Executor-specific result payload
 */
export type VerifySubmitExecutor = (
	summary: string,
	verified: boolean,
	context: AgentToolContext,
) => Promise<string>;

/**
 * Collection of all tool executors
 */
export interface ToolExecutors {
	/** File reading implementation */
	readFile?: FileReadExecutor;
	/** Codebase search implementation */
	search?: SearchExecutor;
	/** Shell command execution implementation */
	bash?: ShellExecutor;
	/** Web content fetching implementation */
	webFetch?: WebFetchExecutor;
	/** Filesystem editor implementation */
	editor?: EditorExecutor;
	/** Apply patch implementation */
	applyPatch?: ApplyPatchExecutor;
	/** Skill invocation implementation */
	skills?: SkillsExecutorWithMetadata;
	/** Follow-up question implementation */
	askQuestion?: AskQuestionExecutor;
	/** Final submission implementation */
	submit?: VerifySubmitExecutor;
}

// =============================================================================
// Tool Configuration
// =============================================================================

/**
 * Names of available default tools
 */
export type DefaultToolName =
	| "read_files"
	| "search_codebase"
	| "run_commands"
	| "fetch_web_content"
	| "apply_patch"
	| "editor"
	| "skills"
	| "ask_question"
	| "submit_and_exit";

/**
 * Configuration for enabling/disabling default tools
 */
export interface DefaultToolsConfig {
	/**
	 * QA credentials available to `run_commands`, from the host's secret store.
	 * A function when the set can change while a session runs.
	 */
	qaCredentials?: readonly QaCredential[] | (() => readonly QaCredential[]);

	/**
	 * Host telemetry service, injected at tool construction time. Tools that
	 * emit operational telemetry (e.g. run_commands timeouts) close over this
	 * service. It is a live host object and must never travel on the per-call
	 * AgentToolContext, which crosses process boundaries over JSON IPC.
	 */
	telemetry?: ITelemetryService;

	/**
	 * Enable the read_files tool
	 * @default true
	 */
	enableReadFiles?: boolean;

	/**
	 * Enable the search_codebase tool
	 * @default true
	 */
	enableSearch?: boolean;

	/**
	 * Enable the run_commands tool
	 * @default true
	 */
	enableBash?: boolean;

	/**
	 * Enable the fetch_web_content tool
	 * @default true
	 */
	enableWebFetch?: boolean;

	/**
	 * Enable the apply_patch tool
	 * @default true
	 */
	enableApplyPatch?: boolean;

	/**
	 * Enable the editor tool
	 * @default true
	 */
	enableEditor?: boolean;

	/**
	 * Enable the skills tool
	 * @default true
	 */
	enableSkills?: boolean;

	/**
	 * Enable the ask_followup_question tool
	 * @default true
	 */
	enableAskQuestion?: boolean;

	/**
	 * Enable the submit_and_exit tool
	 * @default false
	 */
	enableSubmitAndExit?: boolean;

	/**
	 * Current working directory for tools that need it
	 */
	cwd?: string;

	/**
	 * Shell executable (name or full path) the run_commands executor will use.
	 * The tool description tells the model which shell syntax to write, so this
	 * must match the shell configured on the executor.
	 * @default getDefaultShell(process.platform) — "/bin/bash" on Unix, "powershell" on Windows
	 */
	shell?: string;

	/**
	 * Timeout for file read operations in milliseconds
	 * @default 10000
	 */
	fileReadTimeoutMs?: number;

	/**
	 * Timeout for bash command execution in milliseconds
	 * @default 30000
	 */
	bashTimeoutMs?: number;

	/**
	 * Timeout for web fetch operations in milliseconds
	 * @default 30000
	 */
	webFetchTimeoutMs?: number;

	/**
	 * Timeout for search operations in milliseconds
	 * @default 30000
	 */
	searchTimeoutMs?: number;

	/**
	 * Timeout for apply_patch operations in milliseconds
	 * @default 30000
	 */
	applyPatchTimeoutMs?: number;

	/**
	 * Timeout for editor operations in milliseconds
	 * @default 30000
	 */
	editorTimeoutMs?: number;

	/**
	 * Timeout for skills operations in milliseconds
	 * @default 15000
	 */
	skillsTimeoutMs?: number;

	/**
	 * Timeout for submit_and_exit operations in milliseconds
	 * @default 15000
	 */
	submitTimeoutMs?: number;
}

/**
 * Options for creating default tools
 */
export interface CreateDefaultToolsOptions extends DefaultToolsConfig {
	/**
	 * Executor implementations for the tools
	 * Only tools with provided executors will be available
	 */
	executors: ToolExecutors;
	/**
	 * Session-scoped checklist tracker. When provided, every tool gains the
	 * optional `task_progress` parameter, and results carry the checklist back
	 * to the model periodically.
	 *
	 * Absent by default: the tracker holds per-session state, so a shared or
	 * missing one is the difference between a checklist and a leak between
	 * tasks. Hosts opt in by constructing one per session.
	 */
	taskProgress?: TaskProgressTracker;
}
