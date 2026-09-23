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
 * - **An uncapped node is paced by admission, one agent at a time.** A node
 *   with no ceiling (`Infinity`: an elastic or PolyKV opencoti, where the
 *   engine decides) takes one agent, and the next only once the engine has
 *   admitted that one -- its first output is the proof. Before this an
 *   uncapped node "had room" by definition, so at t=0 every queued agent was
 *   leased to it and waited inside the engine instead of here. Measured in
 *   the 75-agent sx4bp run (2026-09-23): two opencoti nodes took all 75 at
 *   once, and an ollama node that finished its one agent in 66 s sat idle for
 *   the rest of the run with 70 agents queued -- queued on a node, not here.
 * - **A spawn that fails goes back to the head.** A lease given back through
 *   {@link AcquireOptions.front} is re-placed before any waiter, so an agent
 *   that was refused or landed on a dead node keeps its place in the FIFO.
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
	/**
	 * The engine took this agent: its first output arrived.
	 *
	 * On an uncapped node this is what opens the node to the next agent.
	 * Idempotent, and a no-op on a capped node, whose room is its count.
	 */
	admitted(): void;
	/**
	 * The engine refused this agent before admitting it. The node takes no
	 * one else until one of its agents finishes or `holdMs` passes, whichever
	 * is first. Frees the slot, like {@link release}.
	 */
	refused(holdMs?: number): void;
}

export interface AcquireOptions {
	/**
	 * Go before every waiter: an agent coming back from a spawn that failed.
	 * It was first in the queue when it was placed, and a refusal is not a
	 * reason to lose that.
	 */
	front?: boolean;
}

/**
 * How long a refused uncapped node is held when the engine gave no time.
 *
 * Short: a refusal describes this moment, and it usually ends when one of the
 * node's own agents finishes, which reopens it at once. This is only the
 * fallback for a refusal with nothing of ours running there to finish.
 */
export const NODE_REFUSED_HOLD_MS = 5_000;

/**
 * How long a node that could not be reached is left out of the rotation.
 *
 * Long enough that a dead LAN box is not retried on every spawn -- with
 * round-robin that is once a lap, each costing a connect timeout -- and short
 * enough that a box which came back is used again within one agent's work.
 */
export const NODE_COOL_OFF_MS = 30_000;

/**
 * The cool-off for a node whose model is not on its server.
 *
 * Longer, because the two conditions heal on different scales. A box that was
 * unplugged can be back in thirty seconds; a model tag that the server has
 * never heard of does not appear on its own, and until someone pulls it every
 * agent sent there dies the same way. Measured on pandorum 2026-09-22: a node
 * configured for `ornith-27b_tb:iq4_xs-128k` against a server holding 193
 * models and not that one, killing two agents of a five-agent fan-out and
 * taking a third when the lead retried.
 *
 * Still a cool-off rather than a removal: `ollama pull` during a long session
 * is an ordinary thing to do, and a node that is out for good would stay out
 * after the user fixed it.
 */
export const NODE_MODEL_MISSING_COOL_OFF_MS = 600_000;

/**
 * How many nodes one agent may be placed on before its failure is its own.
 *
 * Bounded rather than "every node": a request that fails the same way
 * everywhere -- a malformed tool schema, an oversized prompt -- would
 * otherwise walk the whole rotation and take every node out of it on the way
 * past. Three is enough to step over a misconfigured node in any realistic
 * setup and small enough that a systematic failure is reported as one.
 */
export const MAX_NODE_PLACEMENT_ATTEMPTS = 3;

