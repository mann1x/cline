import type { CodeIntelLocation, CodeIntelProvider, CodeIntelSymbol } from "@cline/core"
import * as vscode from "vscode"

/**
 * The VS Code half of `code_intel`.
 *
 * Every language feature VS Code exposes to an extension is reachable through
 * `vscode.commands.executeCommand("vscode.execute<X>Provider", …)`, which
 * dispatches to whichever language server owns the file. That indirection is
 * the whole reason this needs no LSP client of its own, no server processes and
 * no configuration: whatever the user already has installed for TypeScript,
 * Python, Rust or Go answers, and a language nobody installed support for
 * simply returns nothing.
 *
 * The results come back as VS Code objects with several shapes per command —
 * `Location`, `LocationLink`, `SymbolInformation`, `DocumentSymbol` — so
 * normalising them into the flat shapes the tool renders is most of what this
 * file does.
 */

/**
 * Names for `SymbolKind`, whose values are integers on the wire.
 *
 * Built on first use rather than at import. `vscode.SymbolKind` does not exist
 * until the extension host has loaded the module, and reading it at the top
 * level makes this file unimportable anywhere else — including from a test that
 * only wanted something further down the import graph.
 */
let symbolKindNames: Record<number, string> | undefined

function kindName(kind: vscode.SymbolKind): string {
	symbolKindNames ??= {
		[vscode.SymbolKind.File]: "file",
		[vscode.SymbolKind.Module]: "module",
		[vscode.SymbolKind.Namespace]: "namespace",
		[vscode.SymbolKind.Package]: "package",
		[vscode.SymbolKind.Class]: "class",
		[vscode.SymbolKind.Method]: "method",
		[vscode.SymbolKind.Property]: "property",
		[vscode.SymbolKind.Field]: "field",
		[vscode.SymbolKind.Constructor]: "constructor",
		[vscode.SymbolKind.Enum]: "enum",
		[vscode.SymbolKind.Interface]: "interface",
		[vscode.SymbolKind.Function]: "function",
		[vscode.SymbolKind.Variable]: "variable",
		[vscode.SymbolKind.Constant]: "constant",
		[vscode.SymbolKind.String]: "string",
		[vscode.SymbolKind.Number]: "number",
		[vscode.SymbolKind.Boolean]: "boolean",
		[vscode.SymbolKind.Array]: "array",
		[vscode.SymbolKind.Object]: "object",
		[vscode.SymbolKind.Key]: "key",
		[vscode.SymbolKind.Null]: "null",
		[vscode.SymbolKind.EnumMember]: "enum member",
		[vscode.SymbolKind.Struct]: "struct",
		[vscode.SymbolKind.Event]: "event",
		[vscode.SymbolKind.Operator]: "operator",
		[vscode.SymbolKind.TypeParameter]: "type parameter",
	}
	return symbolKindNames[kind] ?? "symbol"
}

function toLocation(entry: vscode.Location | vscode.LocationLink): CodeIntelLocation {
	// Definition providers may return either shape, and which one depends on
	// the language server rather than on the request.
	const link = entry as vscode.LocationLink
	const plain = entry as vscode.Location
	const uri = "targetUri" in entry ? link.targetUri : plain.uri
	const range = "targetUri" in entry ? (link.targetSelectionRange ?? link.targetRange) : plain.range
	return { filePath: uri.fsPath, line: range.start.line, character: range.start.character }
}

function toLocations(result: unknown): CodeIntelLocation[] {
	return Array.isArray(result) ? result.map((entry) => toLocation(entry as vscode.Location | vscode.LocationLink)) : []
}

async function execute<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
	return await vscode.commands.executeCommand<T>(command, ...args)
}

function positionOf(at: CodeIntelLocation): [vscode.Uri, vscode.Position] {
	return [vscode.Uri.file(at.filePath), new vscode.Position(at.line, at.character)]
}

/**
 * Read a file's symbols, whichever shape the server answers in.
 *
 * `executeDocumentSymbolProvider` returns a `DocumentSymbol` tree for most
 * languages and a flat `SymbolInformation[]` for the rest, and which one you
 * get depends on the server rather than the request. Both callers here need the
 * same flat list, so the branch lives once.
 */
