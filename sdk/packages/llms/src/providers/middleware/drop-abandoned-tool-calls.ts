/**
 * A streamed tool call the engine gave up on (opencoti `tool_call_abandon_v1`,
 * bug-3907; docs/llamafile-usage.md section 7).
 *
 * A call whose arguments stop parsing midway (an invalid escape such as
 * `"c:\Users"`) used to end the stream with an error event, and its text never
 * arrived. The engine now sends that text as an ordinary content delta and, on
 * the same chunk, marks the call it had begun streaming:
 *
 *   choices[0].delta.x_tool_call_abandoned = { index, id, name, reason, channel }
 *
 * and lists every one again on the final chunk
 * (`choices[0].x_tool_calls_abandoned`). The turn ends with `stop`.
 *
 * The provider package does not know the field, and at the end of the stream
 * it reports every call it saw begin as a finished call -- here with the
 * partial arguments. That call is dropped by its id, so the turn holds one
 * account of what the model wrote: the text, which the agent runtime already
 * answers as a call it could not read. Without this, the same call was in the
 * turn twice, once as broken arguments and once as text.
 *
 * Raw chunks are asked of the model for this alone, and passed on only to a
 * caller that asked for them too.
 */

import type {
	LanguageModelV4Middleware,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

/** What the engine says about a call it abandoned. */
export interface AbandonedToolCall {
	id?: string;
	index?: number;
	name?: string;
	reason?: string;
	channel?: string;
}

function asAbandoned(value: unknown): AbandonedToolCall | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	return {
		...(typeof v.id === "string" ? { id: v.id } : {}),
		...(typeof v.index === "number" ? { index: v.index } : {}),
		...(typeof v.name === "string" ? { name: v.name } : {}),
		...(typeof v.reason === "string" ? { reason: v.reason } : {}),
		...(typeof v.channel === "string" ? { channel: v.channel } : {}),
	};
}

/** The abandoned calls one raw chunk names: on its delta, or the final list. */
export function readAbandonedToolCalls(raw: unknown): AbandonedToolCall[] {
	if (!raw || typeof raw !== "object") {
		return [];
	}
	const choices = (raw as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) {
		return [];
	}
	const found: AbandonedToolCall[] = [];
	for (const choice of choices) {
		if (!choice || typeof choice !== "object") {
			continue;
		}
		const c = choice as { delta?: unknown; x_tool_calls_abandoned?: unknown };
		const onDelta =
			c.delta && typeof c.delta === "object"
				? asAbandoned(
						(c.delta as { x_tool_call_abandoned?: unknown })
							.x_tool_call_abandoned,
					)
				: undefined;
		if (onDelta) {
			found.push(onDelta);
		}
		if (Array.isArray(c.x_tool_calls_abandoned)) {
			for (const entry of c.x_tool_calls_abandoned) {
				const call = asAbandoned(entry);
				if (call) {
					found.push(call);
				}
			}
		}
	}
	return found;
}

function partCallId(part: LanguageModelV4StreamPart): string | undefined {
	switch (part.type) {
		case "tool-call":
			return part.toolCallId;
		case "tool-input-start":
		case "tool-input-delta":
		case "tool-input-end":
			return part.id;
		default:
			return undefined;
	}
}

export function createDropAbandonedToolCallsMiddleware(options?: {
	onAbandoned?: (call: AbandonedToolCall) => void;
}): LanguageModelV4Middleware {
	return {
		specificationVersion: "v4",
		wrapStream: async ({ params, model }) => {
			const wantsRaw = params.includeRawChunks === true;
			const result = await model.doStream({
				...params,
				includeRawChunks: true,
			});
			const abandoned = new Set<string>();
			const stream = result.stream.pipeThrough(
				new TransformStream<
					LanguageModelV4StreamPart,
					LanguageModelV4StreamPart
				>({
					transform(part, controller) {
						if (part.type === "raw") {
							for (const call of readAbandonedToolCalls(part.rawValue)) {
								if (call.id !== undefined && !abandoned.has(call.id)) {
									abandoned.add(call.id);
									options?.onAbandoned?.(call);
								}
							}
							if (wantsRaw) {
								controller.enqueue(part);
							}
							return;
						}
						const id = partCallId(part);
						if (id !== undefined && abandoned.has(id)) {
							return;
						}
						controller.enqueue(part);
					},
				}),
			);
			return { ...result, stream };
		},
	};
}
