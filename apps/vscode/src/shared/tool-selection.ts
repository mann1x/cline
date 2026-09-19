/**
 * The tools a profile may switch off, and what each one costs to offer.
 *
 * The tool schemas are a fixed price: they are serialized into every request
 * before a single message exists, and compaction cannot touch one token of
 * them. Measured on a 65,536-token window, the system prompt and the schemas
 * together ran 21,000-24,000 tokens -- about a third of the window gone before
 * the conversation starts, of which the prompt itself is 1,607. Dropping a
 * tool is the only thing that buys that room back, and the number beside each
 * one is what it buys.
 *
 * Only the tools that are always there are listed. A tool that exists because
 * some other thing is configured -- `generate_image` needs an image endpoint,
 * `skills` needs a skills executor, `spawn_agent` needs a free delegation slot
 * -- already has a switch, and a second one that does nothing until the first
 * is on would be a control that lies about what it does. MCP tools are absent
 * for a different reason: they are per server in the MCP panel, and their
 * names are only known once a server has answered.
 *
 * The token figures are measured, not estimated by hand, and
 * `tool-selection.test.ts` rebuilds every tool and fails when one drifts. They
 * are what this build offers; the authoritative per-session figure, MCP
 * included, is the manifest each session writes to `cline-tools.json`.
 */
export interface SelectableTool {
	/** The registered tool name, which is what a profile stores. */
	readonly name: string
	/** What the panel calls it. */
	readonly label: string
	/** Why someone would keep it, in one line. */
	readonly summary: string
	/** Serialized name + description + schema, in tokens at 4 chars each. */
	readonly tokens: number
}

export const SELECTABLE_TOOLS: readonly SelectableTool[] = [
	{
		name: "editor",
		label: "editor",
		summary: "Writes files: ranged replacements, whole-file writes and creations.",
		tokens: 1860,
	},
	{
		name: "read_files",
		label: "read_files",
		summary: "Reads files, several at once, with line ranges and revisions.",
		tokens: 947,
	},
	{
		name: "ask_lsp",
		label: "ask_lsp",
		summary: "Definitions, references and hovers from the language servers already installed.",
		tokens: 921,
	},
	{
		name: "check_file",
		label: "check_file",
		summary: "The editor's own diagnostics for a file, plus the project's lint command.",
		tokens: 800,
	},
	{
		name: "grep",
		label: "grep",
		summary: "Regex search across the workspace.",
		tokens: 765,
	},
	{
		name: "browser",
		label: "browser",
		summary: "Drives a real Chrome: loads a page, clicks, types and reads the console.",
		tokens: 645,
	},
	{
		name: "sed",
		label: "sed",
		summary: "Stream edits, with a preview mode and an in-place mode.",
		tokens: 637,
	},
	{
		name: "run_commands",
		label: "run_commands",
		summary: "Runs shell commands in the workspace terminal.",
		tokens: 529,
	},
	{
		name: "search_codebase",
		label: "search_codebase",
		summary: "Semantic search over the indexed workspace.",
		tokens: 482,
	},
	{
		name: "awk",
		label: "awk",
		summary: "Field-oriented extraction over text, read-only.",
		tokens: 442,
	},
	{
		name: "list_files",
		label: "list_files",
		summary: "Lists a directory or finds files by glob, without a shell.",
		tokens: 355,
	},
	{
		name: "fetch_web_content",
		label: "fetch_web_content",
		summary: "Fetches a URL and returns its text.",
		tokens: 264,
	},
]

/** What the whole selectable set costs when every one of them is offered. */
export const SELECTABLE_TOOLS_TOTAL_TOKENS = SELECTABLE_TOOLS.reduce((total, tool) => total + tool.tokens, 0)
