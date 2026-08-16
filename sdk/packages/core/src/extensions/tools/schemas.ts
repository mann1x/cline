/**
 * Zod Schemas for Default Tool Inputs
 *
 * These schemas define the input structure for each default tool
 * and are used for both validation and JSON Schema generation.
 */

import { z } from "zod";

export const INPUT_ARG_CHAR_LIMIT = 6000;

/**
 * Character ceiling for a single `editor` payload.
 *
 * Higher than the shared limit because an edit is not a shell command: the
 * text is a region of a file, and its size is set by the file rather than by
 * how concise the model is being. Measured on a 156-message session — a
 * class-body replacement came to 6,407 characters and was refused for being
 * 407 over, which cost a re-read and several follow-up edits to say the same
 * thing. The guard is still here to catch a runaway payload; it should not be
 * catching ordinary work.
 */
export const DEFAULT_EDITOR_ARG_CHAR_LIMIT = 32_000;

/**
 * Resolve the ceiling, allowing a deployment to move it.
 *
 * The number that actually constrains an edit is the per-turn output cap, and
 * that is a property of the model, not of this file. At a 32,000-token cap with
 * 16,000 reserved for thinking there is roughly 41,000 characters of room for
 * the reply, so a 16,000-character ceiling was leaving most of the budget
 * unusable; a smaller local model may want it lower again. Read once at module
 * load — the value is interpolated into the tool description the model reads,
 * so it cannot be allowed to change underneath a running session and leave the
 * prompt describing a limit that is no longer enforced.
 *
 * Anything unparseable, zero or negative falls back to the default rather than
 * disabling the guard: a typo in an environment variable should not silently
 * remove a safety limit.
 */
function resolveEditorArgCharLimit(): number {
	const raw = process.env.CLINE_EDITOR_ARG_CHAR_LIMIT?.trim();
	if (!raw) {
		return DEFAULT_EDITOR_ARG_CHAR_LIMIT;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_EDITOR_ARG_CHAR_LIMIT;
	}
	return Math.floor(parsed);
}

export const EDITOR_ARG_CHAR_LIMIT = resolveEditorArgCharLimit();

/**
 * A boolean that also accepts the string a model actually sends.
 *
 * Measured: a model called `read_files` with
 * `{path, start_line: "108", end_line: "108", line_numbers: "false"}`. The
 * numbers coerced — they are `z.coerce.number()` — and the quoted boolean did
 * not, so the whole union failed and the tool answered `✖ Invalid input`
 * with no field named. Every boolean in this file is reachable the same way,
 * so none of them is strict.
 */
const LooseBoolean = z.preprocess((value) => {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") {
			return true;
		}
		if (normalized === "false") {
			return false;
		}
	}
	return value;
}, z.boolean());

/**
 * Schema for read tool input
 */
const AbsolutePath = z
	.string()
	.describe("The absolute path of a text file to read content from");

export const ReadFileLineRangeSchema = z
	.object({
		// Models sometimes emit line numbers as strings; coerce so a `"3"` does not
		// reject the whole tool call. The advertised JSON Schema is unaffected.
		start_line: z.coerce
			.number()
			.int()
			.positive()
			.nullable()
			.optional()
			.describe(
				"Optional one-based starting line number to read from; use null or omit for the start of the file",
			),
		end_line: z.coerce
			.number()
			.int()
			.positive()
			.nullable()
			.optional()
			.describe(
				"Optional one-based ending line number to read through; use null or omit to read to the end of the file or the read cap, whichever comes first",
			),
	})
	.describe("Optional inclusive one-based file line range");

export const ReadFileRequestSchema = z
	.object({
		path: AbsolutePath,
		start_line: ReadFileLineRangeSchema.shape.start_line,
		end_line: ReadFileLineRangeSchema.shape.end_line,
		line_numbers: LooseBoolean.nullable()
			.optional()
			.describe(
				"Whether to prefix each line with its number. True by default, because line numbers are how you address an edit. Set false when you are going to copy text out of the result into another tool: the `123 | ` prefix is not in the file, and text pasted back with it cannot match.",
			),
	})
	.describe(
		"A file read request with optional inclusive one-based line bounds. Always include path; start_line/end_line must be on the same object as the path they apply to, never in a separate array element",
	);

/**
 * Schema for read_files tool input
 */
export const ReadFilesInputSchema = z.object({
	files: z
		.array(ReadFileRequestSchema)
		.describe(
			"Array of file read requests; each element is one file and must include path. Omit start_line/end_line or set them to null to read from the start; provide integers on the same object as the path to return only that inclusive one-based line range — never emit a range as its own array element. Reads are capped, so page through long files with start_line/end_line. Prefer this tool over running terminal command to get file content for better performance and reliability.",
		),
});

