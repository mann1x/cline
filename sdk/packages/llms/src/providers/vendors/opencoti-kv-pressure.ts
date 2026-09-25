/**
 * Global KV pressure, and the resize that answers it (`kv_pressure_v1`,
 * `kv_resize_v1`, opencoti b108, mail #296).
 *
 * Until these, a booking was sized once and held for its life (§10.1 of the
 * integration guide): a session that compacted from 200k to 20k still held
 * 200k, while the server refused new agents for want of cells it was not
 * using. The engine now says two things it did not:
 *
 * - **Whether it is refusing.** `GET /kv` carries a `pressure` block -- the
 *   refusals of the last `window_s` seconds -- and every admission 429 carries
 *   the same block as `error.pressure`.
 * - **That a booking can move.** `POST /kv/sessions/{id}/resize {num_ctx}`
 *   shrinks or grows a live booking between requests; the session's next
 *   request runs in the new window.
 *
 * This module is the wire half: the types, the parsers, a per-server record of
 * the last pressure seen, and the resize call. What a running agent does with
 * them -- compact, shrink, grow back -- is policy, and lives with the
 * compaction trigger in `@cline/core` (`kv-pressure.ts`).
 *
 * Nothing here throws. A block that is not there is `undefined`, and a resize
 * that fails in any way comes back as a typed refusal: agents retry and never
 * fail on infrastructure, so there is nothing a caller could usefully catch.
 */

import {
	hasOpencotiFeature,
	OPENCOTI_FEATURES,
	type OpencotiAllocation,
	parseOpencotiAllocations,
	polykvRoot,
	probeOpencotiProps,
} from "./polykv";

/**
 * The server's refusals over its trailing window, as `GET /kv` states them.
 *
 * `refusedMinNeededMin60s` is the number a running session shrinks toward: the
 * smallest floor that would have satisfied one of the refused requests, so
 * freeing that many cells lets at least one of them in.
 */
export interface OpencotiKvPressure {
	/** The trailing window the `*_60s` counters cover, in seconds (60). */
	windowS: number;
	/** Admission refusals inside the window. */
	refused60s: number;
	/** The largest peak among them, in cells. */
	refusedPeakMax60s?: number;
	/** The most any one of them needed. */
	refusedNeededMax60s?: number;
	/** The least any one of them needed: free this much and one fits. */
	refusedMinNeededMin60s?: number;
	/** Epoch seconds of the last refusal, on the server's clock. */
	lastRefusalAt?: number;
	/** Seconds since the last refusal, when the block was written. */
	lastRefusalAgeS?: number;
	/** Refusals since boot. */
	refusalsTotal?: number;
}

const DEFAULT_PRESSURE_WINDOW_S = 60;

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Read a `pressure` block, from `/kv` or from a 429's `error`.
 *
 * `undefined` for anything that is not an object carrying at least the refusal
 * count: a block that does not say how many were refused says nothing a
 * policy could act on.
 */
export function parseOpencotiKvPressure(
	raw: unknown,
): OpencotiKvPressure | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	const block = raw as Record<string, unknown>;
	const refused = finite(block.refused_60s);
	if (refused === undefined) {
		return undefined;
	}
	const optional = (
		key: keyof OpencotiKvPressure,
		value: unknown,
	): Partial<OpencotiKvPressure> => {
		const number = finite(value);
		return number === undefined ? {} : { [key]: number };
	};
	const windowS = finite(block.window_s);
	return {
		windowS:
			windowS !== undefined && windowS > 0
				? windowS
				: DEFAULT_PRESSURE_WINDOW_S,
		refused60s: Math.max(0, refused),
		...optional("refusedPeakMax60s", block.refused_peak_max_60s),
		...optional("refusedNeededMax60s", block.refused_needed_max_60s),
		...optional("refusedMinNeededMin60s", block.refused_min_needed_min_60s),
		...optional("lastRefusalAt", block.last_refusal_at),
		...optional("lastRefusalAgeS", block.last_refusal_age_s),
		...optional("refusalsTotal", block.refusals_total),
	};
}

