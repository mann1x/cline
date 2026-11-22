// How many requests an ollama.com account runs at once, shared by everything
// that uses the account.
//
// Ollama publishes a concurrency allowance per plan (ollama.com/pricing,
// 2026-11): pay-as-you-go and Pro run 3 requests at once, Max and Team 10.
// Requests past it are queued on Ollama's side, and once that queue is full
// they are rejected. Nothing on the wire says how many are running.
//
// The allowance belongs to the account, not to a provider, a session or a
// model: the lead's turns, every delegated agent, the expert and the side calls
// (compaction, notes) all draw on it, through any Ollama or xOllama server
// signed in as that account. So the count is kept here, keyed by the account
// (`OllamaAccount.key`, from `POST /api/me`), and every cloud-model chat
// request takes a slot before it is sent and gives it back when its response
// ends. A request past the allowance waits on this side, where it can be seen
// and cancelled, instead of in Ollama's queue, where it cannot.
//
// Local models are not counted: they run on the server's own slots. Neither is
// an account whose plan this build does not know, or a server that is not
// signed in (a key-authenticated request straight to ollama.com gets no plan
// from the unsigned `/api/me`): those keep the previous behaviour.
//
// One extension host, one count. Two VS Code windows are two processes and
// count separately.
//
// An xOllama server with a pool of cloud accounts (`cloud_accounts_v1`) is
// counted as one unit instead: its allowance is the pool's `parallel_now`,
// keyed by the server, because `/api/me` there answers for the primary
// account alone (see `xollama-cloud-pool`).

import type { BasicLogger } from "@cline/shared";
import {
	looksLikeCloudName,
	type OllamaAccountStatus,
	primeOllamaAccountStatus,
	readOllamaAccountCache,
} from "./ollama-account";
import {
	describeXollamaCloudPool,
	readXollamaCloudPool,
	refreshXollamaCloudPool,
	type XollamaCloudPool,
	xollamaPoolKey,
} from "./xollama-cloud-pool";

/** Concurrent requests per plan, as Ollama publishes them. */
export const OLLAMA_PLAN_CONCURRENCY: Readonly<Record<string, number>> = {
	// A signed-in account with no subscription is pay-as-you-go; the server
	// reports it as "free" (there is no free tier any more).
	free: 3,
	payg: 3,
	"pay-as-you-go": 3,
	pay_as_you_go: 3,
	pro: 3,
	max: 10,
	team: 10,
};

/** The plan's allowance, or undefined for a plan this build does not know. */
export function ollamaPlanConcurrency(
	plan: string | undefined,
): number | undefined {
	if (!plan) return undefined;
	return OLLAMA_PLAN_CONCURRENCY[plan.trim().toLowerCase()];
}

export interface OllamaAccountCap {
	/** Opaque account key; requests with the same key share the allowance. */
	key: string;
	plan: string;
	limit: number;
	/**
	 * Set when the allowance is an xOllama server's account pool: `key` is
	 * then the server, `limit` the pool's `parallel_now` (0 when every
	 * account has run out), and `plan` reads "xOllama pool".
	 */
	pool?: XollamaCloudPool;
}

/** How a cap reads in a log line. */
export function describeOllamaAccountCap(cap: OllamaAccountCap): string {
	return cap.pool
		? describeXollamaCloudPool(cap.pool)
		: `cloud account (${cap.plan}, ${cap.limit} requests at once)`;
}

/** The account's allowance, when the server is signed in on a known plan. */
export function ollamaAccountCap(
	status: OllamaAccountStatus | undefined,
): OllamaAccountCap | undefined {
	const account = status?.account;
	if (!status?.reachable || !account?.signedIn || !account.key)
		return undefined;
	const limit = ollamaPlanConcurrency(account.plan);
	if (!limit) return undefined;
	return { key: account.key, plan: account.plan ?? "", limit };
}

/** Whether the server runs this model on ollama.com. */
export function isOllamaCloudModel(
	status: OllamaAccountStatus | undefined,
	modelId: string,
): boolean {
	const id = modelId.trim();
	const bare = id.replace(/:latest$/, "");
	const entry = status?.models.find(
		(model) => model.name === id || model.name.replace(/:latest$/, "") === bare,
	);
	return entry ? entry.cloud : looksLikeCloudName(id);
}

/** The allowance a cloud model on this server draws on, if any. */
export async function resolveOllamaAccountCap(input: {
	baseUrl: string;
	modelId: string | undefined;
	fetch?: typeof fetch;
	/** "xollama" asks the server for its account pool first. */
	providerId?: string;
}): Promise<OllamaAccountCap | undefined> {
	if (!input.modelId) return undefined;
	const [pool] = await Promise.all([
		input.providerId === "xollama"
			? readXollamaCloudPool(input.baseUrl, input.fetch ?? globalThis.fetch)
			: Promise.resolve(undefined),
		primeOllamaAccountStatus(input.baseUrl, input.fetch),
	]);
	const status = readOllamaAccountCache(input.baseUrl);
	if (!isOllamaCloudModel(status, input.modelId)) return undefined;
	if (pool) {
		return {
			key: xollamaPoolKey(input.baseUrl),
			plan: "xOllama pool",
			limit: pool.parallelNow,
			pool,
		};
	}
	return ollamaAccountCap(status);
}

