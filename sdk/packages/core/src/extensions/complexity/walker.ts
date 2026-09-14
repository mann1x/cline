/**
 * Cognitive complexity, SonarSource-style, over a tree-sitter parse.
 *
 * What it answers is "how hard is this code to follow", and the bound has to
 * be said out loud wherever the number is: **it measures how hard code is to
 * read, not how likely a model is to fix it.** It belongs in an escalation
 * brief as context for the expert, and in the assessment as a tiebreaker. It
 * is not evidence that escalation is warranted, and nothing here lets it act
 * as one.
 *
 * Not cyclomatic complexity, which counts paths and rates a flat twenty-case
 * switch as harder than three levels of nested conditionals. Cognitive
 * complexity charges nesting, which is the thing that actually makes a
 * minified `forEach(d=>{if(d){...}})` expensive to reason about.
 *
 * The node-type sets below are shared across grammars rather than written per
 * language. Tree-sitter's naming is conventional enough that `if_statement`,
 * `while_statement` and `catch_clause` mean the same thing in a dozen
 * grammars, and a type this does not recognise scores nothing -- which is the
 * safe direction for a number that is only ever a tiebreaker.
 */

import {
	grammarFor,
	type ParsedTree,
	parserFor,
	parserForGrammar,
	type SyntaxNode,
} from "./grammars";

/**
 * Breaks the flow and deepens it: each one costs 1 + the nesting it sits at.
 *
 * These were once described here as conventional enough to share across
 * grammars. Measured across the twelve languages below, they are not, and the
 * failures were not small:
 *
 * ```
 * construct          js   py   go   rs    c  cpp   rb     (before)
 * for                 1    1    1    0    1    1    0
 * switch/4 cases      1    0    0    1    9    9    0
 * ```
 *
 * Three separate faults. `case_statement` is a *case label* in C, C++ and PHP,
 * not a switch, so it was charged `1 + depth` per case -- a 20-case switch cost
 * 41 in C against 1 in JavaScript, inverting the one property this metric is
 * chosen for. Several languages name their loops and switches things nobody
 * guessed (`for_expression`, `for_each_statement`, `expression_switch_statement`,
 * `when_expression`, `match_statement`), so those constructs were free. And
 * Ruby names every one of them with a bare keyword, matching nothing at all --
 * a Ruby file scored a defined 0, which is the reading this module exists to
 * refuse.
 *
 * Every name here is verified against a real parse by
 * `grammar-calibration.test.ts`, which scores the same construct in every
 * language and fails if two disagree.
 */
const NESTING_STRUCTURES = new Set([
	"if_statement",
	"if_expression",
	"conditional_expression",
	"ternary_expression",
	"for_statement",
	"for_in_statement",
	"for_of_statement",
	"for_range_loop",
	// Rust and Scala write `for` as an expression; C# and PHP give the
	// for-each form its own node; Lua splits numeric from generic.
	"for_expression",
	"for_each_statement",
	"foreach_statement",
	"enhanced_for_statement",
	"for_numeric_statement",
	"for_generic_statement",
	"while_statement",
	"while_expression",
	"do_statement",
	"repeat_statement",
	"repeat_while_statement",
	"loop_expression",
	"switch_statement",
	"switch_expression",
	"match_expression",
	// Go has three of these and none of them is `switch_statement`; Kotlin's
	// is `when`; Python's structural match is a statement, not an expression.
	"expression_switch_statement",
	"type_switch_statement",
	"select_statement",
	"when_expression",
	"match_statement",
	"catch_clause",
	"catch_block",
	"except_clause",
]);

/**
 * The same thing, for grammars that name it with a bare keyword.
 *
 * Ruby alone: its nodes are `if`, `unless`, `while`, `until`, `for`, `case`.
 * Those words are also *keyword tokens* in ten other grammars -- a JavaScript
 * `if_statement` has a child of type `if` -- so matching them unconditionally
 * would double-count everywhere else. A keyword token is a leaf and a
 * statement is not, and across all twelve languages that separates them
 * exactly: with `childCount > 0` required, these names occur in Ruby and
 * nowhere else.
 *
 * `when` is deliberately absent. It is Ruby's *case label*, and a case label
 * costs nothing -- that is the whole difference from cyclomatic complexity.
 */
