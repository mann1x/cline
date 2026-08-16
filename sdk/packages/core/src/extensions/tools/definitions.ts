/**
 * Default AgentTool Definitions
 *
 * Factory functions for creating the default tools.
 */

import {
	type AgentTool,
	type AgentToolContext,
	createTool,
	getDefaultShell,
	getShellKind,
	type ITelemetryService,
	type ShellKind,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { captureRunCommandsTimeout } from "../../services/telemetry/core-events";
import { CommandExitError } from "./executors/bash";
import {
	MAX_COMMAND_OUTPUT_CHARS,
	MAX_READ_LINES,
	MAX_READ_OUTPUT_CHARS,
	MAX_SEARCH_OUTPUT_CHARS,
} from "./executors/output-limits";
import {
	coalesceOrphanReadRanges,
	expandBracketedPathLists,
	formatError,
	formatReadFileQuery,
	formatRunCommandQueryPreview,
	getEditorSizeError,
	getReadFileRangeError,
	normalizeRunCommandsInput,
	TimeoutError,
	withTimeout,
} from "./helpers";
import {
	createSecretRedactor,
	describeQaCredentials,
	type QaCredential,
	qaCredentialNames,
	resolveCredentialEnv,
} from "./qa-credentials";
import {
	type ApplyPatchInput,
	ApplyPatchInputSchema,
	ApplyPatchInputUnionSchema,
	type AskQuestionInput,
	AskQuestionInputSchema,
	type EditFileInput,
	EditFileInputSchema,
	type FetchWebContentInput,
	FetchWebContentInputSchema,
	LooseFetchWebContentInputSchema,
	type ReadFileRequest,
	type ReadFilesInput,
	ReadFilesInputSchema,
	ReadFilesInputUnionSchema,
	RunCommandsInputSchema,
	type SearchCodebaseInput,
	SearchCodebaseInputSchema,
	SearchCodebaseUnionInputSchema,
	type SkillsInput,
	SkillsInputSchema,
	type StructuredCommandInput,
	type SubmitInput,
	SubmitInputSchema,
	withNewTextAlias,
} from "./schemas";
import {
	TASK_PROGRESS_PARAM,
	TASK_PROGRESS_PARAM_DESCRIPTION,
	withTaskProgressCapture,
} from "./task-progress";
import type {
	ApplyPatchExecutor,
	AskQuestionExecutor,
	CreateDefaultToolsOptions,
	DefaultToolsConfig,
	EditorExecutor,
	FileReadExecutor,
	SearchExecutor,
	ShellExecutor,
	SkillsExecutorWithMetadata,
	ToolOperationResult,
	VerifySubmitExecutor,
	WebFetchExecutor,
} from "./types";

// =============================================================================
// Helper Functions
// =============================================================================

function getStringMetadata(
	context: AgentToolContext,
	key: string,
): string | undefined {
	const value = context.metadata?.[key];
	return typeof value === "string" ? value : undefined;
}

function captureRunCommandsTimeoutFromContext(
	telemetry: ITelemetryService | undefined,
	context: AgentToolContext,
	properties: {
		effectiveTimeoutMs: number;
		timeoutSource: "default_setting" | "configured_setting";
		commandCount: number;
		durationMs: number;
	},
): void {
	captureRunCommandsTimeout(telemetry, {
		tool_name: "run_commands",
		effective_timeout_ms: properties.effectiveTimeoutMs,
		timeout_source: properties.timeoutSource,
		command_count: properties.commandCount,
		duration_ms: properties.durationMs,
		ulid: context.sessionId,
		mode: getStringMetadata(context, "mode"),
		source: getStringMetadata(context, "source"),
		session_id: context.sessionId,
		agent_id: context.agentId,
		conversation_id: context.conversationId,
		run_id: context.runId,
		iteration: context.iteration,
		tool_call_id: context.toolCallId,
	});
}

function getHeredocDelimiter(command: string): string | undefined {
	const match = command.match(
		/(?<![<])<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))/,
	);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function coalesceSplitHeredocCommands(commands: string[]): string[] {
	const coalesced: string[] = [];
	for (let index = 0; index < commands.length; index += 1) {
		const command = commands[index];
		const delimiter = getHeredocDelimiter(command);
		if (!delimiter) {
			coalesced.push(command);
			continue;
		}

		const endIndex = commands.findIndex(
			(nextCommand, nextIndex) =>
				nextIndex > index && nextCommand.trim() === delimiter,
		);
		if (endIndex === -1) {
			coalesced.push(command);
			continue;
		}

		const parts = [command];
		while (index < endIndex) {
			index += 1;
			const nextCommand = commands[index];
			parts.push(nextCommand);
		}
		coalesced.push(parts.join("\n"));
	}
	return coalesced;
}

function coalesceAdjacentStringHeredocs(
	commands: Array<string | StructuredCommandInput>,
): Array<string | StructuredCommandInput> {
	const coalesced: Array<string | StructuredCommandInput> = [];
	let stringRun: string[] = [];

	const flushStringRun = () => {
		if (stringRun.length > 0) {
			coalesced.push(...coalesceSplitHeredocCommands(stringRun));
			stringRun = [];
		}
	};

	for (const command of commands) {
		if (typeof command === "string") {
			stringRun.push(command);
			continue;
		}

		flushStringRun();
		coalesced.push(command);
	}

	flushStringRun();
	return coalesced;
}

