/**
 * The one sleep the retry middlewares wait on.
 *
 * Abort-aware, and it *resolves* on abort rather than throwing: a cancelled
 * backoff is not itself an error, and the caller is in a better position to
 * decide what to surface -- the user's abort reason, or the failure that put it
 * into the backoff in the first place. Every caller checks the signal again on
 * the other side for exactly that reason.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
