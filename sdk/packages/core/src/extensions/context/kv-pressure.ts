import {
	engineSessionId,
	getOpencotiWindowCeiling,
	getOpencotiWindowFloor,
	getPolykvWindowGrant,
	hasOpencotiFeature,
	latestOpencotiPressure,
	normalizeProviderId,
	notePolykvOwnerWindow,
	OPENCOTI_FEATURES,
	type OpencotiAllocation,
	type OpencotiKvPressure,
	type OpencotiResizeResult,
	opencotiPendingResize,
	opencotiPressureState,
	polykvOwnerWindowBounds,
	polykvWorkerChargedTo,
	probeOpencotiProps,
	recordPolykvGrantedWindow,
	reportPolykvNotice,
	resizeOpencotiSession,
} from "@cline/llms";
import type { BasicLogger } from "@cline/shared";
import {
	clearPolykvAllocationCache,
	type PolykvProviderConfig,
	readPolykvKvSnapshot,
} from "./polykv-session";

/**
 * Running agents give cells back when the server is refusing others, and take
 * them again when it stops (`kv_pressure_v1` + `kv_resize_v1`, opencoti b108).
 *
 * The policy, as ruled (2026-09-25): admission refuses new agents under
 * pressure; RUNNING agents compact and shrink, transparently, when there is
 * pressure -- and never below their floor, because one agent with 60k beats
 * two with 30k. The floor is the node's "Agent window" share (or the profile's
 * `contextFloor` for a lead), recorded by the fetch that sent it.
 *
 * Three moves, all at a turn boundary -- the prepare step of the compaction
 * pipeline, which is between this session's requests by construction:
 *
 * 1. **Compact on global pressure.** The server refused someone in the last
 *    minute, this agent holds more than its floor, and compacting would let it
 *    give back a real share of its window: compaction is requested through the
 *    existing trigger -- one more reason beside the ratio, the overflow report
 *    and the engine's own row, never a second compaction path.
 * 2. **Shrink.** After a compaction, or at once when the context is already
 *    small, the booking is resized to what the context needs plus room to
 *    grow, never below the floor.
 * 3. **Grow back.** When a recent read says nobody is being refused and the
 *    booking is filling, it is resized up toward the window it first asked for
 *    -- before the ratio trigger would compact it. Growth is preferred over
 *    compaction whenever the server has the room.
 *
 * Every refusal the engine can give a resize is an ordinary outcome here: a
 * busy session is tried again at the next boundary, a gone one is dropped, an
 * exhausted grow takes `largest_admissible`. Nothing is a warning, and nothing
 * fails a turn. On a server that does not advertise both features none of this
 * runs and no resize is ever sent.
 */

/**
 * How full a shrunk window is left: the context and a reply's room take this
 * share, the rest is room to grow before the next decision. Below
 * {@link KV_GROW_AT} so a window just shrunk is not grown on the next turn,
 * and below the ratio trigger (0.9) so it is not compacted either.
 */
export const KV_SHRINK_FILL = 0.6;

/**
 * How full a window has to be, by the engine's own count, before it grows
 * back. Below the ratio trigger, so growth comes first when there is room.
 */
export const KV_GROW_AT = 0.75;

/** Resize targets are whole multiples of this, as the engine's grants are. */
export const KV_RESIZE_ALIGN = 256;

/**
 * The least a shrink must give back to be worth a resize: a tenth of the
 * window, and never under this many cells. A resize for a handful of cells is
 * churn.
 */
export const KV_SHRINK_MIN_CELLS = 4_096;
export const KV_SHRINK_MIN_SHARE = 0.1;

/**
 * What a pressure compaction must buy, as a share of the window, beyond what
 * a shrink without it would. Compaction costs the agent its detail; it is
 * spent under pressure only when it frees a real part of the booking. Without
 * this a window just shrunk to fit its compacted context would be compacted
 * again on the next turn, for a few thousand cells.
 */
export const KV_PRESSURE_COMPACTION_MIN_GAIN_SHARE = 0.25;

/**
 * How much bigger than a compaction's result the context must be for a
 * pressure compaction: a context already near what compaction would leave has
 * nothing to give.
 */
export const KV_PRESSURE_COMPACTION_MIN_RATIO = 1.25;

