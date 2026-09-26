/**
 * The harness's notes to the model, and how queued ones merge.
 *
 * Every note opens with {@link HARNESS_TAG} so the model can tell the harness
 * from the user. They are written to be cheap: pandorum 2026-09-26, one
 * queued note of nine side-turn recaps was 11.4k characters, each recap
 * quoting the whole stuck-agent report again, and the facts in it were 1.5k.
 */

/** What every note from the harness to the model opens with. */
export const HARNESS_TAG = "[SYSTEM MESSAGE]";

/** The first line of the side-turn recap note. */
export const SIDE_TURN_RECAP_HEADER = `${HARNESS_TAG} Side turns while your agents ran (already done, do not repeat):`;

/** One line of a recap: the user's message, or the harness's report. */
const ITEM = /^- (user:|report \(|earlier report:)/;

function itemsOf(note: string): string[] {
	return note
		.split("\n")
		.filter((line) => ITEM.test(line))
		.map((line) => line.trimEnd());
}

/** What an item did to the round, if anything: `; did: …` to the end. */
function didOf(item: string): string | undefined {
	const at = item.lastIndexOf("; did: ");
	return at >= 0 ? item.slice(at + "; did: ".length) : undefined;
}

/**
 * Two recap notes as one. The user's messages come first, every one kept.
 * Of the reports on stuck agents only the latest is kept whole: it names the
 * agents as they are now. An older one survives only as what it did to them.
 */
export function mergeSideTurnRecaps(older: string, newer: string): string {
	const items = [...itemsOf(older), ...itemsOf(newer)];
	const user = items.filter((item) => item.startsWith("- user:"));
	const reports = items.filter((item) => !item.startsWith("- user:"));
	const latest = [...reports]
		.reverse()
		.find((item) => item.startsWith("- report"));
	const kept = reports.flatMap((item) => {
		if (item === latest) {
			return [item];
		}
		if (item.startsWith("- earlier report:")) {
			return [item];
		}
		const did = didOf(item);
		return did ? [`- earlier report: did: ${did}`] : [];
	});
	return [SIDE_TURN_RECAP_HEADER, ...user, ...kept].join("\n");
}