/**
 * The credentials a call asked for, off the raw input.
 *
 * Read defensively rather than through the schema because `run_commands`
 * accepts a union of nine input shapes -- a bare string, an argv list, a single
 * command object -- and only the object form can carry this field at all. A
 * model that puts it somewhere else gets no credentials rather than a
 * validation failure that loses the whole call.
 */
function readRequestedCredentials(input: unknown): string[] {
	if (typeof input !== "object" || input === null) {
		return [];
	}
	const requested = (input as { credentials?: unknown }).credentials;
	if (typeof requested === "string") {
		return [requested];
	}
	if (!Array.isArray(requested)) {
		return [];
	}
	return requested.filter((name): name is string => typeof name === "string");
}

async function executeShellCommands(
	commands: Array<string | StructuredCommandInput>,
	options: {
		executor: ShellExecutor;
		cwd: string;
		context: AgentToolContext;
		timeoutMs: number;
		timeoutSource: "default_setting" | "configured_setting";
		telemetry?: ITelemetryService;
		/** QA credentials this call may draw on; see `qa-credentials.ts`. */
		credentials?: readonly QaCredential[];
		/** Names the call asked for, for a command that references none by text. */
		requestedCredentials?: readonly string[];
	},
): Promise<ToolOperationResult[]> {
	const { executor, cwd, context, timeoutMs, timeoutSource, telemetry } =
		options;
	const credentials = options.credentials ?? [];
	// Built once for the call, and applied to every result rather than only to
	// the commands that received a credential. A command that was given nothing
	// can still print one -- out of a config file it read, out of a framework
	// that resolved its own environment -- and that is the leak worth catching.
	const redact = createSecretRedactor(credentials);
	const withheldNames = qaCredentialNames([...credentials]);

	return Promise.all(
		commands.map(async (command): Promise<ToolOperationResult> => {
			const startedAt = Date.now();
			// The command itself is echoed back as `query`, so a value the model
			// inlined instead of referencing would return in the transcript from
			// here even if the command printed nothing.
			const query = redact(formatRunCommandQueryPreview(command));
			const env = resolveCredentialEnv(credentials, {
				command,
				requested: options.requestedCredentials,
			});
			try {
				const output = await withTimeout(
					// Called with three arguments when there is nothing to say, so
					// an executor that has never heard of per-call options sees the
					// call it has always seen.
					//
					// `withhold` goes on every command once any credential exists,
					// including the ones that get nothing: its job is to take the
					// declared names *out* of the inherited environment, which
					// matters most for the commands that did not ask.
					credentials.length > 0
						? executor(command, cwd, context, {
								...(Object.keys(env).length > 0 ? { env } : {}),
								withhold: withheldNames,
							})
						: executor(command, cwd, context),
					timeoutMs,
					`Command timed out after ${timeoutMs}ms`,
				);
				return {
					query,
					result: redact(output),
					success: true,
				};
			} catch (error) {
				if (error instanceof TimeoutError) {
					captureRunCommandsTimeoutFromContext(telemetry, context, {
						effectiveTimeoutMs: error.timeoutMs,
						timeoutSource,
						commandCount: commands.length,
						durationMs: Date.now() - startedAt,
					});
				}
				if (error instanceof CommandExitError) {
					return {
						query,
						result: redact(error.output),
						error: redact(error.message),
						success: false,
					};
				}
				const msg = formatError(error);
				return {
					query,
					result: "",
					error: redact(`Command failed: ${msg}`),
					success: false,
				};
			}
		}),
	);
}

// =============================================================================
// AgentTool Factory Functions
// =============================================================================

/**
 * What comes back, said once, in the words the tools actually use.
 *
 * Every tool here is described in terms of what it does and none of them in
 * terms of what they hand back, so a model reading the descriptions has no way
 * to know that the answer to `read_files` is an array of `{query, result}`
 * rather than the file's text. It finds out by receiving one, which costs it a
 * turn of inference at best; watched against small models it costs more than
 * that, because a result it cannot map onto its request looks like a tool that
 * did not work, and a tool that does not work gets replaced by `cat`.
 *
 * `query` is the part worth naming. These tools are batched — several paths,
 * several patterns, several commands in one call — so the entries have to be
 * matched back to the requests, and `query` is what they are matched by.
 */
const TOOL_RESULT_ENVELOPE =
	"`{query, result, success, error?}`, where a failed entry has `success: false` and the reason in `error`.";

/**
 * What a successful read with no content is told to mean.
 *
 * A range whose start is past the end of the file is not an error — the read
 * succeeds and returns nothing. To a model that is paging through a file, an
 * empty successful result reads as "nothing here yet, try again", and it does:
 * measured against a local model, 15 identical `read_files` calls in a row,
 * which no instruction and no output budget broke out of, because every one of
 * them looked like a retryable miss. Saying what the emptiness means, and that
 * there is nothing further to ask for, is what ends the loop.
 */
export const EMPTY_READ_EXPLANATION =
	"[no content returned: the requested line range starts past the end of this file, or the file is empty. Do not request another range for this file - use the content you already have.]";

/**
 * Create the read_files tool
 *
 * Reads the content of one or more files from the filesystem.
 */