/** The booking this session's usage lands in, and its bounds. */
export interface KvResizeSubject {
	/**
	 * `own`: the session's own booking. `owner`: the swarm owner its pooled
	 * turns are charged to -- the owner resizes, never each worker.
	 */
	kind: "own" | "owner";
	/** The id the engine knows the booking by. */
	engineId: string;
	/** The host session whose grant follows the resize. */
	grantKey: string;
	/** Never shrunk below. Absent: no smaller window was declared acceptable. */
	floor?: number;
	/** Never grown above: the window first asked for. */
	ceiling?: number;
}

/** What one turn boundary knows about the server's pressure. */
export interface KvPressureTurn {
	baseUrl: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
	subject: KvResizeSubject;
	state: "active" | "clear" | "unknown";
	pressure?: OpencotiKvPressure;
	/** The subject's `/kv` row, as read this turn (updated by a resize). */
	row?: OpencotiAllocation;
	logger?: BasicLogger;
	/**
	 * The server queues a busy booking's resize for its idle moment
	 * (`kv_resize_deferred_v1`): every resize is asked for that way, and one
	 * already queued is not asked again.
	 */
	deferred?: boolean;
}

/** Per engine booking: a resize in flight, and what the engine has said. */
interface SubjectState {
	inFlight?: boolean;
	/** `per_request_session`: nothing held between requests to resize. */
	perRequest?: boolean;
	/** A grow the engine called invalid stops here, not every turn after. */
	growLimit?: number;
}

const SUBJECT_STATES = new Map<string, SubjectState>();

/** Test seam. */
export function resetKvPressureState(): void {
	SUBJECT_STATES.clear();
}

function subjectState(engineId: string): SubjectState {
	let state = SUBJECT_STATES.get(engineId);
	if (!state) {
		state = {};
		SUBJECT_STATES.set(engineId, state);
	}
	return state;
}

/**
 * The booking a session lives in, or `undefined` when it has none of its own
 * to resize.
 *
 * A pooled worker lives in the owner its last turn was charged to, and only
 * an owner this process opened is resized -- the lead's own session lent to
 * priority-0 agents is the lead's, and the lead resizes it at its own
 * boundaries. Everything else is its own session under the id the wire
 * carried.
 */
export function resolveKvResizeSubject(
	sessionId: string,
	providerConfig: PolykvProviderConfig,
): KvResizeSubject | undefined {
	if (providerConfig.polykvWorker) {
		const owner = polykvWorkerChargedTo(sessionId);
		if (owner !== undefined) {
			const bounds = polykvOwnerWindowBounds(owner);
			return bounds
				? {
						kind: "owner",
						engineId: owner,
						grantKey: sessionId,
						floor: bounds.floor,
						ceiling: bounds.ceiling,
					}
				: undefined;
		}
	}
	const floor = getOpencotiWindowFloor(sessionId);
	// The node window a worker that left its pool recorded, else the window
	// the session first asked for.
	const ceiling =
		getOpencotiWindowCeiling(sessionId) ??
		getPolykvWindowGrant(sessionId)?.asked;
	return {
		kind: "own",
		engineId: engineSessionId(sessionId),
		grantKey: sessionId,
		...(floor !== undefined ? { floor } : {}),
		...(ceiling !== undefined ? { ceiling } : {}),
	};
}

const alignUp = (value: number): number =>
	Math.ceil(value / KV_RESIZE_ALIGN) * KV_RESIZE_ALIGN;
const alignDown = (value: number): number =>
	Math.floor(value / KV_RESIZE_ALIGN) * KV_RESIZE_ALIGN;

const cells = (value: number): string =>
	Math.round(value).toLocaleString("en-US");

/**
 * The window a context of `usage` plus a reply's `room` is shrunk to: aligned
 * up, so never below the floor even where the floor itself is not aligned.
 */
function fitWindow(usage: number, room: number, floor: number): number {
	return alignUp(
		Math.max(floor, Math.max(0, usage + Math.max(0, room)) / KV_SHRINK_FILL),
	);
}

function minShrinkGain(window: number): number {
	return Math.max(
		KV_SHRINK_MIN_CELLS,
		Math.floor(window * KV_SHRINK_MIN_SHARE),
	);
}

