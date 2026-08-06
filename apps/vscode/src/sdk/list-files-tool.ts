import { type AgentTool, createTool } from "@cline/shared"
import * as path from "path"
import { comparablePath } from "./editor-diagnostics"

/**
 * A tool that answers "what is here?".
 *
 * There was no such tool. The model had `read_files`, `search_codebase`,
 * `editor`, `code_intel`, `check_file` and `browser` — everything for working
 * on a file it could already name, and nothing for finding out what files
 * exist. So it shelled out. Measured on a live session, the only two shell
 * commands in the whole run were:
 *
 *   run_commands  {"commands": ["dir /s manic_miner.html"]}
 *   run_commands  {"commands": ["ls"]}
 *
 * A recursive scan from whatever directory the shell happened to start in,
 * then a bare listing of it — the reflex of a model that has been given no
 * other way to look around, in a session that otherwise never touched a shell.
 *
 * Doing it through the shell is worse than doing it here in three ways. It is
 * unbounded: `dir /s` from the wrong root walks the entire drive. It is
 * unscoped: the shell's working directory is not the workspace, so the results
 * can name files the user never opened and the model was never meant to touch.
 * And it is inconsistent: `ls`, `dir`, `Get-ChildItem` and `find` all format
 * differently, so the model has to parse whatever the host's shell produced.
 *
 * This asks VS Code instead. `workspace.findFiles` searches the workspace
 * folders and nothing else, and it honours the `files.exclude` and
 * `search.exclude` the user has already set — so `node_modules` and `.git`
 * stay out without anyone naming them. The containment check below extends the
 * same guarantee to a plain directory listing. The boundary is enforced here
 * rather than requested in a prompt, which is the difference between a rule
 * and a suggestion.
 */

export const LIST_FILES_TOOL_NAME = "list_files"

/** A listing nobody reads in full. Past this, ask a narrower question. */
const DEFAULT_MAX_RESULTS = 200
const MAX_MAX_RESULTS = 1000

export const LIST_FILES_TOOL_DESCRIPTION = `List the files in the workspace. Use this to find out what exists — do not run \`ls\`, \`dir\`, \`find\` or \`Get-ChildItem\` through \`run_commands\` to look around, because this is scoped to the workspace and those are not.

Two ways to ask:
- \`path\` — list what is directly inside one directory. Omit it to list the workspace root.
- \`pattern\` — a glob searched across the whole workspace, e.g. \`**/*.html\`, \`src/**/*.ts\`, \`**/manic_miner.*\`. Use this when you know part of a name but not where it lives.

Results are limited to the workspace folders the user opened, and directories the user's settings exclude from search — \`node_modules\`, \`.git\`, build output — are left out. A path outside the workspace is refused rather than listed.

This tells you which files exist, not what is in them. To find files by their contents use \`search_codebase\`, which reports the line each match is on and is the right way to locate the part of a file worth reading.`

export const LIST_FILES_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description: "Directory to list. Absolute, or relative to the workspace root. Defaults to the workspace root.",
		},
		pattern: {
			type: "string",
			description: "Glob searched across the workspace, e.g. `**/*.html`. Given this, `path` is ignored.",
		},
		max_results: {
			type: "number",
			description: `Most entries to return. Default ${DEFAULT_MAX_RESULTS}, maximum ${MAX_MAX_RESULTS}.`,
		},
	},
	required: [],
} as const

export interface DirectoryEntry {
	name: string
	kind: "file" | "directory"
	/** Bytes, when the host could say cheaply. */
	size?: number
}

/**
 * The workspace operations this tool needs.
 *
 * Structural, like `BrowserDriver`: a unit test should be able to check how a
 * listing is rendered and where the boundary is drawn without standing up the
 * VS Code API.
 */
export interface WorkspaceLister {
	/** Absolute paths of the folders the user opened. Empty when there are none. */
	roots(): string[]
	readDirectory(absolutePath: string): Promise<DirectoryEntry[]>
	/** Absolute paths matching a glob, already filtered by the user's excludes. */
	findFiles(pattern: string, maxResults: number): Promise<string[]>
}

export interface ListFilesToolOptions {
	cwd: string
	createLister: () => WorkspaceLister | Promise<WorkspaceLister>
}

interface ListFilesInput {
	path?: unknown
	pattern?: unknown
	max_results?: unknown
}

/**
 * Whether `candidate` is inside `root`, as this platform judges paths.
 *
 * Compared segment-wise rather than by prefix: `/repo/testing` starts with the
 * string `/repo/test` without being inside it.
 */
