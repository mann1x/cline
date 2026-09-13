import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import { findScriptSyntaxError } from "./delimiter-balance";

/**
 * Hand the model the workspace's language servers.
 *
 * VS Code already runs a language server for every language in the workspace,
 * and those servers already know what every symbol means: where it is defined,
 * everywhere it is used, what its type is, which classes implement it. None of
 * that reached the model. It had regex search — `search_codebase` — and a regex
 * cannot tell a definition from a mention, a method on this class from a method
 * with the same name on another, or a live reference from one inside a comment.
 *
 * So the model compensates by reading. It greps a name, gets forty hits, reads
 * six files to work out which one is the definition, and spends the turns on
 * work the editor had already done and would have answered instantly. This is
 * free capability that was sitting one `executeCommand` away.
 *
 * Position resolution is the part that makes it usable. Every LSP request is
 * addressed by line and character, and a model almost never has those — it has
 * a name it read in a file. So `symbol` is the primary way to ask, and the
 * position is found on the model's behalf; line/character are accepted too, for
 * when it does know.
 *
 * The name is `ask_lsp` because `code_intel` was not carrying what the tool is.
 * Asked afterwards what `code_intel` had been, models that had *used it* did
 * not know it was the LSP and did not expect it to be — with the first line of
 * the description saying so, in the same request. A name is read every time and
 * retained; a description is read once. `ask_lsp` also cannot prefix-match an
 * MCP server's `lsp__*` tools, which a model in a workspace that has one was
 * observed merging with ours.
 *
 * The provider interface below keeps its `CodeIntel*` names. It is the editor's
 * code-intelligence surface, which this tool is one consumer of, and no model
 * ever sees it.
 */

export const ASK_LSP_TOOL_NAME = "ask_lsp";

export const ASK_LSP_OPERATIONS = [
	"definition",
	"references",
	"implementations",
	"type_definition",
	"hover",
	"document_symbols",
	"workspace_symbols",
	"callers",
] as const;

export type AskLspOperation = (typeof ASK_LSP_OPERATIONS)[number];

export const ASK_LSP_TOOL_DESCRIPTION = `Ask the language servers — the LSP — about a symbol. If you are reaching for an LSP tool or an MCP server that wraps one, this is it: the same protocol, already running against this workspace and its open files, with no server to start. This answers questions a text search cannot, because it understands the code: it distinguishes a definition from a mention, and this class's method from another class's method of the same name.

Use this before falling back to \`search_codebase\` for anything about a symbol. It is faster, exact, and does not need you to read files to interpret the result.

Reach for it the moment you are about to do one of these by hand:
- search for a name to find where it is defined -> \`definition\`
- search for a name to find what uses it, or what would break -> \`references\` or \`callers\`
- open a file just to read a signature, type or doc comment -> \`hover\`
- scroll a file, or count brackets, to work out its structure -> \`document_symbols\`
- grep the repo to find which file something lives in -> \`workspace_symbols\`

Operations:
- \`definition\` — where a symbol is defined.
- \`references\` — every place it is actually used.
- \`implementations\` — the classes or functions implementing an interface or abstract method.
- \`type_definition\` — where the type of an expression is defined.
- \`hover\` — the signature, type and documentation, as an editor shows on hover.
- \`document_symbols\` — an outline of one file: its classes, functions and methods.
- \`workspace_symbols\` — find a symbol by name across the whole project when you do not know which file it is in.
- \`callers\` — what calls this function.

How to address a symbol:
- Usually: \`path\` plus \`symbol\` — the name as it appears in that file.
- If you know the exact position: \`path\`, \`line\` and \`character\` (both 1-based).
- If you do not know the file: \`symbol\` alone, with \`operation: "workspace_symbols"\`.

Output: plain text, one result per line as \`file:line:column\` followed by that source line, so you can go straight to the one you want rather than reading each candidate. \`hover\` returns the signature and documentation as text instead, and \`document_symbols\` and \`workspace_symbols\` name each symbol's kind.

An empty answer is a real answer once the symbol resolved: for \`definition\`, \`references\`, \`implementations\`, \`type_definition\`, \`callers\` and \`hover\` the server understood the symbol and nothing matched, so a text search for the same question will not find more. \`workspace_symbols\` is the exception, and says so when it comes back empty: it reads a project-wide index that covers the languages a server is installed for and does not index script embedded in \`.html\` or other template files, so nothing there is not proof of nothing anywhere. And when the file does not parse, every answer about it opens with that line — while it is there, the server is answering from a partial parse and you are reading guesses.`;