function describePressure(pressure: OpencotiKvPressure | undefined): string {
	if (!pressure) {
		return "pressure";
	}
	const refused = pressure.refused60s;
	return refused > 0
		? `pressure: ${refused} refused in ${pressure.windowS}s`
		: "pressure";
}

/**
 * Open a turn boundary: read the pressure, find the booking, and grow it back
 * if the pressure has cleared and it is filling.
 *
 * `undefined` -- and nothing sent -- unless the server advertises both
 * `kv_pressure_v1` and `kv_resize_v1`. Called before the compaction trigger
 * sizes itself, so a window grown here is the window the trigger measures
 * against this very turn.
 */
export async function beginKvPressureTurn(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	logger?: BasicLogger;
	/**
	 * Grow back here when the pressure has cleared. Off for a manual
	 * compaction and an overflow recovery: they are shrink-only boundaries.
	 */
	grow?: boolean;
}): Promise<KvPressureTurn | undefined> {
	const config = options.providerConfig;
	if (
		!options.sessionId ||
		!config.baseUrl ||
		config.providerId === undefined ||
		normalizeProviderId(config.providerId) !== "opencoti"
	) {
		return undefined;
	}
	const props = await probeOpencotiProps(config.baseUrl, config.fetch).catch(
		() => undefined,
	);
	if (
		!hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.kvPressure) ||
		!hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.kvResize)
	) {
		return undefined;
	}
	const subject = resolveKvResizeSubject(options.sessionId, config);
	if (!subject) {
		return undefined;
	}
	const snapshot = await readPolykvKvSnapshot(options);
	const reading = latestOpencotiPressure(config.baseUrl);
	const turn: KvPressureTurn = {
		baseUrl: config.baseUrl,
		...(config.fetch ? { fetch: config.fetch } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		subject,
		state: opencotiPressureState(reading),
		...(reading ? { pressure: reading.pressure } : {}),
		...(options.logger ? { logger: options.logger } : {}),
		...(hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.kvResizeDeferred)
			? { deferred: true }
			: {}),
	};
	const row = snapshot?.allocations.find(
		(entry) => entry.sessionId === subject.engineId,
	);
	if (row) {
		turn.row = row;
	}
	await cancelStaleShrink(turn);
	if (options.grow !== false) {
		await growIfCleared(turn);
	}
	return turn;
}

/**
 * A shrink queued under pressure that has not applied by the time the
 * pressure is gone is a decision nobody would make now: ask for the current
 * window, which cancels it (`kv_resize_deferred_v1`).
 */
async function cancelStaleShrink(turn: KvPressureTurn): Promise<void> {
	const row = turn.row;
	if (
		!turn.deferred ||
		turn.state === "active" ||
		!row ||
		row.resizePending === undefined ||
		row.resizePending >= row.window
	) {
		return;
	}
	await resize(turn, row.window, "cancel");
}

/**
 * Grow back toward the window first asked for: the pressure has cleared on a
 * recent reading, and the engine says the booking is filling. On an exhausted
 * grow, once more at the `largest_admissible` it named, when that is still a
 * grow.
 */
async function growIfCleared(turn: KvPressureTurn): Promise<void> {
	const { row, subject } = turn;
	if (
		turn.state !== "clear" ||
		!row ||
		subject.ceiling === undefined ||
		row.used < row.window * KV_GROW_AT
	) {
		return;
	}
	const state = subjectState(subject.engineId);
	const ceiling = Math.min(subject.ceiling, state.growLimit ?? Infinity);
	// A booking that re-books per request takes its window from each
	// request's own `num_ctx`: there is nothing held to grow.
	if (state.perRequest || ceiling <= row.window) {
		return;
	}
	const first = await resize(turn, ceiling, "grow");
	if (
		first &&
		!first.ok &&
		first.kind === "exhausted" &&
		first.largestAdmissible !== undefined
	) {
		const smaller = alignDown(Math.min(first.largestAdmissible, ceiling));
		if (smaller > row.window) {
			await resize(turn, smaller, "grow");
		}
	}
}

/**
 * Whether this turn should compact because the SERVER is under pressure.
 *
 * All of: refusals inside the window; a floor declared and the booking above
 * it; the context meaningfully bigger than what compaction leaves; and
 * compacting lets the booking shrink by at least
 * {@link KV_PRESSURE_COMPACTION_MIN_GAIN_SHARE} of itself beyond what a plain
 * shrink would. Tokens are on the provider's count (`requestTokens`) and the
 * compacted size is put on the same scale by the caller.
 */
