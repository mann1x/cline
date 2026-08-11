import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";

/** A path in the form two paths can be compared in, as this platform judges it. */
function comparablePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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
 * So the host is asked instead, through `WorkspaceLister`. VS Code's answers
 * from `workspace.findFiles`, which searches the folders the user opened and
 * nothing else and honours the `files.exclude` and `search.exclude` they have
 * already set — so `node_modules` and `.git` stay out without anyone naming
 * them. `createLocalWorkspaceLister` below answers the same questions from the
 * filesystem, for a host with no editor behind it. The containment check
 * extends the same guarantee to a plain directory listing whichever lister is
 * in use. The boundary is enforced here rather than requested in a prompt,
 * which is the difference between a rule and a suggestion.
 *
 * The tool lives in core rather than in the extension because the reflex it
 * displaces is not VS Code's. A CLI run has the same six tools for working on
 * a file it can already name and the same nothing for finding out what exists,
 * and it reaches for `ls` for exactly the same reason.
 */

export const LIST_FILES_TOOL_NAME = "list_files";

/** A listing nobody reads in full. Past this, ask a narrower question. */
const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 1000;

export const LIST_FILES_TOOL_DESCRIPTION = `List the files in the workspace. Use this to find out what exists — do not run \`ls\`, \`dir\`, \`find\` or \`Get-ChildItem\` through \`run_commands\` to look around, because this is scoped to the workspace and those are not.

Two ways to ask:
- \`path\` — list what is directly inside one directory. Omit it to list the workspace root.
- \`pattern\` — a glob searched across the whole workspace, e.g. \`**/*.html\`, \`src/**/*.ts\`, \`**/manic_miner.*\`. Use this when you know part of a name but not where it lives.

Results are limited to the workspace folders the user opened, and directories the user's settings exclude from search — \`node_modules\`, \`.git\`, build output — are left out. A path outside the workspace is refused rather than listed.

This tells you which files exist, not what is in them. To find files by their contents use \`search_codebase\`, which reports the line each match is on and is the right way to locate the part of a file worth reading.`;

export const LIST_FILES_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description:
				"Directory to list. Absolute, or relative to the workspace root. Defaults to the workspace root.",
		},
		pattern: {
			type: "string",
			description:
				"Glob searched across the workspace, e.g. `**/*.html`. Given this, `path` is ignored.",
		},
		max_results: {
			type: "number",
			description: `Most entries to return. Default ${DEFAULT_MAX_RESULTS}, maximum ${MAX_MAX_RESULTS}.`,
		},
	},
	required: [],
} as const;

export interface DirectoryEntry {
	name: string;
	kind: "file" | "directory";
	/** Bytes, when the host could say cheaply. */
	size?: number;
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
	roots(): string[];
	readDirectory(absolutePath: string): Promise<DirectoryEntry[]>;
	/** Absolute paths matching a glob, already filtered by the user's excludes. */
	findFiles(pattern: string, maxResults: number): Promise<string[]>;
}

export interface ListFilesToolOptions {
	cwd: string;
	createLister: () => WorkspaceLister | Promise<WorkspaceLister>;
	/**
	 * Files read this session, so a fruitless workspace search can say what it
	 * could not have covered instead of asserting the file does not exist.
	 */
	getReadPaths?: () => string[];
}

interface ListFilesInput {
	path?: unknown;
	pattern?: unknown;
	max_results?: unknown;
}

/**
 * Whether `candidate` is inside `root`, as this platform judges paths.
 *
 * Compared segment-wise rather than by prefix: `/repo/testing` starts with the
 * string `/repo/test` without being inside it.
 */
export function isWithin(root: string, candidate: string): boolean {
	const from = comparablePath(root);
	const to = comparablePath(candidate);
	if (from === to) {
		return true;
	}
	const relative = path.relative(from, to);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

/** Clamp a caller-supplied limit into something a conversation can hold. */
export function normalizeMaxResults(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_MAX_RESULTS;
	}
	return Math.min(Math.floor(value), MAX_MAX_RESULTS);
}

