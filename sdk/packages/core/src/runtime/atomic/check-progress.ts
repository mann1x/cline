/**
 * Whether a check's new answer is further along than its last one.
 *
 * A carry keeps a failed transaction's files because the check said something
 * new, on the reading that a moving answer is a fix in several parts landing.
 * Any new text counted, so a change that broke something else -- a new error,
 * earlier in the file -- was carried as progress (automaticum audit
 * 2026-11-08, B22). This reads what can be compared between two outputs and
 * says which way they moved; where nothing can be compared it says so, and
 * the carry rule is left as it was.
 */

export type CheckProgress = "better" | "worse" | "unknown";

/** Frames a page ran before it failed, from the page check's own wording. */
function framesRun(output: string): number | undefined {
	const after = /\(after (\d+) frame\(s\)\)/.exec(output);
	if (after) {
		return Number(after[1]);
	}
	const frame = /\bframe (\d+):/.exec(output);
	return frame ? Number(frame[1]) : undefined;
}

/** Errors or failures the output counts, when it counts them. */
function failureCount(output: string): number | undefined {
	let total: number | undefined;
	for (const match of output.matchAll(
		/\b(\d+)\s+(?:errors?|failures?|failed|failing)\b/gi,
	)) {
		total = (total ?? 0) + Number(match[1]);
	}
	return total;
}

/** The first `file:line` an output names. */
function firstLocation(
	output: string,
): { file: string; line: number } | undefined {
	const match = /([\w./-]+\.[A-Za-z0-9]{1,6}):(\d+)/.exec(output);
	return match ? { file: match[1], line: Number(match[2]) } : undefined;
}

export function compareCheckProgress(
	before: string,
	after: string,
): CheckProgress {
	const framesBefore = framesRun(before);
	const framesAfter = framesRun(after);
	if (framesBefore !== undefined && framesAfter !== undefined) {
		if (framesAfter !== framesBefore) {
			return framesAfter > framesBefore ? "better" : "worse";
		}
	}
	const countBefore = failureCount(before);
	const countAfter = failureCount(after);
	if (countBefore !== undefined && countAfter !== undefined) {
		if (countAfter !== countBefore) {
			return countAfter < countBefore ? "better" : "worse";
		}
	}
	const where = firstLocation(before);
	const now = firstLocation(after);
	if (where && now && where.file === now.file && where.line !== now.line) {
		return now.line > where.line ? "better" : "worse";
	}
	return "unknown";
}
