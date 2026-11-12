import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { HostDiagnostic, HostFileDiagnostics } from "../diagnostics/types";
import type {
	CodeIntelLocation,
	CodeIntelProvider,
	CodeIntelSymbol,
} from "../tools/ask-lsp";
import {
	fileUri,
	LspConnection,
	type LspServerSpec,
	serverName,
	uriToPath,
} from "./lsp-connection";

/**
 * The language servers of a host that has no editor to ask.
 *
 * In the extension, `ask_lsp`, `check_file` and the post-edit report read VS
 * Code, which already runs a server for every language in the workspace. A
 * terminal runs none, so this resolves a server per language, starts it on
 * the first question about a file of it, keeps it for the session, and keeps
 * what it publishes as the editor keeps it.
 *
 * The tools' contract is what makes this tractable: an operation that cannot
 * be answered returns nothing, and the tool says so plainly. So a language
 * with no server installed is a quiet "no answer" rather than an error -- the
 * same outcome the extension produces for a language whose extension the user
 * never installed.
 */

/** LSP language ids, by the extension that implies them. */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".html": "html",
	".htm": "html",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".json": "json",
	".jsonc": "jsonc",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
	".java": "java",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hh": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".cs": "csharp",
	".sh": "shellscript",
	".bash": "shellscript",
};

export function languageIdFor(filePath: string): string | undefined {
	return LANGUAGE_BY_EXTENSION[extname(filePath).toLowerCase()];
}

/**
 * A TypeScript installation this machine already has, for servers that need one.
 *
 * Only the globally installed one is considered: a workspace that has its own
 * is found by the server without help, and this exists for the case where there
 * is nothing to find. `tsserver.js` rather than the package root, because the
 * 7.x `typescript` package is a native wrapper that ships no `tsserver` at all
 * and would otherwise be handed over as if it were usable.
 */
export function findGlobalTypescriptLib(): string | undefined {
	const roots = [
		process.env.TSSERVER_PATH,
		"/usr/local/lib/node_modules/typescript/lib",
		"/usr/lib/node_modules/typescript/lib",
		join(process.env.HOME ?? "", ".npm-global/lib/node_modules/typescript/lib"),
	];
	for (const root of roots) {
		if (root && existsSync(join(root, "tsserver.js"))) {
			return root;
		}
	}
	return undefined;
}

/**
 * What VS Code's HTML extension hands its server, and what it answers when
 * the server asks: the script and the style of a page are checked as
 * JavaScript and CSS. The server's script mode reads
 * `js/ts.implicitProjectConfig` with no guard, so it is given VS Code's
 * defaults rather than left to fail.
 */
export const HTML_SERVER_SETTINGS: Record<string, unknown> = {
	html: { validate: { scripts: true, styles: true } },
	"js/ts": {
		implicitProjectConfig: {
			strictNullChecks: true,
			experimentalDecorators: false,
		},
	},
};

/**
 * The servers this host will try, and what each one answers for.
 *
 * Resolution is by what is actually on the machine: the first spec whose
 * command exists and whose language list covers the file wins. Nothing is
 * installed on demand -- a host that pulled down a language server mid-turn
 * would be a surprise, and the tools degrade honestly without one. A host
 * with its own install prefix (automaticum's runner) passes its own specs.
 */
