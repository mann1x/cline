/**
 * Say so, once, when a session's window cannot hold one turn.
 *
 * The settings panel warns where a window is typed; a CLI user has no panel,
 * and a window set by flag or `providers.json` below the fixed price plus the
 * output cap reaches the first request unannounced -- to be cut short or
 * refused there. This is the same arithmetic (`@cline/shared`'s
 * `resolveContextMinimumForWindow`), fed by what the compaction pipeline has
 * just measured, logged at the session's first turn.
 */

import {
	describeContextShortfall,
	resolveContextMinimumForWindow,
} from "@cline/shared";

const warned = new Set<string>();

/** Test seam: the once-per-session memory outlives any one test. */
export function resetContextMinimumWarnings(): void {
	warned.clear();
}

export function warnIfWindowBelowMinimum(input: {
	sessionId: string | undefined;
	logger:
		| {
				log?: (message: string, meta?: { severity?: "warn" }) => void;
		  }
		| undefined;
	contextWindow: number | undefined;
	systemPromptTokens?: number;
	toolSchemaTokens?: number;
	mcpToolSchemaTokens?: number;
	/** The cap the session sends; resolved from the budget when absent. */
	outputCapTokens?: number;
	modelMaxOutputTokens?: number;
}): void {
	const key = input.sessionId ?? "no-session";
	if (warned.has(key)) {
		return;
	}
	const minimum = resolveContextMinimumForWindow({
		contextWindow: input.contextWindow,
		...(input.systemPromptTokens !== undefined
			? { systemPromptTokens: input.systemPromptTokens }
			: {}),
		...(input.toolSchemaTokens !== undefined
			? { toolSchemaTokens: input.toolSchemaTokens }
			: {}),
		...(input.mcpToolSchemaTokens !== undefined
			? { mcpToolSchemaTokens: input.mcpToolSchemaTokens }
			: {}),
		...(input.outputCapTokens !== undefined
			? { explicitOutputCap: input.outputCapTokens }
			: {}),
		...(input.modelMaxOutputTokens !== undefined
			? { modelMaxOutputTokens: input.modelMaxOutputTokens }
			: {}),
	});
	const shortfall = describeContextShortfall(input.contextWindow, minimum);
	// Decided once per session either way: the fixed price barely moves, and a
	// line on every turn would drown the one that matters.
	warned.add(key);
	if (!shortfall) {
		return;
	}
	input.logger?.log?.(`[context] Context window: ${shortfall}`, {
		severity: "warn",
	});
}
