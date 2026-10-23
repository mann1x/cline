// What an Ollama account has left on ollama.com, and what it has used.
//
// Two endpoints, proxied by the local server since Ollama 0.40.6 (upstream
// f86460153) and signed there with the host's own key, so reading them costs
// this client no credential:
//
// - `GET /api/balance` -- the plan's included allowance and any purchased
//   credit. A legacy plan (session and weekly limits) answers with
//   `included.session` / `included.weekly` as `remaining_percent` and
//   `resets_at`; a current plan with `included.balance_usd` and
//   `allowance_usd` over a monthly `period`.
// - `GET /api/usage?range=24h|7d|30d` -- request counts over the range, and on
//   a current plan its cost and tokens too. A legacy plan reports the count
//   alone, so the rest is optional and never rendered as zero.
//
// Until these were proxied the only way to know an account had reached its
// limit was a request refused for it (PLANS §7m): a usage bar would have meant
// signing with the user's private key from inside the extension.
//
// **Rate limit.** `/api/balance` allows 10 requests a minute per user, shared
// across API keys and devices, and the docs ask for one poll a minute. Every
// caller in this process shares one cache per server: nothing is read more
// than once a minute however many panels ask, the 7d and 30d ranges only every
// five (they barely move, and several VS Code windows each polling four
// endpoints a minute would pass the limit on their own), and a 429 holds the
// last answer until its `Retry-After` has passed.

/** One of the limits a legacy plan resets on a schedule. */
export interface OllamaCloudLimit {
	/** 0 to 100; 75 means three quarters is left. */
	readonly remainingPercent: number;
	/** UTC, ISO 8601. */
	readonly resetsAt?: string;
}

export interface OllamaCloudBalance {
	/** Current plans: what is left of the included allowance this period. */
	readonly includedBalanceUsd?: number;
	readonly includedAllowanceUsd?: number;
	/** When the included period resets. UTC, exclusive. */
	readonly periodUntil?: string;
	/** Legacy plans. */
	readonly session?: OllamaCloudLimit;
	readonly weekly?: OllamaCloudLimit;
	/** Unexpired purchased credit. */
	readonly purchasedBalanceUsd?: number;
}

export type OllamaUsageRange = "24h" | "7d" | "30d";

export const OLLAMA_USAGE_RANGES: readonly OllamaUsageRange[] = [
	"24h",
	"7d",
	"30d",
];

/** One range's totals. Only the request count is on every plan. */
export interface OllamaUsageTotals {
	readonly range: OllamaUsageRange;
	readonly requestCount: number;
	readonly usageUsd?: number;
	readonly inputTokens?: number;
	readonly cachedInputTokens?: number;
	readonly outputTokens?: number;
}

/**
 * - `ok`: the balance was read; usage may still be missing a range.
 * - `signed-out`: the server is not signed in to ollama.com (401).
 * - `cloud-disabled`: cloud features are off on that server (403).
 * - `unsupported`: the server predates the proxy (404) -- before 0.40.6.
 * - `rate-limited`: refused with 429 before anything was ever read.
 * - `unreachable`: no answer, or an answer that was not one of the above.
 */
export type OllamaCloudUsageState =
	| "ok"
	| "signed-out"
	| "cloud-disabled"
	| "unsupported"
	| "rate-limited"
	| "unreachable";

export interface OllamaCloudUsage {
	readonly state: OllamaCloudUsageState;
	readonly signinUrl?: string;
	readonly balance?: OllamaCloudBalance;
	/** In {@link OLLAMA_USAGE_RANGES} order, the ranges that were read. */
	readonly usage: readonly OllamaUsageTotals[];
	/** When the balance was last read. */
	readonly readAt?: string;
	/**
	 * Whether the included allowance is used up: a legacy limit at 0%, or a
	 * current plan's included balance at $0. Purchased credit is reported
	 * beside it and not folded in -- whether it pays for requests past the
	 * limit depends on the plan, and this client does not know.
	 */
	readonly includedExhausted: boolean;
}