/** The `error.pressure` of a refusal body, given as text or parsed. */
export function parseOpencotiRefusalPressure(
	body: unknown,
): OpencotiKvPressure | undefined {
	let parsed = body;
	if (typeof body === "string") {
		try {
			parsed = JSON.parse(body);
		} catch {
			return undefined;
		}
	}
	if (!parsed || typeof parsed !== "object") {
		return undefined;
	}
	const error = (parsed as { error?: unknown }).error;
	return error && typeof error === "object"
		? parseOpencotiKvPressure((error as { pressure?: unknown }).pressure)
		: undefined;
}

/** The last pressure a server stated, and when this process read it. */
export interface OpencotiPressureReading {
	pressure: OpencotiKvPressure;
	/** `Date.now()` when it was read -- not the server's clock. */
	at: number;
}

const PRESSURE_BY_ROOT = new Map<string, OpencotiPressureReading>();

/**
 * Remember what a server said about its refusals.
 *
 * Kept per server rather than per session: pressure is the server's, and a
 * refusal one agent's request ran into is news for every other agent there.
 * The newest reading wins, whichever route it came by.
 */
export function noteOpencotiPressure(
	baseUrl: string,
	pressure: OpencotiKvPressure,
	at: number = Date.now(),
): void {
	const root = polykvRoot(baseUrl);
	const known = PRESSURE_BY_ROOT.get(root);
	if (!known || known.at <= at) {
		PRESSURE_BY_ROOT.set(root, { pressure, at });
	}
}

/** Record the `error.pressure` a refusal carried, if it carried one. */
export function noteOpencotiRefusalPressure(
	baseUrl: string,
	body: unknown,
): OpencotiKvPressure | undefined {
	const pressure = parseOpencotiRefusalPressure(body);
	if (pressure) {
		noteOpencotiPressure(baseUrl, pressure);
	}
	return pressure;
}

/** The newest pressure reading for a server, if any. */
export function latestOpencotiPressure(
	baseUrl: string | undefined,
): OpencotiPressureReading | undefined {
	if (!baseUrl) {
		return undefined;
	}
	const reading = PRESSURE_BY_ROOT.get(polykvRoot(baseUrl));
	return reading
		? { pressure: { ...reading.pressure }, at: reading.at }
		: undefined;
}

/** Test seam. */
export function resetOpencotiPressure(): void {
	PRESSURE_BY_ROOT.clear();
}

/**
 * How long a "no refusals" reading may be trusted to say the pressure has
 * cleared. Growing back takes cells, so it waits for a reading this recent;
 * the per-turn `/kv` read is bounded at five seconds, well inside it.
 */
export const OPENCOTI_PRESSURE_CLEAR_MAX_AGE_MS = 15_000;

/**
 * Whether the refusals in a pressure block were for want of cells on the
 * SERVER -- the only refusals running agents answer by giving cells back.
 *
 * `refused_needed_max_60s` is the most base-pool cells any refusal in the
 * window asked for (opencoti `oc_refusal_record`: the admission's
 * `want[OC_POOL_BASE]`). A worker refused because its OWNER is full asks the
 * base pool for nothing -- its cells are priced against the owner's window --
 * so a window of only those reads 0: the server had the room, one booking
 * was short. Live on 8244 (b108, 2026-09-25): four such refusals with 786k
 * base cells free; answering them by compacting and shrinking every running
 * agent would have been exactly wrong. The answer to those is growing the
 * owner (`growPolykvOwnerForWorker`). A block without the field (an older
 * engine) reads as global, as before.
 */
export function opencotiRefusalsAreGlobal(
	pressure: OpencotiKvPressure,
): boolean {
	return (
		pressure.refusedNeededMax60s === undefined ||
		pressure.refusedNeededMax60s > 0
	);
}

/**
 * Whether the server is refusing now: `active`, `clear`, or `unknown`.
 *
 * Active while the last refusal is inside the window, counted forward from
 * when the block was read -- the server's own `last_refusal_age_s` plus the
 * time since -- so a reading does not have to be fresh to still be true, and
 * the server's clock is never compared with ours. A block with refusals and
 * no age is active for one window from the read.
 *
 * Clear only on a recent reading: an old "nothing refused" says nothing about
 * now, and growing on it would take cells someone was just refused.
 *
 * Only refusals for want of server cells count ({@link
 * opencotiRefusalsAreGlobal}): a window of nothing but session-full
 * refusals is a server with room, and reads as one.
 */
