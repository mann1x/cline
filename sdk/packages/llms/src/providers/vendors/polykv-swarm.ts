import {
	noteOpencotiRefusalPressure,
	opencotiPendingResize,
	readOpencotiKv,
	resizeOpencotiSession,
} from "./opencoti-kv-pressure";
import type { OpencotiStreamPhase } from "./opencoti-liveness";
import {
	createPolykvClient,
	hasOpencotiFeature,
	OPENCOTI_FEATURES,
	type PolykvAdmissionPolicy,
	type PolykvClient,
	polykvRoot,
	probeOpencotiProps,
} from "./polykv";

/**
 * Agents that share a prefix, deduplicated on the engine that holds the cells.
 *
 * A swarm of sub-agents on one opencoti server repeats the same context in
 * every agent: the system prompt and tool schemas, then whatever knowledge they
 * were all handed, then the instructions of their role. Measured on 8240 with a
 * 15k-character file as the knowledge: each agent's prompt was 6,133 tokens and
 * 6,099 of them were identical across every agent of a role. Sent as ordinary
 * sessions they are prefilled and held once per agent; attached to a pool tree
 * they are prefilled and held once.
 *
 * The tree mirrors how the agent's first request is laid out, one layer per
 * turn:
 *
 *   P0  system prompt + tools             -- every agent
 *   P1  P0 + the knowledge turn           -- every agent given that knowledge
 *   P2  P1 + the instructions turn        -- every agent of that role
 *   worker: P2 + its own task, attached with `pool_id`
 *
 * Every pool is owned by one **owner session**, whose guaranteed window the
 * whole tree lives in. A worker attached to an owned pool books nothing of its
 * own: the engine charges its private suffix to the owner, so fifty agents fit
 * where one agent's window would otherwise be booked fifty times.
 *
 * Three rules this module exists to keep:
 *
 * - **The prefix is the server's rendering, never ours.** Each layer is the
 *   request's own messages rendered through `/apply-template` and cut at a
 *   sentinel turn, then checked to be a byte-prefix of the rendering of the
 *   request it is for. A prefix that is not is never attached: attaching it
 *   costs a pool and shares nothing.
 * - **Each layer ends after the next turn's opener.** A worker's prompt always
 *   continues with the opener of its task turn. A pool that stops before it is
 *   beaten by any warm slot that last served an agent of the same role -- the
 *   slot's cache matches those extra tokens, the engine prefers it, and the
 *   worker then runs on a private copy charged to the owner in full. Measured:
 *   9 of 40 agents attached with the opener outside the pool.
 * - **Nothing outlives its agents.** Each agent's own session is closed when
 *   the agent ends, and the owner -- with every pool it owns -- when its last
 *   agent does. The engine's idle TTL is the crash net: admission is decided
 *   against held windows, and a window held for five minutes after its work is
 *   done is five minutes of refusals for everyone queued behind it.
 */

/** How one agent's requests attach to the shared tree. */
export interface PolykvWorkerSpec {
	/**
	 * Agents that share owners. The lead conversation's session id: a swarm's
	 * agents dedupe against each other, never against another conversation's.
	 */
	group: string;
	/** This agent's own engine session -- slot affinity for its private suffix. */
	sessionId: string;
	/**
	 * How many turns after the system turn are shared layers.
	 *
	 * The agent's first request is `[system, ...layers, task]`; each layer turn
	 * becomes a pool. `0` shares the system prompt and tools only.
	 */
	layers: number;
	/**
	 * Attach to the tree this agent already has, and build nothing.
	 *
	 * For requests of the agent's that are not its conversation -- the
	 * compaction summarizer. Their prompt shares little with the tree, but
	 * attached to an owned pool they are charged to the owner as a worker
	 * instead of booking a window of their own.
	 */
	attachOnly?: boolean;
	/**
	 * The admission policy for every pool this agent's tree creates.
	 *
	 * Posted as each pool is made, because the engine's gate reads the policy
	 * of the pool a new session names, and that is the pool the worker
	 * attaches to -- a policy on the root alone gates nobody.
	 */
	admission?: PolykvAdmissionPolicy;
	/**
	 * Priority 0 (PLANS §9g): the pools live in THIS session's window -- the
	 * lead conversation's own -- instead of an owner opened for the swarm.
	 *
	 * The lead's session id as the host knows it (the engine spelling is made
	 * here). Such an owner is borrowed, never ours: it is not opened, never
	 * closed, and never swapped for a fresh one. What the swarm puts in it goes
	 * back when its last agent ends -- the pools are released one by one, the
	 * session stays. And a full window is the lead's, so a worker that has not
	 * started yet is not held on it: see `createWorkerFetch`, which hands such
	 * a refusal straight back so the agent overflows to a node.
	 */
	owner?: string;
	/**
	 * The window this agent's node states, and the least of it the agent
	 * accepts -- its "Agent window" share (see `opencoti-agent-window.ts`).
	 * An owner this agent opens is sized from it: it asks for the node's
	 * window (never more than the engine's per-session maximum) rather than
	 * the maximum itself, and floors at the agent's floor rather than at
	 * {@link POLYKV_OWNER_MIN_WINDOW} -- an owner granted less than one of its
	 * agents needs is an owner that agent can never run in.
	 */
	window?: { ask: number; floor: number };
}

/**
 * How many agents may run as sub-pools of the lead's own session (§9g).
 *
 * The engine's per-session sub-pool limit (`polykv_subpools_v1`): the unit
 * of priority 0's capacity, and ruled as its cap.
 */
export const POLYKV_LEAD_SUBPOOL_CAP = 8;

/**
 * Pools the lead-owned swarm tree may hold: one fewer than the session's
 * limit, so the conversation's own sub-pool (`polykv-lead.ts`'s `Ls`, re-made
 * after each compaction) always has a place. A chain that reaches the limit
 * stops there and the worker attaches to its parent -- sharing less.
 */
export const POLYKV_LEAD_WORKER_POOL_MAX = POLYKV_LEAD_SUBPOOL_CAP - 1;

/**
 * Cells of the lead's window a priority-0 agent must leave free to start.
 *
 * The hazard this guards is measured (991ce2466): agents charged to the
 * lead's window filled it at about 21 and 49 of 51 failed. A new agent is
 * therefore admitted to priority 0 only while a quarter of the window -- and
 * never less than a worker's minimum useful room -- is still free for the
 * conversation's own next turn. Below it the agent is refused before it
 * starts and overflows to the Agent Nodes.
 */
export function polykvLeadReserveCells(window: number): number {
	return Math.max(POLYKV_MOVE_MIN_FREE_CELLS, Math.ceil(window * 0.25));
}

/** The lead's allocation on the engine, from `GET /kv`. */
export interface PolykvLeadRoom {
	window: number;
	free: number;
	/** Cells the lead keeps; a priority-0 agent starts only above this. */
	reserve: number;
}

/**
 * How much of the lead's booked window is free right now.
 *
 * `undefined` when it cannot be said -- `/kv` unreadable, or the lead holds
 * no allocation (no `dynamicContextSize`: then a pool it "owns" is unowned,
 * nothing is charged to it, and there is nothing of its to protect). The
 * engine's own refusal is the backstop either way.
 */
export async function readPolykvLeadRoom(options: {
	baseUrl: string;
	fetch: typeof fetch;
	headers?: Record<string, string>;
	owner: string;
}): Promise<PolykvLeadRoom | undefined> {
	try {
		const response = await options.fetch(`${polykvRoot(options.baseUrl)}/kv`, {
			headers: options.headers ?? {},
		});
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as { allocations?: unknown };
		const allocations = Array.isArray(body.allocations)
			? (body.allocations as Array<{
					key?: unknown;
					cells?: unknown;
					used?: unknown;
				}>)
			: [];
		const key = engineSessionId(options.owner);
		const entry = allocations.find((allocation) => allocation.key === key);
		if (typeof entry?.cells !== "number" || entry.cells <= 0) {
			return undefined;
		}
		const used = typeof entry.used === "number" ? entry.used : 0;
		return {
			window: entry.cells,
			free: Math.max(0, entry.cells - used),
			reserve: polykvLeadReserveCells(entry.cells),
		};
	} catch {
		return undefined;
	}
}

/**
 * Agents that have had a turn served, by their own session id.
 *
 * Module state rather than the fetch's own flag because a fetch is built per
 * model, and a model is built per turn: a flag on the fetch would read every
 * later turn of a running agent as its first, and a priority-0 agent would
 * be refused -- killed, since it has already started -- the moment the lead's
 * window dipped below its reserve.
 */
const STARTED_WORKERS = new Set<string>();

export function markPolykvWorkerStarted(sessionId: string): void {
	STARTED_WORKERS.add(engineSessionId(sessionId));
}

export function polykvWorkerStarted(sessionId: string): boolean {
	return STARTED_WORKERS.has(engineSessionId(sessionId));
}

/**
 * Agent engine session -> the owner (engine id) its last resolved attach was
 * charged to. Absent: its last turn went out unpooled, as a session of its own.
 */
const CHARGED_TO = new Map<string, string>();

/**
 * The owner session whose `/kv` row this agent's usage lands in, or
 * `undefined` when its last turn was unpooled (its own row is then the one).
 *
 * A worker attached to an owned pool books nothing: the engine charges its
 * private suffix to the owner, so the owner's row is the booking the agent
 * lives in -- and the one its compaction trigger has to read. Without it the
 * trigger read no row at all for any delegated agent on a PolyKV node.
 */
export function polykvWorkerChargedTo(sessionId: string): string | undefined {
	return CHARGED_TO.get(engineSessionId(sessionId));
}

function noteChargedTo(sessionId: string, attach: PolykvWorkerAttach): void {
	const key = engineSessionId(sessionId);
	if (attach.poolId !== undefined && attach.ownerSessionId !== undefined) {
		CHARGED_TO.set(key, attach.ownerSessionId);
	} else {
		CHARGED_TO.delete(key);
	}
}

export interface PolykvWorkerAttach {
	poolId?: string;
	sessionId: string;
	/**
	 * The server generation `poolId` belongs to (see
	 * {@link polykvRootGeneration}). A pool id is a number the server issued
	 * in one boot; the caller re-prepares rather than send it once the
	 * generation has moved on.
	 */
	generation?: number;
	/**
	 * Why the request goes out with no pool, or with a shallower one than its
	 * layers asked for. Logged at warn by the worker's fetch: 257 dispatches
	 * of 2026-09-25 went out unpooled and the only line about it was a debug
	 * `pool=none`.
	 */
	reason?: string;
	/**
	 * The owner session (engine id) whose window this attach is charged to:
	 * set exactly when `poolId` is. See {@link polykvWorkerChargedTo}.
	 */
	ownerSessionId?: string;
}

/** What the server said a pool was when it made it, to know it again. */
interface PoolRecord {
	parent?: string;
	prefixLen?: number;
}

/** An owner session and the pool tree inside its window. */
interface OwnerShard {
	sessionId: string;
	/**
	 * Layer key -> pool id (`undefined` when that layer could not be pooled).
	 *
	 * The layer key is the stable logical name of a pool -- a hash of the chain
	 * of turns it holds -- and it is what every agent resolves on every turn.
	 * The id is only the current generation's answer to it: when the server
	 * restarts, the whole map goes with the shard (see
	 * {@link invalidatePolykvRoot}) and the key resolves to a pool built anew.
	 */
	pools: Map<string, Promise<string | undefined>>;
	/** Pool id -> what the server said it was, for {@link verifyPolykvRoot}. */
	records: Map<string, PoolRecord>;
	/**
	 * Layer key -> the id `pools` resolved to, once it has: read synchronously
	 * by {@link forgetPolykvWorkerPool}.
	 */
	settled?: Map<string, string | undefined>;
	/** Layer key -> the prompt its pool holds, for each attacher's own prefix check. */
	prompts?: Map<string, string>;
	/**
	 * Layer key -> the last build of it that failed, and why. Never a verdict
	 * for good: an engine refusal is asked again after
	 * {@link POLYKV_LAYER_RETRY_MS}, anything else on the next request. Kept
	 * forever, one refused root put every later agent of the owner on
	 * `pool=none` for the rest of the session (2026-09-25).
	 */
	failed?: Map<string, { at: number; reason: string }>;
	/** Agent session -> the layer keys its last request resolved. */
	uses?: Map<string, string[]>;
	/** Pool creates in flight -> the parent each forks from. */
	creating?: Map<Promise<unknown>, string | undefined>;
	/** A release of this owner's spare pools, when one is running. */
	reclaiming?: Promise<number>;
	/** Agents currently assigned here. */
	agents: Set<string>;
	closed: boolean;
	/**
	 * The lead's own session, lent to the swarm (§9g). Never opened or closed
	 * here: releasing it means releasing the pools, not the session.
	 */
	borrowed?: boolean;
	/**
	 * The window each agent on this owner is owed, and the least of it one
	 * accepts: the node's window and its "Agent window" floor. Absent for an
	 * owner opened with no node window stated -- that owner carries any number
	 * of agents, as every owner did before.
	 */
	perAgent?: { ask: number; floor: number };
	/** The window the engine holds for this owner now, as last granted or resized. */
	window?: number;
	/** The window it was opened asking for: where a pressure grow-back stops. */
	ceiling?: number;
	/** The floor it was opened at: one agent's. */
	windowMin?: number;
	/** The engine's per-session maximum: no owner grows past it. */
	maximum?: number;
	/** A grow of this owner is in flight. */
	growing?: boolean;
	/** When the engine last refused to grow it (`Date.now()`). */
	growRefusedAt?: number;
}

