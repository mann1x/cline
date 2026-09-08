/**
 * How long a request took, in the form that goes under the answer.
 *
 * Only for requests long enough that the number tells the user something. A
 * follow-up question answered in twenty seconds does not want a stopwatch under
 * it — the annotation would appear on nearly every row and stop being read —
 * while an hour of work has a cost worth stating.
 */

/** Below this, nothing is reported. */
export const REQUEST_DURATION_FLOOR_MS = 3 * 60 * 1000

/**
 * `1h2m`, `45m`, or `undefined` when the request was short.
 *
 * Minutes are the unit throughout: past the floor, seconds are noise, and
 * rounding rather than truncating keeps a 59m50s request from reading as 59m.
 */
export function formatRequestDuration(elapsedMs: number): string | undefined {
	if (!Number.isFinite(elapsedMs) || elapsedMs < REQUEST_DURATION_FLOOR_MS) {
		return undefined
	}
	const totalMinutes = Math.round(elapsedMs / 60_000)
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`
}
