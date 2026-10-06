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
	/**
	 * Look in Memory for every message the user sends and put what is found
	 * beside it, so the notes arrive without the model having to ask.
	 */
	autoRecall: boolean;
	/**
	 * Before the automatic search, have a second model write the note that
	 * would answer the message, and search with that as well (HyDE).
	 */
	hyde: boolean;
	/** The saved profile whose model writes it. Empty: none chosen. */
	hydeProfile: string;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
	enabled: false,
	recallCount: 5,
	relevanceThreshold: 0,
	defaultScope: "project",
	autoRecall: true,
	hyde: false,
	hydeProfile: "",
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
		autoRecall: typeof s.autoRecall === "boolean" ? s.autoRecall : d.autoRecall,
		hyde: typeof s.hyde === "boolean" ? s.hyde : d.hyde,
		hydeProfile:
			typeof s.hydeProfile === "string" ? s.hydeProfile.trim() : d.hydeProfile,
	};
}