interface SwarmGroup {
	key: string;
	root: string;
	client: PolykvClient;
	fetch: typeof fetch;
	headers?: Record<string, string>;
	shards: OwnerShard[];
	/** Agent session -> its shard. An agent stays on the shard it started on. */
	assigned: Map<string, OwnerShard>;
	opening?: Promise<OwnerShard | undefined>;
	/** Agents waiting on `opening`, told when it has to wait for room. */
	awaitingOwner: Set<string>;
}

const GROUPS = new Map<string, SwarmGroup>();
/** Agent session -> its group, for release by agent id alone. */
const AGENT_GROUPS = new Map<string, SwarmGroup>();

/**
 * The last owner number used per group name, for the life of the process.
 *
 * Not per group object: a group is dropped when its last agent leaves and
 * made again by the next one, and a counter on it started again at 1. The
 * new group then opened `~polykv-owner-1` -- the name of an owner whose close
 * was still in flight, or that a stale release had left holding its chain --
 * and built the same chain in it again. bs2:8244, 2026-09-25: three identical
 * chains under one `~polykv-owner-1`, its eight sub-pools gone, 112 refused
 * creates, and every agent of the swarm prefilled its own prefix.
 */
const OWNER_SERIALS = new Map<string, number>();

/**
 * Owners a restart check gave up on while agents were still on them.
 *
 * {@link invalidatePolykvRoot} drops a root's owners without closing them:
 * after a real restart there is nothing to close. But it is also reached on
 * suspicion alone, and then the owner is alive, holding a whole window and its
 * pools until the idle TTL. It is closed as soon as none of its agents has a
 * turn running on it, so no turn in flight is cut; on a server that did
 * restart, the close of a name it never saw is a no-op.
 *
 * Not "once every agent has moved to a new owner": the new owners are what
 * the abandoned ones' cells are needed for. pandorum 2026-09-26 19:38Z, 17
 * agents waited about ten minutes for new owners that could not open while
 * the abandoned owners held every cell, until the engine's idle TTL let them
 * go. An agent between turns does not use its old owner again -- it is closed
 * to it, and its next turn is placed anew -- so it holds nothing open.
 */
const ABANDONED = new Map<OwnerShard, PolykvClient>();

/** Worker turns sent and not yet ended, per agent engine session. */
const TURNS_IN_FLIGHT = new Map<string, number>();

function turnRunning(sessionId: string): boolean {
	return (TURNS_IN_FLIGHT.get(sessionId) ?? 0) > 0;
}

/**
 * A worker turn goes out: until the returned call, `sessionId` is using the
 * owner it was sent on. The end is idempotent; ending the agent's last
 * running turn closes any abandoned owner no other running turn holds.
 */
export function beginPolykvWorkerTurn(sessionId: string): () => void {
	TURNS_IN_FLIGHT.set(sessionId, (TURNS_IN_FLIGHT.get(sessionId) ?? 0) + 1);
	let ended = false;
	return () => {
		if (ended) {
			return;
		}
		ended = true;
		const left = (TURNS_IN_FLIGHT.get(sessionId) ?? 1) - 1;
		if (left > 0) {
			TURNS_IN_FLIGHT.set(sessionId, left);
			return;
		}
		TURNS_IN_FLIGHT.delete(sessionId);
		leaveAbandoned(sessionId);
	};
}

function abandonShard(client: PolykvClient, shard: OwnerShard): void {
	if (shard.borrowed) {
		return;
	}
	if (![...shard.agents].some(turnRunning)) {
		void client.closeSession(shard.sessionId).catch(() => false);
		return;
	}
	ABANDONED.set(shard, client);
}

/**
 * `sessionId` is done with the owners it was abandoned on; close any that no
 * running turn holds any longer.
 */
function leaveAbandoned(sessionId: string): Promise<unknown>[] {
	const closes: Promise<unknown>[] = [];
	for (const [shard, client] of [...ABANDONED]) {
		if (
			shard.agents.delete(sessionId) &&
			![...shard.agents].some(turnRunning)
		) {
			ABANDONED.delete(shard);
			closes.push(client.closeSession(shard.sessionId).catch(() => false));
		}
	}
	return closes;
}

/**
 * Take an agent that was released mid-placement back off the owner it was
 * just placed on, closing the owner if that left it empty.
 */
async function leaveReleasedOwner(
	group: SwarmGroup,
	shard: OwnerShard,
	sessionId: string,
): Promise<void> {
	shard.agents.delete(sessionId);
	shard.uses?.delete(sessionId);
	if (group.assigned.get(sessionId) === shard) {
		group.assigned.delete(sessionId);
	}
	if (shard.agents.size === 0 && !shard.closed && !shard.borrowed) {
		shard.closed = true;
		group.shards = group.shards.filter((candidate) => candidate !== shard);
		await group.client.closeSession(shard.sessionId).catch(() => false);
	}
	forgetGroupIfEmpty(group);
}

/** Drop `group` from the registry, unless another has replaced it there. */
function forgetGroupIfEmpty(group: SwarmGroup): void {
	if (
		group.shards.length === 0 &&
		group.assigned.size === 0 &&
		GROUPS.get(group.key) === group
	) {
		GROUPS.delete(group.key);
	}
}

/**
 * What an agent last dispatched with, per agent: `pool:<id>` or the reason
 * it had none. So the worker's fetch logs a change, not every turn.
 */
const LAST_ATTACH = new Map<string, string>();

/**
 * Whether `state` differs from the last one noted for this agent (and note
 * it). The worker's fetch logs only what changed.
 */
export function notePolykvWorkerAttach(
	sessionId: string,
	state: string,
): boolean {
	const key = engineSessionId(sessionId);
	if (LAST_ATTACH.get(key) === state) {
		return false;
	}
	LAST_ATTACH.set(key, state);
	return true;
}

/**
 * Every opencoti session this process opened, so it can be closed by id alone.
 *
 * An agent's session holds a slot affinity even as a worker, and a whole
 * guaranteed window when it is not one -- an agent on an opencoti node without
 * pooling books its own. Its end is the moment to give that back.
 */
const OPENCOTI_SESSIONS = new Map<
	string,
	{ root: string; fetch: typeof fetch; headers?: Record<string, string> }
>();

export function rememberOpencotiSession(
	sessionId: string,
	baseUrl: string,
	fetchFn: typeof fetch,
	headers?: Record<string, string>,
): void {
	if (!OPENCOTI_SESSIONS.has(sessionId)) {
		OPENCOTI_SESSIONS.set(sessionId, {
			root: polykvRoot(baseUrl),
			fetch: fetchFn,
			...(headers ? { headers } : {}),
		});
	}
}

/** A turn that is never anyone's content, marking where a layer ends. */
const SENTINEL = "⁣POLYKV-LAYER-END⁣";

/** Owner windows start here and the engine grants what fits above it. */
export const POLYKV_OWNER_MIN_WINDOW = 32_768;

/**
 * Longest wait between two tries on a full window.
 *
 * There is no overall deadline: a full window is a queue, not a fault -- it
 * drains as the other agents finish -- and an agent is meant to finish its
 * job (ruled after 1tmrl). This is the one guard against a tight loop: the
 * first {@link POLYKV_ROOM_WAITS_AT_NAMED} waits are what the engine names,
 * and after that the wait doubles on each refusal in a row, up to this.
 */
export const POLYKV_ROOM_BACKOFF_MAX_MS = 30_000;

/** Waits in a row taken at the engine's own `Retry-After` before backing off. */
export const POLYKV_ROOM_WAITS_AT_NAMED = 4;

/** The wait before the `waits`th retry on a full window (1-based). */
export function polykvRoomBackoffMs(waits: number, namedMs: number): number {
	const doublings = Math.max(0, waits - POLYKV_ROOM_WAITS_AT_NAMED);
	return Math.min(
		Math.max(POLYKV_ROOM_BACKOFF_MAX_MS, namedMs),
		namedMs * 2 ** doublings,
	);
}

