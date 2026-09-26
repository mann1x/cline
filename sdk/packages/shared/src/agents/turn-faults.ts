/**
 * A turn that failed for a reason outside the model and outside the task.
 *
 * Measured on pandorum's 75-agent swarm (session 1tmrl, build .191): 41 of 75
 * agents ended in infrastructure errors, none of them the agent's fault. The
 * opencoti server behind Node1 restarted twice and every stream open on it
 * ended `server is shutting down`; the admission gate refused turns with
 * `projected mean tps below floor`; and each of those became the agent's final
 * result. Ruled after that run: an agent is meant to complete its job, so a
 * fault like these is retried, never reported as the agent's answer.
 *
 * Two kinds, because they are waited out differently:
 *
 * - `transport` -- nothing, or nothing of the server, answered: a refused or
 *   reset connection, a 502/503/504 from the gateway in front of it, or the
 *   server ending the stream because it is going down. Waited out by asking the
 *   server whether it is back.
 * - `refusal` -- the server answered and declined to run the turn now: an
 *   admission refusal or a rate limit. Waited out by backing off.
 *
 * Deliberately narrow. A failure that is the model's or the request's -- a bad
 * tool call, a context overflow, a 400, an auth error -- is neither, and still
 * ends the run the way it always did: re-sending those only fails again.
 *
 * Read from the flattened message because that is what reaches the agent loop
 * (the provider layer keeps only the text and its class), plus the error
 * object's own code and cause chain when a thrown error is in hand.
 */
import type { ProviderErrorClass } from "../agent";

export type TurnFaultKind = "transport" | "refusal";

/**
 * Transport messages, anchored on the phrases the runtimes and servers use.
 *
 * Kept to phrases no model output would carry as the whole error: they are
 * matched against the provider's error text, never against assistant content.
 */
const TRANSPORT_PATTERNS: readonly RegExp[] = [
	// llama.cpp / opencoti, on every stream open when it is stopped.
	/\bserver is shutting down\b/i,
	// llama.cpp answers 503 while a restarted server is still loading.
	/^(?:error:\s*)?(?:503\s*)?loading model\b/i,
	/\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_CLOSED)\b/,
	/\bsocket hang up\b/i,
	/\bother side closed\b/i,
	/\bsocket (?:was )?closed\b/i,
	/\bpremature close\b/i,
	/\bcannot connect to api\b/i,
	/^fetch failed$/i,
	/^terminated$/i,
	/^(?:network|connection) (?:error|failure|lost|reset)$/i,
	/^(?:(?:error:\s*)?(?:502|503|504)\s*)?(?:bad gateway|service unavailable|gateway time-?out)$/i,
	/^no healthy upstream$/i,
	// llama.cpp / opencoti: llama_decode failed the shared batch. Every slot
	// decoding in it gets this, whatever its own request was -- measured on
	// b108, where one slot's rebase left its positions inconsistent and 47
	// requests across the swarm ended on it. The request is not at fault; a
	// new one is prefilled afresh.
	/^(?:error:\s*)?(?:500\s*)?invalid input batch\.?$/i,
	// opencoti's speculative verification threw because a KV-full decode had
	// halved the batch under it (bug-3655). The server's fault, per batch;
	// 4 agents of swarm 0926 ended on it.
	/^(?:error:\s*)?got exception: speculative batch index \d+ is not inside the current sub-batch\b/i,
	// The stream arrived and could not be read: a provider chunk the AI SDK's
	// schema rejects (`TypeValidationError`) or that is not JSON
	// (`JSONParseError`). Nothing the model chose -- the bytes on the wire
	// are wrong -- and a new request is a new stream. Measured in 4.100.195:
	// opencoti's keepalive stream opened with `data: null`, "Type validation
	// failed: Value: null", and 48 of 75 agents ended on it as a task failure.
	// Anchored at the start: a tool's own input validation is worded
	// "Invalid input for tool ...: Type validation failed ..." and stays the
	// model's.
	/^(?:error:\s*)?(?:AI_TypeValidationError:\s*)?type validation failed\b[^:\n]*: value:/i,
	/^(?:error:\s*)?(?:AI_JSONParseError:\s*)?json parsing failed: text:/i,
];

/** HTTP statuses that mean the thing behind the gateway did not answer. */
const TRANSPORT_STATUSES = new Set([502, 503, 504]);

/**
 * The `error_kind` opencoti puts on the partial eviction's 500, top-level in
 * the error object beside `message` (`kv_observable_v1`, patch 0399).
 */
export const KV_EVICTED_ERROR_KIND = "evicted_kv_full";

/**
 * The partial eviction's text, for engines older than `kv_observable_v1`
 * that name no `error_kind`.
 */
const KV_EVICTION_PATTERN =
	/^(?:error:\s*)?evicted to keep other in-flight requests alive\b/i;

/**
 * Whether a failed turn was the engine evicting this request's sequence.
 *
 * Keyed on the provider layer's class (from `error_kind`, where the engine
 * sends it) and on the text for engines that do not. Every eviction is an
 * engine bug -- no session is meant to be evicted -- so the caller reports
 * it as one, on top of retrying it as a refusal.
 */
export function isKvEviction(
	message: string | undefined,
	errorClass?: ProviderErrorClass,
): boolean {
	return (
		errorClass === "kv_evicted" ||
		KV_EVICTION_PATTERN.test((message ?? "").trim())
	);
}