const BARE_NESTING_STRUCTURES = new Set([
	"if",
	"unless",
	"while",
	"until",
	"for",
	"case",
	// `rescue` was in the set above, and scored 3 for one `begin/rescue`: the
	// statement node holds a `rescue` *keyword token* as a child, and an
	// unconditional match counted both. The same latent fault applies to any
	// bare keyword, which is why every one of them lives here.
	"rescue",
]);

/** Whether this node breaks the flow and deepens what is under it. */
function isNestingStructure(node: SyntaxNode): boolean {
	return (
		NESTING_STRUCTURES.has(node.type) ||
		(node.childCount > 0 && BARE_NESTING_STRUCTURES.has(node.type))
	);
}

/** Breaks the flow without deepening it: a flat +1 wherever it appears. */
const FLAT_STRUCTURES = new Set([
	"goto_statement",
	"labeled_break_statement",
	"labeled_continue_statement",
]);

/**
 * Deepens without scoring.
 *
 * A function is not itself a break in the flow -- writing one is how code is
 * made simpler -- but code inside a nested one is harder to follow, so it
 * counts for the structures below it.
 */
const NESTING_ONLY = new Set([
	"function_declaration",
	"function_definition",
	"function_expression",
	"function_item",
	"method_definition",
	"method_declaration",
	"arrow_function",
	"lambda",
	"closure_expression",
]);

/*
 * Classes are deliberately absent from the set above.
 *
 * They were in it, and in a language where every method lives inside one --
 * Java, C#, Kotlin -- that made the class the first function-like node and
 * every method a *nested* one, so the whole language scored one level deeper
 * than the rest. `if (a) { f(); }` cost 2 in Java against 1 everywhere else,
 * for writing it the only way Java lets you write it.
 *
 * The specification's nesting increments are if/else, loops, switch, catch and
 * nested functions. A class is not among them.
 */

/** Every node type that is a function of some sort, for "the function at line N". */
const FUNCTIONS = new Set([
	"function_declaration",
	"function_definition",
	"function_expression",
	"function_item",
	"method_definition",
	"method_declaration",
	"arrow_function",
	"lambda",
	"closure_expression",
]);

const LOGICAL_OPERATORS = new Set(["&&", "||", "and", "or", "??"]);

/**
 * The scale, because an unbounded integer on its own says nothing.
 *
 * "This function scores 474" is not information. The reader's first question
 * is *out of what*, and there is no out-of-what: the metric is a sum with no
 * ceiling. A model handed a bare number has to score several functions itself,
 * infer a distribution, and guess where the number sits in it -- so what it
 * actually does is ignore the number. The bands are how the scale travels with
 * the score instead of being left for the reader to reconstruct.
 *
 * The boundaries are anchored on the one published figure and then checked
 * against measurement. SonarSource flags a **function** at 15; scoring 5,695
 * functions across TypeScript, C, C++ and a minified HTML game puts that at
 * the worst 6.8%, which is an independent vindication of their number rather
 * than a coincidence worth ignoring. The rest of the ladder is the same
 * distribution:
 *
 * ```
 * p25  0     >=  5  21.6%   moderate
 * p50  1     >= 15   6.8%   high        <- SonarSource's flag point
 * p75  4     >= 25   3.2%   very high
 * p90 10     >= 60   0.7%   extreme
 * p95 18
 * p99 50     max 452
 * ```
 */
export type ComplexityBand =
	| "simple"
	| "moderate"
	| "high"
	| "very high"
	| "extreme";

/** Lower bound of each band, highest first. */
const BANDS: readonly (readonly [number, ComplexityBand])[] = [
	[60, "extreme"],
	[25, "very high"],
	[15, "high"],
	[5, "moderate"],
	[0, "simple"],
];

export function bandFor(score: number): ComplexityBand {
	for (const [floor, band] of BANDS) {
		if (score >= floor) {
			return band;
		}
	}
	return "simple";
}

/**
 * The ladder, written out, so the number is readable without a second lookup.
 *
 * Said in full every time on purpose. The alternative is a bare score plus an
 * expectation that whoever reads it remembers a scale from somewhere else,
 * and nothing downstream of here has a somewhere else.
 */
export const COMPLEXITY_SCALE =
	"0-4 simple, 5-14 moderate, 15-24 high, 25-59 very high, 60+ extreme; 15 is where SonarSource flags a function, and across 5,695 functions of real code 15+ is the worst 6.8% and 60+ the worst 0.7%";

