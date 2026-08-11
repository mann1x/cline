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

/**
 * The endpoint two agents share, or do not.
 *
 * Provider and base URL together, because a provider id alone says nothing
 * about which server: two profiles both naming `ollama` may point at a machine
 * each. Lower-cased, and the trailing slash dropped, so a base URL that differs
 * only in those is one endpoint rather than two.
 */
export function agentEndpointKey(connection: {
	providerId?: string;
	baseUrl?: string;
}): string {
	const provider = (connection.providerId ?? "").toLowerCase();
	const base = (connection.baseUrl ?? "").toLowerCase().replace(/\/+$/, "");
	return `${provider} ${base}`;
}

/**
 * A gate per endpoint, from one bound.
 *
 * The single gate above was written when every delegated agent ran on the
 * session's connection, and its own comment says so -- "they all read this
 * provider". That stopped being true when a configured agent gained
 * `providerId`, and again when it gained `profile:`. Agents on a cloud
 * provider and agents on a local one would otherwise contend for the same
 * slots, so a one-slot Ollama serialises work that was never going near it.
 *
 * The bound is applied per endpoint rather than shared because that is what it
 * measures: how many requests *that server* will serve at once. The number is
 * still the one measured for the session's endpoint, because it is the only
 * one the host has -- conservative in the right direction, since it never
 * over-subscribes a server and a second provider gets its own queue rather
 * than a share of somebody else's.
 */
export interface AgentSlotGateRegistry {
	/** The gate for one endpoint, created on first use and kept. */
	for(key: string): AgentSlotGate;
	/** How many are running across every endpoint. Diagnostics only. */
	active(): number;
}

export function createAgentSlotGateRegistry(
	limit: number | undefined,
): AgentSlotGateRegistry {
	const gates = new Map<string, AgentSlotGate>();
	return {
		for: (key) => {
			const existing = gates.get(key);
			if (existing) {
				return existing;
			}
			const created = createAgentSlotGate(limit);
			gates.set(key, created);
			return created;
		},
		active: () =>
			[...gates.values()].reduce((total, gate) => total + gate.active(), 0),
	};
}