/**
 * Whether a thrown error is the eviction: its `error_kind`, on the error, its
 * `error` body, its response body or data, or anywhere down its cause chain;
 * else its message.
 */
export function isKvEvictionError(error: unknown, depth = 0): boolean {
	if (depth > 5 || error === null || error === undefined) {
		return false;
	}
	if (typeof error === "string") {
		const text = error.trim();
		if (KV_EVICTION_PATTERN.test(text)) {
			return true;
		}
		if (!text.startsWith("{")) {
			return false;
		}
		try {
			return isKvEvictionError(JSON.parse(text), depth + 1);
		} catch {
			return false;
		}
	}
	if (typeof error !== "object") {
		return false;
	}
	const record = error as Record<string, unknown>;
	if (record.error_kind === KV_EVICTED_ERROR_KIND) {
		return true;
	}
	for (const key of ["error", "responseBody", "data", "cause", "message"]) {
		const nested = record[key];
		if (nested !== undefined && nested !== error) {
			if (isKvEvictionError(nested, depth + 1)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Admission refusals. The engine's own words; any of them means "not now",
 * and none of them says anything about the request being wrong.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
	/projected mean tps below floor/i,
	/context allocation exhausted/i,
	/session allocation full/i,
	/admission (?:rejected|refused)/i,
	/\btoo many requests\b/i,
	// opencoti's partial eviction (patch 0233): the node's KV could not fit
	// another token, so it evicted the largest live sequence to keep the
	// others. It says "Context size has been exceeded" but the agent's own
	// window was not -- victims in swarm 0926 held 20-31k of 64k. No room
	// now, like an admission refusal: back off and send again.
	KV_EVICTION_PATTERN,
];

/** Classify a failed turn from what the agent loop was told about it. */
export function classifyTurnFault(
	message: string | undefined,
	errorClass?: ProviderErrorClass,
): TurnFaultKind | undefined {
	const text = (message ?? "").trim();
	// A refusal is checked first: opencoti c7 words an admission refusal as a
	// 429 whose body says `503`, which the status alone would read as a
	// gateway fault.
	if (
		errorClass === "rate_limited" ||
		errorClass === "kv_evicted" ||
		REFUSAL_PATTERNS.some((pattern) => pattern.test(text))
	) {
		return "refusal";
	}
	if (text && TRANSPORT_PATTERNS.some((pattern) => pattern.test(text))) {
		return "transport";
	}
	return undefined;
}

function codeOf(value: object): string | undefined {
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function statusOf(value: object): number | undefined {
	const status =
		(value as { status?: unknown }).status ??
		(value as { statusCode?: unknown }).statusCode;
	return typeof status === "number" ? status : undefined;
}

/**
 * Classify a thrown error, walking its code, status and cause chain.
 *
 * The chain is where undici puts the real reason: `fetch failed` on the outside,
 * `ECONNREFUSED` on the cause.
 */
export function classifyTurnFaultError(
	error: unknown,
	depth = 0,
): TurnFaultKind | undefined {
	if (depth > 5 || error === null || error === undefined) {
		return undefined;
	}
	if (typeof error === "string") {
		return classifyTurnFault(error);
	}
	if (typeof error !== "object") {
		return undefined;
	}
	const status = statusOf(error);
	// The eviction is a 500, which says nothing by itself: its `error_kind`
	// does (`kv_observable_v1`).
	if (status === 429 || isKvEvictionError(error, depth)) {
		return "refusal";
	}
	const message = (error as { message?: unknown }).message;
	const fromMessage =
		typeof message === "string" ? classifyTurnFault(message) : undefined;
	if (fromMessage === "refusal") {
		return fromMessage;
	}
	const code = codeOf(error);
	if (code && classifyTurnFault(code) === "transport") {
		return "transport";
	}
	if (status !== undefined && TRANSPORT_STATUSES.has(status)) {
		return "transport";
	}
	if (fromMessage) {
		return fromMessage;
	}
	return classifyTurnFaultError(
		(error as { cause?: unknown }).cause,
		depth + 1,
	);
}

/** One failed turn, as the agent loop hands it to its recovery. */
export interface TurnFault {
	kind: TurnFaultKind;
	/** The provider's error text. */
	message: string;
	/** Consecutive faults on this turn, from 1. */
	attempt: number;
	/** The run's iteration the fault happened on. */
	iteration: number;
	/** The run's abort signal: the user's Stop. Every wait must honour it. */
	signal?: AbortSignal;
	/**
	 * The engine evicted the turn's sequence ({@link isKvEviction}). Waited
	 * out as a refusal, and reported as the engine bug it is.
	 */
	evicted?: boolean;
	/**
	 * The session's context when it was evicted: the last request that
	 * completed, prompt and reply -- what the engine held for it at the least.
	 * Absent when no request of this run has completed.
	 */
	tokensHeld?: number;
	/** The session the turn belongs to, when the loop knows it. */
	sessionId?: string;
}

/**
 * Wait out a fault and say whether the turn should be sent again.
 *
 * Resolving `true` re-runs the same turn -- an aborted turn committed nothing,
 * so replaying it is correct. `false` lets the failure end the run as before.
 */
export type TurnFaultRecovery = (fault: TurnFault) => Promise<boolean>;