export function createReadFilesTool(
	executor: FileReadExecutor,
	config: Pick<DefaultToolsConfig, "fileReadTimeoutMs"> = {},
): AgentTool<ReadFilesInput, ToolOperationResult[]> {
	const timeoutMs = config.fileReadTimeoutMs ?? 10000;

	return createTool<ReadFilesInput, ToolOperationResult[]>({
		name: "read_files",
		description:
			"Read the content of text or image files at the provided absolute paths, or return only an inclusive one-based line range when start_line/end_line are provided on the same file entry as its path. " +
			"When you already know multiple files you need, read them together in one call, and call this tool in the same response as other independent tool calls. " +
			`Each read returns at most ${MAX_READ_LINES} lines / ~${Math.round(MAX_READ_OUTPUT_CHARS / 1024)}k characters; longer files report their total line count, page through them with start_line/end_line on that file's entry. ` +
			"Reading a range is the normal case; reading a file whole is the exception. Locate first, then read: a diagnostic or a stack trace already names the line, `search_codebase` reports the line every match is on, and `code_intel` resolves a symbol to where it is defined. " +
			"Any of those hands you a line number to read around — take roughly 30 lines either side of it, and widen only if what you needed turned out to fall outside that. Read a file entire only when you have no line to start from and it is genuinely small. " +
			"The cost of reading more than you need is not the tool call: every line returned stays in the conversation for the rest of the task, crowding out the room left to reason about it. " +
			"Binary files that are not image and large files are not supported. " +
			`Output: one object per requested file, in the order requested — ${TOOL_RESULT_ENVELOPE} \`query\` echoes the path you asked for (as \`path:start-end\` when you gave a range), and \`result\` is that file's content, with every line prefixed by its number as \`  92 | text\`. ` +
			"Those numbers are how you address an edit, and they are not in the file. Never paste them into another tool: text carrying a `92 | ` prefix will not match anything. When you are reading in order to copy text into `editor`, set `line_numbers: false` on that file's entry and get it clean. ",
		inputSchema: zodToJsonSchema(ReadFilesInputSchema),
		timeoutMs: timeoutMs * 2, // Account for multiple files
		retryable: true,
		maxRetries: 1,
		execute: async (input, context) => {
			const validate = validateWithZod(
				ReadFilesInputUnionSchema,
				coalesceOrphanReadRanges(expandBracketedPathLists(input)),
			);
			let requests: ReadFileRequest[];
			if (typeof validate === "string") {
				requests = [{ path: validate }];
			} else if (Array.isArray(validate)) {
				requests = validate.map((value) =>
					typeof value === "string" ? { path: value } : value,
				);
			} else if ("files" in validate) {
				const files = Array.isArray(validate.files)
					? validate.files
					: [validate.files];
				requests = files.map((file) =>
					typeof file === "string" ? { path: file } : file,
				);
			} else if ("file_paths" in validate) {
				const filePaths = Array.isArray(validate.file_paths)
					? validate.file_paths
					: [validate.file_paths];
				requests = filePaths.map((path) => ({ path }));
			} else if ("paths" in validate) {
				const paths = Array.isArray(validate.paths)
					? validate.paths
					: [validate.paths];
				requests = paths.map((path) =>
					typeof path === "string" ? { path } : path,
				);
			} else {
				requests = [validate];
			}

			return Promise.all(
				requests.map(async (request): Promise<ToolOperationResult> => {
					const rangeError = getReadFileRangeError(request);
					if (rangeError) {
						return {
							query: formatReadFileQuery(request),
							result: "",
							error: `Invalid file range: ${rangeError}`,
							success: false,
						};
					}

					try {
						const content = await withTimeout(
							executor(request, context),
							timeoutMs,
							`File read timed out after ${timeoutMs}ms`,
						);
						return {
							query: formatReadFileQuery(request),
							result:
								typeof content === "string" && content.trim() === ""
									? EMPTY_READ_EXPLANATION
									: content,
							success: true,
						};
					} catch (error) {
						const msg = formatError(error);
						return {
							query: formatReadFileQuery(request),
							result: "",
							error: `Error reading file: ${msg}`,
							success: false,
						};
					}
				}),
			);
		},
	});
}

/**
 * Create the search_codebase tool
 *
 * Performs regex pattern searches across the codebase.
 */
export function createSearchTool(
	executor: SearchExecutor,
	config: Pick<DefaultToolsConfig, "cwd" | "searchTimeoutMs"> = {},
): AgentTool<SearchCodebaseInput, ToolOperationResult[]> {
	const timeoutMs = config.searchTimeoutMs ?? 30000;
	const cwd = config.cwd ?? process.cwd();

	return createTool<SearchCodebaseInput, ToolOperationResult[]>({
		name: "search_codebase",
		description:
			"Perform regex pattern searches across the codebase. " +
			"Supports multiple parallel searches. When several search patterns could be useful and do not depend on each other, run them together in one call, and call this tool in the same response as other independent tool calls. " +
			"Use for finding code patterns, function definitions, class names, imports, etc. " +
			"It reports one match per file by default, which answers which files mention something. To find every occurrence inside a file — how many times a name appears and where each one is — raise `max_per_file`. `context_lines` sets how many lines are shown either side of a match, 2 by default. " +
			`Output beyond ~${Math.round(MAX_SEARCH_OUTPUT_CHARS / 1000)}k characters per query is middle-truncated; narrow patterns beat broad ones. ` +
			`Output: one object per pattern — ${TOOL_RESULT_ENVELOPE} \`query\` is the pattern you sent and \`result\` is the matching lines with their file paths. A pattern that matched nothing still has \`success: true\` with an empty \`result\`; that is an answer, not a failure, and re-running it will not change it.`,
		inputSchema: zodToJsonSchema(SearchCodebaseInputSchema),
		timeoutMs: timeoutMs * 2,
		retryable: true,
		maxRetries: 1,
		execute: async (input, context) => {
			// Validate input with Zod schema. Every branch of the union normalises
			// to `{ queries: string[] }` with the options alongside it, so which
			// shape the model chose is no longer this function's problem.
			const validated = validateWithZod(SearchCodebaseUnionInputSchema, input);
			const queries = validated.queries;
			// Left undefined when neither was sent, so the executor keeps applying
			// its own defaults rather than being handed two explicit undefineds.
			const queryOptions =
				validated.context_lines != null || validated.max_per_file != null
					? {
							contextLines: validated.context_lines ?? undefined,
							maxPerFile: validated.max_per_file ?? undefined,
						}
					: undefined;

			return Promise.all(
				queries.map(async (query): Promise<ToolOperationResult> => {
					try {
						const results = await withTimeout(
							executor(query, cwd, context, queryOptions),
							timeoutMs,
							`Search timed out after ${timeoutMs}ms`,
						);
						return {
							query,
							result: results,
							success: true,
						};
					} catch (error) {
						const msg = formatError(error);
						return {
							query,
							result: "",
							error: `Search failed: ${msg}`,
							success: false,
						};
					}
				}),
			);
		},
	});
}

