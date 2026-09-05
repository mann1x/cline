import type { RequestTimings } from "@cline/shared"

/**
 * Turning a request's timings into the lines shown under it.
 *
 * Kept apart from the component because the judgement calls here are the
 * substance of the feature and are worth testing directly: which unit a
 * duration reads best in, when a rate is a measurement rather than a division
 * by nearly zero, and — most of all — which fields are genuinely absent. A
 * provider that reports no engine timings must show fewer rows, not rows of
 * zeroes, because a zero here reads as a finding.
 */

export interface TimingRow {
	label: string
	value: string
	/** Shown under the value, for a number that needs its basis stated. */
	note?: string
}

/** `840ms`, `17.3s`, `2m 04s`. */
export function formatDuration(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
		return undefined
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`
	}
	const seconds = ms / 1000
	if (seconds < 60) {
		return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`
	}
	const minutes = Math.floor(seconds / 60)
	const rest = seconds - minutes * 60
	return `${minutes}m ${rest < 10 ? "0" : ""}${rest.toFixed(0)}s`
}

/**
 * `84.2 tok/s`. Below 100 the decimal is the difference between two runs; above
 * it, it is noise.
 */
export function formatRate(perSecond: number | undefined): string | undefined {
	if (perSecond === undefined || !Number.isFinite(perSecond) || perSecond <= 0) {
		return undefined
	}
	return `${perSecond < 100 ? perSecond.toFixed(1) : Math.round(perSecond).toString()} tok/s`
}

export function formatTokens(tokens: number | undefined): string | undefined {
	if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) {
		return undefined
	}
	return tokens.toLocaleString()
}

/**
 * The one line shown when the panel is collapsed.
 *
 * Wall time first because it is the question actually being asked, then the
 * generation rate, which is the number that explains it. Prefers the engine's
 * own rate over anything derived: it counts decode steps rather than tokens,
 * and with speculative decoding those differ.
 */
export function summarizeTimings(timings: RequestTimings | undefined): string | undefined {
	if (!timings) {
		return undefined
	}
	const parts: string[] = []
	const wall = formatDuration(timings.requestMs ?? timings.engineTotalMs)
	if (wall) {
		parts.push(wall)
	}
	const rate = formatRate(timings.generatePerSecond) ?? formatRate(rateFrom(timings.generateTokens, timings.generateMs))
	if (rate) {
		parts.push(rate)
	}
	const firstToken = formatDuration(timings.firstTokenMs)
	if (firstToken) {
		parts.push(`${firstToken} to first token`)
	}
	return parts.length > 0 ? parts.join(" · ") : undefined
}

function rateFrom(tokens: number | undefined, ms: number | undefined): number | undefined {
	if (tokens === undefined || tokens <= 0 || !ms) {
		return undefined
	}
	return (tokens * 1000) / ms
}

const ENGINE_NAMES: Record<NonNullable<RequestTimings["engine"]>, string> = {
	ollama: "Ollama",
	llamacpp: "llama.cpp",
}

export function engineName(timings: RequestTimings | undefined): string | undefined {
	return timings?.engine ? ENGINE_NAMES[timings.engine] : undefined
}

/**
 * Every row worth showing, in the order they answer questions.
 *
 * Cline's own measurements come first because they are the only ones present
 * for every provider, and the engine's follow as the explanation. A row is
 * omitted rather than zeroed when its field is missing — see the module note.
 */
export function timingRows(timings: RequestTimings | undefined): TimingRow[] {
	if (!timings) {
		return []
	}
	const rows: TimingRow[] = []
	const push = (label: string, value: string | undefined, note?: string) => {
		if (value !== undefined) {
			rows.push(note ? { label, value, note } : { label, value })
		}
	}

	push("Total", formatDuration(timings.requestMs), "measured by Cline")
	push("First token", formatDuration(timings.firstTokenMs))

	const name = engineName(timings)
	if (name) {
		// The engine's own total sits next to Cline's on purpose: the gap
		// between them is time the request spent queued, which is invisible in
		// either number alone.
		push("Engine total", formatDuration(timings.engineTotalMs), `reported by ${name}`)
		push("Model load", formatDuration(timings.loadMs))
		push("Prompt tokens", formatTokens(timings.promptTokens))
		push("Prompt time", formatDuration(timings.promptMs))
		push("Prompt rate", formatRate(timings.promptPerSecond ?? rateFrom(timings.promptTokens, timings.promptMs)))
		push("Cached prompt", formatTokens(timings.cachedTokens), "served from the KV cache")
		push("Generated tokens", formatTokens(timings.generateTokens))
		push("Generation time", formatDuration(timings.generateMs))
		push("Generation rate", formatRate(timings.generatePerSecond ?? rateFrom(timings.generateTokens, timings.generateMs)))
		if (timings.draftTokens !== undefined && timings.draftTokens > 0) {
			const accepted = timings.draftAcceptedTokens ?? 0
			push(
				"Draft accepted",
				`${accepted.toLocaleString()} / ${timings.draftTokens.toLocaleString()}`,
				`${Math.round((accepted / timings.draftTokens) * 100)}% of speculative tokens kept`,
			)
		}
	}
	return rows
}