export interface AgentPlacementQueue {
	/**
	 * A slot on the best node with room, waiting for one if none has.
	 *
	 * Rejects only when `signal` aborts, or when no node could ever take an
	 * agent -- see {@link NoAgentCapacityError}.
	 */
	acquire(
		signal?: AbortSignal,
		options?: AcquireOptions,
	): Promise<PlacementLease>;
	/** Agents waiting for a slot, for a status line. */
	readonly waiting: number;
	/** Node id to agents running on it now. A copy. */
	occupancy(): ReadonlyMap<string, number>;
	/**
	 * Take a node out of the rotation for a cool-off.
	 *
	 * Called when an agent could not reach it at all -- a refused connection,
	 * an unknown host -- never for a refusal or an ordinary model error, which
	 * say the node is alive and answering.
	 *
	 * The exception is a model the server does not have. That is an answer,
	 * so it is not unreachable, but it is a node that cannot run anything
	 * until its configuration changes: see
	 * {@link NODE_MODEL_MISSING_COOL_OFF_MS}, which callers pass as
	 * `coolOffMs`.
	 */
	markUnreachable(nodeId: string, coolOffMs?: number): void;
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
	// Uncapped nodes: leases not yet admitted, and refusals still holding.
	const unadmitted = new Map<string, number>();
	const heldUntil = new Map<string, number>();
	const isPaced = (node: AgentNode): boolean => node.capacity === Infinity;
	// What placement sees. An uncapped node has room for exactly one agent
	// the engine has not yet admitted, and none while a refusal holds it --
	// said as a capacity so `placeAgent`'s tiers and round-robin still apply.
	const view = (): AgentNode[] =>
		nodes.map((node) => {
			if (!isPaced(node)) {
				return node;
			}
			const running = occupancy.get(node.id) ?? 0;
			const held = (heldUntil.get(node.id) ?? 0) > now();
			const pending = (unadmitted.get(node.id) ?? 0) > 0;
			return {
				...node,
				capacity: held || pending ? running : running + 1,
			};
		});
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
			nodes: view(),
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
		const paced = nodes.some((node) => node.id === nodeId && isPaced(node));
		occupancy.set(nodeId, (occupancy.get(nodeId) ?? 0) + 1);
		let released = false;
		let pending = paced;
		if (pending) {
			unadmitted.set(nodeId, (unadmitted.get(nodeId) ?? 0) + 1);
		}
		const settle = (): void => {
			if (pending) {
				pending = false;
				unadmitted.set(nodeId, Math.max(0, (unadmitted.get(nodeId) ?? 0) - 1));
			}
		};
		const release = (): void => {
			if (released) {
				return;
			}
			released = true;
			settle();
			occupancy.set(nodeId, Math.max(0, (occupancy.get(nodeId) ?? 0) - 1));
			// One of its own agents finishing is the room a refusal was
			// waiting for.
			heldUntil.delete(nodeId);
			drain();
		};
		return {
			nodeId,
			release,
			admitted: () => {
				if (released || !pending) {
					return;
				}
				settle();
				drain();
			},
			refused: (holdMs = NODE_REFUSED_HOLD_MS) => {
				if (released) {
					return;
				}
				released = true;
				settle();
				occupancy.set(nodeId, Math.max(0, (occupancy.get(nodeId) ?? 0) - 1));
				if (paced) {
					heldUntil.set(nodeId, now() + holdMs);
					schedule(drain, holdMs);
				}
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
		acquire: (signal, options) => {
			if (!anyCapacity) {
				return Promise.reject(new NoAgentCapacityError());
			}
			if (signal?.aborted) {
				return Promise.reject(abortReason(signal));
			}
			// Nobody ahead: place now if anything has room. With anyone
			// waiting there is no room by construction, and asking anyway
			// would let a newcomer take a slot that frees mid-call. An agent
			// coming back to the front has nobody ahead by definition.
			if (waiters.length === 0 || options?.front) {
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
				if (options?.front) {
					waiters.unshift(waiter);
				} else {
					waiters.push(waiter);
				}
			});
		},
		get waiting() {
			return waiters.length;
		},
		occupancy: () => new Map(occupancy),
		markUnreachable: (nodeId, coolOffMs = NODE_COOL_OFF_MS) => {
			if (!nodes.some((node) => node.id === nodeId)) {
				return;
			}
			downUntil.set(nodeId, now() + coolOffMs);
			// Nothing to drain now: a waiter exists only when every node is
			// full, and taking one out of the rotation frees no slot. What
			// does need announcing is the END of the cool-off -- a node that
			// is down but has room is skipped while a live node is full, so an
			// agent can be queued against capacity that exists and is merely
			// out of favour. When the cool-off lapses that capacity becomes
			// usable with no release to notice it, and the waiter would sit
			// until some unrelated agent happened to finish.
			schedule(drain, coolOffMs);
		},
	};
}
