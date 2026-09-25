/**
 * "Agent window": the floor an agent's opencoti session accepts, per node.
 *
 * Ruled 2026-09-25. A node's slider is a share between two ends -- 100% is the
 * node's context window, 0% the minimum one turn needs (system prompt + tool
 * schemas + the output cap, thinking included) -- so "50%" means the same
 * thing whatever window the node is set to. The session asks for the node's
 * window (`num_ctx`) and floors at that share (`num_ctx_min`); the engine
 * grants the largest window that fits, never below the floor
 * (`ctx_min_negotiation_v1`), and below it the refusal is waited out.
 *
 * The floor is computed here, at the wire, because this is the one place both
 * halves of the minimum are exact: the system turn and the tool schemas are in
 * the body as they will be charged, and the output cap is the `max_tokens` the
 * gateway resolved for this request. The arithmetic is `@cline/shared`'s, the
 * same the settings panel shows.
 */

import {
	estimateRequestInputTokens,
	resolveAgentWindowFloor,
	resolveContextMinimum,
} from "@cline/shared";

/** What a node says about its agents' windows, carried on the provider config. */
export interface OpencotiAgentWindowOptions {
	/** 0..100; see `normalizeAgentWindowShare`. */
	sharePercent?: number;
}

/** The node's window and its share, once both are known. */
export interface OpencotiAgentWindow {
	contextWindow: number;
	sharePercent?: number;
}

const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The agent window for this request, or `undefined` when the provider config
 * carries none or there is no window to take a share of.
 *
 * The window is the model's as the connection resolved it -- for an agent
 * node, the node's own (the host puts it there, ahead of any catalog figure).
 */
export function readOpencotiAgentWindow(
	section: unknown,
	contextWindow: number | undefined,
): OpencotiAgentWindow | undefined {
	if (!section || typeof section !== "object" || !positive(contextWindow)) {
		return undefined;
	}
	const share = (section as OpencotiAgentWindowOptions).sharePercent;
	return {
		contextWindow: Math.floor(contextWindow),
		...(typeof share === "number" && Number.isFinite(share)
			? { sharePercent: share }
			: {}),
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part
					? String((part as { text?: unknown }).text ?? "")
					: "",
			)
			.join("");
	}
	return "";
}

/** The cap on the wire: `max_tokens`, its newer spelling, or llama.cpp's. */
export function wireOutputCap(
	body: Record<string, unknown>,
): number | undefined {
	for (const key of ["max_tokens", "max_completion_tokens", "n_predict"]) {
		const value = body[key];
		if (positive(value)) {
			return Math.floor(value);
		}
	}
	return undefined;
}

/**
 * The floor for this request: `minimum + share × (window − minimum)`, with the
 * minimum measured off the body -- its system turn, its tool schemas, and its
 * output cap (`fallbackOutputCap` when the body declares none).
 */
export function agentWindowFloorForBody(
	body: Record<string, unknown>,
	window: OpencotiAgentWindow,
	fallbackOutputCap?: number,
): number | undefined {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const first = messages[0] as
		| { role?: unknown; content?: unknown }
		| undefined;
	const systemPrompt = first?.role === "system" ? textOf(first.content) : "";
	const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
	const systemPromptTokens = estimateRequestInputTokens({
		systemPrompt,
		messages: [],
		tools: [],
	});
	const withTools = tools.length
		? estimateRequestInputTokens({ systemPrompt, messages: [], tools })
		: systemPromptTokens;
	const minimum = resolveContextMinimum({
		systemPromptTokens,
		toolSchemaTokens: Math.max(0, withTools - systemPromptTokens),
		outputRoomTokens: wireOutputCap(body) ?? fallbackOutputCap,
	});
	return resolveAgentWindowFloor({
		contextWindow: window.contextWindow,
		minimumTokens: minimum.minimumTokens,
		...(window.sharePercent !== undefined
			? { sharePercent: window.sharePercent }
			: {}),
	});
}