const RUN_COMMANDS_SHARED_INSTRUCTIONS =
	"Use for listing files, checking git status, running builds, executing tests, etc. " +
	"Commands must be non-interactive. Commands that require follow-up input like pagers should be skipped or used with supported flags/env (e.g. git --no-pager, --non-interactive) to bypass the interaction steps. ";

/**
 * Said separately from the envelope because the failure case is the useful
 * part: a command that exits non-zero is exactly the command whose output the
 * model needs, and `success: false` reads as "there is nothing here".
 */
const RUN_COMMANDS_OUTPUT =
	`Output: one object per command — ${TOOL_RESULT_ENVELOPE} \`query\` is the command and \`result\` is its combined stdout and stderr. ` +
	"A non-zero exit sets `success: false` and describes the exit in `error`, but `result` still holds everything the command printed — read it, that is where the compiler or test failure is.";

/**
 * Build the run_commands tool description for the shell that will actually
 * execute the commands. The shell kind decides the syntax guidance (quoting,
 * sequencing, heredocs), and isWindows adds environment context for POSIX
 * shells running on a Windows host (e.g. Git Bash).
 */
export function buildRunCommandsDescription(
	shellKind: ShellKind,
	isWindows: boolean,
): string {
	if (shellKind === "powershell" || shellKind === "cmd") {
		const shellName = shellKind === "powershell" ? "PowerShell" : "cmd.exe";
		const sequencingOperator = shellKind === "powershell" ? "';'" : "'&&'";
		return (
			"Run non-interactive shell commands from the root of the workspace in Windows environment. " +
			RUN_COMMANDS_SHARED_INSTRUCTIONS +
			`Output beyond ~${Math.round(MAX_COMMAND_OUTPUT_CHARS / 1000)}k characters is middle-truncated (start and end preserved); filter output when you need specific sections. ` +
			`Commands run through ${shellName}; quote paths and arguments for ${shellName} and use ${sequencingOperator} to sequence commands. ` +
			"Include multiple commands in the same call when they are independent and safe to run concurrently. When independent reads, searches, or edits are also needed, call those tools in the same response. " +
			RUN_COMMANDS_OUTPUT
		);
	}

	const environmentNote =
		shellKind === "wsl"
			? "Commands run through bash in WSL (wsl.exe); the Windows working directory is mounted under /mnt/<drive>. "
			: isWindows
				? "Commands run through a POSIX (bash-compatible) shell on Windows. "
				: "";
	return (
		"Run non-interactive shell commands from the root of the workspace. " +
		RUN_COMMANDS_SHARED_INSTRUCTIONS +
		environmentNote +
		"Commands should be properly shell-escaped and targeted to avoid error or timeout. Include multiple commands in the same call when they are independent complete shell commands and safe to run concurrently; multiline scripts and heredocs must be a single command string. When independent reads, searches, or edits are also needed, call those tools in the same response. " +
		`Output beyond ~${Math.round(MAX_COMMAND_OUTPUT_CHARS / 1000)}k characters is middle-truncated (start and end preserved); pipe through grep/head/tail when you need specific sections of large output. ` +
		"For long-running commands, run them in background and redirect output to a tmp file that you can read from later. " +
		RUN_COMMANDS_OUTPUT
	);
}

/**
 * Create the run_commands shell tool for the current platform.
 *
 * This preserves the SDK's platform-specific prompting/schema choices while
 * exposing a single generic shell-tool factory for host integrations. Pass
 * config.shell (matching the executor's shell) so the syntax guidance in the
 * tool description matches the shell that actually runs the commands.
 *
 * config.shell may be a provider function instead of a string. The runtime
 * reads `description` when building each model request, so a provider is
 * consulted at that boundary: a shell change made while the model is
 * generating does not affect the request in flight, and the next request
 * names the new shell. The provider must return the shell the executor will
 * use for tool calls issued by that next request.
 */
