/**
 * Holds delegated agents to the number of requests their endpoint will serve.
 *
 * A local server queues a request that finds no free slot rather than refusing
 * it, and says nothing while it does. Spawning four sub-agents against a
 * one-slot Ollama does not run four agents: it runs one and leaves three
 * waiting, and the run reads as slow rather than blocked. The team runtime
 * already had a concurrency bound of its own (`maxConcurrentRuns`), so this
 * exists for the other path -- `spawn_agent`, which the agent loop can issue
 * several of in a single iteration, each running its sub-agent to completion
 * inline with nothing between them and the server.
 *
 * Deliberately a queue and not a refusal. The waiting has to happen somewhere;
 * doing it here means it happens once, in order, and can be said out loud,
 * rather than inside a provider's socket where nothing can see it.
 */
export interface AgentSlotGate {
	/** Runs `task` when a slot is free. Slots are released on throw too. */
	run<T>(task: () => Promise<T>): Promise<T>;
	/** How many are running now. For diagnostics; never a scheduling input. */
	active(): number;
}

/**
 * @param limit Most agents at once, or `undefined` for no gate of ours.
 *
 * `undefined` is not "unlimited": it is the caller saying something else is
 * deciding -- opencoti with PolyKV on, where admission control answers against
 * measured KV headroom and counting slots here would refuse work the server
 * would have taken.
 */
export function createAgentSlotGate(limit: number | undefined): AgentSlotGate {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
		let running = 0;
		return {
			run: async (task) => {
				running += 1;
				try {
					return await task();
				} finally {
					running -= 1;
				}
			},
			active: () => running,
		};
	}

	const bound = Math.max(1, Math.floor(limit));
	let running = 0;
	const waiting: Array<() => void> = [];

	const release = (): void => {
		// The slot is handed to the next waiter rather than freed and re-taken.
		// Freeing it first leaves a window between the release and the waiter's
		// continuation in which a fresh caller sees a free slot, takes it, and the
		// woken waiter then takes it as well -- two runners against a bound of
		// one. One waiter per release, in arrival order.
		const next = waiting.shift();
		if (next) {
			next();
			return;
		}
		running -= 1;
	};

	return {
		run: async (task) => {
			if (running >= bound) {
				await new Promise<void>((resolve) => {
					waiting.push(resolve);
				});
				// Resumed means the slot was handed over; `running` already counts it.
			} else {
				running += 1;
			}
			try {
				return await task();
			} finally {
				release();
			}
		},
		active: () => running,
	};
}