/** Shortest gap between two reads of the balance and the 24h range. */
export const OLLAMA_USAGE_POLL_MS = 60_000;
/** Shortest gap between two reads of the 7d and 30d ranges. */
export const OLLAMA_USAGE_LONG_RANGE_POLL_MS = 5 * 60_000;
/** Used for a 429 that carried no usable `Retry-After`. */
const DEFAULT_RETRY_MS = 60_000;

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function count(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	return parsed !== undefined && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: undefined;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function parseLimit(value: unknown): OllamaCloudLimit | undefined {
	const body = record(value);
	const remaining = finiteNumber(body.remaining_percent);
	if (remaining === undefined) {
		return undefined;
	}
	const resetsAt = nonEmptyString(body.resets_at);
	return {
		remainingPercent: Math.min(100, Math.max(0, remaining)),
		...(resetsAt ? { resetsAt } : {}),
	};
}

/** Read `GET /api/balance`, either plan shape. */
export function parseOllamaBalance(payload: unknown): OllamaCloudBalance {
	const body = record(payload);
	const included = record(body.included);
	const purchased = record(body.purchased);
	const period = record(included.period);
	const includedBalanceUsd = finiteNumber(included.balance_usd);
	const includedAllowanceUsd = finiteNumber(included.allowance_usd);
	const periodUntil = nonEmptyString(period.until);
	const session = parseLimit(included.session);
	const weekly = parseLimit(included.weekly);
	const purchasedBalanceUsd = finiteNumber(purchased.balance_usd);
	return {
		...(includedBalanceUsd !== undefined ? { includedBalanceUsd } : {}),
		...(includedAllowanceUsd !== undefined ? { includedAllowanceUsd } : {}),
		...(periodUntil ? { periodUntil } : {}),
		...(session ? { session } : {}),
		...(weekly ? { weekly } : {}),
		...(purchasedBalanceUsd !== undefined ? { purchasedBalanceUsd } : {}),
	};
}

/** Read the `totals` of `GET /api/usage`. The buckets are not kept. */
export function parseOllamaUsageTotals(
	range: OllamaUsageRange,
	payload: unknown,
): OllamaUsageTotals | undefined {
	const totals = record(record(payload).totals);
	const requestCount = count(totals.request_count);
	if (requestCount === undefined) {
		return undefined;
	}
	const usageUsd = finiteNumber(totals.usage_usd);
	const inputTokens = count(totals.input_tokens);
	const cachedInputTokens = count(totals.cached_input_tokens);
	const outputTokens = count(totals.output_tokens);
	return {
		range,
		requestCount,
		...(usageUsd !== undefined ? { usageUsd } : {}),
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
	};
}

/** Whether the included allowance is spent, on either plan shape. */
export function includedAllowanceExhausted(
	balance: OllamaCloudBalance | undefined,
): boolean {
	if (!balance) {
		return false;
	}
	if (
		(balance.session && balance.session.remainingPercent <= 0) ||
		(balance.weekly && balance.weekly.remainingPercent <= 0)
	) {
		return true;
	}
	return (
		balance.includedBalanceUsd !== undefined && balance.includedBalanceUsd <= 0
	);
}

/** `Retry-After` in seconds or as an HTTP date, as milliseconds from now. */
function retryAfterMs(header: string | null, nowMs: number): number {
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return seconds * 1000;
		}
		const at = Date.parse(header);
		if (Number.isFinite(at) && at > nowMs) {
			return at - nowMs;
		}
	}
	return DEFAULT_RETRY_MS;
}

function apiRoot(baseUrl: string): string {
	return `${baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/(?:v1|api)$/, "")}/api`;
}

interface Answer {
	readonly status: number;
	readonly body: unknown;
	readonly retryAfter: string | null;
}

async function get(
	doFetch: typeof fetch,
	url: string,
): Promise<Answer | undefined> {
	try {
		const response = await doFetch(url, { method: "GET" });
		const text = await response.text();
		let body: unknown = {};
		try {
			body = text === "" ? {} : JSON.parse(text);
		} catch {
			// A proxy's HTML error page is still a status worth reading.
		}
		return {
			status: response.status,
			body,
			retryAfter: response.headers.get("retry-after"),
		};
	} catch {
		return undefined;
	}
}

interface CacheEntry {
	value?: OllamaCloudUsage;
	balanceReadAtMs?: number;
	/** Per range, when it was last read. */
	rangeReadAtMs: Map<OllamaUsageRange, number>;
	usage: Map<OllamaUsageRange, OllamaUsageTotals>;
	/** Nothing is asked before this, after a 429. */
	retryAtMs?: number;
	inflight?: Promise<OllamaCloudUsage>;
}

const cache = new Map<string, CacheEntry>();

/** Test seam. */
export function resetOllamaCloudUsage(): void {
	cache.clear();
}

function rangeDue(
	entry: CacheEntry,
	range: OllamaUsageRange,
	nowMs: number,
): boolean {
	const at = entry.rangeReadAtMs.get(range);
	const gap =
		range === "24h" ? OLLAMA_USAGE_POLL_MS : OLLAMA_USAGE_LONG_RANGE_POLL_MS;
	return at === undefined || nowMs - at >= gap;
}

