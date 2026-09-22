/**
 * A worker refused because the lead's window is full, which is a wait.
 *
 * Pooled workers are charged against the session that owns the pool -- that is
 * what makes them cost no allocation of their own -- so the lead's window, not
 * the server's cells, is what bounds how many can run at once. When the tree
 * fills it the engine refuses the next one:
 *
 *     admission rejected: session allocation full (worker of '<session>':
 *     39653 of 65536 cells free, needs 40252) — compact the session
 *
 * Measured live on 8240, 2026-09-22: four workers of ~10k prompt each under a
 * 65,536-token lead already holding 22k, and the fifth and sixth were refused.
 * The room appears again the moment a running worker finishes, so this is a
 * queueing condition wearing an error's clothes -- the same shape as the 429
 * the admission gate answers with, and treated the same way.
 *
 * Every other failure is the worker's own and travels untouched.
 */

const SESSION_ALLOCATION_FULL = /session allocation full/i;

export function isSessionAllocationFull(error: unknown): boolean {
	if (!error) {
		return false;
	}
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return SESSION_ALLOCATION_FULL.test(message);
}

export interface SessionFullRetryOptions {
	/** Runs in total, the first included. */
	attempts?: number;
	/** Seam for tests; real waits are seconds, which is the right scale here. */
	sleep?: (ms: number) => Promise<void>;
	onRetry?: (attempt: number, waitMs: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export async function retryWhileSessionFull<T>(
	run: () => Promise<T>,
	options: SessionFullRetryOptions = {},
): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? 3);
	const sleep = options.sleep ?? defaultSleep;
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await run();
		} catch (error) {
			if (!isSessionAllocationFull(error) || attempt >= attempts) {
				// The engine's own message names the session, the cells and the
				// remedy. Nothing here can say it better.
				throw error;
			}
			// Doubling from two seconds: the room is freed by a worker
			// finishing, so the wait is on the scale of a turn, not a frame.
			const waitMs = 2000 * 2 ** (attempt - 1);
			options.onRetry?.(attempt, waitMs);
			await sleep(waitMs);
		}
	}
}