/**
 * Where a file starts being worth raising unprompted.
 *
 * The worst function in it reaching `extreme`. Measured over 380 files of
 * TypeScript, C and C++, that is 6.3% of them -- rare enough that saying
 * something means something, common enough to fire on real code.
 */
export function isHighComplexity(score: ComplexityScore | undefined): boolean {
	return score !== undefined && bandFor(score.score) === "extreme";
}

export interface ComplexityScore {
	/** The cognitive-complexity total for the span that was walked. */
	score: number;
	/** First and last line of that span, one-based. */
	startLine: number;
	endLine: number;
	/** The function's name where the grammar names it, for the reader. */
	name?: string;
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	for (let index = 0; index < node.childCount; index += 1) {
		const child = node.child(index);
		if (child) {
			children.push(child);
		}
	}
	return children;
}

/**
 * Whether two handles point at the same node.
 *
 * By position, never by identity: web-tree-sitter mints a fresh JS object on
 * every access, so `node.child(0) === node.childForFieldName("x")` is false
 * even when they are the same node. Comparing by reference here silently made
 * every `else` clause score as an ordinary nested block -- the chain and the
 * nested form came out identical, which is exactly what the rule exists to
 * tell apart.
 */
function sameNode(
	a: SyntaxNode | null | undefined,
	b: SyntaxNode | null | undefined,
): boolean {
	return (
		!!a &&
		!!b &&
		a.type === b.type &&
		a.startPosition.row === b.startPosition.row &&
		a.startPosition.column === b.startPosition.column &&
		a.endPosition.row === b.endPosition.row &&
		a.endPosition.column === b.endPosition.column
	);
}

/** Whether this node is a `&&`/`||` expression rather than any other binary one. */
function isLogicalExpression(node: SyntaxNode): boolean {
	if (node.type !== "binary_expression" && node.type !== "boolean_operator") {
		return false;
	}
	for (const child of childrenOf(node)) {
		if (child.childCount === 0 && LOGICAL_OPERATORS.has(child.type)) {
			return true;
		}
	}
	return false;
}

/**
 * Count the operator *runs* in a condition.
 *
 * `a && b && c` is one decision to follow and `a && b || c` is two, which is
 * the distinction cyclomatic complexity cannot make -- it counts three
 * operands either way. The walk descends only through logical expressions, so
 * a parenthesised sub-expression starts its own chain and is scored where it
 * is reached rather than folded into this one.
 */
function logicalSequences(node: SyntaxNode): number {
	const operators: string[] = [];
	const walk = (current: SyntaxNode): void => {
		for (const child of childrenOf(current)) {
			if (child.childCount === 0 && LOGICAL_OPERATORS.has(child.type)) {
				operators.push(child.type);
			} else if (isLogicalExpression(child)) {
				walk(child);
			}
		}
	};
	walk(node);
	let runs = 0;
	let previous: string | undefined;
	for (const operator of operators) {
		if (operator !== previous) {
			runs += 1;
		}
		previous = operator;
	}
	return runs;
}

/**
 * The `else` half of an `if`, which is one decision whichever shape it takes.
 *
 * `else if` is one decision and not two, and it does not deepen: a flat
 * four-branch chain reads as four choices at one level, and charging it like
 * four nested ifs would make the clearest shape the most expensive one. Some
 * grammars put the chained `if` straight into the alternative field and others
 * wrap it in an `else_clause`; both mean the same thing.
 */
function scoreAlternative(
	node: SyntaxNode,
	depth: number,
	insideFunction: boolean,
): number {
	const chained =
		node.type === "if_statement"
			? node
			: childrenOf(node).find((child) => child.type === "if_statement");
	if (chained) {
		let score = 1;
		for (const child of childrenOf(chained)) {
			score += sameNode(chained.childForFieldName("alternative"), child)
				? scoreAlternative(child, depth, insideFunction)
				: scoreNode(child, depth + 1, insideFunction, chained);
		}
		return score;
	}
	// A plain `else`. One more decision, and no nesting increment of its own.
	let score = 1;
	for (const child of childrenOf(node)) {
		score += scoreNode(child, depth + 1, insideFunction, node);
	}
	return score;
}

/**
 * Walk one node and everything under it, charging nesting as it goes.
 *
 * `insideFunction` is what keeps a top-level function from charging its own
 * body for existing. Writing a function is how code is made simpler; writing
 * one *inside* another is what makes the code under it harder to follow, so
 * only the second kind deepens.
 */
