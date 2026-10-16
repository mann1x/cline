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

export type ModelRequestWriter = (request: CapturedModelRequest) => void;

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

/** Capture what goes through `fetchImpl`, when a writer is installed. */
export function withModelRequestCapture(
	fetchImpl: typeof fetch,
	sessionId?: string,
): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const current = writer;
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
					current({
						at: new Date().toISOString(),
						url,
						method,
						...(sessionId ? { sessionId } : {}),
						body,
					});
				} catch {
					// A capture must never fail the request it records.
				}
			}
		}
		return fetchImpl(input, init);
	}) as typeof fetch;
}
