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

/** Silent periods after which the server is presumed dead (the contract's three). */
export const OPENCOTI_KEEPALIVE_DEAD_PERIODS = 3;

/**
 * Slack on top of the three periods: the server's ping timer starts when its
 * last write ended, and a busy event loop or a slow link adds to that. Enough
 * to absorb both, small next to a period.
 */
export const OPENCOTI_KEEPALIVE_MARGIN_MS = 5_000;

/** How long a keepalive stream may go without a single byte: 35 s at the default. */
export function opencotiKeepaliveDeadMs(pingSeconds: number): number {
	return (
		pingSeconds * 1000 * OPENCOTI_KEEPALIVE_DEAD_PERIODS +
		OPENCOTI_KEEPALIVE_MARGIN_MS
	);
}

/**
 * The server went silent past three keepalive periods.
 *
 * Carries `code: "ETIMEDOUT"` and says so in its message, because both are
 * what the turn-fault classifier reads as transport -- the kind waited out by
 * asking `/health` and then running the turn again -- whether it is handed
 * the error object or only its flattened text.
 */
export class OpencotiServerSilentError extends Error {
	readonly code = "ETIMEDOUT";
	constructor(readonly silentMs: number) {
		super(
			`ETIMEDOUT: the opencoti server sent nothing for ${Math.round(silentMs / 1000)}s (${OPENCOTI_KEEPALIVE_DEAD_PERIODS} keepalive periods); presumed dead`,
		);
		this.name = "OpencotiServerSilentError";
	}
}

/** What a keepalive comment says the request is doing. */
export type OpencotiStreamPhase =
	| { kind: "queued" }
	| { kind: "prefill"; processed: number; total: number }
	| { kind: "generating"; decoded: number };

/**
 * Read one SSE comment line. A bare `:` (upstream's ping) and anything that is
 * not a keepalive line say nothing about the phase.
 */
export function parseKeepaliveComment(
	line: string,
): OpencotiStreamPhase | undefined {
	const match = /^:\s*keepalive\s+(\w+)(?:\s+(\d+)(?:\/(\d+))?)?\s*$/.exec(
		line.trim(),
	);
	if (!match) {
		return undefined;
	}
	const [, kind, first, second] = match;
	if (kind === "queued") {
		return { kind: "queued" };
	}
	if (kind === "prefill" && first !== undefined && second !== undefined) {
		return { kind: "prefill", processed: Number(first), total: Number(second) };
	}
	if (kind === "generating") {
		return { kind: "generating", decoded: Number(first ?? 0) };
	}
	return undefined;
}

/** A phase, worded for an agent's row. */
export function describeOpencotiStreamPhase(
	phase: OpencotiStreamPhase,
): string {
	const count = (value: number) => Intl.NumberFormat("en-US").format(value);
	switch (phase.kind) {
		case "queued":
			return "Queued on the server";
		case "prefill":
			return `Prefilling ${count(phase.processed)} / ${count(phase.total)}`;
		case "generating":
			return phase.decoded > 0
				? `Generating (silent, ${count(phase.decoded)} tokens so far)`
				: "Generating (silent)";
	}
}

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

/** One read of a byte stream's reader. */
type ChunkRead = Awaited<
	ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

/**
 * Splits a byte stream into lines, keeping the unfinished tail, and drops the
 * `data: null` events on the way.
 *
 * With `stream_options.keepalive` opencoti opens the stream before its first
 * result exists, and writes that missing result as `data: null` -- the first
 * frame of every keepalive stream (patch 0388:
 * `first_result_json = first_result ? ... : json(nullptr)`). It carries
 * nothing, and the AI SDK's chunk schema rejects it: in 4.100.195 every
 * keepalive stream died on it, 48 agents of a 75-agent swarm within seconds
 * of dispatch. So an event whose data is exactly `null` is dropped whole --
 * its `event:`/`id:` lines and the blank line that ends it with it -- and
 * never reaches the SDK or the first-event logic below.
 *
 * An event is held from its first field line to the blank line that ends it,
 * which costs nothing: an SSE parser dispatches nothing before that blank line
 * either. A comment outside an event is passed at once, as it came.
 */