function scoreNode(
	node: SyntaxNode,
	depth: number,
	insideFunction: boolean,
	parent?: SyntaxNode,
): number {
	let score = 0;
	let nextDepth = depth;
	let nowInsideFunction = insideFunction;

	if (node.type === "if_statement") {
		// Handled apart from the rest so the `else` half can be scored at the
		// depth of the `if` it chains from rather than one below it.
		score += 1 + depth;
		for (const child of childrenOf(node)) {
			score += sameNode(node.childForFieldName("alternative"), child)
				? scoreAlternative(child, depth, insideFunction)
				: scoreNode(child, depth + 1, insideFunction, node);
		}
		return score;
	}

	if (isNestingStructure(node)) {
		score += 1 + depth;
		nextDepth = depth + 1;
	} else if (FLAT_STRUCTURES.has(node.type)) {
		score += 1;
	} else if (NESTING_ONLY.has(node.type)) {
		if (insideFunction) {
			nextDepth = depth + 1;
		}
		nowInsideFunction = true;
	} else if (
		isLogicalExpression(node) &&
		!(parent && isLogicalExpression(parent))
	) {
		// Only at the head of a chain: `(a && b) && c` is one run, and scoring
		// the inner expression again as it is walked would count it twice.
		score += logicalSequences(node);
	}

	for (const child of childrenOf(node)) {
		score += scoreNode(child, nextDepth, nowInsideFunction, node);
	}
	return score;
}

/** Name a function the way the grammar does, where it does at all. */
function nameOf(node: SyntaxNode): string | undefined {
	const named = node.childForFieldName("name");
	const text = named?.text?.trim();
	return text ? text : undefined;
}

/** The innermost function containing a line, or nothing when the line is top-level. */
function functionAt(root: SyntaxNode, line: number): SyntaxNode | undefined {
	let found: SyntaxNode | undefined;
	const walk = (node: SyntaxNode): void => {
		if (node.startPosition.row > line || node.endPosition.row < line) {
			return;
		}
		if (FUNCTIONS.has(node.type)) {
			found = node;
		}
		for (const child of childrenOf(node)) {
			walk(child);
		}
	};
	walk(root);
	return found;
}

/** Score a parsed tree, optionally narrowed to the function around one line. */
export function scoreTree(
	tree: ParsedTree,
	options: { line?: number } = {},
): ComplexityScore | undefined {
	const root = tree.rootNode;
	const target =
		options.line === undefined
			? root
			: (functionAt(root, options.line - 1) ?? root);
	return {
		// `false` even when the target is a function: the thing being measured
		// is never charged for being itself.
		score: scoreNode(target, 0, false),
		startLine: target.startPosition.row + 1,
		endLine: target.endPosition.row + 1,
		...(target === root
			? {}
			: { ...(nameOf(target) ? { name: nameOf(target) } : {}) }),
	};
}

/**
 * How much of a tree may be in error before its score is worthless.
 *
 * Not `hasError` on its own, which was the first thing tried and was far too
 * blunt: 40 of 100 real C and C++ files from llama.cpp set it, and **39 of
 * those 40 had under 0.5% of their bytes inside an `ERROR` node** -- one
 * attribute or one macro the grammar does not know, in a file that is
 * otherwise parsed correctly. Silencing those would have deleted the feature
 * for C and C++ (70% of files) to no purpose, because a score taken from a
 * 99.5%-correct tree is a 99.5%-correct score.
 *
 * What has to be caught is wholesale failure, and it does not resemble the
 * above at all. Measured coverage, same corpora:
 *
 * ```
 * real code, grammar hiccup      <= 0.5%   (p90 of erroring C/C++ and TS files)
 * a grammar that has gone bad     100%     (tree-sitter-lua, second parse on)
 * the one genuinely broken file   100%
 * ```
 *
 * So the two populations are separated by a factor of two hundred, and 20%
 * sits in the empty middle with room on both sides.
 */
const MAX_ERROR_COVERAGE = 0.2;

/** Whether the parse failed badly enough that nothing should be said. */
function parseFailed(root: SyntaxNode, sourceLength: number): boolean {
	if (!root.hasError || sourceLength === 0) {
		return false;
	}
	let errored = 0;
	const walk = (node: SyntaxNode): void => {
		if (node.type === "ERROR" || node.type === "MISSING") {
			errored += node.text.length;
			return;
		}
		for (const child of childrenOf(node)) {
			walk(child);
		}
	};
	walk(root);
	return errored / sourceLength > MAX_ERROR_COVERAGE;
}