function formatSize(bytes: number | undefined): string {
	if (bytes === undefined) {
		return "";
	}
	if (bytes >= 1024 * 1024) {
		return `  ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (bytes >= 1024) {
		return `  ${Math.round(bytes / 1024)} KB`;
	}
	return `  ${bytes} B`;
}

/**
 * Render one directory's contents.
 *
 * Directories first and marked with a trailing separator, because the next
 * question is almost always "which of these do I descend into".
 */
export function renderDirectory(
	displayPath: string,
	entries: DirectoryEntry[],
	limit: number,
): string {
	if (entries.length === 0) {
		return `${displayPath} is empty.`;
	}

	const sorted = [...entries].sort((left, right) => {
		if (left.kind !== right.kind) {
			return left.kind === "directory" ? -1 : 1;
		}
		return left.name.localeCompare(right.name);
	});
	const shown = sorted.slice(0, limit);
	const lines = shown.map((entry) =>
		entry.kind === "directory"
			? `  ${entry.name}/`
			: `  ${entry.name}${formatSize(entry.size)}`,
	);
	const hidden = sorted.length - shown.length;
	const heading = `${displayPath} — ${sorted.length} entr${sorted.length === 1 ? "y" : "ies"}${
		hidden > 0 ? `, first ${shown.length} shown` : ""
	}:`;
	return [heading, ...lines].join("\n");
}

/**
 * Files read this session that no workspace root contains.
 *
 * The search is scoped to the workspace; reading and editing are not. A model
 * that has just edited a file outside the roots and is then told the file does
 * not exist has been given a false answer, and it does the only sensible thing
 * with a false answer about something it just did — it asks again. Measured: a
 * file under `repos\test` edited successfully from a workspace of `repos\osync`,
 * then four consecutive searches denying it existed.
 */
function readOutsideRoots(readPaths: string[], roots: string[]): string[] {
	if (roots.length === 0) {
		return [];
	}
	const outside = readPaths.filter(
		(absolute) => !roots.some((root) => isWithin(root, absolute)),
	);
	return [...new Set(outside)];
}

/** Name what the search could not have found, when there is something to name. */
function outsideNote(
	readPaths: string[],
	roots: string[],
	matcher?: (absolute: string) => boolean,
): string {
	const outside = readOutsideRoots(readPaths, roots).filter(
		(absolute) => matcher?.(absolute) ?? true,
	);
	if (outside.length === 0) {
		return "";
	}
	const shown = outside.slice(0, 5);
	return ` This search covers only the workspace, and you have already read these files outside it, which it cannot return:\n${shown
		.map((absolute) => `  ${absolute}`)
		.join(
			"\n",
		)}\nThose paths still work with \`read_files\`, \`editor\` and \`check_file\` — use them directly rather than searching again.`;
}

/** Render a glob search, as paths relative to the root they were found under. */
export function renderMatches(
	pattern: string,
	absolutePaths: string[],
	roots: string[],
	limit: number,
	readPaths: string[] = [],
): string {
	if (absolutePaths.length === 0) {
		const base = path
			.basename(pattern.replace(/\\/g, "/"))
			.replace(/^\*+/, "")
			.replace(/\*+$/, "");
		const relevant = (absolute: string): boolean =>
			base.length === 0 ||
			path.basename(absolute).toLowerCase().includes(base.toLowerCase());
		return `No file in the workspace matches \`${pattern}\`. Re-running it will not change that — the workspace is ${
			roots.length > 0 ? roots.join(", ") : "the current folder"
		}.${outsideNote(readPaths, roots, relevant)} Otherwise try a broader glob, or \`search_codebase\` if you are looking for what is inside a file rather than what it is called.`;
	}

	const relativeTo = (absolute: string): string => {
		for (const root of roots) {
			if (isWithin(root, absolute)) {
				return path.relative(root, absolute) || path.basename(absolute);
			}
		}
		return absolute;
	};

	const shown = absolutePaths.slice(0, limit);
	const hidden = absolutePaths.length - shown.length;
	const heading = `\`${pattern}\` — ${absolutePaths.length} match${absolutePaths.length === 1 ? "" : "es"}${
		hidden > 0 ? `, first ${shown.length} shown` : ""
	}:`;
	return [
		heading,
		...shown.map((absolute) => `  ${relativeTo(absolute)}`),
	].join("\n");
}

/**
 * Directories a walk does not descend into.
 *
 * The same set VS Code excludes by default — `files.exclude` hides `.git` and
 * the other VCS metadata directories, `search.exclude` adds `node_modules` and
 * `bower_components`. Deliberately no build outputs: `dist` and `out` are
 * excluded by *some* users' settings and are the answer to "where did the
 * build go" for others, and a lister that silently hides a directory the user
 * asked about is the failure this tool exists to avoid. A project that wants
 * them out has a `.gitignore`, which is the right thing to read here and is
 * not read yet.
 */
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"bower_components",
]);

/** Directories entered during one glob search, so a symlink loop cannot hang it. */
const MAX_WALKED_DIRECTORIES = 20_000;

/**
 * Translate a glob into a regular expression over slash-separated paths.
 *
 * Supports what the description promises and what a model actually writes: a
 * double star across directories, a single star and `?` within one segment,
 * `{a,b}` alternation and `[...]` classes.
 *
 * A double star followed by a slash matches no directories as readily as many,
 * so a pattern that opens with one finds a file sitting at the root too. A
 * model writing it means "anywhere", and the root is anywhere.
 */
