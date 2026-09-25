/**
 * An agent's realized sampler as one terminal line.
 *
 * The spawn tools report what each agent ran with when the lead set a sampler
 * (`RealizedSpawnSampling` in core): its seed and temperature, and for a
 * `"random"` one what it was drawn around. The webview puts the detail in a
 * tooltip; a terminal has none, so the line carries it:
 * `seed 2847193 (random) · T 0.713 (0.7 ±2%)`.
 */
export function formatSpawnSampling(value: unknown): string | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const sampling = value as {
		temperature?: unknown;
		seed?: unknown;
		seedRandom?: unknown;
		temperatureBase?: unknown;
		temperatureRange?: unknown;
		note?: unknown;
	};
	const parts: string[] = [];
	if (typeof sampling.seed === "number") {
		parts.push(
			`seed ${sampling.seed}${sampling.seedRandom === true ? " (random)" : ""}`,
		);
	}
	if (typeof sampling.temperature === "number") {
		const drawn =
			typeof sampling.temperatureBase === "number" &&
			typeof sampling.temperatureRange === "number"
				? ` (${sampling.temperatureBase} ±${sampling.temperatureRange}%)`
				: "";
		parts.push(`T ${sampling.temperature}${drawn}`);
	} else if (typeof sampling.note === "string" && sampling.note) {
		parts.push(`T model (${sampling.note})`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The sampler lines a spawn tool's call shows: from its agents' progress
 * updates while it ran, or -- for a call read back without them -- from its
 * result, which names one agent's `sampling` or each worker's in `results`.
 * Ordered by member.
 */
export function spawnSamplingLines(entry: {
	samplings?: Record<string, string>;
	result?: { rawOutput?: unknown };
}): string[] {
	const live = Object.entries(entry.samplings ?? {});
	if (live.length > 0) {
		const lines = live
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([member, line]) =>
				live.length > 1 ? `#${Number(member) + 1} ${line}` : line,
			);
		return lines;
	}
	const output = entry.result?.rawOutput as
		| { sampling?: unknown; results?: unknown }
		| undefined;
	if (!output || typeof output !== "object") {
		return [];
	}
	const own = formatSpawnSampling(output.sampling);
	if (own) {
		return [own];
	}
	if (!Array.isArray(output.results)) {
		return [];
	}
	return output.results.flatMap((result: unknown) => {
		const record = result as { name?: unknown; sampling?: unknown };
		const line = formatSpawnSampling(record?.sampling);
		if (!line) {
			return [];
		}
		return [typeof record.name === "string" ? `${record.name} ${line}` : line];
	});
}
