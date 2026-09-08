import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
	CodeIntelLocation,
	CodeIntelProvider,
	CodeIntelSymbol,
} from "@cline/core";
import {
	fileUri,
	LspConnection,
	type LspServerSpec,
	uriToPath,
} from "./lsp-client";

/**
 * The CLI half of `code_intel`.
 *
 * In the extension this is a thin wrapper over VS Code, which already runs a
 * language server for every language in the workspace. A terminal runs none, so
 * this resolves a server per language, starts it on the first question, and
 * keeps it for the session.
 *
 * The tool's contract is what makes this tractable: an operation that cannot be
 * answered returns nothing, and the tool says so plainly. So a language with no
 * server installed is a quiet "no answer" rather than an error — the same
 * outcome the extension produces for a language whose extension the user never
 * installed.
 */

/** LSP language ids, by the extension that implies them. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
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
	".json": "json",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
	".java": "java",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".hpp": "cpp",
};

/**
 * The servers this host will try, and what each one answers for.
 *
 * Resolution is by what is actually on the machine: the first spec whose
 * command exists and whose language list covers the file wins. Nothing is
 * installed on demand — a CLI that pulled down a language server mid-turn would
 * be a surprise, and the tool degrades honestly without one.
 */
export const DEFAULT_LSP_SERVERS: LspServerSpec[] = [
	{
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
	},
	{
		command: "vscode-html-language-server",
		args: ["--stdio"],
		languages: ["html"],
	},
	{
		command: "vscode-css-language-server",
		args: ["--stdio"],
		languages: ["css"],
	},
	{ command: "pyright-langserver", args: ["--stdio"], languages: ["python"] },
	{ command: "gopls", args: ["serve"], languages: ["go"] },
	{ command: "rust-analyzer", args: [], languages: ["rust"] },
];

/**
 * A TypeScript installation this machine already has, for servers that need one.
 *
 * Only the globally installed one is considered: a workspace that has its own
 * is found by the server without help, and this exists for the case where there
 * is nothing to find. `tsserver.js` rather than the package root, because the
 * 7.x `typescript` package is a native wrapper that ships no `tsserver` at all
 * and would otherwise be handed over as if it were usable.
 */
function findGlobalTypescriptLib(): string | undefined {
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

export function languageIdFor(filePath: string): string | undefined {
	return LANGUAGE_BY_EXTENSION[extname(filePath).toLowerCase()];
}

/**
 * Whether a command can be run, without running it.
 *
 * A PATH walk rather than `which`: spawning a shell to ask about six servers on
 * every session start costs more than reading six directories, and this runs
 * before the first `code_intel` question is answered.
 */
function commandExists(command: string): boolean {
	// A command with a path in it is already an answer, and walking PATH for it
	// silently finds nothing: `join("/usr/bin", "/usr/bin/node")` is
	// `/usr/bin/usr/bin/node`. Anyone naming a server by its full path -- which
	// is how a non-standard install is configured -- would get "no server".
	if (command.includes("/") || command.includes("\\")) {
		return existsSync(command);
	}
	const separator = process.platform === "win32" ? ";" : ":";
	const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
	for (const dir of (process.env.PATH ?? "").split(separator)) {
		if (!dir) {
			continue;
		}
		for (const suffix of suffixes) {
			if (existsSync(join(dir, `${command}${suffix}`))) {
				return true;
			}
		}
	}
	return false;
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
				detail?: string;
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

export interface CliCodeIntelOptions {
	cwd: string;
	servers?: LspServerSpec[];
	onError?: (message: string, error: unknown) => void;
}

export function createCliCodeIntelProvider(
	options: CliCodeIntelOptions,
): CodeIntelProvider {
	const servers = options.servers ?? DEFAULT_LSP_SERVERS;
	const connections = new Map<string, LspConnection | null>();
	/**
	 * The text each file had when the server was last told about it.
	 *
	 * Not a read cache -- the file is read every time, because the model is
	 * editing these files as it works and an mtime is not fine-grained enough to
	 * notice an edit that lands in the same millisecond as the read before it.
	 * This exists only to answer "has it changed since the server saw it", which
	 * decides whether the document has to be handed over again.
	 */
	const lastSeen = new Map<string, string>();

	/** The connection that answers for this file, started if it is the first. */
	function connectionFor(filePath: string): LspConnection | undefined {
		const languageId = languageIdFor(filePath);
		if (!languageId) {
			return undefined;
		}
		const existing = connections.get(languageId);
		if (existing !== undefined) {
			return existing ?? undefined;
		}
		const spec = servers.find(
			(candidate) =>
				candidate.languages.includes(languageId) &&
				commandExists(candidate.command),
		);
		if (!spec) {
			// Remembered as "no server", so the PATH is not walked again for every
			// question about every file of this language.
			connections.set(languageId, null);
			return undefined;
		}
		const connection = new LspConnection(spec, options.cwd, options.onError);
		connections.set(languageId, connection);
		return connection;
	}

	async function lines(filePath: string): Promise<string[]> {
		const text = await readFile(filePath, "utf-8");
		const previous = lastSeen.get(filePath);
		if (previous !== undefined && previous !== text) {
			// The server is holding text the file no longer contains, so it has to
			// be handed the file again before the next question is asked about it.
			connectionFor(filePath)?.reopenDocument(filePath);
		}
		lastSeen.set(filePath, text);
		return text.split(/\r?\n/);
	}

	/** Open the document, then ask. Undefined when nothing can answer. */
	async function ask(
		filePath: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const connection = connectionFor(filePath);
		if (!connection) {
			return undefined;
		}
		try {
			await connection.ready();
			const text = (await lines(filePath)).join("\n");
			await connection.openDocument(
				filePath,
				text,
				languageIdFor(filePath) ?? "plaintext",
			);
			return await connection.request(method, params);
		} catch (error) {
			options.onError?.(`[code_intel] ${method} failed`, error);
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

	return {
		async findSymbolPosition(filePath, symbol) {
			// Located by reading rather than by asking the server: this is the
			// call that turns a name the model read into a position, and it has
			// to work before any document is open.
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
			// are merged. A server that has not been started for this session has
			// nothing to say about the workspace yet, which is the honest answer.
			const results: CodeIntelSymbol[] = [];
			for (const connection of connections.values()) {
				if (!connection) {
					continue;
				}
				try {
					await connection.ready();
					results.push(
						...toSymbols(
							await connection.request("workspace/symbol", { query }),
						),
					);
				} catch (error) {
					options.onError?.("[code_intel] workspace/symbol failed", error);
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
			if (!item) {
				return [];
			}
			const connection = connectionFor(location.filePath);
			if (!connection) {
				return [];
			}
			try {
				const incoming = (await connection.request(
					"callHierarchy/incomingCalls",
					{ item },
				)) as Array<{ from?: unknown }> | undefined;
				if (!Array.isArray(incoming)) {
					return [];
				}
				return toSymbols(incoming.map((entry) => entry.from));
			} catch (error) {
				options.onError?.("[code_intel] incomingCalls failed", error);
				return [];
			}
		},
		async readLine(filePath, line) {
			const source = await lines(filePath).catch(() => undefined);
			return source?.[line];
		},
	};
}