const ReadFileRangeAliasFields = {
	start_line: ReadFileLineRangeSchema.shape.start_line,
	end_line: ReadFileLineRangeSchema.shape.end_line,
};

/**
 * Tolerant per-entry schema for read requests. Some models emit the path
 * under `file_path`/`filePath` instead of `path`; normalize those aliases to
 * the canonical shape so downstream code only ever sees `path`.
 */
const LooseReadFileRequestSchema = z.union([
	ReadFileRequestSchema,
	z
		.object({ file_path: AbsolutePath, ...ReadFileRangeAliasFields })
		.transform(({ file_path, ...rest }) => ({ path: file_path, ...rest })),
	z
		.object({ filePath: AbsolutePath, ...ReadFileRangeAliasFields })
		.transform(({ filePath, ...rest }) => ({ path: filePath, ...rest })),
]);

/**
 * Union schema for read_files tool input, allowing either a single string, an array of strings, or the full object schema
 */
export const ReadFilesInputUnionSchema = z.union([
	ReadFilesInputSchema,
	LooseReadFileRequestSchema,
	z.array(LooseReadFileRequestSchema),
	z.array(z.string()),
	z.string(),
	z.object({
		files: z.array(z.union([AbsolutePath, LooseReadFileRequestSchema])),
	}),
	z.object({ files: LooseReadFileRequestSchema }),
	z.object({ files: AbsolutePath }),
	z.object({ file_paths: z.array(AbsolutePath) }),
	z.object({ file_paths: z.string() }),
	z.object({
		paths: z.array(z.union([AbsolutePath, LooseReadFileRequestSchema])),
	}),
	z.object({ paths: LooseReadFileRequestSchema }),
	z.object({ paths: z.string() }),
]);

/**
 * Schema for search_codebase tool input
 */
export const SearchCodebaseInputSchema = z.object({
	queries: z
		.array(z.string())
		.describe("Array of regex search queries to execute"),
	context_lines: z.coerce
		.number()
		.int()
		.min(0)
		.max(20)
		.nullable()
		.optional()
		.describe(
			"How many lines to show either side of each match. Defaults to 2. Use 0 for just the matching lines.",
		),
	max_per_file: z.coerce
		.number()
		.int()
		.positive()
		.max(200)
		.nullable()
		.optional()
		.describe(
			"How many matches to report per file. Defaults to 1, which is right for finding *which* files mention something. Raise it when you need every occurrence within one file — how many times a name appears, and where each one is.",
		),
});

/** The two tuning fields, shared by every object shape below. */
const SearchOptionFields = {
	context_lines: SearchCodebaseInputSchema.shape.context_lines,
	max_per_file: SearchCodebaseInputSchema.shape.max_per_file,
};

/**
 * Union schema for search_codebase tool input, allowing either a single string,
 * an array of strings, or the full object schema.
 *
 * `query` is accepted alongside `queries` because the tool teaches the singular
 * itself: every result comes back as `{ query, result, success }`, and the tool
 * description says so in as many words. Measured on a live session, a model that
 * had read its own search results then sent `{"query":"SpectatorSelectionCard"}`
 * and got `✖ Invalid input` — a union that matches no branch names no field, so
 * it retried the same shape twice more before giving up on the tool. `read_files`
 * already takes `path`, `file_path`, `filePath`, `files`, `file_paths` and
 * `paths`; this one had four branches and none of them singular.
 *
 * Every branch normalises to the canonical `{ queries: string[] }`, and the two
 * option fields ride along on the object branches. They did not before: a
 * `{queries: "x", max_per_file: 10}` matched the bare `{queries: string}` branch,
 * which stripped the unknown key, so the search silently ran at the default of
 * one match per file.
 */
export const SearchCodebaseUnionInputSchema = z
	.union([
		SearchCodebaseInputSchema,
		z.array(z.string()).transform((queries) => ({ queries })),
		z.string().transform((query) => ({ queries: [query] })),
		z
			.object({ queries: z.string(), ...SearchOptionFields })
			.transform(({ queries, ...rest }) => ({ queries: [queries], ...rest })),
		z
			.object({ query: z.array(z.string()), ...SearchOptionFields })
			.transform(({ query, ...rest }) => ({ queries: query, ...rest })),
		z
			.object({ query: z.string(), ...SearchOptionFields })
			.transform(({ query, ...rest }) => ({ queries: [query], ...rest })),
	])
	// Piped back through the canonical schema so the caller is handed one shape
	// rather than a six-way union it has to narrow. Every branch already produces
	// something this accepts; the pipe is what makes that a type as well as a
	// convention.
	.pipe(SearchCodebaseInputSchema);

