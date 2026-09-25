/**
 * Server liveness on the opencoti stream (`stream_keepalive_v1`, patch 0388).
 *
 * Cerebriline runs its local streams with every timeout off, because a 40k
 * prefill behind a busy server can legitimately take minutes of silence. That
 * made a dead server, a half-open connection and a slow turn look the same:
 * nothing on the wire, for as long as anyone cared to wait.
 *
 * With `stream_options.keepalive: true` the server opens the SSE stream at once
 * and sends one comment line per silent `sse_ping_interval`, naming the phase:
 *
 *     : keepalive queued
 *     : keepalive prefill 20481/41533
 *     : keepalive generating 17
 *
 * Three silent periods is dead. Two things come with it:
 *
 * - **The first-result error moves into the stream.** Without the option an
 *   admission refusal, an overlong prompt or a window refusal of the slot is a
 *   plain HTTP error; with it, the stream is already open, so it arrives as a
 *   `data: {"error": {...}}` event under a 200. Every refusal path on this side
 *   reads the status, so {@link superviseKeepaliveStream} puts the status back.
 * - **A silence that outlasts three periods is a transport fault**, raised as
 *   one ({@link OpencotiServerSilentError}) so the turn-fault recovery waits
 *   for `/health` and runs the turn again.
 *
 * Refusals the server makes BEFORE it opens the stream (the enforced admission
 * gate's 429 + Retry-After, its settling hold) are untouched by the option:
 * they are still plain HTTP responses, and a hold is still silence before the
 * headers. The watchdog therefore starts at the headers, never before them.
 */

/**
 * The ping interval this client asks for, in seconds.
 *
 * `/props` does not advertise the server's `--sse-ping-interval` (checked
 * against patch 0388: it is in neither `features` nor
 * `default_generation_settings`), and a server launched with upstream's 30 s
 * would have every healthy stream killed by a watchdog sized for 10 s. So the
 * interval is not guessed: `sse_ping_interval` is a per-request field of the
 * completion schema, and the request states it. 10 s is the patch's own
 * default, so on a stock-configured server this changes nothing.
 */
export const OPENCOTI_KEEPALIVE_PING_SECONDS = 10;

/** What a request that asked for the heartbeat asked for. */
export interface KeepaliveRequest {
	/**
	 * The ping interval it carries, in seconds; absent when the caller turned
	 * the pings off (`sse_ping_interval <= 0`). The stream still opens early
	 * then, so a first-result error is still in-stream -- but a silence proves
	 * nothing, and there is no watchdog.
	 */
	pingSeconds?: number;
}

/**
 * Ask for the heartbeat on a streaming request body, in place.
 *
 * `stream_options` is merged, never replaced: the compatible provider puts
 * `include_usage` there, and the usage row is read from it. Returns what was
 * asked for, or `undefined` for a request that does not stream -- a buffered
 * response has nowhere to put a comment.
 */
export function requestStreamKeepalive(
	body: Record<string, unknown>,
): KeepaliveRequest | undefined {
	if (body.stream !== true) {
		return undefined;
	}
	const existing =
		body.stream_options && typeof body.stream_options === "object"
			? (body.stream_options as Record<string, unknown>)
			: {};
	body.stream_options = { ...existing, keepalive: true };
	const stated = body.sse_ping_interval;
	if (typeof stated === "number" && Number.isFinite(stated)) {
		// The caller chose one.
		return stated > 0 ? { pingSeconds: stated } : {};
	}
	body.sse_ping_interval = OPENCOTI_KEEPALIVE_PING_SECONDS;
	return { pingSeconds: OPENCOTI_KEEPALIVE_PING_SECONDS };
}

/**
 * The HTTP status the server gives an error `type` when it is not streaming.
 *
 * The same table as the server's `format_error_response`, plus the two types
 * opencoti sets by hand (`rate_limit_error` on its 429s, `tool_call_rejected`
 * on a 500). Used only when the event carries no numeric `code`, which every
 * error the server formats does.
 */
const STATUS_BY_ERROR_TYPE: Record<string, number> = {
	invalid_request_error: 400,
	exceed_context_size_error: 400,
	authentication_error: 401,
	permission_error: 403,
	not_found_error: 404,
	rate_limit_error: 429,
	server_error: 500,
	tool_call_rejected: 500,
	not_supported_error: 501,
	unavailable_error: 503,
};

/**
 * The status an in-stream error would have had as a plain HTTP error.
 *
 * The server's non-streaming path sets the status from the error's own `code`
 * (`res->error`: `status = json_value(error, "code", 500)`), so that is read
 * first; the type table is the fallback, and 500 the default, as there.
 */
export function statusOfStreamError(error: Record<string, unknown>): number {
	const code = error.code;
	if (
		typeof code === "number" &&
		Number.isInteger(code) &&
		code >= 400 &&
		code <= 599
	) {
		return code;
	}
	const type = typeof error.type === "string" ? error.type : "";
	return STATUS_BY_ERROR_TYPE[type] ?? 500;
}