export const DEFAULT_LSP_SERVERS: LspServerSpec[] = [
	{
		name: "typescript-language-server",
		command: "typescript-language-server",
		args: ["--stdio"],
		languages: [
			"typescript",
			"typescriptreact",
			"javascript",
			"javascriptreact",
		],
		// Told where TypeScript is rather than left to find it. The server looks
		// for one in the workspace and exits outright when there is none --
		// "Could not find a valid TypeScript installation" -- which is the normal
		// state of a workspace holding one broken `.html` file.
		initializationOptions: () => {
			const lib = findGlobalTypescriptLib();
			return lib ? { tsserver: { path: lib } } : undefined;
		},
		// VS Code's TypeScript extension labels what tsserver reports "ts".
		sources: { typescript: "ts" },
	},
	{
		name: "vscode-html-language-server",
		command: "vscode-html-language-server",
		args: ["--stdio"],
		languages: ["html"],
		initializationOptions: {
			provideFormatter: false,
			embeddedLanguages: { css: true, javascript: true },
		},
		settings: HTML_SERVER_SETTINGS,
	},
	{
		name: "vscode-css-language-server",
		command: "vscode-css-language-server",
		args: ["--stdio"],
		languages: ["css", "scss", "less"],
		initializationOptions: { provideFormatter: false },
	},
	{
		name: "vscode-json-language-server",
		command: "vscode-json-language-server",
		args: ["--stdio"],
		languages: ["json", "jsonc"],
		initializationOptions: { provideFormatter: false },
	},
	{
		name: "pyright",
		command: "pyright-langserver",
		args: ["--stdio"],
		languages: ["python"],
	},
	{
		name: "bash-language-server",
		command: "bash-language-server",
		args: ["start"],
		languages: ["shellscript"],
	},
	{ name: "gopls", command: "gopls", args: ["serve"], languages: ["go"] },
	{
		name: "rust-analyzer",
		command: "rust-analyzer",
		args: [],
		languages: ["rust"],
	},
	// No background index: clangd writes it into the workspace (`.cache/`).
	{
		name: "clangd",
		command: "clangd",
		args: ["--background-index=false"],
		languages: ["c", "cpp"],
	},
	// Pull diagnostics only: its first answer comes before it has loaded the
	// project, and it sends no refresh, so it is asked again on every touch.
	{ name: "csharp-ls", command: "csharp-ls", args: [], languages: ["csharp"] },
];

/**
 * Whether a command can be run, without running it.
 *
 * A PATH walk rather than `which`: spawning a shell to ask about ten servers
 * costs more than reading ten directories, and this runs before the first
 * question is answered.
 */
export function commandExists(command: string): boolean {
	return resolveCommand(command) !== undefined;
}