const CommandInputSchema = z
	.string()
	.describe(
		`The non-interactive shell command to execute - MUST keep input short and concise (within ${INPUT_ARG_CHAR_LIMIT * 2} characters) to avoid timeouts.`,
	);

export const StructuredCommandInputSchema = z.object({
	command: z
		.string()
		.min(1)
		.describe("The executable to run directly without shell parsing."),
	args: z
		.array(z.string())
		.optional()
		.describe("Optional argv list passed directly to the executable."),
});

export const StructuredCommandEntrySchema = z.union([
	CommandInputSchema,
	StructuredCommandInputSchema,
]);

export const RunCommandsInputSchema = z.object({
	commands: z
		.array(CommandInputSchema)
		.describe("Array of complete shell command strings to execute."),
	// Only meaningful when the user has configured QA credentials; the tool
	// description lists the names when there are any and says nothing when
	// there are none. Optional everywhere, because a command that spells
	// `$QA_PASSWORD` out is already asking.
	credentials: z
		.array(z.string())
		.optional()
		.describe(
			"Names of configured QA credentials these commands need, for a command that does not name them itself (a test runner reading its own environment). Values are set only for this call and are never shown to you.",
		),
});

const StructuredCommandsInputSchema = z.object({
	commands: z.array(StructuredCommandEntrySchema),
});

/**
 * One command, however the model chose to spell it.
 *
 * Measured live: `run_commands` answered `Invalid input` to every call in a
 * session -- for `echo` as much as for a pipeline -- and the model concluded
 * the tool was "definitively non-functional in this environment". The union
 * accepted `cmd` at the top level but not inside `commands`, and `args` only
 * as an array, so a single spelling slip failed the whole call with a message
 * that named no field.
 *
 * These are the unambiguous spellings only. Each is transformed to the
 * canonical entry so everything downstream sees one shape.
 */
const ARGV_MIN_LENGTH = 1;

const LooseCommandEntrySchema = z.union([
	CommandInputSchema,
	StructuredCommandInputSchema,
	// `args` as a single string rather than a list.
	z
		.object({ command: z.string().min(1), args: z.string() })
		.transform(({ command, args }) => ({ command, args: [args] })),
	// `cmd` inside `commands`, which the top level already accepted.
	z
		.object({
			cmd: z.string().min(1),
			args: z.union([z.array(z.string()), z.string()]).optional(),
		})
		.transform(({ cmd, args }) => ({
			command: cmd,
			...(args === undefined
				? {}
				: { args: typeof args === "string" ? [args] : args }),
		})),
	// The other names models reach for when they mean "a shell command".
	z
		.object({ shell_command: z.string().min(1) })
		.transform(({ shell_command }) => shell_command),
	z.object({ script: z.string().min(1) }).transform(({ script }) => script),
	// An argv list: first element is the executable, the rest are arguments.
	z
		.array(z.string())
		.min(ARGV_MIN_LENGTH)
		.transform((argv) => ({ command: argv[0], args: argv.slice(1) })),
]);

/**
 * Union schema for run_commands tool input. More flexible.
 */
export const RunCommandsInputUnionSchema = z.union([
	RunCommandsInputSchema,
	StructuredCommandsInputSchema,
	z.object({ commands: z.array(LooseCommandEntrySchema) }),
	z.object({ commands: LooseCommandEntrySchema }),
	z.array(StructuredCommandInputSchema),
	StructuredCommandInputSchema,
	z.object({ command: CommandInputSchema }),
	z.object({ cmd: CommandInputSchema }),
	// Before the loose entry, and deliberately: a bare list of strings has
	// always meant a list of shell commands, and the loose entry would read the
	// same value as one argv list. Order is the only thing separating them.
	z.array(z.string()),
	LooseCommandEntrySchema,
	z.string(),
]);

/**
 * Schema for a single web fetch request
 */
export const WebFetchRequestSchema = z.object({
	url: z.string().describe("The URL to fetch"),
	prompt: z.string().min(2).describe("Analysis prompt for the fetched content"),
});

/**
 * Schema for fetch_web_content tool input
 */
export const FetchWebContentInputSchema = z.object({
	requests: z
		.array(WebFetchRequestSchema)
		.describe("Array of the URLs for the web fetch requests"),
});