export function isWithin(root: string, candidate: string): boolean {
	const from = comparablePath(root)
	const to = comparablePath(candidate)
	if (from === to) {
		return true
	}
	const relative = path.relative(from, to)
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** Clamp a caller-supplied limit into something a conversation can hold. */
export function normalizeMaxResults(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_MAX_RESULTS
	}
	return Math.min(Math.floor(value), MAX_MAX_RESULTS)
}

function formatSize(bytes: number | undefined): string {
	if (bytes === undefined) {
		return ""
	}
	if (bytes >= 1024 * 1024) {
		return `  ${(bytes / (1024 * 1024)).toFixed(1)} MB`
	}
	if (bytes >= 1024) {
		return `  ${Math.round(bytes / 1024)} KB`
	}
	return `  ${bytes} B`
}

/**
 * Render one directory's contents.
 *
 * Directories first and marked with a trailing separator, because the next
 * question is almost always "which of these do I descend into".
 */
export function renderDirectory(displayPath: string, entries: DirectoryEntry[], limit: number): string {
	if (entries.length === 0) {
		return `${displayPath} is empty.`
	}

	const sorted = [...entries].sort((left, right) => {
		if (left.kind !== right.kind) {
			return left.kind === "directory" ? -1 : 1
		}
		return left.name.localeCompare(right.name)
	})
	const shown = sorted.slice(0, limit)
	const lines = shown.map((entry) =>
		entry.kind === "directory" ? `  ${entry.name}/` : `  ${entry.name}${formatSize(entry.size)}`,
	)
	const hidden = sorted.length - shown.length
	const heading = `${displayPath} — ${sorted.length} entr${sorted.length === 1 ? "y" : "ies"}${
		hidden > 0 ? `, first ${shown.length} shown` : ""
	}:`
	return [heading, ...lines].join("\n")
}

/** Render a glob search, as paths relative to the root they were found under. */
export function renderMatches(pattern: string, absolutePaths: string[], roots: string[], limit: number): string {
	if (absolutePaths.length === 0) {
		return `No file in the workspace matches \`${pattern}\`. That is an answer, not a failure — re-running it will not change it. Try a broader glob, or \`search_codebase\` if you are looking for what is inside a file rather than what it is called.`
	}

	const relativeTo = (absolute: string): string => {
		for (const root of roots) {
			if (isWithin(root, absolute)) {
				return path.relative(root, absolute) || path.basename(absolute)
			}
		}
		return absolute
	}

	const shown = absolutePaths.slice(0, limit)
	const hidden = absolutePaths.length - shown.length
	const heading = `\`${pattern}\` — ${absolutePaths.length} match${absolutePaths.length === 1 ? "" : "es"}${
		hidden > 0 ? `, first ${shown.length} shown` : ""
	}:`
	return [heading, ...shown.map((absolute) => `  ${relativeTo(absolute)}`)].join("\n")
}

export function createListFilesTool(options: ListFilesToolOptions): AgentTool {
	return createTool({
		name: LIST_FILES_TOOL_NAME,
		description: LIST_FILES_TOOL_DESCRIPTION,
		inputSchema: LIST_FILES_TOOL_INPUT_SCHEMA,
		timeoutMs: 20_000,
		retryable: true,
		maxRetries: 1,
		execute: async (raw) => {
			const input = (raw ?? {}) as ListFilesInput
			const pattern = typeof input.pattern === "string" ? input.pattern.trim() : ""
			const requested = typeof input.path === "string" ? input.path.trim() : ""
			const limit = normalizeMaxResults(input.max_results)
			const query = pattern !== "" ? `find:${pattern}` : `list:${requested || "."}`

			try {
				const lister = await options.createLister()
				const roots = lister.roots()

				if (pattern !== "") {
					const matches = await lister.findFiles(pattern, limit + 1)
					return {
						query,
						result: renderMatches(pattern, matches, roots, limit),
						success: true,
					}
				}

				const base = roots[0] ?? options.cwd
				const absolute = requested === "" ? base : path.resolve(base, requested)

				// The boundary, enforced rather than requested. `findFiles` gets
				// this from VS Code; a directory listing takes any path, so it is
				// checked here.
				if (roots.length > 0 && !roots.some((root) => isWithin(root, absolute))) {
					return {
						query,
						result: "",
						error: `${absolute} is outside this workspace. Only these folders can be listed: ${roots.join(", ")}. If you need something elsewhere, ask the user to open that folder.`,
						success: false,
					}
				}

				const entries = await lister.readDirectory(absolute)
				return {
					query,
					result: renderDirectory(absolute, entries, limit),
					success: true,
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return {
					query,
					result: "",
					error: `Could not list files: ${message}`,
					success: false,
				}
			}
		},
	})
}