export function createShellTool(
	executor: ShellExecutor,
	config: Pick<DefaultToolsConfig, "cwd" | "bashTimeoutMs" | "telemetry"> & {
		shell?: string | (() => string);
		/**
		 * QA credentials the user configured.
		 *
		 * A provider rather than a list because the set is editable while a
		 * session runs, and because reading it late keeps the values out of this
		 * closure until a command actually needs one.
		 */
		qaCredentials?: readonly QaCredential[] | (() => readonly QaCredential[]);
	} = {},
): AgentTool<unknown, ToolOperationResult[]> {
	const timeoutMs = config.bashTimeoutMs ?? 30000;
	const timeoutSource =
		config.bashTimeoutMs === undefined
			? "default_setting"
			: "configured_setting";
	const cwd = config.cwd ?? process.cwd();
	const isWindows = process.platform === "win32";
	const configShell = config.shell;
	const resolveShell =
		typeof configShell === "function"
			? configShell
			: () => configShell ?? getDefaultShell(process.platform);
	const configCredentials = config.qaCredentials;
	const resolveCredentials = (): readonly QaCredential[] =>
		typeof configCredentials === "function"
			? configCredentials()
			: (configCredentials ?? []);
	const describe = () =>
		buildRunCommandsDescription(getShellKind(resolveShell()), isWindows) +
		describeQaCredentials(qaCredentialNames([...resolveCredentials()]));

	const tool = createTool<unknown, ToolOperationResult[]>({
		name: "run_commands",
		description: describe(),
		inputSchema: zodToJsonSchema(RunCommandsInputSchema),
		timeoutMs: timeoutMs * 2,
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const commands = coalesceAdjacentStringHeredocs(
				normalizeRunCommandsInput(input),
			);

			return executeShellCommands(commands, {
				executor,
				cwd,
				context,
				timeoutMs,
				timeoutSource,
				telemetry: config.telemetry,
				credentials: resolveCredentials(),
				requestedCredentials: readRequestedCredentials(input),
			});
		},
	});

	if (typeof configShell === "function" || configCredentials !== undefined) {
		// The runtime rebuilds tool definitions from this property for every
		// model request, so a getter re-derives the description at exactly the
		// send-to-model boundary. AgentTool consumers only read `description`.
		// Credentials get the same treatment for the same reason: one added
		// mid-session should be nameable on the next request, not the next run.
		Object.defineProperty(tool, "description", {
			get: describe,
			enumerable: true,
		});
	}
	return tool;
}

/**
 * The checklist as a tool in its own right.
 *
 * It carries no behaviour: `withTaskProgressCapture` reads the checklist off
 * the raw input of every tool call, this one included, so the work is already
 * done by the time `execute` runs. What it adds is a name the model can call
 * when it has nothing else to do at that moment -- which is exactly when a
 * plan is usually written, and exactly when there is no other call to attach
 * it to.
 */
export function createTaskProgressTool(): AgentTool<
	Record<string, unknown>,
	ToolOperationResult[]
> {
	return createTool<Record<string, unknown>, ToolOperationResult[]>({
		name: TASK_PROGRESS_PARAM,
		description:
			"Record the checklist for this task without doing anything else. " +
			"Prefer sending `task_progress` alongside a tool call you are already making — it costs no extra step. " +
			"Use this tool when you have no such call to make: writing the plan before starting, or ticking the last box at the end. " +
			`Format: one item per line, "- [ ] pending" or "- [x] done".`,
		inputSchema: {
			type: "object",
			properties: {
				[TASK_PROGRESS_PARAM]: {
					type: "string",
					description: TASK_PROGRESS_PARAM_DESCRIPTION,
				},
			},
			required: [TASK_PROGRESS_PARAM],
		},
		retryable: false,
		maxRetries: 0,
		execute: async (input) => {
			const checklist = input?.[TASK_PROGRESS_PARAM];
			const recorded = typeof checklist === "string" && checklist.trim() !== "";
			return [
				{
					query: "task_progress",
					result: recorded
						? "Checklist recorded."
						: "No checklist sent, so nothing changed. Send the list as the `task_progress` argument.",
					success: recorded,
				},
			];
		},
	});
}

/**
 * Create the fetch_web_content tool
 *
 * Fetches content from URLs and analyzes them using provided prompts.
 */
export function createWebFetchTool(
	executor: WebFetchExecutor,
	config: Pick<DefaultToolsConfig, "webFetchTimeoutMs"> = {},
): AgentTool<FetchWebContentInput, ToolOperationResult[]> {
	const timeoutMs = config.webFetchTimeoutMs ?? 30000;

	return createTool<FetchWebContentInput, ToolOperationResult[]>({
		name: "fetch_web_content",
		description:
			"Fetch content from URLs and analyze them using the provided prompts. " +
			"Use for retrieving documentation, API references, or any web content. " +
			"Each request includes a URL and a prompt describing what information to extract. Fetch independent URLs together in one call, and call this tool in the same response as other independent tool calls. " +
			`Output: one object per request — ${TOOL_RESULT_ENVELOPE} \`query\` is the URL and \`result\` is what was extracted from that page for your prompt, as text.`,
		inputSchema: zodToJsonSchema(FetchWebContentInputSchema),
		timeoutMs: timeoutMs * 2,
		retryable: true,
		maxRetries: 2,
		execute: async (input, context) => {
			// Validate input with Zod schema
			// Advertises `{requests: [...]}`, accepts the flattenings of it too.
			// See LooseFetchWebContentInputSchema for why.
			const validatedInput = validateWithZod(
				LooseFetchWebContentInputSchema,
				input,
			);

			return Promise.all(
				validatedInput.requests.map(
					async (request): Promise<ToolOperationResult> => {
						try {
							const content = await withTimeout(
								executor(request.url, request.prompt, context),
								timeoutMs,
								`Web fetch timed out after ${timeoutMs}ms`,
							);
							return {
								query: request.url,
								result: content,
								success: true,
							};
						} catch (error) {
							const msg = formatError(error);
							return {
								query: request.url,
								result: "",
								error: `Error fetching web content: ${msg}`,
								success: false,
							};
						}
					},
				),
			);
		},
	});
}

