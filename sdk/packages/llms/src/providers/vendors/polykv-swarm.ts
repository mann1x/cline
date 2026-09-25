import {
	createPolykvClient,
	type PolykvAdmissionPolicy,
	type PolykvClient,
	polykvRoot,
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

export interface PolykvWorkerAttach {
	poolId?: string;
	sessionId: string;
}

/** An owner session and the pool tree inside its window. */
interface OwnerShard {
	sessionId: string;
	/** Layer key -> pool id (`undefined` when that layer could not be pooled). */
	pools: Map<string, Promise<string | undefined>>;
	/** Agents currently assigned here. */
	agents: Set<string>;
	closed: boolean;
	/**
	 * The lead's own session, lent to the swarm (§9g). Never opened or closed
	 * here: releasing it means releasing the pools, not the session.
	 */
	borrowed?: boolean;
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
	serial: number;
}

const GROUPS = new Map<string, SwarmGroup>();
/** Agent session -> its group, for release by agent id alone. */
const AGENT_GROUPS = new Map<string, SwarmGroup>();

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
			serial: 0,
		};
		GROUPS.set(key, group);
	}
	return group;
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
): Promise<OwnerShard | undefined> {
	const messages = body.messages as Array<Record<string, unknown>>;
	const system = messages[0];
	const sessionId = engineSessionId(
		`${group.key.split("\n")[1]}~polykv-owner-${++group.serial}`,
	);
	const window = await sessionContextMax(group);
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
				num_ctx_min: Math.min(window, POLYKV_OWNER_MIN_WINDOW),
				max_tokens: 1,
				stream: false,
			}),
			...(signal ? { signal } : {}),
		});
		await response.body?.cancel().catch(() => {});
		if (response.ok) {
			const shard: OwnerShard = {
				sessionId,
				pools: new Map(),
				agents: new Set(),
				closed: false,
			};
			group.shards.push(shard);
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
 * The pool for `layer` of this request on `shard`, creating the chain to it.
 *
 * Returns the deepest pool that could be made. A layer the engine refuses --
 * the per-session pool limit, a contract violation -- stops the chain there,
 * and the worker attaches to its parent: sharing less is still sharing.
 */
async function ensureChain(
	group: SwarmGroup,
	shard: OwnerShard,
	body: Record<string, unknown>,
	layers: number,
	fullRendering: string,
	admission?: PolykvAdmissionPolicy,
): Promise<string | undefined> {
	const messages = body.messages as unknown[];
	const tools = body.tools as unknown[] | undefined;
	let parent: string | undefined;
	const fields = templateFieldsOf(body);
	let key = hashString(
		JSON.stringify([body.model ?? "", tools ?? [], templateSignature(fields)]),
	);
	for (let depth = 0; depth <= layers; depth++) {
		key = hashString(`${key}\n${JSON.stringify(messages[depth])}`);
		let pending = shard.pools.get(key);
		if (
			!pending &&
			shard.borrowed &&
			shard.pools.size >= POLYKV_LEAD_WORKER_POOL_MAX
		) {
			// The lead's session has a sub-pool limit, and its own conversation
			// needs one of them: share what is already built instead.
			return parent;
		}
		if (!pending) {
			const parentId = parent;
			pending = (async () => {
				const prompt = await renderLayer(
					group.client,
					messages.slice(0, depth + 1),
					tools,
					fields,
				);
				if (!prompt || !fullRendering.startsWith(prompt)) {
					return undefined;
				}
				const pool =
					parentId === undefined
						? await group.client.createPool({
								prompt,
								session_id: shard.sessionId,
								pin: true,
							})
						: await group.client.forkPool(parentId, {
								prompt,
								session_id: shard.sessionId,
								pin: true,
							});
				if (admission) {
					// A pool without its policy still shares; one refused
					// policy must not cost the tree.
					await group.client
						.setAdmission(pool.pool_id, admission)
						.catch(() => undefined);
				}
				return pool.pool_id;
			})().catch(() => undefined);
			shard.pools.set(key, pending);
		}
		const poolId = await pending;
		if (poolId === undefined) {
			if (shard.borrowed && shard.pools.get(key) === pending) {
				// On the lead's session a refused pool is priority 0 being
				// full -- its eight per slot, or the server's pool reservoir --
				// and that ends as agents do. Not remembered, so the next agent
				// asks again rather than inheriting this one's refusal.
				shard.pools.delete(key);
			}
			return parent;
		}
		parent = poolId;
	}
	return parent;
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
): Promise<OwnerShard | undefined> {
	group.opening ??= openOwner(group, body, signal, waitForRoom).finally(() => {
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
	const { spec, body } = options;
	const group = groupFor(spec, options.baseUrl, options.fetch, options.headers);
	AGENT_GROUPS.set(spec.sessionId, group);
	const unpooled = { sessionId: engineSessionId(spec.sessionId) };
	if (spec.attachOnly) {
		const shard = group.assigned.get(spec.sessionId);
		if (!shard || shard.closed) {
			return unpooled;
		}
		for (const pending of shard.pools.values()) {
			const poolId = await pending;
			if (poolId !== undefined) {
				return { poolId, sessionId: unpooled.sessionId };
			}
		}
		return unpooled;
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
		return unpooled;
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
				((await openShard(group, body, options.signal, false)) ??
				(current && !current.closed ? current : undefined))
			: ([...group.shards].reverse().find((candidate) => !candidate.closed) ??
				(await awaitOwner(group, spec.sessionId, () =>
					openShard(group, body, options.signal),
				)));
		if (!shard) {
			return unpooled;
		}
		const previous = group.assigned.get(spec.sessionId);
		previous?.agents.delete(spec.sessionId);
		group.assigned.set(spec.sessionId, shard);
		shard.agents.add(spec.sessionId);
	}
	let fullRendering: string;
	try {
		fullRendering = await group.client.applyTemplate({
			messages,
			...(body.tools ? { tools: body.tools as unknown[] } : {}),
			// The request's own fields here as well: the prefix check below is
			// only a check if this is what the server will actually render.
			fields: templateFieldsOf(body),
		});
	} catch {
		return unpooled;
	}
	const poolId = await ensureChain(
		group,
		shard,
		body,
		spec.layers,
		fullRendering,
		spec.admission,
	);
	return poolId === undefined
		? unpooled
		: { poolId, sessionId: unpooled.sessionId };
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
	const open = group.shards.filter(
		(shard) => !shard.closed && shard !== current,
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
	/** Engine session ids closed. */
	closed: string[];
	/** Engine session ids whose close failed, with why. */
	failed: Array<{ sessionId: string; error: string }>;
}

export async function releasePolykvAgent(
	sessionId: string,
): Promise<PolykvReleaseResult> {
	const group = AGENT_GROUPS.get(sessionId);
	AGENT_GROUPS.delete(sessionId);
	ROOM_WAITING.delete(engineSessionId(sessionId));
	STARTED_WORKERS.delete(engineSessionId(sessionId));
	const known = OPENCOTI_SESSIONS.get(sessionId);
	OPENCOTI_SESSIONS.delete(sessionId);
	const result: PolykvReleaseResult = { closed: [], failed: [] };
	const closes: Promise<unknown>[] = [];
	const close = (client: PolykvClient, id: string) =>
		closes.push(
			client.closeSession(id).then(
				() => {
					result.closed.push(id);
				},
				(error: unknown) => {
					result.failed.push({
						sessionId: id,
						error: error instanceof Error ? error.message : String(error),
					});
				},
			),
		);
	if (known) {
		close(
			createPolykvClient({
				baseUrl: known.root,
				fetch: known.fetch,
				...(known.headers ? { headers: known.headers } : {}),
			}),
			engineSessionId(sessionId),
		);
	}
	if (group) {
		const shard = group.assigned.get(sessionId);
		group.assigned.delete(sessionId);
		if (shard) {
			shard.agents.delete(sessionId);
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
		if (group.shards.length === 0 && group.assigned.size === 0) {
			GROUPS.delete(group.key);
		}
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
	GROUPS.clear();
	AGENT_GROUPS.clear();
	STARTED_WORKERS.clear();
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
