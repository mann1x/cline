/**
 * `range`: which pages, slides, sheets or chapters to read.
 */

export interface UnitRange {
	/** Whether a one-based unit is selected. */
	selects: (unit: number) => boolean;
	/** The spec as given, for file names and messages. */
	spec: string;
}

/**
 * Parse `"1-5,9,12-"`: single units, closed spans, and an open end.
 *
 * Throws with a sentence the model can act on; the executor turns a throw
 * into `success: false`.
 */
export function parseUnitRange(
	spec: string | undefined,
): UnitRange | undefined {
	const trimmed = spec?.trim();
	if (!trimmed) {
		return undefined;
	}
	const spans: [number, number][] = [];
	for (const part of trimmed.split(",")) {
		const piece = part.trim();
		if (!piece) continue;
		const match = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(piece);
		if (!match) {
			throw new Error(
				`range "${spec}" is not understood: use one-based numbers, spans and an open end, like "1-5,9,12-".`,
			);
		}
		const from = Number(match[1]);
		const to =
			match[2] === undefined
				? from
				: match[2] === ""
					? Number.POSITIVE_INFINITY
					: Number(match[2]);
		if (from < 1 || to < from) {
			throw new Error(
				`range "${piece}" is empty: numbers start at 1 and a span runs low to high.`,
			);
		}
		spans.push([from, to]);
	}
	if (spans.length === 0) {
		return undefined;
	}
	return {
		selects: (unit) => spans.some(([from, to]) => unit >= from && unit <= to),
		spec: trimmed.replace(/\s+/g, ""),
	};
}

/** `[1,2,3,5,7,8]` as `1-3, 5, 7-8`. */
export function formatUnits(units: readonly number[]): string {
	const sorted = [...new Set(units)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1)
			j++;
		parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
		i = j + 1;
	}
	return parts.join(", ");
}