const APPLY_PATCH_TOOL_DESC = `Use \`apply_patch\` to edit files with the canonical freeform patch grammar. Pass the patch text directly as the \`input\` string. Prefer the exact format below:

*** Begin Patch
*** Update File: path/to/file.ts
@@ optional section marker
 [context before]
-[old line]
+[new line]
 [context after]
*** End Patch

Supported actions:
- \`*** Add File: <path>\`
- \`*** Update File: <path>\`
- \`*** Delete File: <path>\`
- optional \`*** Move to: <new path>\` immediately after an Update File header

Rules:
- In an Add File section, every file-content line must start with \`+\`.
- In an Update section, use context lines plus \`-\` and \`+\` lines to describe the change.
- Use \`@@\` markers when extra context is needed to disambiguate repeated code blocks.
- Do not use line numbers; this format is context-based.
- Prefer sending the patch body directly. Legacy shell wrappers such as \`%%bash\` and \`apply_patch <<"EOF"\` are accepted for compatibility but are not preferred.

Example:

*** Begin Patch
*** Update File: src/page.tsx
@@
   return (
     <div>
       <button onClick={() => console.log("clicked")}>Click me</button>
+      <button onClick={() => console.log("cancel clicked")}>Cancel</button>
     </div>
   );
 }
*** End Patch

Output: a single \`{query, result, success, error?}\` object covering the whole patch, where \`result\` says which files were added, updated, moved or deleted. A patch that did not apply — usually because its context lines no longer match the file — sets \`success: false\` and says so in \`error\`; re-read the file and rebuild the patch from what is actually there rather than resending it.`;

/**
 * Create the apply_patch tool
 *
 * Applies the canonical apply_patch format to one or more files.
 */
export function createApplyPatchTool(
	executor: ApplyPatchExecutor,
	config: Pick<DefaultToolsConfig, "cwd" | "applyPatchTimeoutMs"> = {},
): AgentTool<ApplyPatchInput, ToolOperationResult> {
	const timeoutMs = config.applyPatchTimeoutMs ?? 30000;
	const cwd = config.cwd ?? process.cwd();

	return createTool<ApplyPatchInput, ToolOperationResult>({
		name: "apply_patch",
		description: APPLY_PATCH_TOOL_DESC,
		inputSchema: zodToJsonSchema(ApplyPatchInputSchema),
		timeoutMs,
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const validate = validateWithZod(ApplyPatchInputUnionSchema, input);
			const patchInput =
				typeof validate === "string" ? validate : validate.input;

			try {
				const result = await withTimeout(
					executor({ input: patchInput }, cwd, context),
					timeoutMs,
					`apply_patch timed out after ${timeoutMs}ms`,
				);

				return {
					query: "apply_patch",
					result,
					success: true,
				};
			} catch (error) {
				const msg = formatError(error);
				return {
					query: "apply_patch",
					result: "",
					error: `apply_patch failed: ${msg}`,
					success: false,
				};
			}
		},
	});
}

/**
 * Create the editor tool
 *
 * Supports controlled filesystem edits with create, replace, and insert commands.
 */
