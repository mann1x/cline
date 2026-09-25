/**
 * The least context a session can run in, and what an agent's window is
 * floored at above it.
 *
 * Ruled on 2026-09-25. A request pays two things before the conversation gets
 * a token: the **fixed price** -- the system prompt plus every tool schema it
 * offers, built-in and MCP alike, serialized into every request and beyond
 * compaction's reach -- and the **output room** a reply needs, the resolved
 * per-turn cap (`num_predict` / `n_predict` / `max_tokens`), which includes the
 * thinking budget. A window smaller than the two together cannot hold one turn:
 * the reply is cut short, or the server refuses the request outright.
 *
 * Neither number is estimated here. The fixed price is what the caller already
 * measured -- the context bar's segments in the webview, the compaction
 * pipeline's split in the SDK, the wire payload in the opencoti fetch -- and
 * the output room is {@link resolveOutputBudgetTokens}. This module only
 * composes them, so the booking, the warning and the log line agree.
 *
 * Browser-safe: the settings panel imports it through the browser entry.
 */

import {
	type OutputBudgetMode,
	resolveOutputBudgetTokens,
} from "./output-budget";

export interface ContextFixedPrice {
	/** The system prompt, prompt template included -- it is rendered into it. */
	systemPromptTokens?: number;
	/** The schemas of the built-in tools the session offers. */
	toolSchemaTokens?: number;
	/** The schemas of MCP tools. */
	mcpToolSchemaTokens?: number;
}

export interface ContextMinimum {
	systemPromptTokens: number;
	toolSchemaTokens: number;
	mcpToolSchemaTokens: number;
	/** System prompt + tools + MCP. */
	fixedPriceTokens: number;
	/** The resolved output cap, thinking included. */
	outputRoomTokens: number;
	/** `fixedPriceTokens + outputRoomTokens`. */
	minimumTokens: number;
}

const count = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.ceil(value)
		: 0;

/** The minimum from parts already measured. A missing part costs nothing. */
export function resolveContextMinimum(
	input: ContextFixedPrice & { outputRoomTokens?: number },
): ContextMinimum {
	const systemPromptTokens = count(input.systemPromptTokens);
	const toolSchemaTokens = count(input.toolSchemaTokens);
	const mcpToolSchemaTokens = count(input.mcpToolSchemaTokens);
	const fixedPriceTokens =
		systemPromptTokens + toolSchemaTokens + mcpToolSchemaTokens;
	const outputRoomTokens = count(input.outputRoomTokens);
	return {
		systemPromptTokens,
		toolSchemaTokens,
		mcpToolSchemaTokens,
		fixedPriceTokens,
		outputRoomTokens,
		minimumTokens: fixedPriceTokens + outputRoomTokens,
	};
}

/**
 * The minimum for a given window, with the output room resolved for it.
 *
 * The output room depends on the window -- `auto` is three quarters of it,
 * capped -- so the minimum for a 32,768-token window is not the minimum for a
 * 262,144-token one. `explicitOutputCap` is a cap that goes on the wire ahead
 * of the budget (a typed `num_predict`, a per-turn cap) and wins, exactly as it
 * does at request time.
 */
export function resolveContextMinimumForWindow(
	input: ContextFixedPrice & {
		contextWindow: number | undefined;
		explicitOutputCap?: number;
		outputBudget?: { mode?: OutputBudgetMode; maxTokens?: number };
		modelMaxOutputTokens?: number;
	},
): ContextMinimum {
	const explicit = count(input.explicitOutputCap);
	const outputRoomTokens =
		explicit > 0
			? explicit
			: (resolveOutputBudgetTokens({
					mode: input.outputBudget?.mode ?? "auto",
					...(input.outputBudget?.maxTokens !== undefined
						? { maxTokens: input.outputBudget.maxTokens }
						: {}),
					...(input.contextWindow !== undefined
						? { contextWindow: input.contextWindow }
						: {}),
					...(input.modelMaxOutputTokens !== undefined
						? { modelMaxOutputTokens: input.modelMaxOutputTokens }
						: {}),
				}) ?? 0);
	return resolveContextMinimum({ ...input, outputRoomTokens });
}

/** "Agent window" when a node says nothing: half way from the minimum to the window. */
export const AGENT_WINDOW_DEFAULT_SHARE_PERCENT = 50;

/**
 * The stored share as a whole percentage in 0..100.
 *
 * Zero is a real setting -- "the minimum and no more" -- so it is read as
 * zero; only a value that is not a number at all falls to the default.
 */
export function normalizeAgentWindowShare(value: unknown): number {
	const parsed =
		typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
		return AGENT_WINDOW_DEFAULT_SHARE_PERCENT;
	}
	return Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * The smallest window an agent accepts, as the "Agent window" share places it.
 *
 * `floor = minimum + share × (window − minimum)`: 100% is the node's whole
 * window, 0% the minimum a turn needs, and 50% half way -- the same meaning
 * whatever window the node is set to. A minimum above the window leaves only
 * the window itself, which is the honest ask: the warning is where that is
 * said, not a floor larger than what the node offers.
 *
 * `undefined` without a window: there is nothing to take a share of.
 */
export function resolveAgentWindowFloor(input: {
	contextWindow: number | undefined;
	minimumTokens: number;
	sharePercent?: number;
}): number | undefined {
	const window = count(input.contextWindow);
	if (window === 0) {
		return undefined;
	}
	const minimum = Math.min(count(input.minimumTokens), window);
	const share = normalizeAgentWindowShare(input.sharePercent) / 100;
	return Math.min(window, Math.floor(minimum + share * (window - minimum)));
}

const tokens = (value: number): string => value.toLocaleString("en-US");

/**
 * The warning for a window below the minimum, or `undefined` when it fits.
 *
 * A warning and never a block: the user may know the model's replies are
 * short, and the setting is theirs to save.
 */
export function describeContextShortfall(
	contextWindow: number | undefined,
	minimum: ContextMinimum,
): string | undefined {
	const window = count(contextWindow);
	if (window === 0 || window >= minimum.minimumTokens) {
		return undefined;
	}
	return (
		`${tokens(window)} is below the ${tokens(minimum.minimumTokens)} this profile needs ` +
		`(system prompt + tools + MCP ${tokens(minimum.fixedPriceTokens)}, output room ${tokens(minimum.outputRoomTokens)}). ` +
		"Turns will be cut short or refused."
	);
}