export function kvPressureWantsCompaction(
	turn: KvPressureTurn | undefined,
	input: {
		requestTokens: number;
		compactedTokens: number;
		outputRoomTokens: number;
	},
): boolean {
	const row = turn?.row;
	const floor = turn?.subject.floor;
	if (!turn || turn.state !== "active" || !row || floor === undefined) {
		return false;
	}
	if (row.window <= floor) {
		return false;
	}
	const { requestTokens, compactedTokens, outputRoomTokens } = input;
	if (
		!(compactedTokens > 0) ||
		requestTokens < compactedTokens * KV_PRESSURE_COMPACTION_MIN_RATIO
	) {
		return false;
	}
	// An owner is the whole swarm's booking: compacting this one agent gives
	// back what it frees of it, and no more.
	const usageNow =
		turn.subject.kind === "owner"
			? row.used
			: Math.max(row.used, requestTokens);
	const usageAfter =
		turn.subject.kind === "owner"
			? Math.max(0, row.used - (requestTokens - compactedTokens))
			: compactedTokens;
	const targetNow = Math.min(
		row.window,
		fitWindow(usageNow, outputRoomTokens, floor),
	);
	const targetAfter = fitWindow(usageAfter, outputRoomTokens, floor);
	return (
		targetAfter < row.window &&
		targetNow - targetAfter >=
			row.window * KV_PRESSURE_COMPACTION_MIN_GAIN_SHARE
	);
}

/**
 * Give cells back while the server is refusing: resize the booking down to
 * what the context needs plus room to grow, never below the floor.
 *
 * `usageTokens` is the context about to be sent. Right after a compaction it
 * is the compacted size, which the engine may not see yet -- its tree still
 * holds the old cells until the next request -- so a `used_exceeds_window`
 * then is expected, and the next boundary asks again with the engine's own
 * count. An owner is sized from its own row: its usage is every agent's.
 */
export async function shrinkForKvPressure(
	turn: KvPressureTurn | undefined,
	input: {
		usageTokens: number;
		outputRoomTokens: number;
		afterCompaction: boolean;
	},
): Promise<void> {
	const row = turn?.row;
	const floor = turn?.subject.floor;
	if (!turn || turn.state !== "active" || !row || floor === undefined) {
		return;
	}
	const usage =
		turn.subject.kind === "owner"
			? row.used
			: input.afterCompaction
				? input.usageTokens
				: Math.max(row.used, input.usageTokens);
	const target = Math.min(
		row.window,
		fitWindow(usage, input.outputRoomTokens, floor),
	);
	if (row.window - target < minShrinkGain(row.window)) {
		return;
	}
	const state = subjectState(turn.subject.engineId);
	if (state.perRequest) {
		// Released after every request already: nothing held to give back.
		return;
	}
	const answer = await resize(turn, target, "shrink");
	if (
		answer &&
		!answer.ok &&
		answer.kind === "used_exceeds_window" &&
		answer.used !== undefined
	) {
		// The engine's own floor for this booking. Once more at it, when that
		// still gives back something worth a resize.
		const atUsed = Math.min(
			row.window,
			fitWindow(answer.used, input.outputRoomTokens, floor),
		);
		if (atUsed < target || row.window - atUsed < minShrinkGain(row.window)) {
			return;
		}
		await resize(turn, atUsed, "shrink");
	}
}

/**
 * One resize, and everything the engine can answer to it. Never throws;
 * `undefined` when another boundary already has one in flight for the same
 * booking (two agents of one owner).
 */