export function globToRegExp(pattern: string): RegExp {
	const source = pattern.replace(/\\/g, "/");
	let out = "";
	let braces = 0;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "*") {
			if (source[index + 1] === "*") {
				if (source[index + 2] === "/") {
					out += "(?:[^/]*/)*";
					index += 2;
					continue;
				}
				out += ".*";
				index += 1;
				continue;
			}
			out += "[^/]*";
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			continue;
		}
		if (char === "{") {
			braces++;
			out += "(?:";
			continue;
		}
		if (char === "}" && braces > 0) {
			braces--;
			out += ")";
			continue;
		}
		// Only inside a brace group is a comma an alternation; elsewhere it is a
		// character in a filename, and filenames do contain commas.
		if (char === "," && braces > 0) {
			out += "|";
			continue;
		}
		if (char === "[" || char === "]") {
			out += char;
			continue;
		}
		out += char.replace(/[.+^$(){}|\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

/**
 * A lister backed by the filesystem, for a host with no editor to ask.
 *
 * One root, because that is what a host without a workspace concept has: the
 * directory the run was started in. Everything the tool guarantees — the
 * containment check, the result cap, the excludes — is the same either way,
 * which is the point of the interface.
 */
export function createLocalWorkspaceLister(root: string): WorkspaceLister {
	const absoluteRoot = path.resolve(root);
	return {
		roots: () => [absoluteRoot],

		readDirectory: async (absolutePath: string): Promise<DirectoryEntry[]> => {
			const found = await fs.readdir(absolutePath, { withFileTypes: true });
			const entries: DirectoryEntry[] = [];
			for (const entry of found) {
				if (entry.isDirectory()) {
					if (DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) {
						continue;
					}
					entries.push({ name: entry.name, kind: "directory" });
					continue;
				}
				// A size the host could say cheaply, and nothing more: a file that
				// vanished between the readdir and the stat is listed without one
				// rather than failing the call.
				let size: number | undefined;
				try {
					size = (await fs.stat(path.join(absolutePath, entry.name))).size;
				} catch {
					size = undefined;
				}
				entries.push({
					name: entry.name,
					kind: "file",
					...(size !== undefined ? { size } : {}),
				});
			}
			return entries;
		},

		findFiles: async (
			pattern: string,
			maxResults: number,
		): Promise<string[]> => {
			const matcher = globToRegExp(pattern);
			const matches: string[] = [];
			const queue: string[] = [absoluteRoot];
			let walked = 0;
			while (queue.length > 0 && matches.length < maxResults) {
				const directory = queue.shift() as string;
				if (walked++ >= MAX_WALKED_DIRECTORIES) {
					break;
				}
				let entries: Dirent[];
				try {
					entries = await fs.readdir(directory, { withFileTypes: true });
				} catch {
					// A directory that cannot be read is skipped rather than failing
					// the search: one unreadable folder must not deny the other
					// hundred that matched.
					continue;
				}
				for (const entry of entries) {
					const absolute = path.join(directory, entry.name);
					if (entry.isDirectory()) {
						if (!DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) {
							queue.push(absolute);
						}
						continue;
					}
					const relative = path
						.relative(absoluteRoot, absolute)
						.replace(/\\/g, "/");
					if (matcher.test(relative)) {
						matches.push(absolute);
						if (matches.length >= maxResults) {
							break;
						}
					}
				}
			}
			return matches;
		},
	};
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
			const input = (raw ?? {}) as ListFilesInput;
			const pattern =
				typeof input.pattern === "string" ? input.pattern.trim() : "";
			const requested = typeof input.path === "string" ? input.path.trim() : "";
			const limit = normalizeMaxResults(input.max_results);
			const query =
				pattern !== "" ? `find:${pattern}` : `list:${requested || "."}`;

			try {
				const lister = await options.createLister();
				const roots = lister.roots();

				if (pattern !== "") {
					const matches = await lister.findFiles(pattern, limit + 1);
					return {
						query,
						result: renderMatches(
							pattern,
							matches,
							roots,
							limit,
							options.getReadPaths?.() ?? [],
						),
						success: true,
					};
				}

				const base = roots[0] ?? options.cwd;
				const absolute =
					requested === "" ? base : path.resolve(base, requested);

				// The boundary, enforced rather than requested. `findFiles` gets
				// this from VS Code; a directory listing takes any path, so it is
				// checked here.
				if (
					roots.length > 0 &&
					!roots.some((root) => isWithin(root, absolute))
				) {
					return {
						query,
						result: "",
						error: `${absolute} is outside this workspace, so it cannot be listed. Only these folders can be listed: ${roots.join(", ")}. Listing is the only thing scoped this way — \`read_files\`, \`editor\` and \`check_file\` all take a path outside the workspace, so if you know the file you want, open it directly. To browse this folder, ask the user to open it.`,
						success: false,
					};
				}

				const entries = await lister.readDirectory(absolute);
				return {
					query,
					result: renderDirectory(absolute, entries, limit),
					success: true,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					query,
					result: "",
					error: `Could not list files: ${message}`,
					success: false,
				};
			}
		},
	});
}