/**
 * What the tool will actually accept, as opposed to what it advertises.
 *
 * The advertised shape stays `{requests: [{url, prompt}]}` — one shape to
 * document, and the batching it exists for is the point. But the wrapper is
 * the single most-missed detail in this whole tool set: measured on a live
 * session, a model sent `{url, prompt}` three times, got
 * `Invalid input: expected array, received undefined → at requests` three
 * times, and never worked out what to change. `read_files` has long tolerated
 * the same slip in its own shape; this brings `fetch_web_content` in line.
 *
 * Only the unambiguous flattenings are accepted. Nothing here guesses at a
 * missing `prompt`.
 */
export const LooseFetchWebContentInputSchema = z.union([
	FetchWebContentInputSchema,
	// `{url, prompt}` — one request, sent without its wrapper.
	WebFetchRequestSchema.transform((request) => ({ requests: [request] })),
	// `{requests: {url, prompt}}` — wrapper present, array forgotten.
	z
		.object({ requests: WebFetchRequestSchema })
		.transform(({ requests }) => ({ requests: [requests] })),
	// `[{url, prompt}, ...]` — the array alone.
	z.array(WebFetchRequestSchema).transform((requests) => ({ requests })),
]);

/**
 * The names a model reaches for when it means `new_text`.
 *
 * Measured on two builds: an `editor` call carrying `path`, `start_line`,
 * `end_line` and the whole replacement body under `text` — every argument
 * present, complete and correct, and the call refused for a missing one. Eight
 * such calls in one transaction and ten in another, each a turn spent on a
 * rename, and one of those transactions was two hours long.
 *
 * Accepting the synonym is safe in a way that repairing a payload is not, and
 * the difference is worth stating. Nothing here reconstructs a value or infers
 * intent: the schema has no `text`, `content` or `replacement` field of its
 * own, so a string under one of those names has exactly one thing it can be,
 * and it arrived whole. A `new_text` that was cut short still fails, as it
 * must — a call truncated mid-value patched up and executed writes the
 * fragment over the file it names, and says nothing.
 *
 * `new_text` wins wherever both are present: a model that sent the real
 * argument meant it, and a stray `text` beside it is not a vote.
 */
const NEW_TEXT_ALIASES = ["text", "content", "replacement"] as const;

export function withNewTextAlias(value: unknown): unknown {
	if (value == null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const input = value as Record<string, unknown>;
	if (typeof input.new_text === "string") {
		return value;
	}
	for (const alias of NEW_TEXT_ALIASES) {
		if (typeof input[alias] === "string") {
			const { [alias]: aliased, ...rest } = input;
			return { ...rest, new_text: aliased };
		}
	}
	return value;
}

/**
 * Schema for editor tool input
 */
export const EditFileInputSchema = z
	.object({
		path: z
			.string()
			.min(1)
			.describe("The absolute path for the action to be performed on"),
		old_text: z
			.string()
			.nullable()
			.optional()
			.describe(
				`Exact text to replace (must match exactly once). Omit this when creating a missing file or inserting via insert_line. Keep this at or below ${EDITOR_ARG_CHAR_LIMIT} characters; a match string approaching that length means you are retyping the file, so address the region with start_line/end_line instead.`,
			),
		new_text: z
			.string()
			.describe(
				`The new content to write when creating a missing file, the replacement text for edits, or the inserted text when insert_line is provided. Keep this at or below ${EDITOR_ARG_CHAR_LIMIT} characters for an edit. A whole-file write has no limit, because there is nothing to split it into: that is new_text alone for a file that does not exist, or start_line: 1 with end_line set to the file's line count for one that does.`,
			),
		// See start_line above: coerced so a stringified line number still applies.
		insert_line: z.coerce
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				"Optional positive one-based boundary line. When provided, the tool inserts new_text before that line instead of performing a replacement edit; use line_count + 1 to append at EOF.",
			),
		start_line: z.coerce
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				"Optional positive one-based first line to replace. With end_line, new_text replaces that whole line range and old_text is not needed. Use this when the text to replace is long, minified or repeated: a line number is unambiguous where an exact match is not.",
			),
		end_line: z.coerce
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				"Optional positive one-based last line to replace, inclusive. Defaults to start_line, so start_line on its own replaces exactly that line.",
			),
		start_column: z.coerce
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				"Optional positive one-based first character to replace on start_line. Diagnostics report a column, so this is the unit for a one-character fix on a long or minified line: nothing else on the line is retyped or at risk.",
			),
		end_column: z.coerce
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				"Optional positive one-based last character to replace, inclusive, on end_line. Defaults to start_column, so start_column on its own replaces exactly that one character.",
			),
		insert_column: z.coerce
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				"Optional positive one-based column on insert_line. When provided, new_text is inserted *before* that character on the existing line rather than as a new line; use line_length + 1 to append at the end of the line. This is how you add a single missing bracket without touching the rest of the line.",
			),
		occurrence: z.coerce
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				"Which occurrence of old_text to replace when it appears more than once, one-based in file order. Omit when old_text is unique. Cannot be combined with replace_all.",
			),
		replace_all: LooseBoolean.nullable()
			.optional()
			.describe(
				"Replace every occurrence of old_text instead of requiring exactly one. Cannot be combined with occurrence.",
			),
	})
	.describe(
		"Edit a text file by replacing old_text with new_text, by replacing the start_line..end_line range with new_text, by creating the file with new_text if it does not exist, or by inserting new_text at insert_line. Prefer using this tool for file edits over shell commands. IMPORTANT: large edits can time out, so use small chunks and multiple calls when possible.",
	);

