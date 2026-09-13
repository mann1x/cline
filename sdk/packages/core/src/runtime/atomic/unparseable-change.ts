/**
 * Why a failed check sometimes says nothing about the change that failed it.
 *
 * Measured on the 39-minute run analysed today: the check ran eighteen times,
 * eleven of them byte-identical, over a file that at several points did not
 * parse at all. A check run against a file the engine refuses measures the
 * refusal, not the fix -- but the verdict it produced read like any other
 * failure, so the model reconsidered a plan that had never been tried.
 *
 * This names that case, at the one moment it is cheap to name: the transaction
 * has failed and the files it changed are still on disk, one call before the
 * rollback puts them back.
 *
 * Deliberately past-tense, and deliberately without the scan's prescribed
 * `editor` call. By the time the model reads this the rollback has happened
 * and the column the scan named is a column of a file that no longer exists;
 * handing a 9B a precise instruction against a stale file is how a report
 * meant to save a transaction spends the next one.
 */

import * as path from "node:path";
import {
	canScanDelimiters,
	describeDelimiterBalance,
	findScriptSyntaxError,
} from "../../extensions/tools/delimiter-balance";

/**
 * What a runtime says when it refused the source.
 *
 * Matched against the check's own output, so this gates on the check having
 * reported a parse failure rather than on the scan having an opinion. The
 * heuristic scan is loud -- it speaks up about files that run perfectly well
 * under a parser that disagrees with it -- and a verdict is the wrong place to
 * be loud.
 */
const SYNTAX_SIGNATURES = [
	/\bSyntaxError\b/,
	/\bIndentationError\b/,
	/\bParseError\b/,
	/\bparse error\b/i,
	/\bUnexpected (token|identifier|end of input|EOF|string|number)\b/i,
	/\bmissing \) after argument list\b/i,
	/\binvalid syntax\b/i,
];

/** Whether the check's output names a parse failure. */
export function looksLikeSyntaxError(output: string): boolean {
	return SYNTAX_SIGNATURES.some((signature) => signature.test(output));
}

/** A file as it stood when the transaction failed. */
export interface ChangedFile {
	/** Absolute path. */
	readonly path: string;
	readonly text: string;
}

/**
 * The scan's finding lines, without the repair it prescribes.
 *
 * `describeDelimiterBalance` indents its findings by two spaces and every
 * instruction that follows one by six, so the depth is what separates the
 * description of the fault from the edit that would fix it. The description
 * survives the rollback; the edit does not.
 */
function faultLinesOf(filePath: string, text: string): string[] {
	const scan = describeDelimiterBalance(filePath, text);
	if (!scan) {
		return [];
	}
	return scan.split("\n").filter((line) => line.startsWith("  line "));
}

/**
 * Say that the check measured a file that does not parse, or nothing.
 *
 * Nothing is the common case and the right default: a check fails for real
 * reasons far more often than for a bracket, and a verdict that guessed would
 * be worse than one that stayed quiet.
 */
export function describeUnparseableChange(
	changed: readonly ChangedFile[],
	root: string,
): string | null {
	for (const file of changed) {
		const refused = findScriptSyntaxError(file.path, file.text);
		const faults = canScanDelimiters(file.path)
			? faultLinesOf(file.path, file.text)
			: [];
		if (refused === undefined && faults.length === 0) {
			continue;
		}
		const name = path.relative(root, file.path) || file.path;
		const engine = refused === undefined ? "" : ` ${refused}`;
		return [
			`The check never ran your change: ${name} does not parse.${engine} What it measured was a file the engine refuses, so the verdict above says nothing about whether your fix was right.`,
			...(faults.length > 0 ? ["", ...faults] : []),
			"",
			"That fault goes back with the rest of the work. `check_file` on a file you have just edited catches it before a transaction is spent on it.",
		].join("\n");
	}
	return null;
}