/** Exported for the same reason as `CHECK_FILE_TOOL_INPUT_SCHEMA`. */
export const ASK_LSP_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		operation: {
			type: "string",
			enum: [...ASK_LSP_OPERATIONS],
			description: "What to ask the language server.",
		},
		path: {
			type: "string",
			description:
				"File the symbol appears in. Absolute, or relative to the working directory.",
		},
		symbol: {
			type: "string",
			description:
				"The symbol's name, as written in that file. The usual way to address a symbol.",
		},
		line: {
			type: "number",
			description: "1-based line, if you know the exact position.",
		},
		character: {
			type: "number",
			description: "1-based column, if you know the exact position.",
		},
	},
	required: ["operation"],
} as const;

/** Results per answer. Past this the model should narrow the question. */
const MAX_RESULTS = 40;

/** A location in a file. Lines and characters are 0-based, as LSP has them. */
export interface CodeIntelLocation {
	filePath: string;
	line: number;
	character: number;
}

export interface CodeIntelSymbol {
	name: string;
	/** "class", "function", "method", … — whatever the server calls it. */
	kind: string;
	location: CodeIntelLocation;
	/** The class or module the symbol sits in, when the server says. */
	containerName?: string;
}

/**
 * Everything this tool needs from the editor.
 *
 * An interface rather than direct `vscode` calls so the tool's behaviour — the
 * position resolution, the fallbacks, the rendering — is testable without an
 * extension host. `check-file-tool.ts` is built the same way.
 */
export interface CodeIntelProvider {
	/** Locate a name inside one file, for the position-addressed requests. */
	findSymbolPosition(
		filePath: string,
		symbol: string,
	): Promise<CodeIntelLocation | undefined>;
	definitions(at: CodeIntelLocation): Promise<CodeIntelLocation[]>;
	typeDefinitions(at: CodeIntelLocation): Promise<CodeIntelLocation[]>;
	implementations(at: CodeIntelLocation): Promise<CodeIntelLocation[]>;
	references(at: CodeIntelLocation): Promise<CodeIntelLocation[]>;
	hover(at: CodeIntelLocation): Promise<string | undefined>;
	documentSymbols(filePath: string): Promise<CodeIntelSymbol[]>;
	workspaceSymbols(query: string): Promise<CodeIntelSymbol[]>;
	callers(at: CodeIntelLocation): Promise<CodeIntelSymbol[]>;
	/** The source line, so a result is readable without opening the file. */
	readLine(filePath: string, line: number): Promise<string | undefined>;
	/**
	 * The whole file, for the parse check that qualifies every answer about it.
	 *
	 * Optional because it arrived after the two hosts did, and a provider that
	 * cannot read the file should lose the warning rather than the answer.
	 */
	readFile?(filePath: string): Promise<string | undefined>;
}

export interface AskLspToolOptions {
	cwd: string;
	provider: CodeIntelProvider;
	/**
	 * Where a failed request goes. Injected rather than imported: this tool is
	 * shared by the extension and the CLI, and each has its own logger.
	 */
	onError?: (message: string, error: unknown) => void;
}

interface AskLspInput {
	operation?: unknown;
	path?: unknown;
	symbol?: unknown;
	/**
	 * Accepted as a spelling of `symbol`. `search_codebase` sits next to this
	 * tool and takes `queries`, so a model reaching for a name-search here
	 * reasonably guesses `query` -- observed doing exactly that, which cost a
	 * turn and a fall back to a text search for a question the language server
	 * had already been asked.
	 */
	query?: unknown;
	line?: unknown;
	character?: unknown;
}

export interface ParsedAskLspRequest {
	operation: AskLspOperation;
	filePath?: string;
	symbol?: string;
	/** 0-based, converted from the 1-based numbers the description asks for. */
	line?: number;
	character?: number;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: undefined;
}