class SseLineFilter {
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();
	private carry = "";
	/** The field lines of the event not yet ended. */
	private pending: string[] = [];
	/** The complete lines kept by the last push or flush, for the event reader. */
	lines: string[] = [];

	/** The bytes of `chunk` that go on, possibly none. */
	push(chunk: Uint8Array): Uint8Array {
		this.carry += this.decoder.decode(chunk, { stream: true });
		const lines = this.carry.split("\n");
		this.carry = lines.pop() ?? "";
		return this.encode(this.filter(lines), "");
	}

	/**
	 * What is left at the end of the stream: an event nobody ended, and a last
	 * line without its newline. Neither is dispatched by an SSE parser; both go
	 * on as they came, unless they are the null event.
	 */
	flush(): Uint8Array {
		const rest = this.carry + this.decoder.decode();
		this.carry = "";
		const last = stripCr(rest);
		const event = last ? [...this.pending, last] : this.pending;
		const held = this.pending;
		this.pending = [];
		if (isNullEvent(event)) {
			this.lines = [];
			return new Uint8Array(0);
		}
		this.lines = event;
		return this.encode(held, rest);
	}

	private filter(raw: string[]): string[] {
		const out: string[] = [];
		for (const line of raw.map(stripCr)) {
			if (this.pending.length === 0) {
				if (line === "" || line.startsWith(":")) {
					out.push(line);
				} else {
					this.pending.push(line);
				}
				continue;
			}
			if (line !== "") {
				this.pending.push(line);
				continue;
			}
			if (!isNullEvent(this.pending)) {
				out.push(...this.pending, "");
			}
			this.pending = [];
		}
		this.lines = out;
		return out;
	}

	private encode(lines: string[], tail: string): Uint8Array {
		if (lines.length === 0 && !tail) {
			return new Uint8Array(0);
		}
		return this.encoder.encode(
			lines.map((line) => `${line}\n`).join("") + tail,
		);
	}
}

function stripCr(line: string): string {
	return line.replace(/\r$/, "");
}

/** The event's data is exactly `null`: the first result that was not there. */
function isNullEvent(lines: string[]): boolean {
	const data = lines
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length));
	return data.length > 0 && data.join("\n").trim() === "null";
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

