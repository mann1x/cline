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
	/**
	 * Which memories a workspace uses, by workspace (see
	 * `memoryWorkspaceKey`). A workspace with no entry uses the main memory
	 * for both.
	 */
	selections: Record<string, MemorySelection>;
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

/** The memory every workspace starts on, and the one that cannot be deleted. */
export const MAIN_MEMORY = "main";

/** What a workspace's sessions may do with the memories. */
export interface MemorySelection {
	/** The one memory new notes are kept in. */
	store: string;
	/** The memories that are searched. */
	recall: string[];
}

export const DEFAULT_MEMORY_SELECTION: MemorySelection = {
	store: MAIN_MEMORY,
	recall: [MAIN_MEMORY],
};

/**
 * A workspace's path as the key its selection is filed under: the same for
 * the host that reads it and the panel that writes it, whatever the
 * separators, the trailing slash, or the case of a Windows drive.
 */
export function memoryWorkspaceKey(path: string | undefined): string {
	const text = (path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-zA-Z]:/.test(text) ? text.toLowerCase() : text;
}

/** The memories a workspace uses: what is stored for it, or the main memory. */
export function memorySelectionFor(
	settings: Pick<MemorySettings, "selections">,
	workspace: string | undefined,
): MemorySelection {
	const held = settings.selections[memoryWorkspaceKey(workspace)];
	return held
		? { store: held.store, recall: [...held.recall] }
		: { ...DEFAULT_MEMORY_SELECTION, recall: [MAIN_MEMORY] };
}

/**
 * Every workspace's choice with a memory's old name replaced by its new one,
 * so a renamed memory stays ticked wherever it was.
 */
export function renameMemoryInSelections(
	selections: Record<string, MemorySelection>,
	from: string,
	to: string,
): Record<string, MemorySelection> {
	return Object.fromEntries(
		Object.entries(selections).map(([workspace, selection]) => [
			workspace,
			{
				store: selection.store === from ? to : selection.store,
				recall: selection.recall.map((name) => (name === from ? to : name)),
			},
		]),
	);
}

function resolveSelections(raw: unknown): Record<string, MemorySelection> {
	const selections: Record<string, MemorySelection> = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return selections;
	}
	for (const [workspace, value] of Object.entries(raw)) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as { store?: unknown; recall?: unknown };
		const store =
			typeof entry.store === "string" && entry.store.trim()
				? entry.store.trim()
				: MAIN_MEMORY;
		const recall = Array.isArray(entry.recall)
			? [
					...new Set(
						entry.recall
							.filter((name): name is string => typeof name === "string")
							.map((name) => name.trim())
							.filter(Boolean),
					),
				]
			: [MAIN_MEMORY];
		selections[memoryWorkspaceKey(workspace)] = { store, recall };
	}
	return selections;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
	enabled: false,
	recallCount: 5,
	relevanceThreshold: 0,
	selections: {},
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
		selections: resolveSelections(s.selections),
		autoRecall: typeof s.autoRecall === "boolean" ? s.autoRecall : d.autoRecall,
		hyde: typeof s.hyde === "boolean" ? s.hyde : d.hyde,
		hydeProfile:
			typeof s.hydeProfile === "string" ? s.hydeProfile.trim() : d.hydeProfile,
	};
}