export function hashString(text: string): string {
	// cyrb53: a key, not a fingerprint -- a collision costs one shared pool
	// between two prefixes, which the byte-prefix check then refuses to attach.
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A session id the engine can close.
 *
 * The close route is `/sessions/:session_id/close`, and its parameter cannot
 * hold a `/` -- encoded as `%2F` the route does not match and the close 404s,
 * leaving the window held until the idle TTL. Measured on 8240: an owner named
 * `lead/polykv-owner-1` could be opened, filled and used, and never closed.
 */
export function engineSessionId(id: string): string {
	return id.replace(/[/\\?#%]/g, "~");
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const handle = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(handle);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * What this process knows about one server across its restarts.
 *
 * A restart takes every pool and owner allocation with it, and the new server
 * numbers its pools from 0 again (1tmrl: bs2:8244 restarted twice under a
 * 75-agent swarm). A cached id then names nothing -- and a pool id the server
 * does not know is not refused, it is silently prefilled in full -- or,
 * worse, names a DIFFERENT pool that a newer agent built. So each server root
 * has a generation, and every pool id handed out is tagged with the
 * generation it was made in.
 */
interface RootState {
	generation: number;
	/** The server's identity as `/props` states it, when it states one. */
	identity?: string;
	/** Last time the server was asked whether it is the same one. */
	checkedAt: number;
	/** Something suggested a restart; ask before the next attach. */
	suspect: boolean;
	checking?: Promise<void>;
	/**
	 * The `boot_id` of the process this generation's pools were made on
	 * (`boot_id_v1`), from `/props` when the chain was verified or from the
	 * first `X-OpenCoti-Boot-Id` seen for it.
	 */
	bootId?: string;
	/** Boot ids of processes already replaced: a late answer from one is not news. */
	retiredBootIds?: Set<string>;
}

const ROOT_STATES = new Map<string, RootState>();

/**
 * How often an agent's reattach asks the server whether it is the one its
 * pools were made on, when nothing has suggested otherwise. Shared by every
 * agent on the root, so a swarm asks once per interval, not once per agent.
 */
export const POLYKV_VERIFY_INTERVAL_MS = 2_000;

function rootState(root: string): RootState {
	let state = ROOT_STATES.get(root);
	if (!state) {
		state = { generation: 0, checkedAt: 0, suspect: false };
		ROOT_STATES.set(root, state);
	}
	return state;
}

/** The server generation pool ids on this root currently belong to. */
export function polykvRootGeneration(baseUrl: string): number {
	return rootState(polykvRoot(baseUrl)).generation;
}

/**
 * Something suggested the server at `baseUrl` restarted: a transport fault,
 * or a pooled turn that came back without `X-Context-Window`. The next attach
 * on that root asks the server before it resolves any pool.
 */
export function notePolykvServerFault(baseUrl: string): void {
	const root = polykvRoot(baseUrl);
	if (
		ROOT_STATES.has(root) ||
		[...GROUPS.values()].some((g) => g.root === root)
	) {
		rootState(root).suspect = true;
	}
}

/**
 * The fields opencoti states for exactly this purpose (c8 row L, confirmed in
 * the answer to mail 274): `boot_id` is new with every process, `started_at`
 * is when it started. Read at the top level and under `opencoti.*`, from
 * `/props` and from `/health`. When a build states either, it is the whole
 * identity: nothing else is needed, and a field that can change without a
 * restart must not be read as one.
 */
const BOOT_IDENTITY_FIELDS = ["boot_id", "started_at"] as const;

/**
 * Fields of `/props` that change when the server process does, for a build
 * that states neither boot field. Whatever of them the build states is the
 * identity; a build that states none of them is checked by its pools alone.
 * `build_info` is among them because a restart onto a new build is the
 * common case.
 */
const IDENTITY_FIELDS = [
	"build_info",
	"build_number",
	"build_commit",
	"start_time",
	"started_at",
	"server_start_time",
	"t_start",
	"boot_id",
	"instance_id",
	"pid",
] as const;

function pickIdentity(
	bodies: ReadonlyArray<Record<string, unknown> | undefined>,
	fields: readonly string[],
): Array<[string, unknown]> {
	const picked: Array<[string, unknown]> = [];
	const seen = new Set<string>();
	for (const body of bodies) {
		if (!body) {
			continue;
		}
		const opencoti = (
			body.opencoti && typeof body.opencoti === "object" ? body.opencoti : {}
		) as Record<string, unknown>;
		for (const field of fields) {
			// The same field from /props and /health is one field.
			if (body[field] !== undefined && !seen.has(field)) {
				seen.add(field);
				picked.push([field, body[field]]);
			}
			const nested = `opencoti.${field}`;
			if (opencoti[field] !== undefined && !seen.has(nested)) {
				seen.add(nested);
				picked.push([nested, opencoti[field]]);
			}
		}
	}
	return picked;
}

/**
 * The identity a `/props` body (and, when given, a `/health` body) states,
 * or undefined when it states none. `boot_id` / `started_at` are preferred
 * whenever either is present; see {@link BOOT_IDENTITY_FIELDS}.
 */
export function polykvServerIdentity(
	props: Record<string, unknown> | undefined,
	health?: Record<string, unknown>,
): string | undefined {
	const boot = pickIdentity([props, health], BOOT_IDENTITY_FIELDS);
	if (boot.length > 0) {
		return `boot:${JSON.stringify(boot)}`;
	}
	const picked = pickIdentity([props], IDENTITY_FIELDS);
	return picked.length > 0 ? `props:${JSON.stringify(picked)}` : undefined;
}

/**
 * The server restarted: every pool and owner this process knew on `baseUrl`
 * is gone. Bumps the root's generation and drops its groups' owners, pools
 * and assignments -- nothing is closed, there is nothing left to close -- so
 * each agent's next turn resolves its layer key to a pool built anew, under
 * a new owner, and the prefix is shared again.
 */
export function invalidatePolykvRoot(
	baseUrl: string,
	reason: string,
	options: {
		/**
		 * The agents' notice. `warn` by default; `info` where the loss was
		 * found and recovered in the same breath -- the rebuild is the whole
		 * of what follows, and nothing is left to watch.
		 */
		severity?: PolykvNotice["severity"];
		/** The notice's text, when "restarted" is not what happened. */
		text?: string;
	} = {},
): string[] {
	const root = polykvRoot(baseUrl);
	const state = rootState(root);
	state.generation += 1;
	state.suspect = false;
	const agents: string[] = [];
	for (const group of GROUPS.values()) {
		if (group.root !== root) {
			continue;
		}
		for (const shard of group.shards) {
			shard.closed = true;
			shard.pools.clear();
			shard.records.clear();
			shard.settled?.clear();
			shard.uses?.clear();
			// Its name is never opened again (OWNER_SERIALS), so closing it
			// later can only ever close it -- see ABANDONED.
			abandonShard(group.client, shard);
		}
		group.shards = [];
		agents.push(...group.assigned.keys());
		group.assigned.clear();
		group.opening = undefined;
	}
	for (const agent of agents) {
		reportPolykvNotice(agent, {
			severity: options.severity ?? "warn",
			text:
				options.text ??
				`The server at ${root} restarted (${reason}): this agent's shared pools are rebuilt under a new owner on its next turn.`,
		});
	}
	// Who was told, so a caller with news for one more does not tell twice.
	return agents;
}

/**
 * Owners whose pools the engine released while the server kept running --
 * an allocation idle past the engine's TTL goes with its pools. Only those
 * owners are dropped: their agents are placed anew on their next turn, and
 * every other agent keeps its owner and its pools. The generation moves on,
 * so a request prepared against a released id is prepared again; an agent
 * whose owner stands resolves the same pools as before.
 *
 * `false` when a pool in `gone` belonged to no owner of the swarm, which this
 * cannot account for; nothing was dropped then.
 */
function invalidateLapsedOwners(
	root: string,
	gone: ReadonlySet<string>,
): boolean {
	const lapsed: Array<[SwarmGroup, OwnerShard]> = [];
	const accounted = new Set<string>();
	for (const group of GROUPS.values()) {
		if (group.root !== root) {
			continue;
		}
		for (const shard of group.shards) {
			if (shard.closed) {
				continue;
			}
			const ids = [...shard.records.keys()].filter((id) => gone.has(id));
			if (ids.length > 0) {
				lapsed.push([group, shard]);
				for (const id of ids) {
					accounted.add(id);
				}
			}
		}
	}
	if (accounted.size < gone.size) {
		return false;
	}
	rootState(root).generation += 1;
	for (const [group, shard] of lapsed) {
		shard.closed = true;
		shard.pools.clear();
		shard.records.clear();
		shard.settled?.clear();
		shard.uses?.clear();
		abandonShard(group.client, shard);
		group.shards = group.shards.filter((other) => other !== shard);
		for (const [agent, on] of [...group.assigned]) {
			if (on !== shard) {
				continue;
			}
			group.assigned.delete(agent);
			reportPolykvNotice(agent, {
				severity: "info",
				text: `Its owner on ${root} was released by the server after sitting idle, and its shared pools with it (the server did not restart): they are rebuilt under a new owner on its next turn.`,
			});
		}
	}
	return true;
}

/**
 * How often an owner with agents is kept from lapsing.
 *
 * The engine releases an allocation idle past its TTL (`--elastic-alloc-ttl`,
 * five minutes on bs2), and only a finished request of the owner's resets
 * that clock. An owner whose agents are all being refused -- the pool floor,
 * no room -- or are in long tool calls has none, and on bs2 8244 2026-09-26
 * every one of 26 lapses came exactly five minutes after the owner's last
 * finished request, with its agents still retrying. Losing the owner costs
 * them their pools and a new window they then wait for, so an owner is not
 * let go while it has agents.
 */
export const POLYKV_OWNER_KEEPALIVE_MS = 60_000;

const OWNER_KEEPALIVES = new Map<string, ReturnType<typeof setInterval>>();

function ensureOwnerKeepalive(group: SwarmGroup): void {
	if (OWNER_KEEPALIVES.has(group.root)) {
		return;
	}
	const timer = setInterval(() => {
		void keepPolykvOwnersAlive(group.root, group.fetch, group.headers);
	}, POLYKV_OWNER_KEEPALIVE_MS);
	(timer as { unref?: () => void }).unref?.();
	OWNER_KEEPALIVES.set(group.root, timer);
}

function stopOwnerKeepalive(root: string): void {
	const timer = OWNER_KEEPALIVES.get(root);
	if (timer !== undefined) {
		clearInterval(timer);
		OWNER_KEEPALIVES.delete(root);
	}
}

/**
 * Reset the idle clock of every owner on `root` that has agents: a resize to
 * the window the engine holds for it now (`/kv`), which the engine takes as a
 * use and which changes nothing else. Never a grow -- the window is read, not
 * remembered, so a pressure shrink stands. An owner busy with a request is
 * refused the resize and needs none. Returns how many were reset.
 */
export async function keepPolykvOwnersAlive(
	baseUrl: string,
	fetchFn: typeof fetch,
	headers?: Record<string, string>,
): Promise<number> {
	const root = polykvRoot(baseUrl);
	const live: OwnerShard[] = [];
	for (const group of GROUPS.values()) {
		if (group.root !== root) {
			continue;
		}
		for (const shard of group.shards) {
			if (!shard.closed && !shard.borrowed && shard.agents.size > 0) {
				live.push(shard);
			}
		}
	}
	if (live.length === 0) {
		stopOwnerKeepalive(root);
		return 0;
	}
	const props = await probeOpencotiProps(root, fetchFn).catch(() => undefined);
	if (!hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.kvResize)) {
		return 0;
	}
	const kv = await readOpencotiKv(root, fetchFn).catch(() => undefined);
	if (!kv) {
		return 0;
	}
	const rows = new Map(kv.allocations.map((row) => [row.sessionId, row]));
	let kept = 0;
	await Promise.all(
		live.map(async (shard) => {
			const row = rows.get(shard.sessionId);
			if (!row || row.resizePending !== undefined || shard.growing) {
				return;
			}
			const answer = await resizeOpencotiSession({
				baseUrl: root,
				sessionId: shard.sessionId,
				numCtx: row.window,
				fetch: fetchFn,
				...(headers ? { headers } : {}),
			}).catch(() => undefined);
			if (answer?.ok) {
				kept += 1;
			}
		}),
	);
	return kept;
}

/** `boot_id` as `/props` or `/health` states it, top level or under `opencoti`. */
function readBootId(
	...bodies: ReadonlyArray<Record<string, unknown> | undefined>
): string | undefined {
	for (const body of bodies) {
		const nested =
			body?.opencoti && typeof body.opencoti === "object"
				? (body.opencoti as Record<string, unknown>).boot_id
				: undefined;
		const value = body?.boot_id ?? nested;
		if (typeof value === "string" && value) {
			return value;
		}
	}
	return undefined;
}

/** Record `bootId` as the current generation's, retiring the one it replaces. */
function adoptBootId(state: RootState, bootId: string): void {
	if (state.bootId !== undefined && state.bootId !== bootId) {
		state.retiredBootIds ??= new Set();
		state.retiredBootIds.add(state.bootId);
	}
	state.bootId = bootId;
}

/**
 * The boot id this root's pools belong to, when the server has stated one.
 * `undefined` on a server without `boot_id_v1`: nothing to compare against.
 */
export function polykvRootBootId(baseUrl: string): string | undefined {
	return ROOT_STATES.get(polykvRoot(baseUrl))?.bootId;
}

/**
 * One pool of this agent's chain is gone while the process stayed up
 * (`pool_unknown` under an unchanged boot id): its owner lapsed or was
 * closed, or the engine released it. Forget that pool and every pool forked
 * from it -- in the shard that holds it, and nowhere else -- so the agent's
 * next turn rebuilds its chain from the first layer still standing. Other
 * agents, on this shard or another, keep their pools; if theirs went too,
 * their own next answer says so.
 *
 * Layers whose build failed are retried too: a fork from the pool that just
 * vanished is the likeliest reason one did.
 *
 * Returns whether any pool was forgotten.
 */
export function forgetPolykvWorkerPool(
	baseUrl: string,
	sessionId: string,
	poolId: string,
): boolean {
	const root = polykvRoot(baseUrl);
	const own = AGENT_GROUPS.get(sessionId)?.assigned.get(sessionId);
	const shards = [
		...(own ? [own] : []),
		...[...GROUPS.values()]
			.filter((group) => group.root === root)
			.flatMap((group) => group.shards)
			.filter((shard) => shard !== own),
	];
	const shard = shards.find(
		(candidate) => !candidate.closed && candidate.records.has(poolId),
	);
	if (!shard) {
		return false;
	}
	// The named pool and its descendants, by the parents the server reported.
	const gone = new Set([poolId]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const [id, record] of shard.records) {
			if (!gone.has(id) && record.parent && gone.has(record.parent)) {
				gone.add(id);
				grew = true;
			}
		}
	}
	for (const id of gone) {
		shard.records.delete(id);
	}
	for (const [key, id] of [...(shard.settled ?? [])]) {
		if (id === undefined || gone.has(id)) {
			shard.pools.delete(key);
			shard.settled?.delete(key);
		}
	}
	return true;
}

/**
 * Read the `X-OpenCoti-Boot-Id` of a completion response (`boot_id_v1`).
 *
 * Pool ids restart from 0 with the process, so a pool id held across a
 * restart names nothing -- silently reprocessed in full -- or a pool someone
 * built since. The header is on every completion, so a restart is known from
 * the first answer of the new process, not from the next `/props` check up to
 * {@link POLYKV_VERIFY_INTERVAL_MS} later (and only on a turn that attaches).
 *
 * The generation's boot id is the first one stated for the root -- by
 * `/props` when a chain is verified, or by this header -- and it is carried
 * across a generation that ended for another reason (a lapsed pool, a
 * listing that lost one): that is still the same process. So once the server
 * has stated any boot id, one is always recorded, and a header that differs
 * from it is the one signal: it starts a new generation at once. The swarm's
 * owners and pools are dropped and every agent -- and the lead, whose tree
 * follows the generation -- rebuilds on its next turn. The notice is `info`:
 * the restart is over, and the rebuild is its whole consequence.
 *
 * Returns whether the root was invalidated. An absent header (an older build)
 * says nothing.
 */
export function notePolykvBootId(
	baseUrl: string,
	bootId: string | null | undefined,
): boolean {
	if (!bootId) {
		return false;
	}
	const root = polykvRoot(baseUrl);
	const state = rootState(root);
	if (state.bootId === bootId || state.retiredBootIds?.has(bootId)) {
		return false;
	}
	const previous = state.bootId;
	if (previous === undefined) {
		// The first the root has heard of one: its pools were checked
		// against /props when they were made, and nothing says otherwise.
		adoptBootId(state, bootId);
		return false;
	}
	notePolykvServerFault(baseUrl);
	invalidatePolykvRoot(
		baseUrl,
		`its boot id changed from ${previous} to ${bootId}`,
		{ severity: "info" },
	);
	adoptBootId(state, bootId);
	// The identity /props stated was the old process's: the next check
	// re-baselines on the new one instead of finding the same restart again.
	state.identity = undefined;
	return true;
}

/** What the server said of a pool when it was made, for the listing check. */
export type PolykvPoolRecord = PoolRecord;

/** Pools on `root` held outside the swarm's groups, current generation only. */
export type PolykvPoolHolder = (root: string) => Array<[string, PoolRecord]>;

const SUSPECT_POOL_HOLDERS = new Set<PolykvPoolHolder>();

/**
 * Register pools held outside the swarm -- the lead tree's -- so a restart
 * check can see them too.
 *
 * Read only when a fault made the root suspect: the lead's pools can go for
 * reasons that are not a restart (a lapsed window takes its sub-pool, the
 * engine sweeps an idle shared root), and on a quiet root that must not cost
 * every agent its pools. After a fault, a missing pool is read as the restart
 * it most likely is -- a rebuilt pool costs a prefill, a stale id can attach
 * a turn to someone else's. Returns the unregister.
 */
export function registerPolykvPoolHolder(holder: PolykvPoolHolder): () => void {
	SUSPECT_POOL_HOLDERS.add(holder);
	return () => {
		SUSPECT_POOL_HOLDERS.delete(holder);
	};
}

/** Pool ids this process holds on `root`, with what the server said of each. */
function heldPools(root: string, suspect = false): Array<[string, PoolRecord]> {
	const held: Array<[string, PoolRecord]> = [];
	if (suspect) {
		for (const holder of SUSPECT_POOL_HOLDERS) {
			try {
				held.push(...holder(root));
			} catch {
				// A holder that cannot say contributes nothing.
			}
		}
	}
	for (const group of GROUPS.values()) {
		if (group.root !== root) {
			continue;
		}
		for (const shard of group.shards) {
			if (!shard.closed) {
				held.push(...shard.records.entries());
			}
		}
	}
	return held;
}

/**
 * The pools we made that a `/polykv/pools` listing no longer holds as we made
 * them. `undefined` when the listing says nothing about pools.
 */
function poolsNotListed(
	listing: Record<string, unknown>,
	held: Array<[string, PoolRecord]>,
): Set<string> | undefined {
	if (!Array.isArray(listing.pools)) {
		return undefined;
	}
	const gone = new Set<string>();
	for (const entry of held) {
		if (listingHoldsOurs(listing, [entry]) === false) {
			gone.add(entry[0]);
		}
	}
	return gone;
}

/** Whether a `/polykv/pools` listing still holds every pool we made. */
function listingHoldsOurs(
	listing: Record<string, unknown>,
	held: Array<[string, PoolRecord]>,
): boolean | undefined {
	if (!Array.isArray(listing.pools)) {
		return undefined;
	}
	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of listing.pools as Array<Record<string, unknown>>) {
		if (entry && entry.pool_id !== undefined) {
			byId.set(String(entry.pool_id), entry);
		}
	}
	for (const [id, record] of held) {
		const entry = byId.get(id);
		if (!entry) {
			return false;
		}
		if (
			record.prefixLen !== undefined &&
			typeof entry.prefix_len === "number" &&
			entry.prefix_len !== record.prefixLen
		) {
			return false;
		}
		const parent =
			typeof entry.parent === "number" && entry.parent >= 0
				? String(entry.parent)
				: undefined;
		if (entry.parent !== undefined && (record.parent ?? undefined) !== parent) {
			return false;
		}
	}
	return true;
}

async function readRootJson(
	fetchFn: typeof fetch,
	url: string,
	headers?: Record<string, string>,
	timeoutMs = 5_000,
): Promise<Record<string, unknown> | undefined> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(undefined);
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			(async () => {
				const response = await fetchFn(url, {
					method: "GET",
					headers: headers ?? {},
					signal: controller.signal,
				});
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					return undefined;
				}
				return (await response.json()) as Record<string, unknown>;
			})(),
			expiry,
		]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Ask the server whether it is still the one this process's pools on `root`
 * were made on, and start a new generation if it is not.
 *
 * Two signals, whichever the build gives: its identity in `/props` (see
 * {@link polykvServerIdentity}) changing, or `/polykv/pools` no longer holding
 * a pool we made as we made it. Asked at most every
 * {@link POLYKV_VERIFY_INTERVAL_MS} per root, and at once when a fault made
 * the root suspect. A suspect root that cannot be asked is rebuilt: a rebuilt
 * pool costs a prefill, a stale id can attach an agent to someone else's.
 */