/**
 * Schema for apply_patch tool input
 */
export const ApplyPatchInputSchema = z
	.object({
		input: z
			.string()
			.min(1)
			.describe(
				"The freeform apply_patch payload in the canonical patch grammar (e.g *** Begin Patch, *** Update File:, @@, and *** End Patch).",
			),
	})
	.describe(
		"Modify or create a text file by applying patches using the canonical apply_patch diff grammar. Prefer sending the patch body directly rather than wrapping it in shell syntax. IMPORTANT: large patches can time out, so use small chunks and multiple calls when possible.",
	);
export const ApplyPatchInputUnionSchema = z.union([
	ApplyPatchInputSchema,
	z.string(),
]);

/**
 * Schema for skills tool input
 */
export const SkillsInputSchema = z.object({
	skill: z.string().min(1).describe("Name of the skill to execute."),
	args: z
		.string()
		.nullable()
		.optional()
		.describe("Arguments for the skill; use null when omitted"),
});

/**
 * Schema for ask_followup_question tool input
 */
export const AskQuestionInputSchema = z.object({
	question: z
		.string()
		.min(1)
		.describe(
			'The single question to ask the user. E.g. "How can I help you?"',
		),
	options: z
		.array(z.string().min(1))
		.min(2)
		.max(5)
		.describe(
			"Array of 2-5 user-selectable answer options for the single question",
		),
});

export const SubmitInputSchema = z.object({
	summary: z
		.string()
		.min(10)
		.describe(
			"Summarization of the investigation, steps taken, and resolution status to submit at the end of the session. Before submitting, read the problem again along with any provided test's assertions carefully and confirm your fix produces the expected output.",
		),
	verified: z
		.boolean()
		.describe(
			`Have you verified that the issue is resolved to the best of your knowledge, including updating and creating all the requested files and items? 'True' if you have completed the investigation and taken all necessary steps to resolve the issue.\n'False' if you have done all you can but cannot resolve the issue or if you are stuck and cannot proceed further. =\nIMPORTANT: You must run the specific failing test(s) mentioned in the issue or test patch and include the test output in your reasoning. If the test still fails after your fix, you must revise. Do NOT submit with 'true' unless the test output shows the test passing.`,
		),
});

// =============================================================================
// Type Definitions (derived from Zod schemas)
// =============================================================================

/**
 * Input for a single file read request
 */
export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;

/**
 * Input for the read_files tool
 */
export type ReadFilesInput = z.infer<typeof ReadFilesInputSchema>;

/**
 * Input for the search_codebase tool
 */
export type SearchCodebaseInput = z.infer<typeof SearchCodebaseInputSchema>;

/**
 * Input for the run_commands tool
 */
export type RunCommandsInput = z.infer<typeof RunCommandsInputSchema>;
export type StructuredCommandInput = z.infer<
	typeof StructuredCommandInputSchema
>;

/**
 * Web fetch request parameters
 */
export type WebFetchRequest = z.infer<typeof WebFetchRequestSchema>;

/**
 * Input for the fetch_web_content tool
 */
export type FetchWebContentInput = z.infer<typeof FetchWebContentInputSchema>;

/**
 * Input for the editor tool
 */
export type EditFileInput = z.infer<typeof EditFileInputSchema>;

/**
 * Input for the apply_patch tool
 */
export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

/**
 * Input for the skills tool
 */
export type SkillsInput = z.infer<typeof SkillsInputSchema>;

/**
 * Input for the ask_followup_question tool
 */
export type AskQuestionInput = z.infer<typeof AskQuestionInputSchema>;

/**
 * Input for the submit and exit tool
 */
export type SubmitInput = z.infer<typeof SubmitInputSchema>;