function resolveCommand(command: string): string | undefined {
	// A command with a path in it is already an answer, and walking PATH for it
	// silently finds nothing: `join("/usr/bin", "/usr/bin/node")` is
	// `/usr/bin/usr/bin/node`.
	if (command.includes("/") || command.includes("\\")) {
		return existsSync(command) ? command : undefined;
	}
	const separator = process.platform === "win32" ? ";" : ":";
	const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
	for (const dir of (process.env.PATH ?? "").split(separator)) {
		if (!dir) {
			continue;
		}
		for (const suffix of suffixes) {
			const candidate = join(dir, `${command}${suffix}`);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/** Whether a spec's server is on this machine. */
export function isServerInstalled(spec: LspServerSpec): boolean {
	return commandExists(spec.probe ?? spec.command);
}

export interface HtmlServerTypescriptGap {
	/** Where the server reads TypeScript's `lib.*.d.ts` from. */
	expected: string;
	/** A TypeScript beside the server that would fill it, if there is one. */
	typescript?: string;
}

/**
 * Whether the HTML server of `vscode-langservers-extracted` will find
 * TypeScript's library files.
 *
 * Its bundle (4.10.0) computes them as `<prefix>/node_modules/node_modules/
 * typescript/lib` -- one `node_modules` too many -- so in a normal install
 * they are never there, and a page's script is checked with no types: hover
 * says `any`. Nothing the client sends changes the path. Returns the gap, or
 * nothing when the server is not that one or the files are there.
 */
export function findHtmlServerTypescriptGap(
	spec: LspServerSpec,
): HtmlServerTypescriptGap | undefined {
	const located = resolveCommand(spec.probe ?? spec.command);
	if (!located) {
		return undefined;
	}
	let real: string;
	try {
		real = realpathSync(located);
	} catch {
		return undefined;
	}
	const marker = join("vscode-langservers-extracted", "bin");
	if (!dirname(real).endsWith(marker)) {
		return undefined;
	}
	const pkg = dirname(dirname(real));
	const expected = resolve(pkg, "..", "node_modules", "typescript", "lib");
	if (existsSync(join(expected, "lib.d.ts"))) {
		return undefined;
	}
	const sibling = resolve(pkg, "..", "typescript");
	return {
		expected,
		...(existsSync(join(sibling, "lib", "lib.d.ts"))
			? { typescript: sibling }
			: {}),
	};
}

/**
 * Fill the gap with a link to the TypeScript beside the server.
 *
 * Writes into the server's install prefix, so it is never done implicitly: a
 * host calls this when its owner has said so (automaticum's image does the
 * same at build time). Returns whether the link now exists.
 */
export function repairHtmlServerTypescript(
	gap: HtmlServerTypescriptGap,
): boolean {
	if (!gap.typescript) {
		return false;
	}
	const link = dirname(gap.expected);
	try {
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(gap.typescript, link, "dir");
		return existsSync(join(gap.expected, "lib.d.ts"));
	} catch {
		return false;
	}
}

interface Position {
	line: number;
	character: number;
}

function toLocation(raw: unknown): CodeIntelLocation | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const entry = raw as {
		uri?: string;
		targetUri?: string;
		range?: { start?: Position };
		targetSelectionRange?: { start?: Position };
	};
	const uri = entry.uri ?? entry.targetUri;
	const start = entry.range?.start ?? entry.targetSelectionRange?.start;
	if (!uri || !start) {
		return undefined;
	}
	return {
		filePath: uriToPath(uri),
		line: start.line,
		character: start.character,
	};
}

function toLocations(raw: unknown): CodeIntelLocation[] {
	if (Array.isArray(raw)) {
		return raw
			.map(toLocation)
			.filter((entry): entry is CodeIntelLocation => entry !== undefined);
	}
	const single = toLocation(raw);
	return single ? [single] : [];
}

/** LSP `SymbolKind` is a number; the tool wants something a model can read. */
const SYMBOL_KINDS = [
	"file",
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"function",
	"variable",
	"constant",
	"string",
	"number",
	"boolean",
	"array",
	"object",
	"key",
	"null",
	"enum member",
	"struct",
	"event",
	"operator",
	"type parameter",
];

function kindName(kind: unknown): string {
	return typeof kind === "number" && kind >= 1 && kind <= SYMBOL_KINDS.length
		? SYMBOL_KINDS[kind - 1]
		: "symbol";
}

function toSymbols(raw: unknown, fallbackPath?: string): CodeIntelSymbol[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const symbols: CodeIntelSymbol[] = [];
	const walk = (entries: unknown[], container?: string) => {
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			const node = entry as {
				name?: string;
				kind?: number;
				containerName?: string;
				location?: { uri?: string; range?: { start?: Position } };
				range?: { start?: Position };
				selectionRange?: { start?: Position };
				children?: unknown[];
				uri?: string;
			};
			const start =
				node.selectionRange?.start ??
				node.range?.start ??
				node.location?.range?.start;
			const uri = node.location?.uri ?? node.uri;
			if (node.name && start) {
				symbols.push({
					name: node.name,
					kind: kindName(node.kind),
					location: {
						filePath: uri ? uriToPath(uri) : (fallbackPath ?? ""),
						line: start.line,
						character: start.character,
					},
					containerName: node.containerName ?? container,
				});
			}
			if (Array.isArray(node.children)) {
				walk(node.children, node.name);
			}
		}
	};
	walk(raw);
	return symbols;
}

/** Directories never worth looking into for a workspace's languages. */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"target",
	"bin",
	"obj",
	"dist",
	"build",
	".venv",
	"__pycache__",
	".cache",
]);

