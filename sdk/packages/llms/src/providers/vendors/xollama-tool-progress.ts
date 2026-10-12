/**
 * xOllama's `tool_call_progress_v1`: a tool call's text while it is written.
 *
 * `/api/chat` holds a tool call back until the model has closed it, so a call
 * that takes six minutes to write is six minutes of nothing, and a client
 * guard has nothing to read until there is nothing left to save (session
 * x8yap, pandorum, 2026-10-12: `stream-open iter=12 after=348258ms`). Asked
 * with `"tool_call_progress": true`, a server that announces the feature adds
 *
 *   message.tool_call_progress = { index, syntax, text, tokens, done? }
 *
 * to the streamed chunks: `text` is the raw output of one step the server
 * held back, delimiters included, in the model's own notation. `index` counts
 * runs of held output; a run that ends with `done` was a call, and a short
 * one that does not was a parser deciding about a tag. The parsed call still
 * arrives whole.
 *
 * This wrapper asks for it, lifts it off the response, and hands it on as the
 * `tool-input-delta` parts every other provider's streamed arguments already
 * are. What reads them does not read a notation (see `tool-intent-guard` in
 * `@cline/agents`), so `syntax` is only logged.
 */

import type { BasicLogger } from "@cline/shared";
import {
	STREAM_SIDE_PARTS_HEADER,
	type StreamSideParts,
	streamSidePartsById,
} from "../stream-side-parts";
import { probeXollama } from "./xollama";

export const XOLLAMA_TOOL_CALL_PROGRESS_FEATURE = "tool_call_progress_v1";

function chatRoot(input: Parameters<typeof fetch>[0]): string | undefined {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	const at = url.search(/\/api\/chat(?:[?#]|$)/);
	return at >= 0 ? url.slice(0, at) : undefined;
}

function takeHeader(
	headers: RequestInit["headers"] | undefined,
	name: string,
): { value: string | undefined; rest: RequestInit["headers"] | undefined } {
	if (!headers) {
		return { value: undefined, rest: headers };
	}
	const copy = new Headers(headers as ConstructorParameters<typeof Headers>[0]);
	const value = copy.get(name) ?? undefined;
	if (value === undefined) {
		return { value, rest: headers };
	}
	copy.delete(name);
	return { value, rest: copy };
}

interface ProgressStep {
	index?: unknown;
	syntax?: unknown;
	text?: unknown;
	tokens?: unknown;
	done?: unknown;
}

/** Push one chunk's progress, and return the chunk without it. */
function liftProgress(
	raw: string,
	queue: StreamSideParts,
	seen: { syntax?: string },
	logger: BasicLogger | undefined,
): string {
	if (!raw.includes('"tool_call_progress"')) {
		return raw;
	}
	let chunk: { message?: Record<string, unknown> };
	try {
		chunk = JSON.parse(raw);
	} catch {
		return raw;
	}
	const step = chunk.message?.tool_call_progress as ProgressStep | undefined;
	if (!step || typeof step !== "object" || !chunk.message) {
		return raw;
	}
	const id = `xollama_call_${typeof step.index === "number" ? step.index : 0}`;
	if (typeof step.syntax === "string" && seen.syntax !== step.syntax) {
		seen.syntax = step.syntax;
		logger?.debug?.(
			`[xollama] tool call progress is streaming (notation: ${step.syntax})`,
		);
	}
	if (typeof step.text === "string" && step.text.length > 0) {
		queue.push({ type: "tool-input-delta", id, delta: step.text });
	}
	if (step.done === true) {
		queue.push({ type: "tool-input-end", id });
	}
	const { tool_call_progress: _lifted, ...message } = chunk.message;
	return JSON.stringify({ ...chunk, message });
}

/**
 * Ask a streamed chat for its tool-call progress and route it to the queue
 * the request names. A request that names none, a server that does not
 * announce the feature, and a request that does not stream all go out and
 * come back untouched.
 */
export function withXollamaToolCallProgress(
	baseFetch: typeof fetch,
	options?: { logger?: BasicLogger },
): typeof fetch {
	return (async (input, init) => {
		const { value: queueId, rest: headers } = takeHeader(
			init?.headers,
			STREAM_SIDE_PARTS_HEADER,
		);
		const sent = queueId === undefined ? init : { ...init, headers };
		const queue = streamSidePartsById(queueId);
		const root = chatRoot(input);
		if (!queue || root === undefined || typeof init?.body !== "string") {
			return baseFetch(input, sent);
		}
		let body = init.body;
		try {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			const wanted =
				parsed.stream !== false &&
				Array.isArray(parsed.tools) &&
				parsed.tools.length > 0 &&
				(await probeXollama(root, baseFetch))?.features.includes(
					XOLLAMA_TOOL_CALL_PROGRESS_FEATURE,
				) === true;
			if (!wanted) {
				return baseFetch(input, sent);
			}
			body = JSON.stringify({ ...parsed, tool_call_progress: true });
		} catch {
			return baseFetch(input, sent);
		}
		const response = await baseFetch(input, { ...sent, body });
		if (!response.ok || !response.body) {
			return response;
		}
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		const seen: { syntax?: string } = {};
		let partial = "";
		const lifted = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(bytes, controller) {
					partial += decoder.decode(bytes, { stream: true });
					const lines = partial.split("\n");
					partial = lines.pop() ?? "";
					if (lines.length > 0) {
						const out = lines.map((line) =>
							liftProgress(line, queue, seen, options?.logger),
						);
						controller.enqueue(encoder.encode(`${out.join("\n")}\n`));
					}
				},
				flush(controller) {
					partial += decoder.decode();
					if (partial !== "") {
						controller.enqueue(
							encoder.encode(
								liftProgress(partial, queue, seen, options?.logger),
							),
						);
					}
				},
			}),
		);
		return new Response(lifted, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}) as typeof fetch;
}