export interface KeepaliveSupervision {
	/**
	 * The ping interval the request asked for, in seconds. Absent: pings off,
	 * so no watchdog.
	 */
	pingSeconds?: number;
	/** Told once, when the silence has outlasted three periods. */
	onDead?: (error: OpencotiServerSilentError) => void;
	/**
	 * Told the phase each keepalive comment names, and `undefined` once the
	 * stream produces again (or ends). Per comment; the receiver throttles.
	 */
	onPhase?: (phase: OpencotiStreamPhase | undefined) => void;
	/** Test seams. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/** The header patch 0388 puts on every completion response. */
export const OPENCOTI_BOOT_ID_HEADER = "x-opencoti-boot-id";

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
 * - Throughout, before and after that first event, a silence longer than three
 *   ping periods plus a margin cancels the body and fails the read with
 *   {@link OpencotiServerSilentError}: thrown from here while the first event
 *   is awaited, as a stream error after it. Armed only when the pings are on
 *   AND the response carries `X-OpenCoti-Boot-Id` -- the proof that the
 *   process that answered is one that sends the heartbeat. `/props` was read
 *   once per root; a restart onto an older build would leave long prefills
 *   silent, and a watchdog on those would kill healthy turns.
 */
export async function superviseKeepaliveStream(
	response: Response,
	options: KeepaliveSupervision = {},
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
	// What goes on: every byte but the `data: null` events.
	const filter = new SseLineFilter();
	const readEvent = createEventReader();
	const deadMs =
		options.pingSeconds !== undefined &&
		options.pingSeconds > 0 &&
		response.headers.has(OPENCOTI_BOOT_ID_HEADER)
			? opencotiKeepaliveDeadMs(options.pingSeconds)
			: undefined;
	const setTimer =
		options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer =
		options.clearTimer ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));

	let phaseShown = false;
	const showPhase = (phase: OpencotiStreamPhase | undefined) => {
		if (phase === undefined && !phaseShown) {
			return;
		}
		phaseShown = phase !== undefined;
		try {
			options.onPhase?.(phase);
		} catch {
			// A row update must never fail a request.
		}
	};

	/**
	 * One read, failed when no byte -- a comment is a byte -- arrives within
	 * the dead interval. The body is cancelled, which closes the connection.
	 */
	const readWithin = (): Promise<ChunkRead> => {
		if (deadMs === undefined) {
			return reader.read();
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			const handle = setTimer(() => {
				if (settled) {
					return;
				}
				settled = true;
				const error = new OpencotiServerSilentError(deadMs);
				reader.cancel(error).catch(() => {});
				try {
					options.onDead?.(error);
				} catch {
					// Reporting the death must not change it.
				}
				reject(error);
			}, deadMs);
			reader.read().then(
				(result) => {
					if (!settled) {
						settled = true;
						clearTimer(handle);
						resolve(result);
					}
				},
				(error: unknown) => {
					if (!settled) {
						settled = true;
						clearTimer(handle);
						reject(error);
					}
				},
			);
		});
	};

	const consider = (
		lines: string[],
	): { error?: Record<string, unknown>; data: boolean } => {
		let data = false;
		for (const line of lines) {
			const event = readEvent(line);
			if (!event) {
				continue;
			}
			if (event.type === "comment") {
				const phase = parseKeepaliveComment(event.line);
				if (phase) {
					showPhase(phase);
				}
				continue;
			}
			if (event.type === "error") {
				return { error: event.error, data };
			}
			data = true;
		}
		return { data };
	};

	// Up to the first event that is not a comment. A `data: null` event is
	// not one: it never leaves the filter, so an error after it is still the
	// first result's.
	const read: Uint8Array[] = [];
	const keep = (bytes: Uint8Array) => {
		if (bytes.length > 0) {
			read.push(bytes);
		}
	};
	let ended = false;
	while (true) {
		const result = await readWithin();
		if (result.done) {
			ended = true;
			keep(filter.flush());
			const tail = consider(filter.lines);
			if (tail.error && !tail.data) {
				showPhase(undefined);
				return firstResultErrorResponse(response, tail.error);
			}
			break;
		}
		keep(filter.push(result.value));
		const seen = consider(filter.lines);
		if (seen.error && !seen.data) {
			reader.cancel().catch(() => {});
			showPhase(undefined);
			return firstResultErrorResponse(response, seen.error);
		}
		if (seen.data || seen.error) {
			break;
		}
	}
	showPhase(undefined);

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
				// Until something goes on: a read can be all null event, or a
				// line without its end yet.
				while (true) {
					const result = await readWithin();
					if (result.done) {
						const tail = filter.flush();
						consider(filter.lines);
						showPhase(undefined);
						if (tail.length > 0) {
							controller.enqueue(tail);
						}
						controller.close();
						return;
					}
					const bytes = filter.push(result.value);
					// Silent generation (hidden reasoning, a long draft round) is
					// pinged too; the row says so until the next frame.
					const seen = consider(filter.lines);
					if (seen.data || seen.error) {
						showPhase(undefined);
					}
					if (bytes.length > 0) {
						controller.enqueue(bytes);
						return;
					}
				}
			} catch (error) {
				showPhase(undefined);
				controller.error(error);
			}
		},
		cancel(reason) {
			showPhase(undefined);
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
