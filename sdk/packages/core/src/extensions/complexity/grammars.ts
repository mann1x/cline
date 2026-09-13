/**
 * Loading a tree-sitter grammar, lazily and never fatally.
 *
 * The whole grammar set ships -- 50 MB of `tree-sitter-wasms`, which is a
 * deliberate choice over a curated subset: a subset means picking the languages
 * that matter now, and the first file in an unpicked language reads as "no
 * complexity" rather than "not measured". Nothing is loaded until a file in
 * that language is actually asked about, so the cost is disk rather than
 * memory or start-up.
 *
 * Every failure path here answers `undefined`, which callers must treat as *no
 * input* rather than as a complexity of zero. A missing wasm, a runtime that
 * cannot instantiate it, a language nothing ships a grammar for: all of them
 * mean the same thing, and none of them is evidence about the code.
 */

import { createRequire } from "node:module";

/** File extension to the grammar `tree-sitter-wasms` names it with. */
const GRAMMARS: Readonly<Record<string, string>> = {
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".hpp": "cpp",
	".cs": "c_sharp",
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
	".kt": "kotlin",
	".scala": "scala",
	".lua": "lua",
	".sh": "bash",
	".bash": "bash",
	".html": "html",
	".htm": "html",
	".css": "css",
};

/** Whether a grammar exists for this file at all. */
export function grammarFor(filePath: string): string | undefined {
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	return GRAMMARS[extension];
}

/** The minimum of web-tree-sitter this module uses, so tests can stand in. */
export interface ParsedTree {
	rootNode: SyntaxNode;
}

export interface SyntaxNode {
	readonly type: string;
	readonly startPosition: { row: number; column: number };
	readonly endPosition: { row: number; column: number };
	readonly childCount: number;
	child(index: number): SyntaxNode | null;
	childForFieldName(name: string): SyntaxNode | null;
	readonly text: string;
}

interface ParserLike {
	setLanguage(language: unknown): void;
	parse(source: string): ParsedTree | null;
}

let initialised: Promise<unknown> | undefined;
const languages = new Map<string, Promise<unknown | undefined>>();

/**
 * Where the wasm files are, resolved from this package's own dependency.
 *
 * `createRequire` rather than a bundler import: the grammars are data the
 * runtime reads, not modules, and a bundler asked to inline 50 MB of wasm
 * produces a bundle nobody can ship. A host that relocates them -- the VS Code
 * extension copies the ones it wants next to its bundle -- passes its own
 * directory instead.
 */
function resolveGrammarPath(grammar: string, grammarDir?: string): string {
	if (grammarDir) {
		return `${grammarDir}/tree-sitter-${grammar}.wasm`;
	}
	const require = createRequire(import.meta.url);
	return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

/**
 * A parser for this file's language, or nothing.
 *
 * Nothing is a normal answer and is never an error the caller has to handle as
 * one: the complexity input is optional everywhere it is read.
 */
export async function parserFor(
	filePath: string,
	options: { grammarDir?: string } = {},
): Promise<ParserLike | undefined> {
	const grammar = grammarFor(filePath);
	if (!grammar) {
		return undefined;
	}
	try {
		const treeSitter = (await import("web-tree-sitter")) as unknown as {
			Parser: {
				init(): Promise<void>;
				new (): ParserLike;
			};
			Language: { load(path: string): Promise<unknown> };
		};
		initialised ??= treeSitter.Parser.init();
		await initialised;
		let language = languages.get(grammar);
		if (!language) {
			language = treeSitter.Language.load(
				resolveGrammarPath(grammar, options.grammarDir),
			).catch(() => undefined);
			languages.set(grammar, language);
		}
		const loaded = await language;
		if (!loaded) {
			return undefined;
		}
		const parser = new treeSitter.Parser();
		parser.setLanguage(loaded);
		return parser;
	} catch {
		// A runtime without wasm, a grammar that will not instantiate, a
		// package that was not installed. None of them is a fact about the code.
		return undefined;
	}
}

/** Drop the cached grammars. For tests, and for a host that swaps the directory. */
export function forgetGrammars(): void {
	initialised = undefined;
	languages.clear();
}