function readIndex(value: unknown): number | undefined {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric)) {
		return undefined;
	}
	// The description asks for 1-based, which is what an editor shows and what
	// every error message the model has ever read uses. A model that sends 0
	// anyway means the first line, so the floor is 0 either way.
	return Math.max(0, Math.trunc(numeric) - 1);
}

/**
 * Read a request, or say what is missing from it.
 *
 * Returns a message rather than throwing: an unusable call should cost the
 * model one sentence telling it what to send, not a tool error it has to
 * interpret.
 */
export function parseAskLspRequest(
	input: AskLspInput | undefined,
): ParsedAskLspRequest | string {
	const operation = readString(input?.operation)?.toLowerCase() as
		| AskLspOperation
		| undefined;
	if (!operation || !ASK_LSP_OPERATIONS.includes(operation)) {
		return `\`operation\` must be one of: ${ASK_LSP_OPERATIONS.join(", ")}.`;
	}

	const filePath = readString(input?.path);
	const symbol = readString(input?.symbol) ?? readString(input?.query);
	const line = readIndex(input?.line);
	const character = readIndex(input?.character);

	if (operation === "workspace_symbols") {
		return symbol
			? { operation, symbol }
			: { operation, symbol: filePath ?? "" };
	}
	if (operation === "document_symbols") {
		return filePath
			? { operation, filePath }
			: "`document_symbols` needs a `path`.";
	}
	if (!filePath) {
		return `\`${operation}\` needs a \`path\`, plus either a \`symbol\` or a \`line\` and \`character\`.`;
	}
	if (symbol === undefined && line === undefined) {
		return `\`${operation}\` needs a \`symbol\` to look for in ${filePath}, or a \`line\` and \`character\`.`;
	}
	return { operation, filePath, symbol, line, character };
}

function relative(cwd: string, filePath: string): string {
	const rel = path.relative(cwd, filePath);
	return rel && !rel.startsWith("..") ? rel : filePath;
}

