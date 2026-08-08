/**
 * A stall bound that asks the server before it gives up.
 *
 * Every fixed timeout on a local model is a guess about hardware. undici's
 * five-minute `bodyTimeout` is the one that keeps ending runs, but replacing it
 * with a bigger constant only moves the guess: prompt prefill at a hundred
 * thousand tokens is minutes of silence on a healthy socket, and the same
 * silence is what a crashed server looks like from the client side. The two are
 * indistinguishable from the stream alone — but not from the server, which will
 * answer a second connection in milliseconds if it is alive.
 *
 * So silence is not the failure condition here; silence *from a server that has
 * stopped answering* is. On each quiet interval this asks Ollama whether it is
 * up, and a server that answers buys the request another interval, from zero,
 * as many times as it keeps answering. What is left is a real bound — the
 * request dies when the server does, and only then.
 *
 * The interval is therefore a polling period rather than a patience budget, and
 * is set short enough to notice a dead server quickly rather than long enough
 * to outlast a slow one.
 */

import type { BasicLogger } from "@cline/shared";

/** How long a quiet stream may stay quiet before the server is asked about it. */
export const OLLAMA_STALL_PROBE_INTERVAL_MS = 30_000;

/** How long the health probe itself may take before it counts as no answer. */
export const OLLAMA_HEALTH_PROBE_TIMEOUT_MS = 10_000;

/**
 * How many probes in a row must go unanswered before the request is failed.
 *
 * More than one because a single refused connection is not yet evidence: a
 * server under a heavy generation can drop a probe, and killing a run that was
 * about to produce its first token is worse than waiting one more interval.
 */
export const OLLAMA_HEALTH_PROBE_FAILURES_BEFORE_GIVING_UP = 3;

export type OllamaHealthProbe = () => Promise<boolean>;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		// Node keeps the event loop alive for pending timers; a watchdog is not
		// a reason for a process to stay up.
		(timer as unknown as { unref?: () => void }).unref?.();
	});
}

/**
 * Ask an Ollama server whether it is alive.
 *
 * `/api/ps` rather than `/api/version` because the answer carries something
 * worth logging — whether the model this request is for is still resident. That
 * does not decide the verdict: a model evicted mid-queue will be reloaded and
 * the request still completes, so treating eviction as death would fail
 * requests that were going to succeed. It is the difference between "the
 * server is busy with us" and "the server is busy with something else", which
 * is exactly what someone reading the log after a stall wants to know.
 */
export function createOllamaHealthProbe(options: {
	url: string;
	fetch: typeof fetch;
	model?: string;
	dispatcher?: unknown;
	timeoutMs?: number;
	logger?: BasicLogger;
}): OllamaHealthProbe {
	let origin: string;
	try {
		origin = new URL(options.url).origin;
	} catch {
		// Without an origin there is nothing to ask, and a probe that cannot run
		// must not be read as a dead server.
		return async () => true;
	}
	const timeoutMs = options.timeoutMs ?? OLLAMA_HEALTH_PROBE_TIMEOUT_MS;
	return async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		(timer as unknown as { unref?: () => void }).unref?.();
		try {
			const response = await options.fetch(`${origin}/api/ps`, {
				method: "GET",
				signal: controller.signal,
				...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
			} as RequestInit);
			if (!response.ok) {
				return false;
			}
			if (options.model) {
				const loaded = await readLoadedModels(response);
				options.logger?.debug?.(
					`[ollama] health probe answered; ${
						loaded === undefined
							? "model residency unknown"
							: loaded.some((name) => name.startsWith(options.model ?? ""))
								? `${options.model} is resident`
								: `${options.model} is not resident (loaded: ${loaded.join(", ") || "none"})`
					}`,
				);
			}
			return true;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	};
}

async function readLoadedModels(
	response: Response,
): Promise<string[] | undefined> {
	try {
		const body = (await response.json()) as {
			models?: { name?: unknown; model?: unknown }[];
		};
		if (!Array.isArray(body.models)) {
			return undefined;
		}
		return body.models
			.map((entry) =>
				typeof entry.name === "string"
					? entry.name
					: typeof entry.model === "string"
						? entry.model
						: undefined,
			)
			.filter((name): name is string => name !== undefined);
	} catch {
		return undefined;
	}
}