/**
 * The `<script>` bodies in an HTML document, with where each one starts.
 *
 * `tree-sitter-html` does not descend into a script: the body arrives as one
 * `raw_text` node and nothing inside it is parsed. So a single-file game --
 * every loop and every nested `forEach(d=>{if(d){...}})` of it -- scored
 * exactly 0, and 0 is a *defined* answer, which is the one reading the rest of
 * this module refuses to allow. Measured on the manic_miner harness source:
 * 137 lines, score 0.
 */
function scriptBodies(
	root: SyntaxNode,
): { body: SyntaxNode; startRow: number }[] {
	const found: { body: SyntaxNode; startRow: number }[] = [];
	const walk = (node: SyntaxNode): void => {
		if (node.type === "script_element") {
			// A `type` that is not JavaScript means the body is data -- an
			// import map, a JSON island, a template -- and scoring it as code
			// would be inventing a number. Absent, `module`, and the
			// JavaScript media types are the ones that are code.
			const start = childrenOf(node).find(
				(child) => child.type === "start_tag",
			);
			if (start && !isJavaScriptScriptTag(start.text)) {
				return;
			}
			const body = childrenOf(node).find((child) => child.type === "raw_text");
			// No body is `<script src=...>`: a real script, but not one this
			// file contains, so there is nothing here to measure.
			if (body) {
				found.push({ body, startRow: body.startPosition.row });
			}
			return;
		}
		for (const child of childrenOf(node)) {
			walk(child);
		}
	};
	walk(root);
	return found;
}

