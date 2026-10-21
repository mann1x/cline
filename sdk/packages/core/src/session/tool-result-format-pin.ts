import {
	DEFAULT_TOOL_RESULT_FORMAT,
	isToolResultFormat,
	LEGACY_TOOL_RESULT_FORMAT,
	type ToolResultFormat,
} from "@cline/shared";

/** Where a session records the format its tool results are read in. */
export const TOOL_RESULT_FORMAT_METADATA_KEY = "toolResultFormat";

/**
 * The format a session's tool results are sent in, fixed when it starts.
 *
 * The setting chooses it for a new conversation and for nothing else: a
 * transcript whose first half the model read as JSON and whose second half it
 * reads as text is worse than either. So the format a session recorded wins
 * over the one configured now, and a session with history that recorded none
 * started before the setting existed, which means it ran on `json`.
 */
export function pinToolResultFormat(input: {
	stored?: Record<string, unknown>;
	hasHistory: boolean;
	configured?: ToolResultFormat;
}): ToolResultFormat {
	const stored = input.stored?.[TOOL_RESULT_FORMAT_METADATA_KEY];
	if (isToolResultFormat(stored)) {
		return stored;
	}
	// Not the default: that is what a new conversation gets, and it changed.
	if (input.hasHistory) {
		return LEGACY_TOOL_RESULT_FORMAT;
	}
	return input.configured ?? DEFAULT_TOOL_RESULT_FORMAT;
}