export async function verifyPolykvRoot(
	root: string,
	fetchFn: typeof fetch,
	headers?: Record<string, string>,
): Promise<void> {
	const state = rootState(root);
	if (
		!state.suspect &&
		Date.now() - state.checkedAt < POLYKV_VERIFY_INTERVAL_MS
	) {
		return;
	}
	if (state.checking) {
		return state.checking;
	}
	state.checking = (async () => {
		const held = heldPools(root, state.suspect);
		const [props, listing] = await Promise.all([
			readRootJson(fetchFn, `${root}/props`, headers),
			held.length > 0
				? readRootJson(fetchFn, `${root}/polykv/pools`, headers)
				: Promise.resolve(undefined),
		]);
		// `/health` is asked only for what `/props` did not say: the boot
		// fields, on a build that puts them there alone.
		const health =
			props && polykvServerIdentity(props)?.startsWith("boot:")
				? undefined
				: await readRootJson(fetchFn, `${root}/health`, headers);
		state.checkedAt = Date.now();
		const identity =
			props || health ? polykvServerIdentity(props, health) : undefined;
		let reason: string | undefined;
		// Compared only kind to kind: a `/health` that did not answer this once
		// drops the boot fields it carries, and falling back to the `/props`
		// fields is not a new server. A build that gains the boot fields is
		// re-baselined, never read as a restart.
		const kind = (value: string) => value.slice(0, value.indexOf(":"));
		if (
			identity !== undefined &&
			state.identity !== undefined &&
			kind(identity) === kind(state.identity) &&
			identity !== state.identity
		) {
			reason = "its identity in /props changed";
		}
		// The generation's boot id, from a header seen before any /props read,
		// against the one /props states now.
		const bootId = readBootId(props, health);
		if (
			!reason &&
			bootId !== undefined &&
			state.bootId !== undefined &&
			bootId !== state.bootId
		) {
			reason = "its boot id changed";
		}
		if (
			identity !== undefined &&
			(state.identity === undefined ||
				kind(identity) === "boot" ||
				kind(state.identity) !== "boot")
		) {
			state.identity = identity;
		}
		// Pools gone from a server that did not restart are an owner that
		// lapsed: the engine releases an allocation idle past its TTL, and its
		// pools with it. That costs that owner's agents their pools and no one
		// else's. Read as a restart, it cost every agent on the server its
		// owner -- bs2 8244 2026-09-26: 26 lapses, 51 owners in two hours, the
		// same 34k-token chain built once per owner, and the abandoned owners'
		// windows booked until they lapsed in turn.
		let lapsed: Set<string> | undefined;
		if (!reason && held.length > 0 && listing) {
			const gone = poolsNotListed(listing, held);
			if (gone && gone.size > 0) {
				const sameBoot =
					bootId !== undefined &&
					state.bootId !== undefined &&
					bootId === state.bootId;
				if (sameBoot) {
					lapsed = gone;
				} else {
					reason = "the pools this process made are gone";
				}
			}
		}
		// A suspect root whose listing did not answer. The boot id settles it
		// when the server states one: the same boot is the same process, and
		// a listing that did not answer a busy engine in time is a missed
		// check -- pandorum 2026-09-26, 4.100.206: 17 agents told their
		// server restarted, every owner abandoned, and the swarm waited ten
		// minutes for cells the abandoned owners still held. Nothing
		// answering at all leaves the root suspect, asked again on the next
		// attach. Only a server that answers without a boot id to compare is
		// rebuilt on suspicion alone.
		let stillSuspect = false;
		if (!reason && state.suspect && held.length > 0 && !listing) {
			const sameBoot =
				bootId !== undefined &&
				state.bootId !== undefined &&
				bootId === state.bootId;
			if (!props && !health) {
				stillSuspect = true;
			} else if (!sameBoot) {
				reason = "a fault, and its pools could not be confirmed";
			}
		}
		state.suspect = stillSuspect;
		if (reason) {
			invalidatePolykvRoot(root, reason);
		} else if (lapsed && invalidateLapsedOwners(root, lapsed) === false) {
			// A pool gone that no owner of the swarm held -- the lead's -- is
			// dropped with the root, as before, but not called a restart.
			invalidatePolykvRoot(root, "pools gone", {
				text: `Pools this process made on ${root} are gone, though the server did not restart: this agent's shared pools are rebuilt under a new owner on its next turn.`,
			});
		}
		if (bootId !== undefined) {
			adoptBootId(state, bootId);
		}
	})().finally(() => {
		state.checking = undefined;
	});
	return state.checking;
}

function groupFor(
	spec: PolykvWorkerSpec,
	baseUrl: string,
	fetchFn: typeof fetch,
	headers?: Record<string, string>,
): SwarmGroup {
	const root = polykvRoot(baseUrl);
	// A borrowed owner is its own group: its agents must never be moved to,
	// or opened beside, an owner the swarm opened -- and the swarm's owners
	// must never be handed the lead's window.
	const key = spec.owner
		? `${root}\n${spec.group}\nlead:${engineSessionId(spec.owner)}`
		: `${root}\n${spec.group}`;
	let group = GROUPS.get(key);
	if (!group) {
		group = {
			key,
			root,
			client: createPolykvClient({
				baseUrl: root,
				fetch: fetchFn,
				...(headers ? { headers } : {}),
			}),
			fetch: fetchFn,
			...(headers ? { headers } : {}),
			shards: [],
			assigned: new Map(),
			awaitingOwner: new Set(),
		};
		GROUPS.set(key, group);
	}
	ensureOwnerKeepalive(group);
	return group;
}

/**
 * Owner engine session -> the owner this process opened under that id.
 *
 * What a resize of an owner is bounded by (`kv_resize_v1`): an owner is the
 * booking its pooled agents live in, so it is the owner that shrinks under
 * pressure and grows back -- never below the floor its agents are owed,
 * never above the window it asked for. Only owners this module opened are
 * here: the lead's own session lent to priority-0 agents is the lead's to
 * resize.
 */
const OWNER_SHARDS = new Map<string, OwnerShard>();

/**
 * The bounds of an owner this process opened, by its engine session id.
 *
 * The floor is every agent on it at its own floor -- one agent's floor times
 * the agents it carries now (never less than the floor it opened at, never
 * above the ceiling): a pressure shrink that left four agents one agent's
 * floor would starve three of them.
 */
export function polykvOwnerWindowBounds(
	ownerSessionId: string,
): { floor: number; ceiling: number } | undefined {
	const shard = OWNER_SHARDS.get(ownerSessionId);
	if (!shard || shard.ceiling === undefined || shard.windowMin === undefined) {
		return undefined;
	}
	const ceiling = shard.ceiling;
	const perAgentFloor = shard.perAgent?.floor ?? shard.windowMin;
	const floor = Math.min(
		ceiling,
		Math.max(shard.windowMin, shard.agents.size * perAgentFloor),
	);
	return { floor, ceiling };
}

/**
 * The engine resized an owner (a pressure shrink or grow-back): the agents it
 * carries follow the window it holds now.
 */
export function notePolykvOwnerWindow(
	ownerSessionId: string,
	window: number,
): void {
	const shard = OWNER_SHARDS.get(ownerSessionId);
	if (shard && Number.isFinite(window) && window > 0) {
		shard.window = window;
	}
}

/**
 * What an owner asks the engine for: every agent it can carry at the node's
 * window, capped at the engine's per-session maximum.
 *
 * The engine charges each pooled worker's private cells to its owner
 * (`oc_alloc_tree_used`: a slot's tokens minus what it shares from a pool),
 * so an owner booked at one agent's window has to hold every one of its
 * workers in it. Live on 8244 (b108, 2026-09-25): 64k owners refused their
 * second and third worker ("session allocation full (worker of ...)") with
 * 786k base cells free. The node window is the budget PER AGENT; an owner
 * carries `agents` of them. The floor is one agent's: an owner granted less
 * carries the agent that opened it, and the capacity check below keeps the
 * others off it.
 */
export function polykvOwnerBooking(
	perAgent: { ask: number; floor: number },
	maximum: number,
): { window: number; windowMin: number; agents: number } {
	const ask = Math.max(1, Math.min(perAgent.ask, maximum));
	const agents = Math.max(1, Math.floor(maximum / ask));
	const window = Math.max(perAgent.floor, Math.min(maximum, agents * ask));
	return { window, windowMin: Math.min(window, perAgent.floor), agents };
}

/**
 * How many agents an owner of `window` cells carries at `ask` each.
 *
 * `sharedPrefix` is the prefix every agent on it shares from its pools: the
 * engine charges it once, to the pool, and each worker only for what is past
 * it. Never less than one: an owner is never opened for nobody, and the agent
 * that opened it keeps it whatever it was granted.
 */
export function polykvOwnerAgentCapacity(
	window: number,
	ask: number,
	sharedPrefix = 0,
): number {
	if (!(ask > 0) || !(window > 0)) {
		return 1;
	}
	const prefix = Math.max(0, Math.min(sharedPrefix, ask - 1));
	return Math.max(1, Math.floor((window - prefix) / (ask - prefix)));
}

/** The cells an owner needs to carry `agents` at `ask`, the prefix once. */
function ownerWindowFor(agents: number, ask: number, sharedPrefix: number) {
	const prefix = Math.max(0, Math.min(sharedPrefix, ask - 1));
	return prefix + agents * (ask - prefix);
}

/**
 * The prefix every agent on this owner shares: its shortest pool, the root.
 * `0` until one is built -- the capacity is then counted conservatively.
 */
function ownerSharedPrefix(shard: OwnerShard): number {
	let shortest: number | undefined;
	for (const record of shard.records.values()) {
		if (typeof record.prefixLen === "number" && record.prefixLen > 0) {
			shortest =
				shortest === undefined
					? record.prefixLen
					: Math.min(shortest, record.prefixLen);
		}
	}
	return shortest ?? 0;
}

/** How many agents this owner carries at the window it holds now. */
function ownerCapacity(shard: OwnerShard): number {
	if (!shard.perAgent || shard.window === undefined) {
		return Number.POSITIVE_INFINITY;
	}
	return polykvOwnerAgentCapacity(
		shard.window,
		shard.perAgent.ask,
		ownerSharedPrefix(shard),
	);
}