/** The languages of a workspace's files, looked for at most `limit` entries deep. */
export function workspaceLanguages(root: string, limit = 5_000): string[] {
	const found = new Set<string>();
	const queue = [root];
	let seen = 0;
	while (queue.length > 0 && seen < limit) {
		const dir = queue.shift() as string;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++seen > limit) {
				break;
			}
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) {
					queue.push(join(dir, entry.name));
				}
			} else {
				const language = languageIdFor(entry.name);
				if (language) {
					found.add(language);
				}
			}
		}
	}
	return [...found].sort();
}

export interface LspServerStatus {
	server: string;
	languages: string[];
	installed: boolean;
	started?: boolean;
	failed?: string;
	/** Something the server needs that this machine lacks. */
	warning?: string;
}

export interface LspHostOptions {
	/** The workspace root the servers start in. */
	cwd: string;
	/** Tried in order; the first installed one for a language wins. */
	servers?: LspServerSpec[];
	onError?: (message: string, error: unknown) => void;
	/** Whether a spec's server is installed. Defaults to a PATH/probe check. */
	isInstalled?: (spec: LspServerSpec) => boolean;
}

export interface LspHost {
	/** `ask_lsp`'s host half. */
	provider: CodeIntelProvider;
	/**
	 * Hand the file's server the file as it is on disk (`save`: as just
	 * written). Undefined when no server answers for it or it cannot be read.
	 */
	touch(
		filePath: string,
		options?: { save?: boolean },
	): Promise<{ languageId: string } | undefined>;
	/** Whether an installed server answers for this file's language. */
	serves(filePath: string): boolean;
	/**
	 * Every file a server has reported on, with `pending` set when the file
	 * changed after the server last reported on it.
	 */
	readDiagnostics(): Promise<HostFileDiagnostics[]>;
	/** Start the servers for these languages (default: the workspace's) now. */
	prewarm(languages?: string[]): string[];
	/** Which server answers for which language, and in what state. */
	status(): LspServerStatus[];
	dispose(): Promise<void>;
}

/**
 * The session's language servers, behind `ask_lsp`, `check_file` and the
 * post-edit report.
 */
