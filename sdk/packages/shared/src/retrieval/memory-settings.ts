/**
 * Memory's settings, with their defaults: what the model may keep between
 * tasks, and how much of it a recall returns.
 */

export interface MemorySettings {
	/** Whether the model is offered Memory at all. */
	enabled: boolean;
	/** Memories a recall returns. */
	recallCount: number;
	/**
	 * Memories the reranker scores below this are left out, so a question
	 * Memory cannot answer returns nothing instead of the least bad notes.
	 */
	relevanceThreshold: number;
	/** Where `remember` keeps a note when the model does not say. */
	defaultScope: "project" | "global";
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
	enabled: false,
	recallCount: 5,
	relevanceThreshold: 0,
	defaultScope: "project",
};

/** Stored settings, whatever shape they are in, as settings that can be used. */
export function resolveMemorySettings(
	stored: Partial<Record<keyof MemorySettings, unknown>> | undefined | null,
): MemorySettings {
	const d = DEFAULT_MEMORY_SETTINGS;
	const s = stored ?? {};
	const count = Number(s.recallCount);
	const threshold = Number(s.relevanceThreshold);
	return {
		enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
		recallCount: Number.isFinite(count)
			? Math.min(50, Math.max(1, Math.round(count)))
			: d.recallCount,
		relevanceThreshold: Number.isFinite(threshold)
			? Math.min(1, Math.max(0, threshold))
			: d.relevanceThreshold,
		defaultScope: s.defaultScope === "global" ? "global" : "project",
	};
}