export interface StallWatchdogOptions {
	probe: OllamaHealthProbe;
	intervalMs?: number;
	failuresBeforeGivingUp?: number;
	logger?: BasicLogger;
	/** Names the thing being watched in logs and in the failure message. */
	label: string;
}

/**
 * Run `probe` every quiet interval until something else finishes.
 *
 * Returns a stop function and calls `onDead` once, with the elapsed time, when
 * the server has failed enough probes in a row to be called dead. Restarting
 * the interval after a successful probe is the whole point: a live server
 * resets the clock rather than spending a budget.
 */
export function watchForStall(
	options: StallWatchdogOptions & { onDead: (elapsedMs: number) => void },
): { stop: () => void; noteActivity: () => void } {
	const intervalMs = options.intervalMs ?? OLLAMA_STALL_PROBE_INTERVAL_MS;
	const allowedFailures =
		options.failuresBeforeGivingUp ??
		OLLAMA_HEALTH_PROBE_FAILURES_BEFORE_GIVING_UP;
	let stopped = false;
	let quietSince = Date.now();
	let consecutiveFailures = 0;

	const run = async (): Promise<void> => {
		while (!stopped) {
			const quietFor = Date.now() - quietSince;
			if (quietFor < intervalMs) {
				await delay(intervalMs - quietFor);
				continue;
			}
			await delay(intervalMs);
			if (stopped || Date.now() - quietSince < intervalMs) {
				continue;
			}
			const healthy = await options.probe();
			if (stopped) {
				return;
			}
			if (healthy) {
				consecutiveFailures = 0;
				options.logger?.debug?.(
					`[ollama] ${options.label} quiet for ${Math.round(
						(Date.now() - quietSince) / 1000,
					)}s; server answered, still waiting`,
				);
				continue;
			}
			consecutiveFailures += 1;
			options.logger?.log(
				`[ollama] ${options.label} quiet and the server did not answer (${consecutiveFailures}/${allowedFailures})`,
				{ severity: "warn" },
			);
			if (consecutiveFailures >= allowedFailures) {
				stopped = true;
				options.onDead(Date.now() - quietSince);
				return;
			}
		}
	};
	void run();

	return {
		stop: () => {
			stopped = true;
		},
		noteActivity: () => {
			quietSince = Date.now();
			consecutiveFailures = 0;
		},
	};
}

/**
 * Wrap a streaming response so a stalled body is measured against the server
 * rather than against a stopwatch.
 *
 * The reader's pending read is kept and re-raced rather than re-issued: a
 * `ReadableStreamDefaultReader` allows one outstanding `read()`, so the timeout
 * has to lose the race without cancelling the thing it raced.
 */
export function withStallWatchdog(
	response: Response,
	options: StallWatchdogOptions,
): Response {
	if (!response.body) {
		return response;
	}
	const reader = response.body.getReader();
	let watcher: { stop: () => void; noteActivity: () => void } | undefined;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let dead: Error | undefined;
			let resolveDead: (() => void) | undefined;
			const deadPromise = new Promise<void>((resolve) => {
				resolveDead = resolve;
			});
			watcher = watchForStall({
				...options,
				onDead: (elapsedMs) => {
					dead = new Error(
						`Ollama stopped responding: no ${options.label} for ${Math.round(
							elapsedMs / 1000,
						)}s and the server failed its health checks`,
					);
					resolveDead?.();
				},
			});

			const pump = async (): Promise<void> => {
				try {
					for (;;) {
						const pending = reader.read();
						const outcome = await Promise.race([
							pending.then((value) => ({ kind: "read" as const, value })),
							deadPromise.then(() => ({ kind: "dead" as const })),
						]);
						if (outcome.kind === "dead") {
							await reader.cancel().catch(() => {});
							controller.error(dead);
							return;
						}
						if (outcome.value.done) {
							controller.close();
							return;
						}
						watcher?.noteActivity();
						controller.enqueue(outcome.value.value);
					}
				} catch (error) {
					controller.error(error);
				} finally {
					watcher?.stop();
				}
			};
			void pump();
		},
		cancel(reason) {
			watcher?.stop();
			return reader.cancel(reason);
		},
	});

	return new Response(stream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