export function createLspHost(options: LspHostOptions): LspHost {
	const cwd = options.cwd;
	const specs = options.servers ?? DEFAULT_LSP_SERVERS;
	const installed = options.isInstalled ?? isServerInstalled;
	const onError = options.onError;
	/** By language: the connection, or null for "no server", remembered. */
	const connections = new Map<string, LspConnection | null>();
	/** By server: one process however many languages it answers for. */
	const byServer = new Map<string, LspConnection>();
	const diagnostics = new Map<
		string,
		{ diagnostics: HostDiagnostic[]; pending: boolean }
	>();

	function hold(
		filePath: string,
		next: HostDiagnostic[] | undefined,
		pending: boolean,
	) {
		const previous = diagnostics.get(filePath);
		diagnostics.set(filePath, {
			diagnostics: next ?? previous?.diagnostics ?? [],
			pending,
		});
	}

	function connectionForLanguage(
		languageId: string,
	): LspConnection | undefined {
		const existing = connections.get(languageId);
		if (existing !== undefined) {
			return existing ?? undefined;
		}
		const spec = specs.find(
			(candidate) =>
				candidate.languages.includes(languageId) && installed(candidate),
		);
		if (!spec) {
			// Remembered as "no server", so the PATH is not walked again for every
			// question about every file of this language.
			connections.set(languageId, null);
			return undefined;
		}
		let connection = byServer.get(serverName(spec));
		if (!connection) {
			connection = new LspConnection(spec, cwd, {
				onError,
				onDiagnostics: (filePath, list) => hold(resolve(filePath), list, false),
			});
			byServer.set(serverName(spec), connection);
		}
		connections.set(languageId, connection);
		return connection;
	}

	function connectionFor(filePath: string): LspConnection | undefined {
		const languageId = languageIdFor(filePath);
		return languageId ? connectionForLanguage(languageId) : undefined;
	}

	async function touch(
		filePath: string,
		touchOptions?: { save?: boolean },
	): Promise<{ languageId: string; connection: LspConnection } | undefined> {
		const absolute = resolve(cwd, filePath);
		const languageId = languageIdFor(absolute);
		const connection = connectionFor(absolute);
		if (!connection || !languageId) {
			return undefined;
		}
		let text: string;
		try {
			// Read every time, never cached: the model is editing these files as
			// it works, and an mtime is not fine-grained enough to notice an edit
			// that lands in the same millisecond as the read before it.
			text = await readFile(absolute, "utf-8");
		} catch {
			return undefined;
		}
		try {
			await connection.ready();
		} catch {
			return undefined;
		}
		if (connection.syncDocument(absolute, text, languageId)) {
			hold(absolute, undefined, true);
		}
		if (touchOptions?.save) {
			connection.documentSaved(absolute);
		}
		// A server that answers only when asked is asked on every touch: its
		// first answer can come before it has loaded the project, and it says
		// nothing when that changes.
		if (connection.pullsDiagnostics) {
			hold(absolute, undefined, true);
			connection
				.pullDiagnostics(absolute)
				.then((list) => hold(absolute, list, false))
				.catch((error: unknown) => {
					hold(absolute, undefined, false);
					onError?.("[lsp] textDocument/diagnostic failed", error);
				});
		}
		return { languageId, connection };
	}

	/** Sync the document, then ask. Undefined when nothing can answer. */
	async function ask(
		filePath: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const held = await touch(filePath);
		if (!held) {
			return undefined;
		}
		try {
			return await held.connection.request(method, params);
		} catch (error) {
			onError?.(`[ask_lsp] ${method} failed`, error);
			return undefined;
		}
	}

	function at(filePath: string, location: CodeIntelLocation) {
		return {
			textDocument: { uri: fileUri(filePath) },
			position: { line: location.line, character: location.character },
		};
	}

	async function positional(
		method: string,
		location: CodeIntelLocation,
		extra: Record<string, unknown> = {},
	): Promise<CodeIntelLocation[]> {
		const raw = await ask(location.filePath, method, {
			...at(location.filePath, location),
			...extra,
		});
		return toLocations(raw);
	}

	async function lines(filePath: string): Promise<string[]> {
		return (await readFile(filePath, "utf-8")).split(/\r?\n/);
	}

	const provider: CodeIntelProvider = {
		/**
		 * Find where a name occurs in a file, as the extension does: the
		 * document's own symbol table first, because a declaration is what the
		 * model almost always means and a hit there is unambiguous; then the
		 * first whole-word occurrence, which covers locals, imports and
		 * anything the server does not list -- and every file no server serves.
		 */
		async findSymbolPosition(filePath, symbol) {
			const declared = (
				await provider.documentSymbols(filePath).catch(() => [])
			).find((entry) => entry.name === symbol);
			if (declared) {
				return declared.location;
			}
			const source = await lines(filePath).catch(() => undefined);
			if (!source) {
				return undefined;
			}
			const pattern = new RegExp(
				`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
			);
			for (let line = 0; line < source.length; line++) {
				const match = pattern.exec(source[line]);
				if (match) {
					return { filePath, line, character: match.index };
				}
			}
			return undefined;
		},
		definitions: (location) => positional("textDocument/definition", location),
		typeDefinitions: (location) =>
			positional("textDocument/typeDefinition", location),
		implementations: (location) =>
			positional("textDocument/implementation", location),
		references: (location) =>
			positional("textDocument/references", location, {
				context: { includeDeclaration: false },
			}),
		async hover(location) {
			const raw = (await ask(location.filePath, "textDocument/hover", {
				...at(location.filePath, location),
			})) as { contents?: unknown } | undefined;
			const contents = raw?.contents;
			if (!contents) {
				return undefined;
			}
			if (typeof contents === "string") {
				return contents;
			}
			if (Array.isArray(contents)) {
				return contents
					.map((part) =>
						typeof part === "string"
							? part
							: ((part as { value?: string }).value ?? ""),
					)
					.filter(Boolean)
					.join("\n");
			}
			return (contents as { value?: string }).value;
		},
		async documentSymbols(filePath) {
			const raw = await ask(filePath, "textDocument/documentSymbol", {
				textDocument: { uri: fileUri(filePath) },
			});
			return toSymbols(raw, filePath);
		},
		async workspaceSymbols(query) {
			// No file to key on, so every started server is asked and the answers
			// are merged. A server not started this session has nothing to say
			// about the workspace yet, which is the honest answer.
			const results: CodeIntelSymbol[] = [];
			for (const connection of byServer.values()) {
				try {
					await connection.ready();
					results.push(
						...toSymbols(
							await connection.request("workspace/symbol", { query }),
						),
					);
				} catch (error) {
					onError?.("[ask_lsp] workspace/symbol failed", error);
				}
			}
			return results;
		},
		async callers(location) {
			const prepared = (await ask(
				location.filePath,
				"textDocument/prepareCallHierarchy",
				{ ...at(location.filePath, location) },
			)) as unknown[] | undefined;
			const item = Array.isArray(prepared) ? prepared[0] : undefined;
			const connection = item ? connectionFor(location.filePath) : undefined;
			if (!connection) {
				return [];
			}
			try {
				const incoming = (await connection.request(
					"callHierarchy/incomingCalls",
					{ item },
				)) as Array<{ from?: unknown }> | undefined;
				return Array.isArray(incoming)
					? toSymbols(incoming.map((entry) => entry.from))
					: [];
			} catch (error) {
				onError?.("[ask_lsp] incomingCalls failed", error);
				return [];
			}
		},
		async readLine(filePath, line) {
			return (await lines(filePath).catch(() => undefined))?.[line];
		},
		async readFile(filePath) {
			return (await lines(filePath).catch(() => undefined))?.join("\n");
		},
	};

	return {
		provider,
		async touch(filePath, touchOptions) {
			const held = await touch(filePath, touchOptions);
			return held ? { languageId: held.languageId } : undefined;
		},
		serves: (filePath) => connectionFor(resolve(cwd, filePath)) !== undefined,
		async readDiagnostics() {
			return [...diagnostics.entries()].map(([filePath, held]) => ({
				filePath,
				diagnostics: held.diagnostics,
				pending: held.pending,
			}));
		},
		prewarm(languages = workspaceLanguages(cwd)) {
			const started: string[] = [];
			for (const language of languages) {
				const connection = connectionForLanguage(language);
				const name = connection ? serverName(connection.spec) : undefined;
				if (connection && name && !started.includes(name)) {
					started.push(name);
					connection.ready().catch(() => {});
				}
			}
			return started;
		},
		status() {
			return specs.map((spec) => {
				const connection = byServer.get(serverName(spec));
				const isInstalled = installed(spec);
				const gap = isInstalled ? findHtmlServerTypescriptGap(spec) : undefined;
				return {
					server: serverName(spec),
					languages: spec.languages,
					installed: isInstalled,
					...(connection?.started ? { started: true } : {}),
					...(connection?.failed ? { failed: connection.failed.message } : {}),
					...(gap
						? {
								warning: `TypeScript's library files are not at ${gap.expected}, where this server reads them; a page's script is checked without types.${gap.typescript ? ` repairHtmlServerTypescript() links ${gap.typescript} there.` : ""}`,
							}
						: {}),
				};
			});
		},
		async dispose() {
			await Promise.all(
				[...byServer.values()].map((connection) =>
					connection.dispose().catch(() => {}),
				),
			);
		},
	};
}