/** Whether a `<script ...>` start tag says its body is JavaScript. */
function isJavaScriptScriptTag(startTag: string): boolean {
	const match = startTag.match(/\stype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
	const declared = (match?.[2] ?? match?.[3] ?? match?.[4])
		?.trim()
		.toLowerCase();
	if (!declared) {
		return true;
	}
	return (
		declared === "module" ||
		declared === "text/javascript" ||
		declared === "application/javascript" ||
		declared === "text/ecmascript" ||
		declared === "application/ecmascript"
	);
}

/**
 * An HTML document scored through its scripts.
 *
 * The sum across every script, because the document is the unit the caller
 * named -- `escalate` and `check_file` both hand over a path, not a function.
 * The span reported is the first script's first line to the last script's
 * last line, in the HTML file's own coordinates, so it points at something the
 * reader can open.
 *
 * Silence is preserved exactly where it was: a document whose scripts cannot
 * be parsed, or whose JavaScript grammar will not load, answers `undefined`.
 * A document with no script at all is not silence -- there is genuinely no
 * code in it -- and keeps the markup score, which is 0.
 */
async function scoreHtml(
	tree: ParsedTree,
	options: { line?: number; grammarDir?: string },
): Promise<ComplexityScore | undefined> {
	const scripts = scriptBodies(tree.rootNode);
	if (scripts.length === 0) {
		return scoreTree(tree, options);
	}
	const parser = await parserForGrammar("javascript", options);
	if (!parser) {
		return undefined;
	}

	// A line inside one script narrows to the function around it, the way the
	// same option does for a file that is all one language. The line arrives in
	// the document's numbering and the script is parsed on its own, so it is
	// shifted in and the answer shifted back.
	const containing =
		options.line === undefined
			? undefined
			: scripts.find(
					({ body }) =>
						options.line !== undefined &&
						options.line - 1 >= body.startPosition.row &&
						options.line - 1 <= body.endPosition.row,
				);
	if (containing) {
		const parsed = parser.parse(containing.body.text);
		// The same bar the outer tree is held to. A script body is where the
		// code actually is, so a body that did not parse is exactly the case
		// the guard exists for -- and checking only the document, which is
		// almost always well-formed HTML around a broken script, would have
		// let every one of them through.
		if (!parsed || parseFailed(parsed.rootNode, containing.body.text.length)) {
			parsed?.delete?.();
			return undefined;
		}
		try {
			const inner = scoreTree(parsed, {
				line: (options.line as number) - containing.startRow,
			});
			return inner
				? {
						...inner,
						startLine: inner.startLine + containing.startRow,
						endLine: inner.endLine + containing.startRow,
					}
				: undefined;
		} finally {
			parsed.delete?.();
		}
	}

	// The hardest function across every script, not the sum across them: a page
	// with six small scripts is six small problems, and adding them up reports
	// one large one that nobody has to read.
	let worst: ComplexityScore | undefined;
	for (const { body, startRow } of scripts) {
		const parsed = parser.parse(body.text);
		if (!parsed || parseFailed(parsed.rootNode, body.text.length)) {
			parsed?.delete?.();
			return undefined;
		}
		try {
			const scored = worstFunctionIn(parsed, startRow);
			if (scored && (!worst || scored.score > worst.score)) {
				worst = scored;
			}
		} finally {
			parsed.delete?.();
		}
	}
	return worst;
}

/**
 * The hardest single function in a tree, shifted into the file's own lines.
 *
 * A whole-file sum is dominated by *size*: `local-runtime-host.ts` totalled 865
 * over 4,002 lines and its worst function is 248, while a 137-line minified
 * game totalled 238. Summing therefore ranks a long, plain file above a short,
 * dense one, which inverts what the number is for. A single function is also
 * the unit SonarSource's 15 refers to, so it is the only unit the scale can be
 * quoted against honestly -- and unlike a file total it names something: a
 * function, on a line, that the reader can open.
 */
function worstFunctionIn(
	tree: ParsedTree,
	rowOffset: number,
): ComplexityScore | undefined {
	const functions: SyntaxNode[] = [];
	const walk = (node: SyntaxNode): void => {
		if (NESTING_ONLY.has(node.type)) {
			functions.push(node);
		}
		for (const child of childrenOf(node)) {
			walk(child);
		}
	};
	walk(tree.rootNode);

	let worst: ComplexityScore | undefined;
	for (const fn of functions) {
		const scored = scoreTree(tree, { line: fn.startPosition.row + 1 });
		if (scored && (!worst || scored.score > worst.score)) {
			worst = scored;
		}
	}
	// A file with no functions at all is not a file with no code -- a script of
	// top-level statements is exactly what a small page or a shell-shaped
	// module looks like -- so it falls back to the whole tree.
	const result = worst ?? scoreTree(tree);
	return result
		? {
				...result,
				startLine: result.startLine + rowOffset,
				endLine: result.endLine + rowOffset,
			}
		: undefined;
}

/**
 * How hard the code around a line is to follow, or nothing.
 *
 * Nothing means "not measured" and must never be read as "simple": a language
 * with no grammar, a runtime that cannot load wasm, a file that will not parse.
 * Every one of those is silence, not a low score.
 */
export async function scoreComplexity(
	filePath: string,
	source: string,
	options: { line?: number; grammarDir?: string } = {},
): Promise<ComplexityScore | undefined> {
	const grammar = grammarFor(filePath);
	if (!grammar) {
		return undefined;
	}
	const parser = await parserFor(filePath, options);
	if (!parser) {
		return undefined;
	}
	// The tree is freed in `finally`: it lives in wasm memory, which nothing
	// collects, and the result is a plain object that holds no node.
	let tree: ParsedTree | null = null;
	try {
		tree = parser.parse(source);
		if (!tree) {
			return undefined;
		}
		if (parseFailed(tree.rootNode, source.length)) {
			return undefined;
		}
		if (grammar === "html") {
			return await scoreHtml(tree, options);
		}
		// A line means "the function around this line" and is answered exactly.
		// Without one the question is about the file, and the answer is its
		// hardest function rather than the sum of all of them.
		return options.line === undefined
			? worstFunctionIn(tree, 0)
			: scoreTree(tree, options);
	} catch {
		return undefined;
	} finally {
		tree?.delete?.();
	}
}

/**
 * The one sentence that must travel with the number.
 *
 * `check_file` states its own bound the same way, and for the same reason: a
 * measurement handed over without it gets used as the thing it is not.
 */
export function describeComplexity(
	score: ComplexityScore,
	filePath: string,
): string {
	const where = score.name
		? `\`${score.name}\` (${filePath}:${score.startLine}-${score.endLine})`
		: `${filePath}:${score.startLine}-${score.endLine}`;
	return `Cognitive complexity of ${where}: ${score.score} — ${bandFor(score.score)} (${COMPLEXITY_SCALE}). That measures how hard the code is to read, not how likely this change is to work — treat it as context, not as evidence.`;
}