export function createAskLspTool(options: AskLspToolOptions): AgentTool {
	const { provider, cwd } = options;

	const renderLocations = async (
		locations: readonly CodeIntelLocation[],
		empty: string,
	): Promise<string> => {
		if (locations.length === 0) {
			return empty;
		}
		const shown = locations.slice(0, MAX_RESULTS);
		const lines = await Promise.all(
			shown.map(async (location) => {
				const source = (
					await provider.readLine(location.filePath, location.line)
				)?.trim();
				const where = `${relative(cwd, location.filePath)}:${location.line + 1}:${location.character + 1}`;
				return source ? `${where}  ${source}` : where;
			}),
		);
		const omitted = locations.length - shown.length;
		return omitted > 0
			? `${lines.join("\n")}\n…and ${omitted} more`
			: lines.join("\n");
	};

	const renderSymbols = (
		symbols: readonly CodeIntelSymbol[],
		empty: string,
	): string => {
		if (symbols.length === 0) {
			return empty;
		}
		const shown = symbols.slice(0, MAX_RESULTS);
		const lines = shown.map((symbol) => {
			const where = `${relative(cwd, symbol.location.filePath)}:${symbol.location.line + 1}`;
			const container = symbol.containerName ? `${symbol.containerName}.` : "";
			return `${symbol.kind} ${container}${symbol.name} — ${where}`;
		});
		const omitted = symbols.length - shown.length;
		return omitted > 0
			? `${lines.join("\n")}\n…and ${omitted} more`
			: lines.join("\n");
	};

	return createTool({
		name: ASK_LSP_TOOL_NAME,
		description: ASK_LSP_TOOL_DESCRIPTION,
		inputSchema: ASK_LSP_TOOL_INPUT_SCHEMA,
		execute: async (rawInput: unknown) => {
			const request = parseAskLspRequest(rawInput as AskLspInput | undefined);
			if (typeof request === "string") {
				return request;
			}

			try {
				if (request.operation === "workspace_symbols") {
					if (!request.symbol) {
						// Name every spelling that works. The old message named
						// only `symbol`, so a call that sent something else was
						// told what was missing but not that its own field had
						// been ignored.
						return "`workspace_symbols` needs the name to search for, as `symbol` (or `query`).";
					}
					return renderSymbols(
						await provider.workspaceSymbols(request.symbol),
						// The one empty answer this tool cannot stand behind.
						// It reads a project-wide index, and an index has a
						// shape: it covers the languages a server is installed
						// for, and script inside an `.html` file is in none of
						// them. Reported as authoritative, a class that plainly
						// exists comes back "no symbol" and the model either
						// believes it or stops believing the tool.
						`No symbol named "${request.symbol}" in the project-wide index. That index covers the languages a server is installed for and does not index script embedded in \`.html\` or other template files, so this is not proof the symbol does not exist: if you know which file it is in, ask \`document_symbols\` for that file; otherwise \`search_codebase\` is the right fallback here.`,
					);
				}

				const filePath = path.resolve(cwd, request.filePath as string);
				const display = relative(cwd, filePath);

				const fault = await describeParseFault(provider, filePath, display);

				if (request.operation === "document_symbols") {
					return (
						fault +
						renderSymbols(
							await provider.documentSymbols(filePath),
							`${display}: no symbols reported.`,
						)
					);
				}

				const at = await resolvePosition(provider, filePath, request);
				if (!at) {
					// The distinction matters: "the symbol is not there" is a
					// different problem from "the language server said nothing".
					return `${fault}Could not find \`${request.symbol}\` in ${display}. Check the spelling, or pass \`line\` and \`character\`.`;
				}

				return fault + (await answer(request.operation, at));
			} catch (error) {
				options.onError?.("[CodeIntel] request failed", error);
				return `The language server could not answer: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	});

	/** The position-addressed operations, once the position is known. */
	async function answer(
		operation: AskLspOperation,
		at: CodeIntelLocation,
	): Promise<string> {
		switch (operation) {
			case "definition":
				return await renderLocations(
					await provider.definitions(at),
					`No definition found for that symbol.`,
				);
			case "type_definition":
				return await renderLocations(
					await provider.typeDefinitions(at),
					`No type definition found.`,
				);
			case "implementations":
				return await renderLocations(
					await provider.implementations(at),
					`No implementations found.`,
				);
			case "references":
				return await renderLocations(
					await provider.references(at),
					`No references found.`,
				);
			case "callers":
				return renderSymbols(await provider.callers(at), `Nothing calls that.`);
			case "hover": {
				const hover = await provider.hover(at);
				return hover?.trim()
					? hover.trim()
					: `The language server had nothing to say about that symbol.`;
			}
			default:
				return `Unsupported operation: ${operation}.`;
		}
	}
}

/**
 * A line to put in front of every answer about a file that does not parse.
 *
 * A language server does not stop at a syntax error: it recovers, and keeps
 * answering from whatever tree it salvaged. So `definition` still returns a
 * location and `references` still returns a list, and past the fault both are
 * guesses — which is exactly the state a model is in when it is hunting a
 * broken file, and exactly when it is least able to tell. Saying so costs one
 * line and turns a wrong answer into a signposted one.
 *
 * The check is the same `new Function` parse `check_file` uses, on the same
 * file extensions, so the two tools never disagree about whether a file parses.
 */
async function describeParseFault(
	provider: CodeIntelProvider,
	filePath: string,
	display: string,
): Promise<string> {
	const source = await provider.readFile?.(filePath).catch(() => undefined);
	if (source === undefined) {
		return "";
	}
	const fault = findScriptSyntaxError(filePath, source);
	return fault
		? `${display} does not parse — ${fault}. The language server answered from a partial parse, so treat what follows as a guess: run \`check_file\` on this file and fix the syntax first.\n\n`
		: "";
}

/**
 * Turn what the model sent into a position the language server accepts.
 *
 * An explicit position wins when given. Otherwise the symbol's name is located
 * in the file, which is the case this tool exists to make possible — a model
 * reading code has names, not coordinates.
 */
async function resolvePosition(
	provider: CodeIntelProvider,
	filePath: string,
	request: ParsedAskLspRequest,
): Promise<CodeIntelLocation | undefined> {
	if (request.line !== undefined) {
		return { filePath, line: request.line, character: request.character ?? 0 };
	}
	if (!request.symbol) {
		return undefined;
	}
	return await provider.findSymbolPosition(filePath, request.symbol);
}
