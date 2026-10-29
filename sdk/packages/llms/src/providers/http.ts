import type { GatewayProviderSettings } from "@cline/shared";

export function ensureFetch(fetchImpl?: typeof fetch): typeof fetch {
	const resolved = fetchImpl ?? globalThis.fetch;
	if (!resolved) {
		throw new Error(
			"No fetch implementation is available. Pass one in the gateway or provider config.",
		);
	}
	return resolved;
}

/**
 * Wait for `work`, or stop waiting when `signal` aborts.
 *
 * For setup a request awaits before it is sent: a probe the server never
 * answers would otherwise hold the request past its own abort, because nothing
 * the abort reaches has been sent yet. The work itself is not cancelled; it may
 * be shared with other callers, and it keeps whatever bound it has of its own.
 */
export function untilAborted<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) {
		return work;
	}
	if (signal.aborted) {
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export async function resolveApiKey(
	settings: GatewayProviderSettings,
): Promise<string | undefined> {
	const explicitApiKey = settings.apiKey?.trim();
	if (explicitApiKey) {
		return explicitApiKey;
	}

	const resolvedApiKey = await settings.apiKeyResolver?.();
	const trimmedResolvedApiKey = resolvedApiKey?.trim();
	if (trimmedResolvedApiKey) {
		return trimmedResolvedApiKey;
	}

	for (const key of settings.apiKeyEnv ?? []) {
		const value = readEnv(key);
		if (value) {
			return value;
		}
	}

	return undefined;
}

export async function fetchJson(
	url: string,
	init: RequestInit,
	options: {
		fetch: typeof fetch;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<unknown> {
	const controller = new AbortController();
	const signal = mergeSignals(options.signal, controller.signal);
	const timeoutMs = options.timeoutMs ?? 30_000;
	const timeout =
		timeoutMs > 0
			? setTimeout(
					() => controller.abort(new Error("Request timed out")),
					timeoutMs,
				)
			: undefined;

	try {
		const response = await options.fetch(url, { ...init, signal });
		const text = await response.text();
		const payload = text ? (JSON.parse(text) as unknown) : undefined;

		if (!response.ok) {
			const message =
				typeof payload === "object" && payload && "error" in payload
					? JSON.stringify((payload as { error: unknown }).error)
					: text || `${response.status} ${response.statusText}`;
			throw new Error(`Gateway request failed: ${message}`);
		}

		return payload;
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function mergeSignals(
	first: AbortSignal | undefined,
	second: AbortSignal,
): AbortSignal {
	if (!first) {
		return second;
	}

	if (first.aborted) {
		second.throwIfAborted?.();
		return first;
	}

	const controller = new AbortController();
	const abort = (event?: Event) => {
		const target = event?.target as AbortSignal | null;
		controller.abort(target?.reason);
	};

	first.addEventListener("abort", abort, { once: true });
	second.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}

function readEnv(key: string): string | undefined {
	const env = globalThis.process?.env;
	if (!env) {
		return undefined;
	}

	const value = env[key];
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