export function opencotiPressureState(
	reading: OpencotiPressureReading | undefined,
	now: number = Date.now(),
): "active" | "clear" | "unknown" {
	if (!reading) {
		return "unknown";
	}
	const { pressure, at } = reading;
	const elapsedS = Math.max(0, (now - at) / 1000);
	const windowS = pressure.windowS;
	// A negative age is the server's "never refused": no age at all.
	const age =
		pressure.lastRefusalAgeS !== undefined && pressure.lastRefusalAgeS >= 0
			? pressure.lastRefusalAgeS + elapsedS
			: undefined;
	const refusing =
		age !== undefined
			? age <= windowS
			: pressure.refused60s > 0 && elapsedS <= windowS;
	if (refusing && opencotiRefusalsAreGlobal(pressure)) {
		return "active";
	}
	return now - at <= OPENCOTI_PRESSURE_CLEAR_MAX_AGE_MS ? "clear" : "unknown";
}

/** What one `GET /kv` read gives the pressure policy. */
export interface OpencotiKvSnapshot {
	allocations: OpencotiAllocation[];
	/** Present only where the server advertises `kv_pressure_v1`. */
	pressure?: OpencotiKvPressure;
}

const KV_READ_TIMEOUT_MS = 5_000;

/**
 * `GET /kv`: the allocations, and -- under `kv_pressure_v1` -- the pressure.
 *
 * One read for both, so the compaction trigger's per-turn row read carries
 * the pressure with it rather than asking a second time. The pressure is also
 * recorded for the server (see {@link noteOpencotiPressure}). `undefined`
 * where the server does not offer `/kv` (`kv_status_v1`) or did not answer.
 */
