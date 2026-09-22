/**
 * The queue in front of {@link placeAgent}: every tier full means wait.
 *
 * §9h's ruling. A swarm of thirty against twenty slots completes, more slowly;
 * refusing would make a swarm larger than total capacity partly fail, and a
 * bounded wait only moves where that failure happens.
 *
 * Two consequences the queue exists to get right:
 *
 * - **It drains in spawn order.** An agent asked for first starts first. A
 *   newcomer never jumps a waiter, and it could not usefully try: while
 *   anyone is waiting, every node is full, because a free slot would already
 *   have gone to them.
 * - **It dequeues by the live-occupancy rule, not by where the last agent
 *   went.** Each freed slot runs {@link placeAgent} again for the head of the
 *   queue, so a slot freed in tier 1 takes the head of the queue back up to
 *   tier 1 rather than leaving it for tier 2 to fill.
 *
 * The occupancy it keeps is its own ledger of leases: a node's capacity is a
 * count of agents *we* may run on it -- its Parallel Sessions setting, or for
 * opencoti the sub-pools inside its one session -- so what we have put there
 * is the measure that capacity is stated in.
 */
import {
	type AgentNode,
	emptyPlacementState,
	type PlacementState,
	placeAgent,
} from "./agent-placement";

export interface PlacementLease {
	nodeId: string;
	/** Frees the slot. Safe to call more than once; only the first counts. */
	release(): void;
}

/**
 * How long a node that could not be reached is left out of the rotation.
 *
 * Long enough that a dead LAN box is not retried on every spawn -- with
 * round-robin that is once a lap, each costing a connect timeout -- and short
 * enough that a box which came back is used again within one agent's work.
 */
export const NODE_COOL_OFF_MS = 30_000;

export interface AgentPlacementQueue {
	/**
	 * A slot on the best node with room, waiting for one if none has.
	 *
	 * Rejects only when `signal` aborts, or when no node could ever take an
	 * agent -- see {@link NoAgentCapacityError}.
	 */
	acquire(signal?: AbortSignal): Promise<PlacementLease>;
	/** Agents waiting for a slot, for a status line. */
	readonly waiting: number;
	/** Node id to agents running on it now. A copy. */
	occupancy(): ReadonlyMap<string, number>;
	/**
	 * Take a node out of the rotation for {@link NODE_COOL_OFF_MS}.
	 *
	 * Called when an agent could not reach it at all -- a refused connection,
	 * an unknown host -- never for a model error or a refusal, which say the
	 * node is alive and answering.
	 */
	markUnreachable(nodeId: string): void;
}

/**
 * No node has any capacity at all, so waiting would never end.
 *
 * Distinct from full on purpose. Full is a state that ends when an agent
 * finishes; every node configured to zero is a configuration, and an agent
 * queued behind it would hang the spawn for the life of the session.
 */
export class NoAgentCapacityError extends Error {
	constructor() {
		super("No agent node can take an agent: every node has a capacity of 0.");
		this.name = "NoAgentCapacityError";
	}
}

interface Waiter {
	resolve: (lease: PlacementLease) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException("The spawn was cancelled while waiting.", "AbortError")
	);
}

export function createAgentPlacementQueue(
	nodes: readonly AgentNode[],
	options?: {
		/** Injected so the cool-off can be tested without waiting for it. */
		now?: () => number;
		/** Injected for the same reason; returns a canceller. */
		schedule?: (fn: () => void, ms: number) => void;
	},
): AgentPlacementQueue {
	const occupancy = new Map<string, number>();
	const downUntil = new Map<string, number>();
	const waiters: Waiter[] = [];
	const now = options?.now ?? Date.now;
	const schedule =
		options?.schedule ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms) as unknown as {
				unref?: () => void;
			};
			// A cool-off must not be a reason for the process to stay alive.
			timer.unref?.();
		});
	let state: PlacementState = emptyPlacementState();
	// `Infinity` is capacity, and the most capacity there is: it is how a node
	// on an endpoint that decides its own admission says "no bound from here",
	// which is what the panel recommends for an elastic or PolyKV opencoti.
	// `Number.isFinite` reads it as no capacity at all, so a session whose
	// nodes were ALL uncapped rejected every spawn outright with
	// `NoAgentCapacityError`. The test for it is the all-uncapped session.
	const anyCapacity = nodes.some(
		(entry) => !Number.isNaN(entry.capacity) && entry.capacity > 0,
	);

	const tryPlace = (): PlacementLease | undefined => {
		const result = placeAgent({
			nodes,
			occupancy,
			state,
			downUntil,
			now: now(),
		});
		state = result.state;
		if (result.placement.kind === "queued") {
			return undefined;
		}
		const nodeId = result.placement.nodeId;
		occupancy.set(nodeId, (occupancy.get(nodeId) ?? 0) + 1);
		let released = false;
		return {
			nodeId,
			release: () => {
				if (released) {
					return;
				}
				released = true;
				occupancy.set(nodeId, Math.max(0, (occupancy.get(nodeId) ?? 0) - 1));
				drain();
			},
		};
	};

	const drain = (): void => {
		while (waiters.length > 0) {
			const lease = tryPlace();
			if (!lease) {
				return;
			}
			const head = waiters.shift() as Waiter;
			if (head.signal && head.onAbort) {
				head.signal.removeEventListener("abort", head.onAbort);
			}
			head.resolve(lease);
		}
	};

	return {
		acquire: (signal) => {
			if (!anyCapacity) {
				return Promise.reject(new NoAgentCapacityError());
			}
			if (signal?.aborted) {
				return Promise.reject(abortReason(signal));
			}
			// Nobody ahead: place now if anything has room. With anyone
			// waiting there is no room by construction, and asking anyway
			// would let a newcomer take a slot that frees mid-call.
			if (waiters.length === 0) {
				const lease = tryPlace();
				if (lease) {
					return Promise.resolve(lease);
				}
			}
			return new Promise<PlacementLease>((resolve, reject) => {
				const waiter: Waiter = { resolve, reject, signal };
				if (signal) {
					waiter.onAbort = () => {
						const index = waiters.indexOf(waiter);
						if (index >= 0) {
							waiters.splice(index, 1);
							reject(abortReason(signal));
						}
					};
					signal.addEventListener("abort", waiter.onAbort, { once: true });
				}
				waiters.push(waiter);
			});
		},
		get waiting() {
			return waiters.length;
		},
		occupancy: () => new Map(occupancy),
		markUnreachable: (nodeId) => {
			if (!nodes.some((node) => node.id === nodeId)) {
				return;
			}
			downUntil.set(nodeId, now() + NODE_COOL_OFF_MS);
			// Nothing to drain now: a waiter exists only when every node is
			// full, and taking one out of the rotation frees no slot. What
			// does need announcing is the END of the cool-off -- a node that
			// is down but has room is skipped while a live node is full, so an
			// agent can be queued against capacity that exists and is merely
			// out of favour. When the cool-off lapses that capacity becomes
			// usable with no release to notice it, and the waiter would sit
			// until some unrelated agent happened to finish.
			schedule(drain, NODE_COOL_OFF_MS);
		},
	};
}
