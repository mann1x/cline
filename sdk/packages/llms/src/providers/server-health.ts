/**
 * Is a model server answering again, and wait until it is.
 *
 * Measured on pandorum's 75-agent swarm (1tmrl, build .191): the opencoti
 * server behind Node1 restarted at 05:16:25Z and was listening again ten
 * seconds later, yet its agents either ended on the restart or sat out a fixed
 * 30 s cool-off. Asking the server is the only way to know when it is back, and
 * `GET /health` is the one route every llama.cpp build, opencoti included,
 * answers without doing any work.
 *
 * What counts as back is deliberately loose, because the probe is shared by
 * every provider an agent can run on:
 *
 * - `2xx` -- up.
 * - `503` -- llama.cpp's "loading model": the process is there and not ready,
 *   which is exactly the window after a restart. Not back yet.
 * - any other status -- something answered. A server without a `/health` route
 *   (ollama's is `/`, a cloud API has none) 404s it, and a 404 from the server
 *   is proof enough that the server is there.
 * - no response at all -- not back.
 */

/** Longest a single probe may take before it counts as no answer. */
export const SERVER_HEALTH_PROBE_TIMEOUT_MS = 5_000;

/** First wait between probes; doubles on each probe that finds nothing. */
export const SERVER_HEALTH_FIRST_INTERVAL_MS = 1_000;

/**
 * Longest wait between probes. There is no overall deadline: an agent waits
 * for its server for as long as it takes, and the user's Stop is the bound.
 */
export const SERVER_HEALTH_MAX_INTERVAL_MS = 30_000;

/**
 * The server's root, from the base URL a provider is configured with.
 *
 * `/health` lives at the root, not under the OpenAI-compatible `/v1` or
 * ollama's `/api`.
 */
export function serverRoot(baseUrl: string | undefined): string | undefined {
	if (!baseUrl?.trim()) {
		return undefined;
	}
	try {
		const url = new URL(baseUrl.trim());
		return `${url.protocol}//${url.host}`;
	} catch {
		return undefined;
	}
}

/** Abort-aware sleep that resolves, never rejects, on abort. */
export function sleepUnlessAborted(
	ms: number,
	signal?: AbortSignal | null,
): Promise<void> {
	return new Promise((resolve) => {
		if (ms <= 0 || signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** One probe of `${root}/health`. See the module note for what counts. */
export async function probeServerHealth(
	root: string,
	options: {
		fetch?: typeof fetch;
		headers?: Record<string, string>;
		signal?: AbortSignal | null;
		timeoutMs?: number;
	} = {},
): Promise<boolean> {
	const doFetch = options.fetch ?? fetch;
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(),
		options.timeoutMs ?? SERVER_HEALTH_PROBE_TIMEOUT_MS,
	);
	const onAbort = () => timeout.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await doFetch(`${root.replace(/\/+$/, "")}/health`, {
			method: "GET",
			headers: options.headers ?? {},
			signal: timeout.signal,
		});
		await response.body?.cancel().catch(() => {});
		return response.status !== 503;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/** Delay before the probe after `probes` that found nothing. */
export function serverHealthBackoffMs(
	probes: number,
	first = SERVER_HEALTH_FIRST_INTERVAL_MS,
	max = SERVER_HEALTH_MAX_INTERVAL_MS,
): number {
	return Math.min(max, first * 2 ** Math.max(0, probes));
}

/**
 * Wait until the server at `root` answers, probing with exponential backoff
 * capped at {@link SERVER_HEALTH_MAX_INTERVAL_MS}. No overall deadline.
 *
 * Resolves `true` when it answered, `false` when `signal` aborted first.
 */
export async function waitForServerHealth(
	root: string,
	options: {
		fetch?: typeof fetch;
		headers?: Record<string, string>;
		signal?: AbortSignal | null;
		/** Called before each probe, with how many came before it. */
		onProbe?: (probes: number) => void;
		/** Seam for tests. */
		sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
		/** Seam for tests. */
		probe?: (root: string) => Promise<boolean>;
	} = {},
): Promise<boolean> {
	const sleep = options.sleep ?? sleepUnlessAborted;
	const probe =
		options.probe ??
		((target: string) =>
			probeServerHealth(target, {
				...(options.fetch ? { fetch: options.fetch } : {}),
				...(options.headers ? { headers: options.headers } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			}));
	for (let probes = 0; ; probes += 1) {
		if (options.signal?.aborted) {
			return false;
		}
		options.onProbe?.(probes);
		if (await probe(root)) {
			return !options.signal?.aborted;
		}
		await sleep(serverHealthBackoffMs(probes), options.signal);
	}
}
