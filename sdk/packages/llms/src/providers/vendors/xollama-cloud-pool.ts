// An xOllama server's pool of Ollama Cloud accounts.
//
// An xOllama build with `cloud_accounts_v1` can serve cloud models through up
// to 25 ollama.com accounts besides its primary, `accounts_at_once` of them
// taking requests at the same time (xollama plans/cloud-accounts.md,
// 2026-11-22). `/api/me` still answers for the primary account only, so the
// per-account cap in `ollama-account-slots` would stop at that one plan's
// allowance -- 3 on Pro -- while the server serves e.g. 9. When a pool is
// configured the server is the unit that has an allowance, and
// `GET /api/xollama/cloud` says how big it is:
//
//   {"accounts":4,"accounts_at_once":3,"parallel":9,"parallel_now":9,
//    "in_use":2,"queued":0,"exhausted":1,"next_reset":"2026-11-23T00:00:00Z",
//    "pool":[...]}
//
// `parallel_now` leaves out the accounts that ran out (402) or whose key
// ollama.com refused, so it is the number to cap at. `{"accounts":0}` is a
// server with no pool: the per-account cap stays. The route sits behind the
// server's local API key when one is set, so it is read with the provider's
// authenticated fetch.
//
// Over the cap costs latency, not errors: the server queues a request that
// finds every slot taken. The cap here keeps the wait on this side, where it
// can be seen and cancelled, as for a single account.

import { OLLAMA_METADATA_TIMEOUT_MS } from "./ollama-account";
import { probeXollama, xollamaOrigin } from "./xollama";

export const XOLLAMA_CLOUD_ACCOUNTS_FEATURE = "cloud_accounts_v1";

/** How long a pool reading stands before it is read again. */
export const XOLLAMA_CLOUD_POOL_TTL_MS = 60_000;

export interface XollamaCloudPool {
	/**
	 * Accounts configured on the server, whatever their state (a signed-out
	 * one counts here and adds nothing to `parallelNow`). Always > 0 here.
	 */
	accounts: number;
	/** How many of them take requests at the same time. */
	accountsAtOnce: number;
	/** Requests the configuration allows at once. */
	parallel: number;
	/** Requests allowed at once now: exhausted or refused accounts left out. */
	parallelNow: number;
	exhausted: number;
	/** When the first exhausted account is back, as the server wrote it. */
	nextReset?: string;
}

interface CacheEntry {
	readAt: number;
	pool: XollamaCloudPool | undefined;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<XollamaCloudPool | undefined>>();

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;
}

/** The route's answer, or undefined for a server with no pool. */
export function parseXollamaCloudPool(
	body: unknown,
): XollamaCloudPool | undefined {
	if (!body || typeof body !== "object") return undefined;
	const raw = body as Record<string, unknown>;
	const accounts = count(raw.accounts);
	if (!accounts) return undefined;
	const parallel = count(raw.parallel) ?? 0;
	const parallelNow = count(raw.parallel_now) ?? parallel;
	return {
		accounts,
		accountsAtOnce: count(raw.accounts_at_once) ?? accounts,
		parallel,
		parallelNow,
		exhausted: count(raw.exhausted) ?? 0,
		...(typeof raw.next_reset === "string" && raw.next_reset
			? { nextReset: raw.next_reset }
			: {}),
	};
}

async function readPool(
	origin: string,
	fetchImpl: typeof fetch,
): Promise<XollamaCloudPool | undefined> {
	const info = await probeXollama(origin, fetchImpl);
	if (!info?.features.includes(XOLLAMA_CLOUD_ACCOUNTS_FEATURE)) {
		return undefined;
	}
	const response = await fetchImpl(`${origin}/api/xollama/cloud`, {
		signal: AbortSignal.timeout(OLLAMA_METADATA_TIMEOUT_MS),
	});
	if (!response.ok) {
		// 401 without the local key, or a server that dropped the route: the
		// per-account cap is the safe reading.
		return undefined;
	}
	return parseXollamaCloudPool(await response.json());
}

function refresh(
	origin: string,
	fetchImpl: typeof fetch,
): Promise<XollamaCloudPool | undefined> {
	const pending = inFlight.get(origin);
	if (pending) return pending;
	const read = readPool(origin, fetchImpl)
		.catch(() => undefined)
		.then((pool) => {
			cache.set(origin, { readAt: Date.now(), pool });
			return pool;
		})
		.finally(() => inFlight.delete(origin));
	inFlight.set(origin, read);
	return read;
}

/**
 * The server's cloud account pool, or undefined when it has none (or is not
 * an xOllama with the feature). Read once, then again when the reading is a
 * minute old: a stale reading is answered at once and refreshed behind it, so
 * a request never waits on the re-read.
 */
export async function readXollamaCloudPool(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
): Promise<XollamaCloudPool | undefined> {
	const origin = xollamaOrigin(baseUrl);
	const cached = cache.get(origin);
	if (!cached) return refresh(origin, fetchImpl);
	if (Date.now() - cached.readAt >= XOLLAMA_CLOUD_POOL_TTL_MS) {
		void refresh(origin, fetchImpl);
	}
	return cached.pool;
}

/**
 * Read the pool again now, after a 402 or 429: an account just ran out or was
 * refused, and `parallel_now` has likely moved.
 */
export function refreshXollamaCloudPool(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
): Promise<XollamaCloudPool | undefined> {
	return refresh(xollamaOrigin(baseUrl), fetchImpl);
}

/** The pool's slot key: one count per server, whatever account serves it. */
export function xollamaPoolKey(baseUrl: string | undefined): string {
	return `xollama:${xollamaOrigin(baseUrl)}`;
}

/**
 * How the pool reads in a log line. `accounts` counts every configured
 * account, signed out ones included, and an omitted `accounts_at_once` means
 * all of them, so "N at once" is said only when it is fewer.
 */
export function describeXollamaCloudPool(pool: XollamaCloudPool): string {
	const atOnce =
		pool.accountsAtOnce < pool.accounts
			? `, ${pool.accountsAtOnce} at once`
			: "";
	return `xOllama pool of ${pool.accounts} Ollama Cloud account(s)${atOnce}`;
}

/** Test seam. */
export function resetXollamaCloudPools(): void {
	cache.clear();
	inFlight.clear();
}
