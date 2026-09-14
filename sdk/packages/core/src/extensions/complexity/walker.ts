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

/** Breaks the flow and deepens it: each one costs 1 + the nesting it sits at. */
const NESTING_STRUCTURES = new Set([
	"if_statement",
	"if_expression",
	"conditional_expression",
	"ternary_expression",
	"for_statement",
	"for_in_statement",
	"for_of_statement",
	"for_range_loop",
	"while_statement",
	"while_expression",
	"do_statement",
	"loop_expression",
	"switch_statement",
	"switch_expression",
	"match_expression",
	"case_statement",
	"catch_clause",
	"except_clause",
	"rescue",
]);

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
	"class_declaration",
	"class_definition",
]);

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
 * Where a file's score starts being worth mentioning unprompted.
 *
 * Extended from SonarSource's default, which flags a *function* at 15. A file
 * is the sum of its functions, so 50 is roughly "several functions that would
 * each be flagged" -- a convention carried over, not a boundary measured on
 * these runs, and it is quoted nowhere as evidence of anything. It decides one
 * thing only: whether a nudge mentions the expert.
 */
export const HIGH_FILE_COMPLEXITY = 50;

/** Whether a score is high enough to be worth raising on its own. */
export function isHighComplexity(score: ComplexityScore | undefined): boolean {
	return score !== undefined && score.score >= HIGH_FILE_COMPLEXITY;
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

	if (NESTING_STRUCTURES.has(node.type)) {
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
		if (!parsed) {
			return undefined;
		}
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
	}

	let total = 0;
	let startLine = Number.POSITIVE_INFINITY;
	let endLine = 0;
	for (const { body, startRow } of scripts) {
		const parsed = parser.parse(body.text);
		if (!parsed) {
			return undefined;
		}
		const scored = scoreTree(parsed);
		if (!scored) {
			return undefined;
		}
		total += scored.score;
		startLine = Math.min(startLine, scored.startLine + startRow);
		endLine = Math.max(endLine, scored.endLine + startRow);
	}
	return {
		score: total,
		startLine: Number.isFinite(startLine) ? startLine : 1,
		endLine,
	};
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
	try {
		const tree = parser.parse(source);
		if (!tree) {
			return undefined;
		}
		if (grammar === "html") {
			return await scoreHtml(tree, options);
		}
		return scoreTree(tree, options);
	} catch {
		return undefined;
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
	return `Cognitive complexity of ${where}: ${score.score}. That measures how hard the code is to read, not how likely this change is to work — treat it as context, not as evidence.`;
}
