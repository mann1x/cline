/**
 * Jev's settings, shared by the host that reads them and the tab that writes
 * them.
 *
 * The defaults restate core's `JEV_DEFAULT_*` because the webview cannot
 * import `@cline/core`; `jev-settings.test.ts` fails if they drift.
 */

/** Jev's configuration, as the Jev tab stores it. */
export interface JevSettings {
	/** A pinned version keeps tuned floors valid; `jev-latest` moves with releases. */
	model: string
	floor: number
	highStakesFloor: number
	timeoutMs: number
	/** Rank a model-authored question's options before the user sees them. */
	rankQuestions: boolean
	/** Score a task's complexity for the escalation assessment. */
	appraiseEscalation: boolean
}

export const DEFAULT_JEV_SETTINGS: JevSettings = {
	model: "jev-latest",
	floor: 0.6,
	highStakesFloor: 0.85,
	timeoutMs: 15_000,
	rankQuestions: true,
	appraiseEscalation: true,
}

function unitInterval(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback
}

/** Parse the stored record; anything missing or malformed takes its default. */
export function parseJevSettings(raw: string | undefined): JevSettings {
	if (!raw) {
		return { ...DEFAULT_JEV_SETTINGS }
	}
	let parsed: Record<string, unknown>
	try {
		const value = JSON.parse(raw)
		parsed = typeof value === "object" && value !== null ? value : {}
	} catch {
		return { ...DEFAULT_JEV_SETTINGS }
	}
	const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_JEV_SETTINGS.model
	const timeoutMs =
		typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs) && parsed.timeoutMs >= 1_000
			? Math.min(parsed.timeoutMs, 120_000)
			: DEFAULT_JEV_SETTINGS.timeoutMs
	return {
		model,
		floor: unitInterval(parsed.floor, DEFAULT_JEV_SETTINGS.floor),
		highStakesFloor: unitInterval(parsed.highStakesFloor, DEFAULT_JEV_SETTINGS.highStakesFloor),
		timeoutMs,
		// Absent reads as the default, which is on: `false` is the only way off.
		rankQuestions: parsed.rankQuestions !== false,
		appraiseEscalation: parsed.appraiseEscalation !== false,
	}
}
