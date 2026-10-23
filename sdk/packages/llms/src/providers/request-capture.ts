/**
 * Saving the exact body of every generation request, for replaying a turn.
 *
 * A garbled first token is either the model's own sample or something the
 * engine carried over, and only the request that produced it tells the two
 * apart: replayed on a fresh engine with the same weights, the first token's
 * probabilities answer it (opencoti #1553). Nothing kept that request until
 * now -- the session files hold the conversation, not the body that was sent,
 * and the server logs hold neither.
 *
 * Off unless a host installs a writer. The capture sits where a body is final:
 * innermost in the Ollama and xOllama vendors, after every field xOllama adds,
 * and on the gateway's fetch for every other provider. Headers are never
 * captured, so no key or token reaches the writer; the body is captured as it
 * was sent.
 *
 * The response is captured too when the writer asks for it, by returning a
 * sink. A request alone is not a trace: the model's answer reaches the next
 * request only after the history has been reshaped -- older reasoning dropped
 * by the reasoning-history scope, the latest inlined as `<think>` where the
 * template drops the field -- so it cannot stand in for what was generated.
 * The response is the raw stream as the caller read it from the server.
 */

/** One captured request. */
export interface CapturedModelRequest {
	/** When the request was sent, ISO 8601. */
	at: string;
	url: string;
	method: string;
	/** The conversation it belongs to, when the caller knows it. */
	sessionId?: string;
	/** The body, parsed when it is JSON and otherwise as sent. */
	body: unknown;
}

/** The answer to one captured request, as the server streamed it. */
export interface CapturedModelResponse {
	/** When the response ended, ISO 8601. */
	at: string;
	status: number;
	/** The response body as sent: SSE, NDJSON or JSON text, undecoded. */
	body: string;
	/** False when the stream was cut off: `body` holds what arrived. */
	complete: boolean;
	/** Why the stream ended early, when it did. */
	error?: string;
}

export type ModelResponseWriter = (response: CapturedModelResponse) => void;

/**
 * Called once per request. Returning a {@link ModelResponseWriter} asks for
 * that request's response as well; anything else saves the request only.
 *
 * `unknown` rather than the function type, so a writer written before
 * responses were captured -- `(request) => saved.push(request)` returns a
 * number -- still type-checks and still saves requests alone.
 */
export type ModelRequestWriter = (request: CapturedModelRequest) => unknown;

let writer: ModelRequestWriter | undefined;

/**
 * Install the writer, or remove it with `undefined`. On Ollama and xOllama it
 * is read at every request, so a switch takes effect on the next one; other
 * providers are wrapped when their session's model is built, so for them it
 * takes effect with the next session.
 */
export function setModelRequestCapture(
	next: ModelRequestWriter | undefined,
): void {
	writer = next;
}

export function isModelRequestCaptureOn(): boolean {
	return writer !== undefined;
}

/** Generation endpoints only: probes, tokenizing and model lists are not turns. */
const GENERATION_PATH =
	/\/(?:api\/chat|api\/generate|chat\/completions|completions|completion|responses|messages)$/;

/** Bodies already captured, so a request passing two capturing layers is saved once. */
const captured = new WeakSet<object>();

function urlOf(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string"
		? input
		: input instanceof URL
			? input.href
			: input.url;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The response, with its body recorded as the caller reads it.
 *
 * Passed through rather than copied with `clone()`: a tee'd copy that falls
 * behind the caller loses the chunks it had not read when the stream errors,
 * which is exactly the cut-off response worth keeping. Read on demand, so the
 * caller's pace is the server's, and nothing is buffered on the side. Saved
 * when the caller reaches the end, cancels, or the stream fails, with what had
 * arrived by then; a body the caller never reads is never saved.
 */
function recordedResponse(
	response: Response,
	sink: ModelResponseWriter,
): Response {
	let text = "";
	let saved = false;
	const decoder = new TextDecoder();
	const finish = (complete: boolean, error?: string) => {
		if (saved) {
			return;
		}
		saved = true;
		text += decoder.decode();
		try {
			sink({
				at: new Date().toISOString(),
				status: response.status,
				body: text,
				complete,
				...(error ? { error } : {}),
			});
		} catch {
			// A capture must never fail the request it records.
		}
	};
	if (!response.body) {
		finish(true);
		return response;
	}
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					finish(true);
					controller.close();
					return;
				}
				text += decoder.decode(value, { stream: true });
				controller.enqueue(value);
			} catch (cause) {
				finish(false, messageOf(cause));
				controller.error(cause);
			}
		},
		cancel(reason) {
			finish(
				false,
				reason === undefined ? "cancelled by the reader" : messageOf(reason),
			);
			return reader.cancel(reason);
		},
	});
	const recorded = new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
	// Not settable through the constructor, and read by some clients.
	for (const key of ["url", "redirected", "type"] as const) {
		Object.defineProperty(recorded, key, { value: response[key] });
	}
	return recorded;
}

/** Capture what goes through `fetchImpl`, when a writer is installed. */
export function withModelRequestCapture(
	fetchImpl: typeof fetch,
	sessionId?: string,
): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const current = writer;
		let sink: ModelResponseWriter | undefined;
		if (current !== undefined && init !== undefined && !captured.has(init)) {
			const url = urlOf(input);
			const method = (init.method ?? "GET").toUpperCase();
			let path = url;
			try {
				path = new URL(url).pathname;
			} catch {
				// Not a URL this can parse; matched as written.
			}
			if (
				method === "POST" &&
				typeof init.body === "string" &&
				GENERATION_PATH.test(path)
			) {
				captured.add(init);
				let body: unknown = init.body;
				try {
					body = JSON.parse(init.body);
				} catch {
					// Kept as sent.
				}
				try {
					const asked = current({
						at: new Date().toISOString(),
						url,
						method,
						...(sessionId ? { sessionId } : {}),
						body,
					});
					// Only a function asks for the response: `(r) => list.push(r)`
					// returns a number.
					sink =
						typeof asked === "function"
							? (asked as ModelResponseWriter)
							: undefined;
				} catch {
					// A capture must never fail the request it records.
				}
			}
		}
		let response: Response;
		try {
			response = await fetchImpl(input, init);
		} catch (cause) {
			try {
				sink?.({
					at: new Date().toISOString(),
					status: 0,
					body: "",
					complete: false,
					error: messageOf(cause),
				});
			} catch {
				// A capture must never fail the request it records.
			}
			throw cause;
		}
		return sink ? recordedResponse(response, sink) : response;
	}) as typeof fetch;
}