/** Resize targets are whole multiples of this, as the engine's grants are. */
const OWNER_RESIZE_ALIGN = 256;
const alignUp = (value: number): number =>
	Math.ceil(value / OWNER_RESIZE_ALIGN) * OWNER_RESIZE_ALIGN;

/**
 * Grow an owner this process opened to `target` cells (`kv_resize_v1`).
 * `true` when the engine took it. Never throws: a refusal -- busy with its
 * workers' requests, no room, no resize on this server -- is `false`, and
 * the caller places the agent elsewhere or waits.
 *
 * `defer`: where the server offers `kv_resize_deferred_v1`, a busy owner
 * queues the grow for its idle moment instead of refusing it -- still
 * `false` here (nothing is applied yet), and a grow already queued at least
 * this big is not asked again.
 */
async function growOwner(
	group: SwarmGroup,
	shard: OwnerShard,
	target: number,
	defer = false,
): Promise<boolean> {
	if (
		shard.closed ||
		shard.borrowed ||
		shard.growing ||
		shard.window === undefined ||
		shard.maximum === undefined ||
		target <= shard.window ||
		target > shard.maximum
	) {
		return false;
	}
	const props = await probeOpencotiProps(group.root, group.fetch).catch(
		() => undefined,
	);
	if (!hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.kvResize)) {
		return false;
	}
	const deferred =
		defer &&
		hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.kvResizeDeferred);
	const queued = deferred
		? opencotiPendingResize(group.root, shard.sessionId)
		: undefined;
	if (queued !== undefined && queued >= target) {
		// Already queued for the owner's idle moment: the same decision again
		// would only overwrite it with itself.
		return false;
	}
	shard.growing = true;
	try {
		const answer = await resizeOpencotiSession({
			baseUrl: group.root,
			sessionId: shard.sessionId,
			numCtx: target,
			...(deferred ? { deferred: true } : {}),
			fetch: group.fetch,
			...(group.headers ? { headers: group.headers } : {}),
		});
		if (!answer.ok && answer.kind === "deferred") {
			return false;
		}
		if (!answer.ok) {
			shard.growRefusedAt = Date.now();
			return false;
		}
		shard.window = answer.windowNew;
		shard.ceiling = Math.max(shard.ceiling ?? 0, answer.windowNew);
		shard.growRefusedAt = undefined;
		return true;
	} finally {
		shard.growing = false;
	}
}

/**
 * Make room on an open owner for one more agent by growing it, where the
 * engine allows: an owner granted less than it asked, or shrunk under
 * pressure. `true` when one grew; the caller looks for room again.
 *
 * The engine resizes only between an owner's requests -- any running worker
 * of it answers `session_busy` -- so this mostly succeeds on an owner whose
 * agents are all in their tools. A refused owner is not asked again for
 * {@link POLYKV_LAYER_RETRY_MS}.
 */
async function growOwnerForAgent(
	group: SwarmGroup,
	open: OwnerShard[],
): Promise<boolean> {
	const now = Date.now();
	for (const shard of open) {
		if (
			!shard.perAgent ||
			shard.borrowed ||
			(shard.growRefusedAt !== undefined &&
				now - shard.growRefusedAt < POLYKV_LAYER_RETRY_MS)
		) {
			continue;
		}
		const target = alignUp(
			ownerWindowFor(
				shard.agents.size + 1,
				shard.perAgent.ask,
				ownerSharedPrefix(shard),
			),
		);
		if (await growOwner(group, shard, target)) {
			return true;
		}
	}
	return false;
}

/**
 * The owner a new agent goes on, with the agent already counted on it.
 *
 * The newest open owner with room for one more at the node's window; else an
 * open owner grown by one agent; else a new owner, waiting for room on the
 * engine as long as it takes (agents retry, never fail). The seat is taken
 * here, synchronously after the check, so agents arriving together never
 * over-fill one owner between the check and the assignment.
 */
async function placeAgent(
	group: SwarmGroup,
	spec: PolykvWorkerSpec,
	body: Record<string, unknown>,
	signal: AbortSignal | null | undefined,
): Promise<OwnerShard | undefined> {
	const take = (shard: OwnerShard): OwnerShard => {
		const previous = group.assigned.get(spec.sessionId);
		if (previous && previous !== shard) {
			previous.agents.delete(spec.sessionId);
			previous.uses?.delete(spec.sessionId);
		}
		group.assigned.set(spec.sessionId, shard);
		shard.agents.add(spec.sessionId);
		return shard;
	};
	const roomy = (shard: OwnerShard) =>
		!shard.closed && shard.agents.size < ownerCapacity(shard);
	while (true) {
		const open = [...group.shards]
			.reverse()
			.filter((candidate) => !candidate.closed && !candidate.borrowed);
		const found = open.find(roomy);
		if (found) {
			return take(found);
		}
		if (await growOwnerForAgent(group, open)) {
			continue;
		}
		const opened = await awaitOwner(group, spec.sessionId, () =>
			openShard(group, body, signal, true, spec.window),
		);
		if (!opened) {
			return undefined;
		}
		if (roomy(opened)) {
			return take(opened);
		}
		// Others waiting on the same open took its seats: look again.
	}
}

/**
 * The owner parsed from a worker's session-full refusal, and by how much it
 * is short: `session allocation full (worker of '<owner>': <free> of <cells>
 * cells free, needs <need>)`.
 */
export function parseWorkerWindowFull(
	text: string,
): { owner: string; free: number; cells: number; needs: number } | undefined {
	const match =
		/session allocation full \(worker of '([^']+)': (\d+) of (\d+) cells free, needs (\d+)\)/i.exec(
			text,
		);
	if (!match) {
		return undefined;
	}
	return {
		owner: match[1] as string,
		free: Number(match[2]),
		cells: Number(match[3]),
		needs: Number(match[4]),
	};
}

/**
 * A worker was refused because its owner's window is full -- not because the
 * server is: grow that owner by the shortfall so the worker fits.
 *
 * The engine prices a worker at its private cells (its prompt and declared
 * reply past the pool it attaches to) against the owner's free cells, and
 * such a refusal asks nothing of the base pool (`refused_needed_max_60s` 0):
 * the cells are there, the owner's booking is what is short. The answer is
 * a bigger owner, never compacting everyone. Bounded by the engine's
 * per-session maximum; the resize itself is bounded by the free base cells
 * (a 429 there means the server really is full, and the worker waits).
 * `true` when the owner grew and the worker should be sent again.
 */
export async function growPolykvOwnerForWorker(
	sessionId: string,
	refusalText: string,
): Promise<boolean> {
	const refusal = parseWorkerWindowFull(refusalText);
	if (!refusal) {
		return false;
	}
	const group = AGENT_GROUPS.get(sessionId);
	const shard = OWNER_SHARDS.get(refusal.owner);
	if (
		!group ||
		!shard ||
		shard.closed ||
		shard.borrowed ||
		!group.shards.includes(shard)
	) {
		return false;
	}
	const shortfall = refusal.needs - refusal.free;
	if (shortfall <= 0) {
		return false;
	}
	const current = Math.max(refusal.cells, shard.window ?? 0);
	shard.window = current;
	const target = alignUp(refusal.cells + shortfall);
	if (target <= current) {
		// Grown meanwhile by another refused worker: send it again.
		return true;
	}
	return growOwner(group, shard, target, true);
}

/** The model's own per-session maximum, which is what an owner asks for. */
async function sessionContextMax(group: SwarmGroup): Promise<number> {
	try {
		const response = await group.fetch(`${group.root}/kv`, {
			headers: group.headers ?? {},
		});
		const body = (await response.json()) as { session_ctx_max?: unknown };
		if (typeof body.session_ctx_max === "number" && body.session_ctx_max > 0) {
			return body.session_ctx_max;
		}
	} catch {
		// Falls through to the floor: an owner that asks for less than the
		// engine could give still works, and the engine clamps anyway.
	}
	return POLYKV_OWNER_MIN_WINDOW;
}

/**
 * Open an owner: a one-token request that books a window under a new id.
 *
 * `num_ctx` is the model's maximum and `num_ctx_min` the floor, so the engine
 * settles the grant in one admission -- the largest window that fits right
 * now, or a 429 naming when to come back. The size is the engine's decision,
 * which is the point: nothing on this side knows how many other sessions the
 * cells are owed to.
 */