function stateFor(status: number): OllamaCloudUsageState {
	switch (status) {
		case 401:
			return "signed-out";
		case 403:
			return "cloud-disabled";
		case 404:
		case 405:
			return "unsupported";
		case 429:
			return "rate-limited";
		default:
			return "unreachable";
	}
}

async function refresh(
	root: string,
	entry: CacheEntry,
	doFetch: typeof fetch,
	nowMs: number,
): Promise<OllamaCloudUsage> {
	const ranges = OLLAMA_USAGE_RANGES.filter((range) =>
		rangeDue(entry, range, nowMs),
	);
	const [balance, ...answers] = await Promise.all([
		get(doFetch, `${root}/balance`),
		...ranges.map((range) => get(doFetch, `${root}/usage?range=${range}`)),
	]);

	let limited: Answer | undefined;
	for (const [index, answer] of answers.entries()) {
		const range = ranges[index] as OllamaUsageRange;
		if (answer?.status === 429) {
			limited = answer;
			continue;
		}
		const totals =
			answer?.status === 200
				? parseOllamaUsageTotals(range, answer.body)
				: undefined;
		if (totals) {
			entry.usage.set(range, totals);
			entry.rangeReadAtMs.set(range, nowMs);
		}
	}
	if (balance?.status === 429) {
		limited = balance;
	}
	if (limited) {
		entry.retryAtMs = nowMs + retryAfterMs(limited.retryAfter, nowMs);
	}

	const usage = OLLAMA_USAGE_RANGES.map((range) =>
		entry.usage.get(range),
	).filter((totals): totals is OllamaUsageTotals => totals !== undefined);

	if (balance?.status === 200) {
		const parsed = parseOllamaBalance(balance.body);
		entry.balanceReadAtMs = nowMs;
		entry.value = {
			state: "ok",
			balance: parsed,
			usage,
			readAt: new Date(nowMs).toISOString(),
			includedExhausted: includedAllowanceExhausted(parsed),
		};
		return entry.value;
	}

	// A refusal of the balance alone is not a new verdict on the account when
	// the last read succeeded: a 429 or a dropped connection keeps what is
	// known, with the ranges that did come back folded in.
	if (
		entry.value?.state === "ok" &&
		(balance === undefined || balance.status === 429 || balance.status >= 500)
	) {
		entry.value = { ...entry.value, usage };
		return entry.value;
	}

	const state = balance ? stateFor(balance.status) : "unreachable";
	const signinUrl =
		state === "signed-out"
			? nonEmptyString(record(balance?.body).signin_url)
			: undefined;
	// A server that answered at all is asked again on the ordinary cadence;
	// the balance's own timestamp is what spaces the next read.
	entry.balanceReadAtMs = nowMs;
	entry.usage.clear();
	entry.rangeReadAtMs.clear();
	entry.value = {
		state,
		...(signinUrl ? { signinUrl } : {}),
		usage: [],
		includedExhausted: false,
	};
	return entry.value;
}

/**
 * The account's balance and usage through an Ollama or xOllama server.
 *
 * Never throws and never reads more often than {@link OLLAMA_USAGE_POLL_MS}:
 * inside that window, or while a 429 is being waited out, it answers from the
 * last read, and callers that ask at the same moment share one read.
 */
export async function readOllamaCloudUsage(
	baseUrl: string | undefined,
	options: { fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<OllamaCloudUsage> {
	if (!baseUrl?.trim()) {
		return { state: "unreachable", usage: [], includedExhausted: false };
	}
	const root = apiRoot(baseUrl);
	const nowMs = options.nowMs ?? Date.now();
	let entry = cache.get(root);
	if (!entry) {
		entry = { rangeReadAtMs: new Map(), usage: new Map() };
		cache.set(root, entry);
	}
	if (entry.inflight) {
		return entry.inflight;
	}
	const waiting = entry.retryAtMs !== undefined && nowMs < entry.retryAtMs;
	const fresh =
		entry.balanceReadAtMs !== undefined &&
		nowMs - entry.balanceReadAtMs < OLLAMA_USAGE_POLL_MS;
	if (waiting || fresh) {
		return (
			entry.value ?? {
				state: "rate-limited",
				usage: [],
				includedExhausted: false,
			}
		);
	}
	const current = entry;
	current.inflight = refresh(
		root,
		current,
		options.fetchImpl ?? fetch,
		nowMs,
	).finally(() => {
		current.inflight = undefined;
	});
	return current.inflight;
}