export function createEditorTool(
	executor: EditorExecutor,
	config: Pick<DefaultToolsConfig, "cwd" | "editorTimeoutMs"> = {},
): AgentTool<EditFileInput, ToolOperationResult> {
	const timeoutMs = config.editorTimeoutMs ?? 30000;
	const cwd = config.cwd ?? process.cwd();

	return createTool<EditFileInput, ToolOperationResult>({
		name: "editor",
		description:
			"An editor for controlled filesystem edits on the text file at the provided path. It does six things, chosen by which arguments you send:\n" +
			"- Replace text: `old_text` plus `new_text`. When `old_text` occurs more than once, add `occurrence` (one-based, in file order) to pick one, or `replace_all: true` to change every one.\n" +
			"- Replace lines: `start_line` plus `new_text`, with optional `end_line` (inclusive, defaults to `start_line`). No `old_text` needed. Prefer this when the text is long, minified or repeated: a diagnostic already gives you the line number, and a line number cannot be ambiguous. An empty `new_text` deletes the range.\n" +
			"- Replace characters: `start_line` and `start_column` plus `new_text`, with optional `end_line`/`end_column` (both inclusive; each defaults to its start). This is the unit a diagnostic speaks in — `Line 108, column 385` — and on a long or minified line it is the only edit that leaves the other 400 characters untouched. `start_column` on its own replaces exactly one character.\n" +
			"- Insert: `insert_line` plus `new_text`, which adds text before that line without replacing anything. Use `line_count + 1` to append at EOF. Add `insert_column` to insert *within* that line instead, before the character at that column — this is how you add one missing bracket. Use `line_length + 1` to append at the end of the line.\n" +
			"- Create: `new_text` alone, when the file does not exist. To rewrite a file that already exists, replace lines 1 through its line count with `start_line: 1` and `end_line: <line count>`. Both are whole-file writes and neither has a size limit, because a file written whole cannot be split — but reach for either only once a targeted edit has failed, since a rewrite that is slightly wrong quietly loses the parts you did not mean to touch.\n" +
			"Use this rather than a shell command for anything that changes a file. If several edits to different files or non-overlapping regions are already known, emit multiple editor tool calls in the same response instead of serializing them across turns. " +
			"Read the lines you are about to change before you change them: an edit aimed at a range you have not read in its current state is refused. Your own edits count — one that changes the file's length moves every line below it, so read that region again before editing it a second time. Line numbers taken from an earlier turn, from a task summary, or from a diagnostic issued before your last edit are the ones that go stale. " +
			"Replace means replace. If `new_text` repeats the lines already in the range and then continues, the edit appends a second copy of them rather than replacing anything, and it is refused. Send only the text that should end up in that range. " +
			"Output: a single `{query, result, success, error?}` object for this one edit, where `query` is `edit:<path>` or `insert:<path>` and `result` describes what changed. " +
			"A failed edit changes nothing: `success` is false, `error` says why, and the file is exactly as it was. Do not resend the same call — `error` names the fix. In particular, text copied out of a `read_files` result must have its `123 | ` line-number gutter removed first.",

		inputSchema: zodToJsonSchema(EditFileInputSchema),
		timeoutMs,
		retryable: false, // Editing operations are stateful and should not auto-retry
		maxRetries: 0,
		execute: async (input, context) => {
			// Applied before validation rather than inside the schema, so the
			// JSON Schema the model is shown still advertises exactly one name
			// for this argument. The alias is a landing net, not a second way
			// of calling the tool.
			const validatedInput = validateWithZod(
				EditFileInputSchema,
				withNewTextAlias(input),
			);
			const operation = validatedInput.insert_line == null ? "edit" : "insert";
			const sizeError = getEditorSizeError(validatedInput);

			if (sizeError) {
				return {
					query: `${operation}:${validatedInput.path}`,
					result: "",
					error: sizeError,
					success: false,
				};
			}

			try {
				const result = await withTimeout(
					executor(validatedInput, cwd, context),
					timeoutMs,
					`Editor operation timed out after ${timeoutMs}ms`,
				);

				return {
					query: `${operation}:${validatedInput.path}`,
					result,
					success: true,
				};
			} catch (error) {
				const msg = formatError(error);
				return {
					query: `${operation}:${validatedInput.path}`,
					result: "",
					error: `Editor operation failed: ${msg}`,
					success: false,
				};
			}
		},
	});
}

/**
 * Create the skills tool
 *
 * Invokes a configured skill by name and optional arguments.
 */
export function createSkillsTool(
	executor: SkillsExecutorWithMetadata,
	config: Pick<DefaultToolsConfig, "skillsTimeoutMs"> = {},
): AgentTool<SkillsInput, string> {
	const timeoutMs = config.skillsTimeoutMs ?? 15000;

	const baseDescription =
		"Execute a skill within the main conversation. " +
		"When users ask you to perform tasks, check if any available skills match. " +
		"When users reference a slash command, invoke it with this tool. " +
		'Input: `skill` (required) and optional `args`. Example: `skill: "pdf"`, `skill: "commit", args: "-m \\"Fix bug\\""`, `skill: "review-pr", args: "123"`, `skill: "ms-office-suite:pdf"`. ' +
		"When a skill matches the user's request, invoking this tool is a blocking requirement before any other response. " +
		"Never mention a skill without invoking this tool. " +
		"Output: the skill's own output, as plain text — not an object, and not wrapped in anything. Treat it as instructions to follow, and continue working; it is not the end of your turn.";

	const tool = createTool<SkillsInput, string>({
		name: "skills",
		description: baseDescription,
		inputSchema: zodToJsonSchema(SkillsInputSchema),
		timeoutMs,
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const validatedInput = validateWithZod(SkillsInputSchema, input);
			return withTimeout(
				executor(
					validatedInput.skill,
					validatedInput.args || undefined,
					context,
				),
				timeoutMs,
				`Skills operation timed out after ${timeoutMs}ms`,
			);
		},
	});

	Object.defineProperty(tool, "description", {
		get() {
			const skills = executor.configuredSkills
				?.filter((s) => !s.disabled)
				.map((s) => s.name);
			if (skills && skills.length > 0) {
				return `${baseDescription} Available skills: ${skills.join(", ")}.`;
			}
			return baseDescription;
		},
		enumerable: true,
		configurable: true,
	});

	return tool;
}

/**
 * Create the ask_question tool
 *
 * Asks the user a single clarifying question with 2-5 selectable options.
 */
export function createAskQuestionTool(
	executor: AskQuestionExecutor,
): AgentTool<AskQuestionInput, string> {
	return {
		name: "ask_question",
		description:
			"Ask user a question for clarifying or gathering information needed to complete the task. " +
			"For example, ask the user clarifying questions about a key implementation decision. " +
			"You should only ask one question. " +
			"Provide an array of 2-5 options for the user to choose from. " +
			"Never include an option to toggle to Act mode. " +
			"Output: the user's answer, as plain text — one of the options you offered, or whatever they wrote instead. Act on it in the same turn; the answer arriving is not a reason to stop.",
		inputSchema: zodToJsonSchema(AskQuestionInputSchema),
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const validatedInput = validateWithZod(AskQuestionInputSchema, input);
			return executor(validatedInput.question, validatedInput.options, context);
		},
	};
}