async function openOwner(
	group: SwarmGroup,
	body: Record<string, unknown>,
	signal: AbortSignal | null | undefined,
	/**
	 * Queue for room when the engine has none. Off for an extra owner: that is
	 * an offer, and a refused one means "wait on the owner you have".
	 */
	waitForRoom: boolean,
	/** The opening agent's node window; see {@link PolykvWorkerSpec.window}. */
	agentWindow?: { ask: number; floor: number },
): Promise<OwnerShard | undefined> {
	const messages = body.messages as Array<Record<string, unknown>>;
	const system = messages[0];
	const name = group.key.split("\n")[1] ?? "";
	const serial = (OWNER_SERIALS.get(name) ?? 0) + 1;
	OWNER_SERIALS.set(name, serial);
	const sessionId = engineSessionId(`${name}~polykv-owner-${serial}`);
	const generation = polykvRootGeneration(group.root);
	const maximum = await sessionContextMax(group);
	// Sized from the agents it hosts, where their node states a window: every
	// agent it can carry at the node's window (the engine's maximum at most),
	// floored at the opening agent's share -- see polykvOwnerBooking. Without
	// one, the engine's maximum floored at the owner minimum, as before.
	const booking = agentWindow
		? polykvOwnerBooking(agentWindow, maximum)
		: undefined;
	const window = booking ? booking.window : maximum;
	const windowMin = booking
		? booking.windowMin
		: Math.min(window, POLYKV_OWNER_MIN_WINDOW);
	let waits = 0;
	while (true) {
		const response = await group.fetch(`${group.root}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(group.headers ?? {}) },
			body: JSON.stringify({
				...(body.model !== undefined ? { model: body.model } : {}),
				messages: [system, { role: "user", content: "." }],
				...(body.tools !== undefined ? { tools: body.tools } : {}),
				session_id: sessionId,
				num_ctx: window,
				num_ctx_min: windowMin,
				max_tokens: 1,
				stream: false,
			}),
			...(signal ? { signal } : {}),
		});
		if (response.status === 429) {
			// Every admission refusal says how hard the server is refusing
			// (`kv_pressure_v1`): news for every running agent there.
			noteOpencotiRefusalPressure(
				group.root,
				await response.text().catch(() => ""),
			);
		} else {
			await response.body?.cancel().catch(() => {});
		}
		if (response.ok) {
			// The window the engine granted, which may be less than asked:
			// what the agents on this owner are counted against.
			const granted = Number(response.headers.get("x-context-window"));
			if (polykvRootGeneration(group.root) !== generation) {
				// The server restarted while this owner was being opened: it
				// belongs to a generation nothing may attach to any more.
				return undefined;
			}
			const shard: OwnerShard = {
				sessionId,
				pools: new Map(),
				records: new Map(),
				agents: new Set(),
				closed: false,
				window: Number.isFinite(granted) && granted > 0 ? granted : window,
				ceiling: window,
				windowMin,
				maximum,
				...(agentWindow
					? {
							perAgent: {
								ask: Math.min(agentWindow.ask, maximum),
								floor: agentWindow.floor,
							},
						}
					: {}),
			};
			group.shards.push(shard);
			OWNER_SHARDS.set(sessionId, shard);
			return shard;
		}
		if (response.status !== 429 || !waitForRoom) {
			return undefined;
		}
		const wait = Number(response.headers.get("retry-after"));
		waits += 1;
		for (const agent of group.awaitingOwner) {
			reportPolykvRoomWait(agent, {
				waiting: true,
				reason:
					"Waiting for room on the server: every cell is booked, so a new window for this swarm cannot open yet.",
			});
		}
		await sleep(
			polykvRoomBackoffMs(
				waits,
				Number.isFinite(wait) && wait > 0 ? wait * 1000 : 2000,
			),
			signal,
		);
	}
}

/**
 * Fields of a chat request that are not how its prompt renders, or that name
 * this request's own session and pool.
 */
const NOT_TEMPLATE_FIELDS = new Set([
	"messages",
	"tools",
	"model",
	"stream",
	"stream_options",
	"session_id",
	"pool_id",
	"num_ctx",
	"num_ctx_min",
	"shared_prefix_n_tokens",
	"overcommit",
]);

/**
 * The fields of `body` a pool's rendering must be given, so that it renders
 * the prompt the way the server will render this request.
 *
 * Everything but the conversation and this request's own session, rather than
 * a list of the fields known to matter: the server parses `/apply-template`
 * with the chat request's own parser, and a field left out is one more way for
 * the two to disagree. The one that did, on 8240 2026-09-24:
 * `reasoning_budget_tokens: 0` renders Gemma-4's system turn without
 * `<|think|>`, and the pool, rendered without it, had the flag. Every worker
 * request diverged from its pool at token 4 -- 20 attaches of 20 -- and
 * prefilled its whole ~5.6k-token prompt on every turn.
 */
export function templateFieldsOf(
	body: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(body)) {
		if (!NOT_TEMPLATE_FIELDS.has(name) && value !== undefined) {
			fields[name] = value;
		}
	}
	return fields;
}

/**
 * What in `fields` can change a rendering, for keying pools by it.
 *
 * Not the fields themselves: a request's budget is a share of its output cap,
 * so it moves turn by turn, and a pool keyed on the number would be rebuilt
 * whenever it did. What renders differently is whether there is one -- `0`
 * drops the thinking flag, any other count keeps it (measured on 8240).
 */
export function templateSignature(
	fields: Readonly<Record<string, unknown>>,
): string {
	const budget = (value: unknown) =>
		value === undefined ? undefined : value === 0 ? 0 : "on";
	return JSON.stringify([
		fields.chat_template_kwargs,
		fields.reasoning_effort,
		fields.reasoning_format,
		fields.enable_thinking,
		budget(fields.reasoning_budget_tokens),
		budget(fields.reasoning_budget),
		budget(fields.thinking_budget_tokens),
	]);
}

/**
 * The layer's prefix: the conversation so far, rendered by the server, up to
 * and including the opener of the turn that follows it.
 *
 * `fields` are the request's own (`templateFieldsOf`): a layer rendered
 * without them is a different prompt from the one the request renders to.
 */
export async function renderLayer(
	client: PolykvClient,
	messages: readonly unknown[],
	tools: readonly unknown[] | undefined,
	fields?: Readonly<Record<string, unknown>>,
): Promise<string | undefined> {
	const rendered = await client.applyTemplate({
		messages: [...messages, { role: "user", content: SENTINEL }],
		...(tools ? { tools } : {}),
		...(fields ? { fields } : {}),
	});
	const at = rendered.indexOf(SENTINEL);
	return at > 0 ? rendered.slice(0, at) : undefined;
}

/**
 * How long a layer the engine refused is left alone before it is asked again.
 *
 * A refusal is a state of the owner -- its sub-pools, its window -- that
 * changes as agents end, so it is never remembered for good; this is only
 * the guard against every turn of every agent asking in a tight loop.
 */
export const POLYKV_LAYER_RETRY_MS = 5_000;

/**
 * Whether the engine refused a pool create for want of room: in its owner (the
 * sub-pool limit, a full allocation), or in the KV cache for the prefill --
 * b137 (patch 0412) answers that `503` "no room in the KV cache for the pool
 * prefill" where b133 answered `500`. Each is met the same way: release what
 * the owner holds for nobody, and create again.
 */
export function isPolykvNoRoomRefusal(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return /sub-pool limit reached|session allocation full \('|no room in the KV cache/i.test(
		text,
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Give back what an owner at its sub-pool limit holds that nobody needs,
 * children first, and say how many pools went.
 *
 * Two kinds, in this order:
 *
 * 1. Pools the server lists under this owner that this process never made --
 *    a previous extension process's chain under the same name, or a create
 *    whose answer was lost. Nothing here can attach to them.
 * 2. Only if there are none: this owner's own chains that no agent on it
 *    resolved on its last request -- the tree of a role whose agents have all
 *    ended while the owner stays up for others.
 *
 * Never on a borrowed owner: the lead's session holds the conversation's own
 * pools too, and those are not the swarm's to judge. Single-flight per
 * owner, and it waits out the creates already in flight first, so a pool
 * made a moment ago is not read as nobody's.
 */
function reclaimOwnerPools(
	group: SwarmGroup,
	shard: OwnerShard,
	keep: string | undefined,
): Promise<number> {
	if (shard.borrowed) {
		return Promise.resolve(0);
	}
	shard.reclaiming ??= (async () => {
		await Promise.allSettled([...(shard.creating?.keys() ?? [])]);
		const listing = await readRootJson(
			group.fetch,
			`${group.root}/polykv/pools`,
			group.headers,
		);
		const entries = (
			Array.isArray(listing?.pools) ? listing.pools : []
		) as Array<Record<string, unknown>>;
		const listedParent = new Map<string, string | undefined>();
		for (const entry of entries) {
			if (entry?.pool_id !== undefined && entry.pool_id !== null) {
				listedParent.set(
					String(entry.pool_id),
					typeof entry.parent === "number" && entry.parent >= 0
						? String(entry.parent)
						: undefined,
				);
			}
		}
		const parentOf = (id: string) =>
			shard.records.get(id)?.parent ?? listedParent.get(id);
		const ancestry = (id: string | undefined, into: Set<string>) => {
			for (
				let at = id, hops = 0;
				at !== undefined && !into.has(at) && hops < 64;
				at = parentOf(at), hops += 1
			) {
				into.add(at);
			}
		};
		// What must stay: the chain the failed build forks from, and the
		// parents of any create still in flight.
		const kept = new Set<string>();
		ancestry(keep, kept);
		for (const parent of shard.creating?.values() ?? []) {
			ancestry(parent, kept);
		}
		let victims = entries
			.filter(
				(entry) =>
					entry?.owner === shard.sessionId &&
					entry.pool_id !== undefined &&
					entry.pool_id !== null,
			)
			.map((entry) => String(entry.pool_id))
			.filter((id) => !shard.records.has(id) && !kept.has(id));
		if (victims.length === 0) {
			const used = new Set(kept);
			for (const keys of shard.uses?.values() ?? []) {
				for (const key of keys) {
					ancestry(shard.settled?.get(key), used);
				}
			}
			const spare = new Set<string>();
			for (const [key, id] of [...(shard.settled ?? [])]) {
				if (id !== undefined && !used.has(id)) {
					spare.add(id);
					// Forgotten now, before the releases: an agent that asks for
					// this layer meanwhile builds it again rather than attach to
					// a pool on its way out.
					shard.pools.delete(key);
					shard.settled?.delete(key);
					shard.prompts?.delete(key);
				}
			}
			victims = [...spare];
		}
		const depth = (id: string) => {
			const chain = new Set<string>();
			ancestry(id, chain);
			return chain.size;
		};
		victims.sort((a, b) => depth(b) - depth(a));
		let released = 0;
		for (const id of victims) {
			await group.client.unpin(id).catch(() => undefined);
			try {
				await group.client.releasePool(id);
				released += 1;
			} catch {
				// Gone already, or refused: either way not counted.
			}
			shard.records.delete(id);
		}
		return released;
	})().finally(() => {
		shard.reclaiming = undefined;
	});
	return shard.reclaiming;
}

/** Create or fork one pool on `shard`, known as in flight until it answers. */
function createOnShard(
	group: SwarmGroup,
	shard: OwnerShard,
	parentId: string | undefined,
	prompt: string,
) {
	const body = { prompt, session_id: shard.sessionId, pin: true };
	const call =
		parentId === undefined
			? group.client.createPool(body)
			: group.client.forkPool(parentId, body);
	shard.creating ??= new Map();
	shard.creating.set(call, parentId);
	void call
		.catch(() => undefined)
		.finally(() => {
			shard.creating?.delete(call);
		});
	return call;
}

/**
 * Build one layer's pool: render it, check it is a prefix of the request it
 * is for, create or fork it -- and at the owner's sub-pool limit, release
 * what the owner holds for nobody and create again. Resolves to the pool id,
 * or to `undefined` with the reason in `shard.failed`.
 */
function buildLayer(options: {
	group: SwarmGroup;
	shard: OwnerShard;
	key: string;
	parentId: string | undefined;
	messages: readonly unknown[];
	tools: readonly unknown[] | undefined;
	fields: Readonly<Record<string, unknown>>;
	fullRendering: string;
	admission?: PolykvAdmissionPolicy;
}): Promise<string | undefined> {
	const { group, shard, key, parentId } = options;
	const fail = (reason: string, cooldown: boolean): undefined => {
		shard.failed ??= new Map();
		shard.failed.set(key, {
			at: cooldown ? Date.now() : Number.NEGATIVE_INFINITY,
			reason,
		});
		return undefined;
	};
	return (async () => {
		let prompt: string | undefined;
		try {
			prompt = await renderLayer(
				group.client,
				options.messages,
				options.tools,
				options.fields,
			);
		} catch (error) {
			return fail(`the layer could not be rendered: ${errorText(error)}`, true);
		}
		if (!prompt || !options.fullRendering.startsWith(prompt)) {
			// This request's; the next one is checked on its own.
			return fail(
				"the layer's rendering is not a prefix of the request's",
				false,
			);
		}
		let pool: Awaited<ReturnType<PolykvClient["createPool"]>>;
		try {
			pool = await createOnShard(group, shard, parentId, prompt);
		} catch (error) {
			if (!isPolykvNoRoomRefusal(error)) {
				return fail(`the engine refused the pool: ${errorText(error)}`, true);
			}
			const released = await reclaimOwnerPools(group, shard, parentId).catch(
				() => 0,
			);
			if (released === 0) {
				return fail(
					`${errorText(error)} (owner ${shard.sessionId}: nothing it holds is spare)`,
					true,
				);
			}
			try {
				pool = await createOnShard(group, shard, parentId, prompt);
			} catch (retry) {
				return fail(
					`the engine refused the pool again after ${released} of owner ${shard.sessionId}'s spare pools were released: ${errorText(retry)}`,
					true,
				);
			}
		}
		shard.failed?.delete(key);
		if (options.admission) {
			// A pool without its policy still shares; one refused
			// policy must not cost the tree.
			await group.client
				.setAdmission(pool.pool_id, options.admission)
				.catch(() => undefined);
		}
		shard.records.set(String(pool.pool_id), {
			...(parentId !== undefined ? { parent: parentId } : {}),
			...(typeof pool.prefix_len === "number"
				? { prefixLen: pool.prefix_len }
				: {}),
		});
		shard.prompts ??= new Map();
		shard.prompts.set(key, prompt);
		return pool.pool_id;
	})().catch((error: unknown) =>
		fail(`the layer could not be built: ${errorText(error)}`, true),
	);
}

/** What {@link ensureChain} resolved for one request. */
interface ChainResult {
	/** The deepest pool the request can attach to. */
	poolId?: string;
	/** The layer keys it resolved, root first. */
	keys: string[];
	/** Why the chain stopped short of the layers asked for. */
	reason?: string;
}

/**
 * The pool for `layer` of this request on `shard`, creating the chain to it.
 *
 * One build per layer key per owner, however many agents ask at once: the
 * first one's promise is what the rest await (single-flight). Returns the
 * deepest pool that could be made. A layer the engine refuses stops the chain
 * there, and the worker attaches to its parent -- sharing less is still
 * sharing -- with the reason, and the layer is asked again later.
 */
async function ensureChain(
	group: SwarmGroup,
	shard: OwnerShard,
	agent: string,
	body: Record<string, unknown>,
	layers: number,
	fullRendering: string,
	admission?: PolykvAdmissionPolicy,
): Promise<ChainResult> {
	const messages = body.messages as unknown[];
	const tools = body.tools as unknown[] | undefined;
	let parent: string | undefined;
	const fields = templateFieldsOf(body);
	let key = hashString(
		JSON.stringify([body.model ?? "", tools ?? [], templateSignature(fields)]),
	);
	const keys: string[] = [];
	// What this agent resolved last time stays counted as in use until this
	// resolve is done, so a reclaim meanwhile does not take it.
	const before = shard.uses?.get(agent) ?? [];
	const using = (resolved: string[]) => {
		shard.uses ??= new Map();
		shard.uses.set(agent, resolved);
	};
	const done = (result: Omit<ChainResult, "keys">): ChainResult => {
		using(keys);
		return { ...result, keys };
	};
	for (let depth = 0; depth <= layers; depth++) {
		key = hashString(`${key}\n${JSON.stringify(messages[depth])}`);
		let pending = shard.pools.get(key);
		if (!pending) {
			const failed = shard.failed?.get(key);
			if (failed && Date.now() - failed.at < POLYKV_LAYER_RETRY_MS) {
				return done({ poolId: parent, reason: failed.reason });
			}
		}
		if (
			!pending &&
			shard.borrowed &&
			shard.pools.size >= POLYKV_LEAD_WORKER_POOL_MAX
		) {
			// The lead's session has a sub-pool limit, and its own conversation
			// needs one of them: share what is already built instead.
			return done({
				poolId: parent,
				reason: `the lead's session already holds ${POLYKV_LEAD_WORKER_POOL_MAX} of the swarm's pools`,
			});
		}
		if (!pending) {
			pending = buildLayer({
				group,
				shard,
				key,
				parentId: parent,
				messages: messages.slice(0, depth + 1),
				tools,
				fields,
				fullRendering,
				...(admission ? { admission } : {}),
			});
			shard.pools.set(key, pending);
			const settling = pending;
			void settling.then((id) => {
				if (shard.pools.get(key) === settling) {
					shard.settled ??= new Map();
					shard.settled.set(key, id);
				}
			});
		}
		const poolId = await pending;
		if (poolId === undefined) {
			if (shard.pools.get(key) === pending) {
				// Not remembered as "no pool": the next agent asks again (after
				// the cooldown, for a refusal) instead of inheriting this one's.
				shard.pools.delete(key);
				shard.settled?.delete(key);
			}
			return done({
				poolId: parent,
				reason: shard.failed?.get(key)?.reason ?? "the layer was not pooled",
			});
		}
		const prompt = shard.prompts?.get(key);
		if (prompt !== undefined && !fullRendering.startsWith(prompt)) {
			// Built for another agent's request, and this one renders it
			// otherwise: attaching it would share nothing.
			return done({
				poolId: parent,
				reason: `layer ${depth} is not a prefix of this request's rendering`,
			});
		}
		keys.push(key);
		using([...new Set([...before, ...keys])]);
		parent = poolId;
	}
	return done({ poolId: parent });
}