export async function readOpencotiKv(
	baseUrl: string | undefined,
	fetchImpl?: typeof fetch,
): Promise<OpencotiKvSnapshot | undefined> {
	if (!baseUrl) {
		return undefined;
	}
	const doFetch = fetchImpl ?? fetch;
	const props = await probeOpencotiProps(baseUrl, doFetch);
	if (!hasOpencotiFeature(props.features, OPENCOTI_FEATURES.kvStatus)) {
		return undefined;
	}
	const at = Date.now();
	const body = await boundedRequest(doFetch, `${polykvRoot(baseUrl)}/kv`, {
		method: "GET",
	});
	if (!body || !body.ok || !isRecord(body.json)) {
		return undefined;
	}
	const kv = body.json;
	const pressure = hasOpencotiFeature(
		props.features,
		OPENCOTI_FEATURES.kvPressure,
	)
		? parseOpencotiKvPressure(kv.pressure)
		: undefined;
	if (pressure) {
		noteOpencotiPressure(baseUrl, pressure, at);
	}
	return {
		allocations: parseOpencotiAllocations(kv),
		...(pressure ? { pressure } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A request that cannot outlive its bound, answering status and JSON body.
 * `undefined` when it threw or timed out. See `boundedJson` in `polykv.ts`
 * for why both the signal and the race are needed.
 */
async function boundedRequest(
	doFetch: typeof fetch,
	url: string,
	init: { method: string; body?: unknown; headers?: Record<string, string> },
	timeoutMs: number = KV_READ_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; json: unknown } | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let expired: (() => void) | undefined;
	const expiry = new Promise<undefined>((resolve) => {
		expired = () => resolve(undefined);
	});
	const abandon = setTimeout(() => expired?.(), timeoutMs);
	try {
		return await Promise.race([
			(async () => {
				const response = await doFetch(url, {
					method: init.method,
					headers: {
						...(init.body !== undefined
							? { "content-type": "application/json" }
							: {}),
						...(init.headers ?? {}),
					},
					...(init.body !== undefined
						? { body: JSON.stringify(init.body) }
						: {}),
					signal: controller.signal,
				});
				const text = await response.text().catch(() => "");
				let json: unknown;
				try {
					json = text ? JSON.parse(text) : undefined;
				} catch {
					json = undefined;
				}
				return { ok: response.ok, status: response.status, json };
			})(),
			expiry,
		]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		clearTimeout(abandon);
	}
}

/**
 * The route a resize goes to.
 *
 * `POST /kv/sessions/{id}/resize` for an id the path can carry; `POST
 * /sessions/resize {session_id, num_ctx}` for anything else. The path segment
 * cannot hold a `/` -- encoded, the route does not match (the close route's
 * lesson, `engineSessionId`) -- and our own ids carry `~` (`~teammate-…`,
 * `~agent-…`, `~polykv-owner-…`), which the body form takes without asking how
 * the router reads it.
 */
export function opencotiResizeRequest(
	sessionId: string,
	numCtx: number,
): { path: string; body: Record<string, unknown> } {
	if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
		return {
			path: `/kv/sessions/${sessionId}/resize`,
			body: { num_ctx: numCtx },
		};
	}
	return {
		path: "/sessions/resize",
		body: { session_id: sessionId, num_ctx: numCtx },
	};
}

/** A resize the engine took. `cellsDelta` is negative for cells given back. */
export interface OpencotiResizeDone {
	ok: true;
	window?: number;
	windowNew: number;
	cells?: number;
	cellsNew?: number;
	cellsDelta?: number;
	used?: number;
	sequences?: number;
}

/**
 * A resize the engine did not take, by kind:
 *
 * - `session_not_found` (404), `session_closing` (409): the booking is gone
 *   or going; nothing to resize.
 * - `invalid_num_ctx`, `above_session_ctx_max` (400).
 * - `per_request_session` (409): the session holds nothing between
 *   requests, so there is nothing to resize -- and stating a smaller
 *   `num_ctx` on its next request would make it a HELD booking (mail #301).
 * - `session_busy` (409): a task is active or pending; try between requests.
 * - `used_exceeds_window` (409): the tree holds more than the asked window;
 *   `used` is the floor.
 * - `exhausted` (429): a grow the free cells cannot cover;
 *   `largestAdmissible` is the most it could grow to.
 * - `transport`: no answer at all.
 * - anything else the engine names, verbatim.
 */
export interface OpencotiResizeRefused {
	ok: false;
	status: number;
	kind: string;
	message?: string;
	used?: number;
	window?: number;
	cells?: number;
	largestAdmissible?: number;
	pressure?: OpencotiKvPressure;
}

export type OpencotiResizeResult = OpencotiResizeDone | OpencotiResizeRefused;

/** The error kinds the resize contract names. */
const RESIZE_KINDS = new Set([
	"session_not_found",
	"invalid_num_ctx",
	"above_session_ctx_max",
	"per_request_session",
	"session_closing",
	"session_busy",
	"used_exceeds_window",
]);

/**
 * The kind of a resize refusal.
 *
 * The envelope is `{error: {code, message, type, error_kind, …}}`. Which of
 * those carries `session_busy` is read in order -- `error_kind`, then a string
 * `code`, then `type` -- and a 429 without a named kind is the exhausted grow,
 * the one refusal the contract gives by status alone.
 */
function resizeKind(status: number, error: Record<string, unknown>): string {
	for (const candidate of [error.error_kind, error.code, error.type]) {
		if (typeof candidate === "string" && RESIZE_KINDS.has(candidate)) {
			return candidate;
		}
	}
	if (status === 429) {
		return "exhausted";
	}
	if (status === 404) {
		return "session_not_found";
	}
	for (const candidate of [error.error_kind, error.code, error.type]) {
		if (typeof candidate === "string" && candidate) {
			return candidate;
		}
	}
	return `http_${status}`;
}

/**
 * Resize a live booking (`kv_resize_v1`). Never throws.
 *
 * `sessionId` is the id the wire carried (`engineSessionId(...)`). Only valid
 * between the session's requests: the engine answers `session_busy` while a
 * task is active or pending, and the caller tries again at its next turn
 * boundary. The caller checks the feature; this only makes the call.
 */
export async function resizeOpencotiSession(options: {
	baseUrl: string;
	sessionId: string;
	numCtx: number;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
}): Promise<OpencotiResizeResult> {
	const request = opencotiResizeRequest(
		options.sessionId,
		Math.max(1, Math.floor(options.numCtx)),
	);
	const answer = await boundedRequest(
		options.fetch ?? fetch,
		`${polykvRoot(options.baseUrl)}${request.path}`,
		{
			method: "POST",
			body: request.body,
			...(options.headers ? { headers: options.headers } : {}),
		},
	);
	if (!answer) {
		return { ok: false, status: 0, kind: "transport" };
	}
	const body = isRecord(answer.json) ? answer.json : {};
	if (answer.ok) {
		const windowNew = finite(body.window_new) ?? finite(body.window);
		if (windowNew === undefined || windowNew <= 0) {
			return {
				ok: false,
				status: answer.status,
				kind: "malformed_response",
			};
		}
		const field = (key: string): number | undefined => finite(body[key]);
		const optional = (
			key: keyof OpencotiResizeDone,
			value: number | undefined,
		): Partial<OpencotiResizeDone> =>
			value === undefined ? {} : { [key]: value };
		return {
			ok: true,
			windowNew,
			...optional("window", field("window")),
			...optional("cells", field("cells")),
			...optional("cellsNew", field("cells_new")),
			...optional("cellsDelta", field("cells_delta")),
			...optional("used", field("used")),
			...optional("sequences", field("sequences")),
		};
	}
	const error = isRecord(body.error) ? body.error : body;
	const pressure = parseOpencotiKvPressure(error.pressure);
	if (pressure) {
		noteOpencotiPressure(options.baseUrl, pressure);
	}
	const number = (key: string): number | undefined => finite(error[key]);
	const used = number("used");
	const window = number("window");
	const cells = number("cells");
	const largestAdmissible = number("largest_admissible");
	return {
		ok: false,
		status: answer.status,
		kind: resizeKind(answer.status, error),
		...(typeof error.message === "string" ? { message: error.message } : {}),
		...(used !== undefined ? { used } : {}),
		...(window !== undefined ? { window } : {}),
		...(cells !== undefined ? { cells } : {}),
		...(largestAdmissible !== undefined ? { largestAdmissible } : {}),
		...(pressure ? { pressure } : {}),
	};
}

/**
 * The floor each session declared for its window, by the host's session id.
 *
 * Recorded by the fetch that sent it -- the agent window's share measured off
 * the body, or the profile's `contextFloor` -- because that is the one place
 * it is known exactly, and a resume sends the grant in its place. A session
 * with no floor recorded declared no smaller window acceptable, and is never
 * shrunk.
 */
const WINDOW_FLOORS = new Map<string, number>();

export function recordOpencotiWindowFloor(
	sessionId: string,
	floor: number | undefined,
): void {
	if (typeof floor === "number" && Number.isFinite(floor) && floor > 0) {
		WINDOW_FLOORS.set(sessionId, Math.floor(floor));
	}
}

export function getOpencotiWindowFloor(
	sessionId: string | undefined,
): number | undefined {
	return sessionId ? WINDOW_FLOORS.get(sessionId) : undefined;
}

/** Test seam. */
export function resetOpencotiWindowFloors(): void {
	WINDOW_FLOORS.clear();
}

/**
 * The window a session would ask for in a booking of its own, by the host's
 * session id: the ceiling a pressure resize grows it back to.
 *
 * The grant's `asked` is that ceiling for a session that booked its own window
 * from the start. A swarm worker whose first grant came while it was pooled
 * has none -- that grant was its owner's window, and `asked` is kept from the
 * first grant -- so the worker records the node window here when it leaves the
 * pool and books its own.
 */
const WINDOW_CEILINGS = new Map<string, number>();

export function recordOpencotiWindowCeiling(
	sessionId: string,
	ceiling: number | undefined,
): void {
	if (typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0) {
		WINDOW_CEILINGS.set(sessionId, Math.floor(ceiling));
	}
}

export function getOpencotiWindowCeiling(
	sessionId: string | undefined,
): number | undefined {
	return sessionId ? WINDOW_CEILINGS.get(sessionId) : undefined;
}

/** Test seam. */
export function resetOpencotiWindowCeilings(): void {
	WINDOW_CEILINGS.clear();
}
