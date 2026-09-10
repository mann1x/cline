/**
 * Find the plan in what a model wrote, wherever it wrote it.
 *
 * The protocol asks for a plan before the first edit -- a numbered list, each
 * entry naming WHERE, WHAT and WHY -- and says to put it in the reply "so it
 * is on the record and the user can see it, not only in your reasoning". A 9B
 * measured on a manic_miner session complied with the instruction and ignored
 * that last clause, four times out of four: assistant messages 7, 61, 77 and
 * 79 each carried a full `TX-01 Plan` with WHERE/WHAT/WHY -- one of them as a
 * table -- and every one of them had a reply of exactly zero characters.
 *
 * That costs twice. The user never sees the plan, and `report.plan` is read
 * off the reply, so the transaction record carries none either and the next
 * transaction is told nothing about what the last one intended.
 *
 * Asking harder is not the fix at this size. Reading the reasoning is: the
 * plan is there, in full, and it only has to be found.
 *
 * The danger in doing that is a false positive -- reasoning is long and
 * discursive, and pasting the wrong part of it into the chat and into the
 * transaction record would be worse than showing nothing. So recognition is
 * deliberately strict: a plan must name all three of WHERE, WHAT and WHY, and
 * must have list or table structure. Prose that merely discusses a plan does
 * not qualify.
 */

/** Longest plan worth carrying. Past this it is not a plan, it is a transcript. */
const MAX_PLAN_CHARS = 4000;

/** A heading that announces a plan: `# TX-01 Plan`, `**Plan:**`, `Plan:`. */
const PLAN_HEADING =
	/^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:TX-?\d+\s*[-:—]?\s*)?plan\b[^\n]*$/i;

/** A heading that is clearly something else, and so ends the plan. */
const OTHER_HEADING = /^\s{0,3}#{1,6}\s+/;

/** `1.` / `1)` / `- ` / `* ` — the shapes a numbered or bulleted entry takes. */
const LIST_ITEM = /^\s{0,6}(?:\d{1,2}[.)]|[-*+])\s+\S/;

/** A markdown table row, which is how the same model rendered one of its plans. */
const TABLE_ROW = /^\s{0,6}\|.*\|\s*$/;

/** Whether a block names all three things an entry is required to name. */
function namesAllThree(block: string): boolean {
	return (
		/\bwhere\b/i.test(block) &&
		/\bwhat\b/i.test(block) &&
		/\bwhy\b/i.test(block)
	);
}

/** Whether a block is laid out as a list or a table rather than as prose. */
function hasStructure(lines: readonly string[]): boolean {
	return lines.some((line) => LIST_ITEM.test(line) || TABLE_ROW.test(line));
}

/**
 * The plan stated in `text`, or nothing.
 *
 * Returns the block verbatim, trimmed. Verbatim matters: this is shown to the
 * user as the model's own words and stored as the transaction's plan, and a
 * summary of a plan is not a plan.
 */
export function readPlan(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const lines = text.split("\n");

	// Prefer an announced plan: the heading tells us where it starts, which is
	// the one thing structure alone cannot.
	for (let index = 0; index < lines.length; index += 1) {
		if (!PLAN_HEADING.test(lines[index])) {
			continue;
		}
		const block = takeBlock(lines, index + 1);
		if (block.length > 0 && namesAllThree(block.join("\n"))) {
			return finish([lines[index], ...block]);
		}
	}

	// No heading. A list whose entries name WHERE, WHAT and WHY is a plan
	// whatever it is called, so fall back to finding one — but only starting
	// from a list item, never from prose.
	for (let index = 0; index < lines.length; index += 1) {
		if (!LIST_ITEM.test(lines[index]) && !TABLE_ROW.test(lines[index])) {
			continue;
		}
		const block = [lines[index], ...takeBlock(lines, index + 1)];
		if (namesAllThree(block.join("\n"))) {
			return finish(block);
		}
		// Skip past this block rather than re-entering it line by line.
		index += block.length;
	}

	return undefined;
}

/**
 * The lines belonging to the block that starts at `from`.
 *
 * Ends at a heading for something else, or at two blank lines in a row — a
 * single blank line is how these models separate a plan's entries, so ending
 * on one would truncate almost every plan to its first item.
 */
function takeBlock(lines: readonly string[], from: number): string[] {
	const block: string[] = [];
	let blanks = 0;
	for (let index = from; index < lines.length; index += 1) {
		const line = lines[index];
		if (OTHER_HEADING.test(line) && !PLAN_HEADING.test(line)) {
			break;
		}
		if (line.trim() === "") {
			blanks += 1;
			if (blanks >= 2) {
				break;
			}
			block.push(line);
			continue;
		}
		blanks = 0;
		block.push(line);
	}
	// Trailing blanks belong to whatever comes next, not to the plan.
	while (block.length > 0 && block[block.length - 1].trim() === "") {
		block.pop();
	}
	return block;
}

/** Trim the block and refuse it if it has no list or table structure. */
function finish(block: readonly string[]): string | undefined {
	if (!hasStructure(block)) {
		return undefined;
	}
	const plan = block.join("\n").trim();
	if (plan.length === 0) {
		return undefined;
	}
	return plan.length > MAX_PLAN_CHARS
		? `${plan.slice(0, MAX_PLAN_CHARS).trimEnd()}\n…`
		: plan;
}