/**
 * The lead's own session as this group's one owner, with the agent on it.
 *
 * Made on first use and again after its last agent released it; it is never
 * opened (the lead's window already exists) and never closed from here.
 */
function lendLeadShard(
	group: SwarmGroup,
	agentSessionId: string,
	owner: string,
): OwnerShard {
	let lent = group.shards.find((candidate) => !candidate.closed);
	if (!lent) {
		lent = {
			sessionId: engineSessionId(owner),
			pools: new Map(),
			records: new Map(),
			agents: new Set(),
			closed: false,
			borrowed: true,
		};
		group.shards.push(lent);
	}
	const previous = group.assigned.get(agentSessionId);
	if (previous !== lent) {
		previous?.agents.delete(agentSessionId);
		group.assigned.set(agentSessionId, lent);
		lent.agents.add(agentSessionId);
	}
	return lent;
}

/** Wait on an owner opening, as one of the agents that will be told if it stalls. */
async function awaitOwner<T>(
	group: SwarmGroup,
	sessionId: string,
	open: () => Promise<T>,
): Promise<T> {
	group.awaitingOwner.add(sessionId);
	try {
		return await open();
	} finally {
		group.awaitingOwner.delete(sessionId);
	}
}

function openShard(
	group: SwarmGroup,
	body: Record<string, unknown>,
	signal: AbortSignal | null | undefined,
	waitForRoom = true,
	agentWindow?: { ask: number; floor: number },
): Promise<OwnerShard | undefined> {
	group.opening ??= openOwner(
		group,
		body,
		signal,
		waitForRoom,
		agentWindow,
	).finally(() => {
		group.opening = undefined;
	});
	return group.opening;
}

/**
 * Where this agent's request attaches, creating what it needs.
 *
 * `undefined` pool means "run unpooled": no owner could be opened, or the
 * request is not shaped `[system, ...layers, task]`. The request then goes out
 * as an ordinary session of its own, which is slower, never wrong.
 */
export async function preparePolykvWorker(options: {
	spec: PolykvWorkerSpec;
	baseUrl: string;
	fetch: typeof fetch;
	headers?: Record<string, string>;
	body: Record<string, unknown>;
	signal?: AbortSignal | null;
	/** Start on a fresh owner: the current one refused this agent. */
	fresh?: boolean;
}): Promise<PolykvWorkerAttach> {
	const root = polykvRoot(options.baseUrl);
	// Is the server the one these pools were made on? Asked on reattach --
	// an agent coming back from its tools may find the server restarted
	// under it -- and settled before anything is resolved from the cache.
	await verifyPolykvRoot(root, options.fetch, options.headers);
	// A restart found by another agent while this one resolved is a pool id
	// from a boot that is gone: resolve again against the new generation.
	for (let tries = 0; tries < 3; tries += 1) {
		const generation = polykvRootGeneration(root);
		const attach = await attachWorker(options);
		if (polykvRootGeneration(root) === generation) {
			noteChargedTo(options.spec.sessionId, attach);
			return attach.poolId === undefined ? attach : { ...attach, generation };
		}
	}
	const unpooled: PolykvWorkerAttach = {
		sessionId: engineSessionId(options.spec.sessionId),
		reason:
			"the server's generation moved on three times while this request resolved its pool",
	};
	noteChargedTo(options.spec.sessionId, unpooled);
	return unpooled;
}

async function attachWorker(options: {
	spec: PolykvWorkerSpec;
	baseUrl: string;
	fetch: typeof fetch;
	headers?: Record<string, string>;
	body: Record<string, unknown>;
	signal?: AbortSignal | null;
	fresh?: boolean;
}): Promise<PolykvWorkerAttach> {
	const { spec, body } = options;
	const group = groupFor(spec, options.baseUrl, options.fetch, options.headers);
	AGENT_GROUPS.set(spec.sessionId, group);
	const sessionId = engineSessionId(spec.sessionId);
	const unpooled = (reason: string): PolykvWorkerAttach => ({
		sessionId,
		reason,
	});
	if (spec.attachOnly) {
		const shard = group.assigned.get(spec.sessionId);
		if (!shard || shard.closed) {
			return unpooled("this agent has no pool tree to attach to yet");
		}
		for (const pending of shard.pools.values()) {
			const poolId = await pending;
			if (poolId !== undefined) {
				return { poolId, sessionId, ownerSessionId: shard.sessionId };
			}
		}
		return unpooled("this agent's owner holds no pool yet");
	}
	const messages = body.messages;
	if (
		!Array.isArray(messages) ||
		messages.length < spec.layers + 2 ||
		(messages[0] as { role?: string })?.role !== "system" ||
		messages
			.slice(1, spec.layers + 1)
			.some((message) => (message as { role?: string })?.role !== "user")
	) {
		return unpooled(
			`the request is not shaped [system, ${spec.layers} shared user turn(s), task]`,
		);
	}
	const current = group.assigned.get(spec.sessionId);
	let shard = options.fresh ? undefined : current;
	if (spec.owner) {
		// Priority 0: the one owner is the lead's session, lent rather than
		// opened. There is no fresh one to try and nothing to open.
		shard = lendLeadShard(group, spec.sessionId, spec.owner);
	} else if (!shard || shard.closed) {
		shard = options.fresh
			? // An extra owner, if the engine has room for one; otherwise the
				// agent keeps its place on the owner it has and waits there.
				((await openShard(group, body, options.signal, false, spec.window)) ??
				(current && !current.closed ? current : undefined))
			: await placeAgent(group, spec, body, options.signal);
		if (!shard) {
			return unpooled(
				options.fresh
					? "the engine has no room for another owner, and this agent has none to keep"
					: "no owner session could be opened for the swarm",
			);
		}
		const previous = group.assigned.get(spec.sessionId);
		if (previous !== shard) {
			previous?.agents.delete(spec.sessionId);
			previous?.uses?.delete(spec.sessionId);
		}
		group.assigned.set(spec.sessionId, shard);
		shard.agents.add(spec.sessionId);
		if (AGENT_GROUPS.get(spec.sessionId) !== group) {
			// Released while it waited for its owner: the release found it on no
			// owner, and adding it now would hold this one open with nobody on
			// it -- booked, with its pools, until the engine's idle TTL.
			await leaveReleasedOwner(group, shard, spec.sessionId);
			return unpooled("this agent was released while its owner opened");
		}
	}
	// On an owner now: off any a restart check abandoned, closing the last.
	leaveAbandoned(spec.sessionId);
	let fullRendering: string;
	try {
		fullRendering = await group.client.applyTemplate({
			messages,
			...(body.tools ? { tools: body.tools as unknown[] } : {}),
			// The request's own fields here as well: the prefix check below is
			// only a check if this is what the server will actually render.
			fields: templateFieldsOf(body),
		});
	} catch (error) {
		return unpooled(
			`the request could not be rendered through /apply-template: ${errorText(error)}`,
		);
	}
	const chain = await ensureChain(
		group,
		shard,
		spec.sessionId,
		body,
		spec.layers,
		fullRendering,
		spec.admission,
	);
	if (chain.poolId === undefined) {
		return unpooled(
			`owner ${shard.sessionId}: ${chain.reason ?? "no layer was pooled"}`,
		);
	}
	return {
		poolId: chain.poolId,
		sessionId,
		ownerSessionId: shard.sessionId,
		...(chain.reason
			? {
					reason: `attached ${chain.keys.length} of ${spec.layers + 1} layers on owner ${shard.sessionId}: ${chain.reason}`,
				}
			: {}),
	};
}

/**
 * A worker refused because its owner's window is full, as the engine words it.
 *
 * Distinct from every other 429 on purpose: this one is a queue on a window
 * other agents are draining, and it may also be answered by opening another
 * owner.
 */