export function createSubmitAndExitTool(
	executor: VerifySubmitExecutor,
	config: Pick<DefaultToolsConfig, "submitTimeoutMs"> = {},
): AgentTool<SubmitInput, string> {
	const timeoutMs = config.submitTimeoutMs ?? 15000;

	return createTool<SubmitInput, string>({
		name: "submit_and_exit",
		description:
			"Submit the final answer and exit the conversation. " +
			"For example, submit a summary of the investigation and confirm the issue is resolved. " +
			"You should only submit once all necessary steps are completed. " +
			"Make sure to verify your output matches the expected format, data types, and file locations specified. " +
			"Provide a summary of the investigation and confirm the issue is resolved. " +
			"Output: a short confirmation, as plain text. This call ends the run — nothing you plan after it will happen, so call it only when there is nothing left to do.",
		inputSchema: zodToJsonSchema(SubmitInputSchema),
		lifecycle: {
			completesRun: true,
		},
		timeoutMs,
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const validatedInput = validateWithZod(SubmitInputSchema, input);
			return withTimeout(
				executor(validatedInput.summary, validatedInput.verified, context),
				timeoutMs,
				`submit_and_exit timed out after ${timeoutMs}ms`,
			);
		},
	});
}

// =============================================================================
// Default Tools Factory
// =============================================================================

/**
 * Create a set of default tools for an agent
 *
 * This function creates the default tools based on the provided configuration
 * and executors. Only tools that are enabled AND have an executor provided
 * will be included in the returned array.
 *
 * @example
 * ```typescript
 * import { Agent, createDefaultTools } from "@cline/core"
 * import * as fs from "fs/promises"
 * import { exec } from "child_process"
 *
 * const tools = createDefaultTools({
 *   executors: {
 *     readFile: async ({ path }) => fs.readFile(path, "utf-8"),
 *     bash: async (cmd, cwd) => {
 *       return new Promise((resolve, reject) => {
 *         exec(cmd, { cwd }, (err, stdout, stderr) => {
 *           if (err) reject(new Error(stderr || err.message))
 *           else resolve(stdout)
 *         })
 *       })
 *     },
 *   },
 *   enableReadFiles: true,
 *   enableBash: true,
 *   enableSearch: false, // Disabled
 *   enableWebFetch: false, // Disabled
 *   cwd: "/path/to/project",
 * })
 *
 * const agent = new Agent({
 *   // ... provider config
 *   tools,
 * })
 * ```
 */
export function createDefaultTools(
	options: CreateDefaultToolsOptions,
): AgentTool[] {
	const {
		executors,
		enableReadFiles = true,
		enableSearch = true,
		enableBash = true,
		enableWebFetch = true,
		enableApplyPatch = false,
		enableEditor = true,
		enableSkills = true,
		enableAskQuestion = true,
		enableSubmitAndExit = false,
		taskProgress,
		...config
	} = options;

	const tools: AgentTool<never, unknown>[] = [];

	// Add read_files tool if enabled and executor provided
	if (enableReadFiles && executors.readFile) {
		tools.push(createReadFilesTool(executors.readFile, config));
	}

	// Add search_codebase tool if enabled and executor provided
	if (enableSearch && executors.search) {
		tools.push(createSearchTool(executors.search, config));
	}

	// Add run_commands tool if enabled and executor provided
	if (enableBash && executors.bash) {
		tools.push(createShellTool(executors.bash, config));
	}

	// Add fetch_web_content tool if enabled and executor provided
	if (enableWebFetch && executors.webFetch) {
		tools.push(createWebFetchTool(executors.webFetch, config));
	}

	// Add editor tool if enabled and executor provided,
	// else check if apply_patch tool is enabled and executor provided
	// NOTE: Do not enable two similar tools at the same time.
	if (enableEditor && executors.editor) {
		tools.push(createEditorTool(executors.editor, config));
	} else if (enableApplyPatch && executors.applyPatch) {
		tools.push(createApplyPatchTool(executors.applyPatch, config));
	}

	// Add skills tool if enabled and executor provided
	if (enableSkills && executors.skills) {
		tools.push(createSkillsTool(executors.skills, config));
	}

	const submitExecutor = enableSubmitAndExit ? executors.submit : undefined;

	// Add ask_question tool if enabled and executor provided
	if (enableAskQuestion && executors.askQuestion && !submitExecutor) {
		tools.push(createAskQuestionTool(executors.askQuestion));
	}

	// Add submit_and_exit tool if enabled and executor provided
	if (submitExecutor) {
		tools.push(createSubmitAndExitTool(submitExecutor, config));
	}

	// The checklist rides along on other tools, but models call it as a tool
	// anyway -- reported live as `Model tried to call unavailable tool
	// 'task_progress'`, twice in a row, while the panel showed "Tasks (2/6)".
	// Being told a tool does not exist, while the prompt keeps asking for a
	// checklist, costs a turn every time and teaches the model nothing. Calling
	// it directly now works and means the same thing.
	if (taskProgress) {
		tools.push(createTaskProgressTool());
	}

	// Applied last, so every tool the caller enabled carries the checklist —
	// including any added above after this line was written. The wrapper only
	// adds a parameter and observes it; a tool's own behaviour is unchanged.
	if (taskProgress) {
		return tools.map((tool) =>
			withTaskProgressCapture(tool, taskProgress),
		) as unknown as AgentTool[];
	}

	return tools as unknown as AgentTool[];
}