/**
 * The response the server would have sent for this error without the option:
 * its status, and `{"error": <the same object>}` as the body -- exactly
 * `res->error`'s shape, so `largest_admissible`, `n_ctx`, `n_prompt_tokens`
 * and the message every refusal matcher reads are all where they were. The
 * headers the server set before opening the stream (`X-Context-Window`, the
 * boot id) ride along, as they do on its plain error.
 */
function firstResultErrorResponse(
	response: Response,
	error: Record<string, unknown>,
): Response {
	const headers = new Headers(response.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.delete("content-length");
	headers.delete("transfer-encoding");
	return new Response(JSON.stringify({ error }), {
		status: statusOfStreamError(error),
		headers,
	});
}

/** Splits a byte stream into lines, keeping the unfinished tail. */
class LineSplitter {
	private readonly decoder = new TextDecoder();
	private carry = "";
	push(chunk: Uint8Array): string[] {
		this.carry += this.decoder.decode(chunk, { stream: true });
		const lines = this.carry.split("\n");
		this.carry = lines.pop() ?? "";
		return lines.map((line) => line.replace(/\r$/, ""));
	}
	flush(): string[] {
		const rest = this.carry + this.decoder.decode();
		this.carry = "";
		return rest ? [rest.replace(/\r$/, "")] : [];
	}
}

type StreamEvent =
	| { type: "comment"; line: string }
	| { type: "data" }
	| { type: "error"; error: Record<string, unknown> };

/**
 * One line's meaning, with `event:` state carried between lines.
 *
 * The server writes a first-result error as `data: {"error": {...}}` on the
 * OpenAI routes and as `event: error` + `data: {...}` on the Anthropic one
 * (`format_error` in `handle_completions_impl`); both are read.
 */
function createEventReader(): (line: string) => StreamEvent | undefined {
	let eventName: string | undefined;
	return (line) => {
		if (line === "") {
			eventName = undefined;
			return undefined;
		}
		if (line.startsWith(":")) {
			return { type: "comment", line };
		}
		if (line.startsWith("event:")) {
			eventName = line.slice("event:".length).trim();
			return undefined;
		}
		if (!line.startsWith("data:")) {
			return undefined;
		}
		const payload = line.slice("data:".length).trim();
		// Only a frame that names an error can be one: the cheap gate first,
		// as most frames are content deltas.
		if (eventName !== "error" && !payload.includes('"error"')) {
			return { type: "data" };
		}
		try {
			const parsed = JSON.parse(payload) as Record<string, unknown>;
			const nested = parsed?.error;
			if (nested && typeof nested === "object") {
				return { type: "error", error: nested as Record<string, unknown> };
			}
			if (eventName === "error" && parsed && typeof parsed === "object") {
				return { type: "error", error: parsed };
			}
		} catch {
			// Not JSON: a content frame that happens to contain the word.
		}
		return { type: "data" };
	};
}

/**
 * Supervise a response to a request that asked for the heartbeat.
 *
 * - A response that is not a 200 event stream is returned as it is: a refusal
 *   the server made before opening the stream is already the HTTP error it
 *   always was.
 * - Otherwise the stream is read up to its first data or error event --
 *   comments do not count. An error first becomes the plain HTTP response it
 *   would have been without the option, so every status-reading path (the 429
 *   window negotiation, the worker's window-full wait, the 5xx server-fault
 *   wait, the error classifier) sees what it always saw. Anything else is
 *   handed on as a stream that replays what was read and then continues.
 */
export async function superviseKeepaliveStream(
	response: Response,
): Promise<Response> {
	const contentType = response.headers.get("content-type") ?? "";
	if (
		response.status !== 200 ||
		!contentType.includes("text/event-stream") ||
		response.body === null
	) {
		return response;
	}
	const reader = response.body.getReader();
	const splitter = new LineSplitter();
	const readEvent = createEventReader();

	const consider = (
		lines: string[],
	): { error?: Record<string, unknown>; data: boolean } => {
		let data = false;
		for (const line of lines) {
			const event = readEvent(line);
			if (!event || event.type === "comment") {
				continue;
			}
			if (event.type === "error") {
				return { error: event.error, data };
			}
			data = true;
		}
		return { data };
	};

	// Up to the first event that is not a comment.
	const read: Uint8Array[] = [];
	let ended = false;
	while (true) {
		const result = await reader.read();
		if (result.done) {
			ended = true;
			const tail = consider(splitter.flush());
			if (tail.error && !tail.data) {
				return firstResultErrorResponse(response, tail.error);
			}
			break;
		}
		read.push(result.value);
		const seen = consider(splitter.push(result.value));
		if (seen.error && !seen.data) {
			reader.cancel().catch(() => {});
			return firstResultErrorResponse(response, seen.error);
		}
		if (seen.data || seen.error) {
			break;
		}
	}

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of read) {
				controller.enqueue(chunk);
			}
			if (ended) {
				controller.close();
			}
		},
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					controller.close();
					return;
				}
				controller.enqueue(result.value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