export function isWorkerWindowFull(status: number, text: string): boolean {
	return status === 429 && /session allocation full \(worker of/i.test(text);
}

/**
 * Below this many free cells an owner is not worth moving to: a worker's
 * next request charges its whole prompt, and a sliver of room refuses it again.
 */
export const POLYKV_MOVE_MIN_FREE_CELLS = 16_384;

/**
 * Move a refused worker to the open owner with the most room, if one has more
 * than its own.
 *
 * An agent stays on the owner it started on so its private suffix stays warm
 * -- but that rule, alone, stalled a 75-agent swarm on 2026-09-24: the engine's
 * whole KV was booked by four owners, one of them 77% full and refusing its
 * workers, the other three at 3-8%. The refused agents waited on their own
 * owner for up to fifteen minutes while three quarters of the cells sat idle,
 * and a fresh owner could not open because there were no cells left to book.
 * One full reprocess on a roomier owner is cheaper than that queue.
 *
 * Moving the last agent off an owner closes it, as a release would: its window
 * is then free for an owner that has work.
 */
export async function movePolykvWorker(sessionId: string): Promise<boolean> {
	const group = AGENT_GROUPS.get(sessionId);
	const current = group?.assigned.get(sessionId);
	// A priority-0 agent has one owner, the lead's session, and nowhere to
	// move to: its group holds nothing else.
	if (!group || !current || current.borrowed) {
		return false;
	}
	// Only to an owner with a seat left: moving onto one that carries all its
	// agents already is the refusal this move is escaping, on another owner.
	const open = group.shards.filter(
		(shard) =>
			!shard.closed &&
			shard !== current &&
			shard.agents.size < ownerCapacity(shard),
	);
	if (open.length === 0) {
		return false;
	}
	let allocations: Array<{ key?: unknown; cells?: unknown; used?: unknown }>;
	try {
		const response = await group.fetch(`${group.root}/kv`, {
			headers: group.headers ?? {},
		});
		const body = (await response.json()) as { allocations?: unknown };
		allocations = Array.isArray(body.allocations)
			? (body.allocations as typeof allocations)
			: [];
	} catch {
		return false;
	}
	const freeOf = (shard: OwnerShard): number => {
		const entry = allocations.find((a) => a.key === shard.sessionId);
		const cells = typeof entry?.cells === "number" ? entry.cells : 0;
		const used = typeof entry?.used === "number" ? entry.used : cells;
		return Math.max(0, cells - used);
	};
	const here = freeOf(current);
	let best: OwnerShard | undefined;
	let bestFree = Math.max(here, POLYKV_MOVE_MIN_FREE_CELLS - 1);
	for (const shard of open) {
		const free = freeOf(shard);
		if (free > bestFree) {
			best = shard;
			bestFree = free;
		}
	}
	if (!best) {
		return false;
	}
	current.agents.delete(sessionId);
	current.uses?.delete(sessionId);
	group.assigned.set(sessionId, best);
	best.agents.add(sessionId);
	if (current.agents.size === 0 && !current.closed) {
		current.closed = true;
		group.shards = group.shards.filter((shard) => shard !== current);
		await group.client.closeSession(current.sessionId).catch(() => false);
	}
	return true;
}

/**
 * The agent is done: close its session, and its owner if it was the last.
 *
 * Never throws and never waits on anything but the close calls themselves --
 * this runs on every agent's way out, including the ones being cancelled.
 */
export interface PolykvReleaseResult {
	/** Engine session ids closed: the engine held them and let them go. */
	closed: string[];
	/** Engine session ids whose close failed, with why. */
	failed: Array<{ sessionId: string; error: string }>;
	/**
	 * Closes the engine answered `found: false` for: it held no session under
	 * the id. For an agent that sent requests, ours and the engine's have
	 * diverged -- a restart, the idle TTL, or an id the wire never carried.
	 */
	notFound: string[];
	/**
	 * The agent's own session, not closed: the server does not advertise
	 * `session_close_v1`, so the route is not there to ask.
	 */
	unsupported: string[];
}

export async function releasePolykvAgent(
	sessionId: string,
): Promise<PolykvReleaseResult> {
	const group = AGENT_GROUPS.get(sessionId);
	AGENT_GROUPS.delete(sessionId);
	ROOM_WAITING.delete(engineSessionId(sessionId));
	STARTED_WORKERS.delete(engineSessionId(sessionId));
	LAST_ATTACH.delete(engineSessionId(sessionId));
	CHARGED_TO.delete(engineSessionId(sessionId));
	// Released: whatever turn it had is over, and holds no abandoned owner.
	TURNS_IN_FLIGHT.delete(sessionId);
	const known = OPENCOTI_SESSIONS.get(sessionId);
	OPENCOTI_SESSIONS.delete(sessionId);
	const result: PolykvReleaseResult = {
		closed: [],
		failed: [],
		notFound: [],
		unsupported: [],
	};
	const closes: Promise<unknown>[] = [];
	const closeNow = (client: PolykvClient, id: string): Promise<void> =>
		client.closeSession(id).then(
			(found) => {
				(found ? result.closed : result.notFound).push(id);
			},
			(error: unknown) => {
				result.failed.push({
					sessionId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
	const close = (client: PolykvClient, id: string) =>
		closes.push(closeNow(client, id));
	if (known) {
		const id = engineSessionId(sessionId);
		const client = createPolykvClient({
			baseUrl: known.root,
			fetch: known.fetch,
			...(known.headers ? { headers: known.headers } : {}),
		});
		// Only where the server says it has the route: a 404 there is not a
		// close, and reading it as one is how a held window goes unnoticed.
		closes.push(
			probeOpencotiProps(known.root, known.fetch)
				.catch(() => undefined)
				.then((props) =>
					hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.sessionClose)
						? closeNow(client, id)
						: void result.unsupported.push(id),
				),
		);
	}
	closes.push(...leaveAbandoned(sessionId));
	if (group) {
		const shard = group.assigned.get(sessionId);
		group.assigned.delete(sessionId);
		if (shard) {
			shard.agents.delete(sessionId);
			shard.uses?.delete(sessionId);
			if (shard.agents.size === 0 && !shard.closed) {
				shard.closed = true;
				group.shards = group.shards.filter((candidate) => candidate !== shard);
				if (shard.borrowed) {
					// The lead's session is not ours to close -- closing it would
					// end the conversation's window. What the swarm put in it goes
					// back instead, deepest first, so the lead gets its cells and
					// its sub-pool slots back when its agents are done. A lead
					// whose conversation ended meanwhile is closed after that.
					closes.push(
						releaseLentPools(group.client, shard).then(() =>
							runDeferredLeadClose(shard.sessionId),
						),
					);
				} else {
					// Closing the owner releases every pool it owns with it.
					close(group.client, shard.sessionId);
				}
			}
		}
		// Only this group: one that replaced it under the same key belongs to
		// agents still running, and dropping it made the next agent open the
		// chain again (2026-09-25).
		forgetGroupIfEmpty(group);
	}
	await Promise.all(closes);
	return result;
}

/**
 * Lead sessions whose close is waiting on their priority-0 agents.
 *
 * Closing the lead's opencoti session releases every sub-pool it owns, and a
 * worker that then names a released pool is not refused: it is silently given
 * a full prefill (opencoti, mail 269). So a lead whose conversation ends while
 * its priority-0 agents still run is closed after the last of them, not
 * before.
 */
const DEFERRED_LEAD_CLOSES = new Map<string, () => Promise<unknown>>();

/** The lent shard for this lead, if agents are running on it. */
function busyLentShard(owner: string): OwnerShard | undefined {
	const id = engineSessionId(owner);
	for (const group of GROUPS.values()) {
		for (const shard of group.shards) {
			if (
				shard.borrowed &&
				!shard.closed &&
				shard.sessionId === id &&
				shard.agents.size > 0
			) {
				return shard;
			}
		}
	}
	return undefined;
}

/**
 * Hold a lead's session close until its last priority-0 agent ends.
 *
 * `true` when the close was deferred -- the caller must not close now -- and
 * `false` when nothing of the swarm is running in that session, so the caller
 * closes as it always did. A second deferral for one lead replaces the first.
 */
export function deferPolykvLeadClose(
	owner: string,
	close: () => Promise<unknown>,
): boolean {
	if (!busyLentShard(owner)) {
		return false;
	}
	DEFERRED_LEAD_CLOSES.set(engineSessionId(owner), close);
	return true;
}

/** Whether priority-0 agents are running in this lead's session now. */
export function polykvLeadLent(owner: string): boolean {
	return busyLentShard(owner) !== undefined;
}

async function runDeferredLeadClose(sessionId: string): Promise<void> {
	const close = DEFERRED_LEAD_CLOSES.get(sessionId);
	DEFERRED_LEAD_CLOSES.delete(sessionId);
	await close?.().catch(() => undefined);
}

/** Release the pools a swarm built in the lead's window, children first. */
async function releaseLentPools(
	client: PolykvClient,
	shard: OwnerShard,
): Promise<void> {
	const ids = (
		await Promise.all(
			[...shard.pools.values()].map((pending) =>
				pending.catch(() => undefined),
			),
		)
	).filter((id): id is string => id !== undefined);
	shard.pools.clear();
	for (const id of ids.reverse()) {
		await client.unpin(id).catch(() => undefined);
		await client.releasePool(id).catch(() => undefined);
	}
}

/**
 * The lead conversation `group` ended: release every owner its swarm opened.
 *
 * Its agents are being stopped with it, and each one's own release lands when
 * its abort does -- or never, on a path that throws before it gets there. So
 * the owners go back with the lead rather than at the engine's idle TTL. The
 * agents' registrations on them are dropped; an agent's own release landing
 * after this still closes its own session. A borrowed owner -- the lead's own
 * session -- gives back the pools the swarm put in it, and a lead close that
 * was deferred on them runs.
 *
 * @returns how many owners were released.
 */
export async function releasePolykvSwarmsOf(group: string): Promise<number> {
	const closes: Promise<unknown>[] = [];
	let released = 0;
	for (const swarm of [...GROUPS.values()]) {
		if (swarm.key.split("\n")[1] !== group) {
			continue;
		}
		for (const shard of swarm.shards) {
			if (shard.closed) {
				continue;
			}
			shard.closed = true;
			released += 1;
			closes.push(
				shard.borrowed
					? releaseLentPools(swarm.client, shard).then(() =>
							runDeferredLeadClose(shard.sessionId),
						)
					: swarm.client.closeSession(shard.sessionId).catch(() => false),
			);
			shard.agents.clear();
		}
		swarm.shards = [];
		for (const agent of swarm.assigned.keys()) {
			if (AGENT_GROUPS.get(agent) === swarm) {
				AGENT_GROUPS.delete(agent);
			}
		}
		swarm.assigned.clear();
		forgetGroupIfEmpty(swarm);
	}
	await Promise.all(closes);
	return released;
}

/** Close every owner this process holds. For shutdown and for tests. */
export async function releaseAllPolykvSwarms(): Promise<void> {
	const closes: Promise<unknown>[] = [];
	for (const group of GROUPS.values()) {
		for (const shard of group.shards) {
			shard.closed = true;
			closes.push(
				shard.borrowed
					? releaseLentPools(group.client, shard)
					: group.client.closeSession(shard.sessionId).catch(() => false),
			);
		}
	}
	for (const [shard, client] of ABANDONED) {
		closes.push(client.closeSession(shard.sessionId).catch(() => false));
	}
	ABANDONED.clear();
	TURNS_IN_FLIGHT.clear();
	GROUPS.clear();
	AGENT_GROUPS.clear();
	for (const root of [...OWNER_KEEPALIVES.keys()]) {
		stopOwnerKeepalive(root);
	}
	STARTED_WORKERS.clear();
	ROOT_STATES.clear();
	OWNER_SERIALS.clear();
	OWNER_SHARDS.clear();
	LAST_ATTACH.clear();
	CHARGED_TO.clear();
	// Shutdown: the lent pools are gone, so the leads can go too.
	for (const sessionId of [...DEFERRED_LEAD_CLOSES.keys()]) {
		closes.push(runDeferredLeadClose(sessionId));
	}
	await Promise.all(closes);
}

/** Where an agent's request is while it waits on the engine for room. */
/** Something about an agent's requests that its row should say. */
export interface PolykvNotice {
	/** `warn` is a fault the turn survived: it ran, but not as it should have. */
	severity: "info" | "warn";
	/** Worded for the agent's row. */
	text: string;
}

const NOTICE_LISTENERS = new Map<string, Set<(notice: PolykvNotice) => void>>();
const LAST_NOTICE = new Map<string, string>();

/**
 * Be told what the vendor learns about an agent's requests from the engine.
 *
 * The same reach problem as the room wait: the response is read inside this
 * vendor's fetch, where nothing of the agent's UI can be reached. A worker's
 * pool shared 4 tokens of 5,627 on every turn of 2026-09-24 and it reached the
 * server log only. Keyed by the agent's own session id. Returns the
 * unsubscribe.
 */
export function onPolykvNotice(
	sessionId: string,
	listener: (notice: PolykvNotice) => void,
): () => void {
	const key = engineSessionId(sessionId);
	let listeners = NOTICE_LISTENERS.get(key);
	if (!listeners) {
		listeners = new Set();
		NOTICE_LISTENERS.set(key, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) {
			NOTICE_LISTENERS.delete(key);
			LAST_NOTICE.delete(key);
		}
	};
}

/**
 * Report a notice for an agent. A repeat of the last one is dropped: a
 * divergence found on every turn is one line on the row, not one per turn.
 */
export function reportPolykvNotice(
	sessionId: string,
	notice: PolykvNotice,
): void {
	const key = engineSessionId(sessionId);
	if (LAST_NOTICE.get(key) === notice.text) {
		return;
	}
	const listeners = NOTICE_LISTENERS.get(key);
	if (!listeners) {
		return;
	}
	LAST_NOTICE.set(key, notice.text);
	for (const listener of listeners) {
		try {
			listener(notice);
		} catch {
			// A listener's fault is not the request's.
		}
	}
}

export interface PolykvRoomWait {
	/** `true` while the request is held client-side, `false` once it is sent. */
	waiting: boolean;
	/** What it is waiting for, worded for the agent's row. */
	reason?: string;
}

const ROOM_WAIT_LISTENERS = new Map<
	string,
	Set<(state: PolykvRoomWait) => void>
>();
const ROOM_WAITING = new Set<string>();

/**
 * Be told when an agent's requests are held waiting for room on the engine.
 *
 * The wait happens inside this vendor's fetch, where nothing of the agent's UI
 * can be reached, so the agent's row went on saying "running" for as long as
 * it waited -- 75 rows running on 2026-09-24 while the server was processing
 * 27. Keyed by the agent's own session id, as the worker spec carries it.
 * Returns the unsubscribe.
 */
export function onPolykvRoomWait(
	sessionId: string,
	listener: (state: PolykvRoomWait) => void,
): () => void {
	const key = engineSessionId(sessionId);
	let listeners = ROOM_WAIT_LISTENERS.get(key);
	if (!listeners) {
		listeners = new Set();
		ROOM_WAIT_LISTENERS.set(key, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) {
			ROOM_WAIT_LISTENERS.delete(key);
		}
	};
}

/**
 * Report an agent waiting, or no longer waiting. Only changes are passed on,
 * so a wait of forty refusals is one "waiting" and one "sent".
 */
export function reportPolykvRoomWait(
	sessionId: string,
	state: PolykvRoomWait,
): void {
	const key = engineSessionId(sessionId);
	if (state.waiting === ROOM_WAITING.has(key)) {
		return;
	}
	if (state.waiting) {
		ROOM_WAITING.add(key);
	} else {
		ROOM_WAITING.delete(key);
	}
	for (const listener of ROOM_WAIT_LISTENERS.get(key) ?? []) {
		try {
			listener(state);
		} catch {
			// A listener is a UI update; it must never fail a request.
		}
	}
}

/**
 * The least time between two row updates of the same phase kind. A new kind
 * (queued -> prefill) and the end of the phase always go through at once.
 */
export const POLYKV_PHASE_REPORT_MS = 3_000;

const PHASE_LISTENERS = new Map<
	string,
	Set<(phase: OpencotiStreamPhase | undefined) => void>
>();
const LAST_PHASE = new Map<string, { at: number; kind?: string }>();

/**
 * Be told what an agent's request is doing on the server while its stream is
 * silent: queued, prefilling `n` of `N`, generating with nothing to show
 * (`stream_keepalive_v1`), and `undefined` once it produces again.
 *
 * The same reach problem as the room wait: the heartbeat is read inside this
 * vendor's fetch. Without it a 40k prefill behind a busy server was a row
 * that said nothing for minutes. Keyed by the agent's own session id.
 * Returns the unsubscribe.
 */
export function onPolykvStreamPhase(
	sessionId: string,
	listener: (phase: OpencotiStreamPhase | undefined) => void,
): () => void {
	const key = engineSessionId(sessionId);
	let listeners = PHASE_LISTENERS.get(key);
	if (!listeners) {
		listeners = new Set();
		PHASE_LISTENERS.set(key, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) {
			PHASE_LISTENERS.delete(key);
			LAST_PHASE.delete(key);
		}
	};
}

/**
 * Report an agent's stream phase. Throttled here, once for every listener:
 * a repeat of the same kind within {@link POLYKV_PHASE_REPORT_MS} is dropped,
 * so the row is updated in place every few seconds at most.
 */
export function reportPolykvStreamPhase(
	sessionId: string,
	phase: OpencotiStreamPhase | undefined,
	now: number = Date.now(),
): void {
	const key = engineSessionId(sessionId);
	const listeners = PHASE_LISTENERS.get(key);
	if (!listeners) {
		return;
	}
	const last = LAST_PHASE.get(key);
	if (phase === undefined) {
		if (last?.kind === undefined) {
			return;
		}
	} else if (
		last?.kind === phase.kind &&
		now - last.at < POLYKV_PHASE_REPORT_MS
	) {
		return;
	}
	LAST_PHASE.set(key, { at: now, ...(phase ? { kind: phase.kind } : {}) });
	for (const listener of listeners) {
		try {
			listener(phase);
		} catch {
			// A listener is a UI update; it must never fail a request.
		}
	}
}

/** Test seam. */
export function polykvSwarmState(): Array<{
	group: string;
	owners: Array<{
		sessionId: string;
		borrowed?: boolean;
		agents: string[];
		pools: number;
	}>;
}> {
	return [...GROUPS.values()].map((group) => ({
		group: group.key,
		owners: group.shards.map((shard) => ({
			sessionId: shard.sessionId,
			...(shard.borrowed ? { borrowed: true } : {}),
			agents: [...shard.agents],
			pools: shard.pools.size,
		})),
	}));
}
