/**
 * How long a completed run took, for the label on the green box.
 *
 * No floor, unlike the row above. That one is an annotation the user did not
 * ask for and so has to earn its place; this one answers "how long did that
 * take", which is the question the completion box is being read to answer.
 * A run that finished in forty seconds has a right to say so.
 *
 * Seconds below a minute, then minutes, then hours: `45s`, `2m`, `1h2m`.
 * Rounding rather than truncating throughout, so 59m50s reads `1h0m`.
 */
export function formatRunDuration(elapsedMs: number): string | undefined {
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
		return undefined
	}
	if (elapsedMs < 60_000) {
		// Never "0s" for a run that did happen: sub-second still took a moment.
		return `${Math.max(1, Math.round(elapsedMs / 1000))}s`
	}
	const totalMinutes = Math.round(elapsedMs / 60_000)
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`
}
