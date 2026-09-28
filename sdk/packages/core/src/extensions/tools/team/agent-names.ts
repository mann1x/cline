/**
 * Agents of one call named apart.
 *
 * The lead is free to give several agents the same name -- asked for five
 * reviews, it sends five entries called `code-review` -- and nothing refused
 * it, so a round held five agents answering to one name: their rows, the
 * notices about them ("code-review: refused 13x") and the round index could
 * not tell them apart (pandorum h0o2o, 2026-09-28, 25 agents under 5 names).
 *
 * Failing the call would make the lead spend a turn on a formality. So a name
 * used more than once becomes `<name>-1`, `<name>-2`, ... in the order given,
 * the way `count` names its copies, skipping any name already taken in the
 * call, and the lead is told what was renamed. A name used once is left alone.
 *
 * The host keys an agent's row by its position and shows this name, so it
 * applies the same function (`spawnBatchMembers`); both have to agree.
 */
export function uniqueAgentNames(names: readonly string[]): {
	names: string[];
	renamed: Array<{ from: string; to: string[] }>;
} {
	const uses = new Map<string, number>();
	for (const name of names) {
		uses.set(name, (uses.get(name) ?? 0) + 1);
	}
	const taken = new Set(names.filter((name) => uses.get(name) === 1));
	const next = new Map<string, number>();
	const renamedTo = new Map<string, string[]>();
	const result = names.map((name) => {
		if (uses.get(name) === 1) {
			return name;
		}
		let n = next.get(name) ?? 1;
		let candidate = `${name}-${n}`;
		while (taken.has(candidate)) {
			n += 1;
			candidate = `${name}-${n}`;
		}
		next.set(name, n + 1);
		taken.add(candidate);
		renamedTo.set(name, [...(renamedTo.get(name) ?? []), candidate]);
		return candidate;
	});
	return {
		names: result,
		renamed: [...renamedTo.entries()].map(([from, to]) => ({ from, to })),
	};
}

/** The sentence that tells the lead which agents were renamed. */
export function describeRenamedAgents(
	renamed: ReadonlyArray<{ from: string; to: string[] }>,
): string | undefined {
	if (renamed.length === 0) {
		return undefined;
	}
	const lines = renamed.map(
		({ from, to }) =>
			`"${from}" x${to.length} -> ${to[0]} ... ${to[to.length - 1]}`,
	);
	return `Several agents shared a name, so each was given its own: ${lines.join("; ")}. Refer to them by these names or by id.`;
}