async function readDocumentSymbols(filePath: string): Promise<CodeIntelSymbol[]> {
	const symbols = await execute<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
		"vscode.executeDocumentSymbolProvider",
		vscode.Uri.file(filePath),
	)
	const flat: CodeIntelSymbol[] = []
	if (!Array.isArray(symbols) || symbols.length === 0) {
		return flat
	}
	if ("children" in symbols[0]) {
		flattenDocumentSymbols(symbols as vscode.DocumentSymbol[], filePath, undefined, flat)
		return flat
	}
	for (const entry of symbols as vscode.SymbolInformation[]) {
		flat.push({
			name: entry.name,
			kind: kindName(entry.kind),
			containerName: entry.containerName || undefined,
			location: {
				filePath,
				line: entry.location.range.start.line,
				character: entry.location.range.start.character,
			},
		})
	}
	return flat
}

/** Flatten the tree `executeDocumentSymbolProvider` returns for most languages. */
function flattenDocumentSymbols(
	symbols: readonly vscode.DocumentSymbol[],
	filePath: string,
	container: string | undefined,
	into: CodeIntelSymbol[],
): void {
	for (const symbol of symbols) {
		into.push({
			name: symbol.name,
			kind: kindName(symbol.kind),
			containerName: container,
			location: {
				filePath,
				line: symbol.selectionRange.start.line,
				character: symbol.selectionRange.start.character,
			},
		})
		if (symbol.children?.length) {
			flattenDocumentSymbols(symbol.children, filePath, symbol.name, into)
		}
	}
}

export function createVscodeCodeIntelProvider(): CodeIntelProvider {
	return {
		/**
		 * Find where a name occurs in a file.
		 *
		 * The document's own symbol table is tried first, because a symbol's
		 * declaration is what the model almost always means, and a hit there is
		 * unambiguous. Falling back to a word-boundary text search covers local
		 * variables, imports and anything the server does not list — a first
		 * textual occurrence is still a real position on a real identifier,
		 * which is all the language server needs to answer.
		 */
		async findSymbolPosition(filePath, symbol) {
			const match = (await readDocumentSymbols(filePath)).find((entry) => entry.name === symbol)
			if (match) {
				return match.location
			}

			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
			const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`)
			for (let line = 0; line < document.lineCount; line++) {
				const found = document.lineAt(line).text.match(pattern)
				if (found?.index !== undefined) {
					return { filePath, line, character: found.index }
				}
			}
			return undefined
		},

		async definitions(at) {
			return toLocations(await execute("vscode.executeDefinitionProvider", ...positionOf(at)))
		},

		async typeDefinitions(at) {
			return toLocations(await execute("vscode.executeTypeDefinitionProvider", ...positionOf(at)))
		},

		async implementations(at) {
			return toLocations(await execute("vscode.executeImplementationProvider", ...positionOf(at)))
		},

		async references(at) {
			return toLocations(await execute("vscode.executeReferenceProvider", ...positionOf(at)))
		},

		async hover(at) {
			const hovers = await execute<vscode.Hover[]>("vscode.executeHoverProvider", ...positionOf(at))
			if (!Array.isArray(hovers)) {
				return undefined
			}
			const parts: string[] = []
			for (const hover of hovers) {
				for (const content of hover.contents) {
					if (typeof content === "string") {
						parts.push(content)
					} else if ("value" in content) {
						parts.push(content.value)
					}
				}
			}
			return parts.join("\n").trim() || undefined
		},

		documentSymbols: readDocumentSymbols,

		async workspaceSymbols(query) {
			const symbols = await execute<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query)
			return (symbols ?? []).map((entry) => ({
				name: entry.name,
				kind: kindName(entry.kind),
				containerName: entry.containerName || undefined,
				location: {
					filePath: entry.location.uri.fsPath,
					line: entry.location.range.start.line,
					character: entry.location.range.start.character,
				},
			}))
		},

		async callers(at) {
			// Two steps by design: the hierarchy item has to be prepared before
			// it can be asked about, and preparing it is what resolves the
			// position to the enclosing callable.
			const items = await execute<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", ...positionOf(at))
			if (!Array.isArray(items) || items.length === 0) {
				return []
			}
			const incoming = await execute<vscode.CallHierarchyIncomingCall[]>("vscode.provideIncomingCalls", items[0] as unknown)
			return (incoming ?? []).map((call) => ({
				name: call.from.name,
				kind: kindName(call.from.kind),
				containerName: call.from.detail || undefined,
				location: {
					filePath: call.from.uri.fsPath,
					line: call.from.selectionRange.start.line,
					character: call.from.selectionRange.start.character,
				},
			}))
		},

		async readLine(filePath, line) {
			try {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
				return line >= 0 && line < document.lineCount ? document.lineAt(line).text : undefined
			} catch {
				return undefined
			}
		},
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
