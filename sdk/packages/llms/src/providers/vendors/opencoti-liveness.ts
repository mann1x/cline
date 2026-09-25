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

/**
 * Ask for the heartbeat on a streaming request body, in place.
 *
 * `stream_options` is merged, never replaced: the compatible provider puts
 * `include_usage` there, and the usage row is read from it. Returns the ping
 * interval the request now carries, or `undefined` when the request does not
 * stream (a buffered response has nowhere to put a comment) or asked for no
 * pings at all.
 */
export function requestStreamKeepalive(
	body: Record<string, unknown>,
): number | undefined {
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
		// The caller chose one. `<= 0` disables the pings, and without pings a
		// silence proves nothing: no watchdog.
		return stated > 0 ? stated : undefined;
	}
	body.sse_ping_interval = OPENCOTI_KEEPALIVE_PING_SECONDS;
	return OPENCOTI_KEEPALIVE_PING_SECONDS;
}
