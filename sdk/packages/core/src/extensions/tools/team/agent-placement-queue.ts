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
): AgentPlacementQueue {
	const occupancy = new Map<string, number>();
	const waiters: Waiter[] = [];
	let state: PlacementState = emptyPlacementState();
	const anyCapacity = nodes.some(
		(entry) => Number.isFinite(entry.capacity) && entry.capacity > 0,
	);

	const tryPlace = (): PlacementLease | undefined => {
		const result = placeAgent({ nodes, occupancy, state });
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
	};
}
