import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";

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
 */

export const CODE_INTEL_TOOL_NAME = "code_intel";

export const CODE_INTEL_OPERATIONS = [
	"definition",
	"references",
	"implementations",
	"type_definition",
	"hover",
	"document_symbols",
	"workspace_symbols",
	"callers",
] as const;

export type CodeIntelOperation = (typeof CODE_INTEL_OPERATIONS)[number];

export const CODE_INTEL_TOOL_DESCRIPTION = `Ask the language servers — the LSP — about a symbol. If you are reaching for an LSP tool or an MCP server that wraps one, this is it: the same protocol, already running against this workspace and its open files, with no server to start. This answers questions a text search cannot, because it understands the code: it distinguishes a definition from a mention, and this class's method from another class's method of the same name.

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

Output: plain text, one result per line as \`file:line:column\` followed by that source line, so you can go straight to the one you want rather than reading each candidate. \`hover\` returns the signature and documentation as text instead, and \`document_symbols\` and \`workspace_symbols\` name each symbol's kind. No results is a definite answer — the language server understands this symbol and nothing matches — so do not fall back to a text search for the same question.`;

/** Exported for the same reason as `CHECK_FILE_TOOL_INPUT_SCHEMA`. */
export const CODE_INTEL_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		operation: {
			type: "string",
			enum: [...CODE_INTEL_OPERATIONS],
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
}

export interface CodeIntelToolOptions {
	cwd: string;
	provider: CodeIntelProvider;
	/**
	 * Where a failed request goes. Injected rather than imported: this tool is
	 * shared by the extension and the CLI, and each has its own logger.
	 */
	onError?: (message: string, error: unknown) => void;
}

interface CodeIntelInput {
	operation?: unknown;
	path?: unknown;
	symbol?: unknown;
	line?: unknown;
	character?: unknown;
}

export interface ParsedCodeIntelRequest {
	operation: CodeIntelOperation;
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
export function parseCodeIntelRequest(
	input: CodeIntelInput | undefined,
): ParsedCodeIntelRequest | string {
	const operation = readString(input?.operation)?.toLowerCase() as
		| CodeIntelOperation
		| undefined;
	if (!operation || !CODE_INTEL_OPERATIONS.includes(operation)) {
		return `\`operation\` must be one of: ${CODE_INTEL_OPERATIONS.join(", ")}.`;
	}

	const filePath = readString(input?.path);
	const symbol = readString(input?.symbol);
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

export function createCodeIntelTool(options: CodeIntelToolOptions): AgentTool {
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
		name: CODE_INTEL_TOOL_NAME,
		description: CODE_INTEL_TOOL_DESCRIPTION,
		inputSchema: CODE_INTEL_TOOL_INPUT_SCHEMA,
		execute: async (rawInput: unknown) => {
			const request = parseCodeIntelRequest(
				rawInput as CodeIntelInput | undefined,
			);
			if (typeof request === "string") {
				return request;
			}

			try {
				if (request.operation === "workspace_symbols") {
					if (!request.symbol) {
						return "`workspace_symbols` needs a `symbol` to search for.";
					}
					return renderSymbols(
						await provider.workspaceSymbols(request.symbol),
						`No symbol matching "${request.symbol}" in this workspace.`,
					);
				}

				const filePath = path.resolve(cwd, request.filePath as string);
				const display = relative(cwd, filePath);

				if (request.operation === "document_symbols") {
					return renderSymbols(
						await provider.documentSymbols(filePath),
						`${display}: no symbols reported.`,
					);
				}

				const at = await resolvePosition(provider, filePath, request);
				if (!at) {
					// The distinction matters: "the symbol is not there" is a
					// different problem from "the language server said nothing".
					return `Could not find \`${request.symbol}\` in ${display}. Check the spelling, or pass \`line\` and \`character\`.`;
				}

				switch (request.operation) {
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
						return renderSymbols(
							await provider.callers(at),
							`Nothing calls that.`,
						);
					case "hover": {
						const hover = await provider.hover(at);
						return hover?.trim()
							? hover.trim()
							: `The language server had nothing to say about that symbol.`;
					}
					default:
						return `Unsupported operation: ${request.operation}.`;
				}
			} catch (error) {
				options.onError?.("[CodeIntel] request failed", error);
				return `The language server could not answer: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	});
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
	request: ParsedCodeIntelRequest,
): Promise<CodeIntelLocation | undefined> {
	if (request.line !== undefined) {
		return { filePath, line: request.line, character: request.character ?? 0 };
	}
	if (!request.symbol) {
		return undefined;
	}
	return await provider.findSymbolPosition(filePath, request.symbol);
}