class AccountSlots {
	active = 0;
	private readonly waiters: Array<{
		grant: () => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(public limit: number) {}

	get waiting(): number {
		return this.waiters.length;
	}

	/** Resolves with a release function once a slot is free. */
	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason ?? new Error("aborted"));
		}
		if (this.active < this.limit) {
			this.active += 1;
			return Promise.resolve(this.releaser());
		}
		return new Promise((resolve, reject) => {
			const waiter: (typeof this.waiters)[number] = {
				grant: () => {
					if (waiter.onAbort)
						signal?.removeEventListener("abort", waiter.onAbort);
					this.active += 1;
					resolve(this.releaser());
				},
				...(signal ? { signal } : {}),
			};
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(signal.reason ?? new Error("aborted"));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	private releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			this.drain();
		};
	}

	/** Grant waiting requests while there is room, e.g. after the limit rose. */
	drain(): void {
		while (this.active < this.limit && this.waiters.length > 0) {
			this.waiters.shift()?.grant();
		}
	}
}

const accounts = new Map<string, AccountSlots>();

function slotsFor(cap: OllamaAccountCap): AccountSlots {
	let slots = accounts.get(cap.key);
	if (!slots) {
		slots = new AccountSlots(cap.limit);
		accounts.set(cap.key, slots);
	} else if (slots.limit !== cap.limit) {
		// A plan change (an upgrade mid-session) applies to the next grant.
		slots.limit = cap.limit;
		slots.drain();
	}
	return slots;
}

/** Take one of the account's slots; resolves with its release function. */
export function acquireOllamaAccountSlot(
	cap: OllamaAccountCap,
	signal?: AbortSignal,
): Promise<() => void> {
	return slotsFor(cap).acquire(signal);
}

/** Running and waiting requests on an account, for logs and tests. */
export function ollamaAccountSlotUsage(
	key: string,
): { active: number; waiting: number; limit: number } | undefined {
	const slots = accounts.get(key);
	return slots
		? { active: slots.active, waiting: slots.waiting, limit: slots.limit }
		: undefined;
}

/** Test seam. */
export function resetOllamaAccountSlots(): void {
	accounts.clear();
}

const CHAT_PATH =
	/\/(?:api\/(?:chat|generate)|v1\/(?:chat\/completions|completions|responses|messages))\/?$/;

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return (input as Request).url;
}

function requestMethod(
	input: Parameters<typeof fetch>[0],
	init: RequestInit | undefined,
): string {
	return (
		init?.method ??
		(typeof input === "object" && "method" in input ? input.method : "GET")
	).toUpperCase();
}

function requestModel(body: unknown): string | undefined {
	if (typeof body !== "string") return undefined;
	try {
		const model = (JSON.parse(body) as { model?: unknown }).model;
		return typeof model === "string" && model.trim() ? model : undefined;
	} catch {
		return undefined;
	}
}

/** The response, with the slot released when its body ends, fails or is cancelled. */
function releaseWhenDone(
	response: Response,
	release: () => void,
	signal: AbortSignal | null | undefined,
): Response {
	if (!response.body) {
		release();
		return response;
	}
	signal?.addEventListener("abort", release, { once: true });
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					release();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		cancel(reason) {
			release();
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Count this server's cloud-model chat requests against the account's
 * allowance. Anything else (local models, probes, an unknown plan) passes
 * straight through.
 */
export function withOllamaAccountSlots(
	baseFetch: typeof fetch,
	options: {
		baseUrl: string;
		/** For the account read; the unwrapped server fetch. */
		probeFetch?: typeof fetch;
		logger?: BasicLogger;
		/** "xollama" counts against the server's account pool when it has one. */
		providerId?: string;
	},
): typeof fetch {
	return (async (input, init) => {
		if (requestMethod(input, init) !== "POST") return baseFetch(input, init);
		let path: string;
		try {
			path = new URL(requestUrl(input)).pathname;
		} catch {
			return baseFetch(input, init);
		}
		if (!CHAT_PATH.test(path)) return baseFetch(input, init);
		const cap = await resolveOllamaAccountCap({
			baseUrl: options.baseUrl,
			modelId: requestModel(init?.body),
			...(options.probeFetch ? { fetch: options.probeFetch } : {}),
			...(options.providerId ? { providerId: options.providerId } : {}),
		});
		if (!cap) return baseFetch(input, init);
		if (cap.pool && cap.limit === 0) {
			// Every account in the pool has run out, is signed out or was refused. Waiting here
			// would wait for a reading to change; the server answers at once with
			// a 402 that says when the first account is back, and that is the
			// message to show.
			options.logger?.log?.(
				`[ollama] ${describeOllamaAccountCap(cap)}: no account can take requests (each has reached its usage limit or is signed out)${
					cap.pool.nextReset
						? `; the first is back at ${cap.pool.nextReset}`
						: ""
				}`,
			);
			return afterPoolAnswer(await baseFetch(input, init), options);
		}
		const usage = ollamaAccountSlotUsage(cap.key);
		if (usage && usage.active >= usage.limit) {
			options.logger?.log?.(
				`[ollama] ${describeOllamaAccountCap(cap)}: all ${cap.limit} in use, ${
					usage.waiting + 1
				} waiting; this request starts when one finishes`,
			);
		}
		const release = await acquireOllamaAccountSlot(
			cap,
			init?.signal ?? undefined,
		);
		let response: Response;
		try {
			response = await baseFetch(input, init);
		} catch (error) {
			release();
			throw error;
		}
		if (cap.pool) afterPoolAnswer(response, options);
		return releaseWhenDone(response, release, init?.signal);
	}) as typeof fetch;
}

/**
 * A 402 or 429 from a pooled server means an account just ran out or every
 * slot was taken: read the pool again now rather than a minute from now, so
 * the next request is capped at what the server can still serve.
 */
function afterPoolAnswer(
	response: Response,
	options: { baseUrl: string; probeFetch?: typeof fetch },
): Response {
	if (response.status === 402 || response.status === 429) {
		void refreshXollamaCloudPool(
			options.baseUrl,
			options.probeFetch ?? globalThis.fetch,
		);
	}
	return response;
}
