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

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * Where the wasm files are. Three places, in the order a host would want.
 *
 * `createRequire` rather than a bundler import: the grammars are data the
 * runtime reads, not modules, and a bundler asked to inline 50 MB of wasm
 * produces a bundle nobody can ship.
 *
 * The middle case is the shipped one. A bundled host has no `node_modules` to
 * resolve against, so the build copies the grammars to a `grammars/` directory
 * beside the bundle and this finds them there -- by looking, not by being told.
 * Being told was the alternative and it is the weaker design: a `grammarDir`
 * threaded through the runtime config is a field every layer has to remember to
 * copy, and the failure when one does not is this feature going quiet rather
 * than anything breaking. The explicit option stays for a host that puts them
 * somewhere else entirely.
 */
export function resolveGrammarPath(
	grammar: string,
	grammarDir?: string,
	/** The bundle's directory. A parameter so a test can be somewhere else. */
	besideDir: string = moduleDirectory(),
): string | undefined {
	const file = `tree-sitter-${grammar}.wasm`;
	if (grammarDir) {
		return join(grammarDir, file);
	}
	const beside = join(besideDir, "grammars", file);
	if (existsSync(beside)) {
		return beside;
	}
	try {
		const require = createRequire(import.meta.url);
		return require.resolve(`tree-sitter-wasms/out/${file}`);
	} catch {
		return undefined;
	}
}

/**
 * The directory this module was loaded from.
 *
 * In the extension that is the bundle's directory, because esbuild rewrites
 * `import.meta.url` to the bundle's own path; unbundled it is this file's.
 * Either way it is where a build would have put the grammars.
 */
function moduleDirectory(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return ".";
	}
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
			const path = resolveGrammarPath(grammar, options.grammarDir);
			if (!path) {
				return undefined;
			}
			language = treeSitter.Language.load(path).catch(() => undefined);
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