async function resize(
	turn: KvPressureTurn,
	target: number,
	direction: "shrink" | "grow" | "cancel",
): Promise<OpencotiResizeResult | undefined> {
	const { subject } = turn;
	const state = subjectState(subject.engineId);
	if (state.inFlight) {
		return undefined;
	}
	if (turn.deferred) {
		// One target per booking, as the engine keeps it: the same decision
		// again is already queued. A different one overwrites it.
		const queued =
			turn.row?.resizePending ??
			opencotiPendingResize(turn.baseUrl, subject.engineId);
		if (queued !== undefined && queued === target) {
			return undefined;
		}
	}
	state.inFlight = true;
	let answer: OpencotiResizeResult;
	try {
		answer = await resizeOpencotiSession({
			baseUrl: turn.baseUrl,
			sessionId: subject.engineId,
			numCtx: target,
			...(turn.deferred ? { deferred: true } : {}),
			...(turn.fetch ? { fetch: turn.fetch } : {}),
			...(turn.headers ? { headers: turn.headers } : {}),
		});
	} finally {
		state.inFlight = false;
	}
	const before = turn.row?.window;
	const who = `[PolyKV] ${subject.engineId}`;
	const why =
		direction === "shrink"
			? describePressure(turn.pressure)
			: direction === "grow"
				? "pressure cleared"
				: "queued shrink cancelled: pressure cleared";
	const info = (message: string) =>
		turn.logger?.log?.(`${who}: ${message}`, { severity: "info" });
	if (answer.ok) {
		// Every reader of the booking asks again: the next `/kv` read, and the
		// window the next turn is sized against.
		clearPolykvAllocationCache();
		recordPolykvGrantedWindow(subject.grantKey, answer.windowNew);
		if (subject.kind === "owner") {
			// The owner carries as many agents as its new window holds.
			notePolykvOwnerWindow(subject.engineId, answer.windowNew);
		}
		if (turn.row) {
			const { resizePending: _applied, ...rest } = turn.row;
			turn.row = { ...rest, window: answer.windowNew };
		}
		const change = `window ${before !== undefined ? cells(before) : "?"} → ${cells(answer.windowNew)}`;
		info(
			`${change} (${why}${
				answer.cellsDelta !== undefined
					? `; ${cells(Math.abs(answer.cellsDelta))} cells ${answer.cellsDelta < 0 ? "given back" : "taken"}`
					: ""
			})`,
		);
		if (answer.cellsDelta !== 0 && answer.windowNew !== before) {
			reportPolykvNotice(subject.grantKey, {
				severity: "info",
				text: `${change} (${direction === "shrink" ? "pressure" : "pressure cleared"})`,
			});
		}
		return answer;
	}
	switch (answer.kind) {
		case "deferred":
			// Queued, not applied: the window this turn is sized against is
			// still the old one, and the next `/kv` read says when it moved.
			if (turn.row) {
				turn.row = {
					...turn.row,
					resizePending: answer.pending ?? target,
				};
			}
			info(
				`${direction} to ${cells(target)} queued for the booking's idle moment: a request is in flight on it`,
			);
			break;
		case "session_busy":
			info(
				`${direction} to ${cells(target)} waits for the next turn boundary: a request is in flight on this booking`,
			);
			break;
		case "used_exceeds_window":
			info(
				`cannot ${direction} to ${cells(target)} yet: the engine still holds ${
					answer.used !== undefined ? cells(answer.used) : "more than that"
				}; asked again at the next turn boundary`,
			);
			break;
		case "per_request_session":
			// Nothing to do, in either direction. A per-request booking is
			// released after each request, and stating a smaller `num_ctx` on
			// the next one would turn it into a HELD booking, released only by
			// close or the TTL (opencoti mail #301): the opposite of giving
			// cells back.
			state.perRequest = true;
			info("books per request: nothing is held between its requests to resize");
			break;
		case "session_not_found":
		case "session_closing":
			info(
				`no ${direction}: the engine holds no live booking under this id (${answer.kind})`,
			);
			break;
		case "invalid_num_ctx":
		case "above_session_ctx_max":
			if (direction === "grow" && before !== undefined) {
				// The engine will not book that window for this session; the
				// booking it has is where growing stops.
				state.growLimit = before;
			}
			info(
				`${direction} to ${cells(target)} refused (${answer.kind}${answer.message ? `: ${answer.message}` : ""})`,
			);
			break;
		case "exhausted":
			info(
				`the server has no room to grow to ${cells(target)}${
					answer.largestAdmissible !== undefined
						? ` (largest admissible ${cells(answer.largestAdmissible)})`
						: ""
				}`,
			);
			break;
		default:
			info(
				`${direction} to ${cells(target)} not taken (${answer.kind}${
					answer.status ? `, ${answer.status}` : ""
				}${answer.message ? `: ${answer.message}` : ""}); asked again at the next turn boundary`,
			);
	}
	return answer;
}
