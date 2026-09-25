import { hoistPromptEnvironment } from "@cline/shared";
import {
	clearPolykvSession,
	createPolykvClient,
	getPolykvSession,
	hasOpencotiFeature,
	OPENCOTI_FEATURES,
	type PolykvClient,
	polykvRoot,
	probeOpencotiProps,
	setPolykvSession,
} from "./polykv";
import {
	engineSessionId,
	hashString,
	type PolykvPoolRecord,
	polykvRootGeneration,
	registerPolykvPoolHolder,
	renderLayer,
	templateFieldsOf,
	templateSignature,
	verifyPolykvRoot,
} from "./polykv-swarm";

/**
 * Conversations that share a prefix, deduplicated on the engine.
 *
 * Every Cline conversation on one opencoti server opens with the same system
 * prompt and tool schemas -- a third of the window -- and before this each one
 * prefilled and held its own copy. Measured on 8240 with a 4,877-token prompt:
 * two leads, each with its own root pool inside its own window, held the
 * prefix twice. Laid out as below, the same two leads held it once and each
 * window counted 29 tokens of its own.
 *
 *   P0   static system prompt + tools   -- every conversation on the server;
 *                                          no owner, so no one's window pays
 *    └ Ls  + the environment turn        -- conversation s: its working
 *                                          directory, date, rules, mode;
 *                                          owned by s, inside s's window
 *        └ the conversation, attached to Ls
 *
 * Two things make P0 shareable at all:
 *
 * - **The environment is its own turn.** The per-session values are marked in
 *   the system prompt (`@cline/shared` `markPromptEnvironment`) and lifted
 *   into a user turn here, on the wire, so the system turn is identical for
 *   every conversation. In place, the first differing byte -- the working
 *   directory, twenty lines in -- ends the prefix, tools included.
 * - **P0 has no owner.** A request that attaches an owned pool is priced as a
 *   worker of that pool's owner. A conversation is not anyone's worker: it
 *   books its own window and attaches an unowned root, whose cells are charged
 *   to the server once.
 *
 * `Ls` is created only once the conversation holds a window (a pool's owner
 * must be a live allocation, or the pool is silently unowned) -- with
 * `dynamicContextSize` off there is no window, and the conversation attaches
 * P0 directly. It is re-made when the environment changes (a mode switch, a
 * new day) and when the engine released it with a lapsed window.
 *
 * What this does NOT buy on c7: admission. The engine's context-size check
 * counts shared tokens against the window, so a conversation sharing P0 still
 * books a window covering P0 + its own tokens. The saving is the prefill of P0
 * on every new conversation, and the cells held once. (Reported as E4.)
 *
 * Across a server restart the tree follows the swarm's root generation
 * (`polykvRootGeneration`): a restarted server numbers its pools from 0
 * again, so an id cached from before names nothing -- or someone else's
 * pool. Every root and sub-pool is tagged with the generation it was made in;
 * once the generation moves, the lead's next turn rebuilds its chain, never
 * sends, releases or forks from an id of the old one.
 */

/** A root one or more conversations on a server share. */
interface LeadRoot {
	key: string;
	root: string;
	client: PolykvClient;
	/** `undefined` when the root could not be pooled. */
	pool?: Promise<
		| { id: string; prompt: string; prefixLen: number; shared: boolean }
		| undefined
	>;
	sessions: Set<string>;
	/** The server generation `pool` was made in. */
	generation: number;
	/** `pool` once it resolved, for the restart check (which is synchronous). */
	held?: { id: string; prefixLen: number };
}

/** Where a lead request attaches, and what that means for its window. */
export interface LeadAttach {
	poolId: string;
	/** Tokens of the request's prefix the pool holds. */
	sharedTokens: number;
	/**
	 * The server counts `num_ctx` as the private budget
	 * (`polykv_private_window_v1`): the shared prefix rides above it.
	 */
	privateWindow: boolean;
	/**
	 * The server generation `poolId` belongs to. A request that goes out after
	 * the generation moved must not carry it.
	 */
	generation: number;
}

interface LeadSession {
	sessionId: string;
	root: LeadRoot;
	/** The conversation holds a window the engine granted. */
	windowLive: boolean;
	sub?: {
		key: string;
		pool: Promise<{ id: string; prefixLen: number } | undefined>;
		/** `pool` once it resolved, for the restart check. */
		held?: { id: string; prefixLen: number };
	};
	/** The server generation `sub` and `windowLive` belong to. */
	generation: number;
	lastUsed: number;
}

const ROOTS = new Map<string, LeadRoot>();
const LEADS = new Map<string, LeadSession>();

/**
 * After this long without a request, check the pools still exist.
 *
 * Well under the engine's idle TTL (300 s on the builds measured): a window
 * that lapses takes every pool its session owned with it, and a request
 * naming a released pool is not refused -- it reprocesses in full, silently.
 */
export const POLYKV_LEAD_RECHECK_MS = 60_000;

/**
 * The lead tree's pools, for the swarm's restart check after a fault. Only
 * the current generation's: an older id is already known to be gone.
 */
registerPolykvPoolHolder((serverRoot) => {
	const generation = polykvRootGeneration(serverRoot);
	const held: Array<[string, PolykvPoolRecord]> = [];
	for (const root of ROOTS.values()) {
		if (
			root.root === serverRoot &&
			root.generation === generation &&
			root.held
		) {
			held.push([root.held.id, { prefixLen: root.held.prefixLen }]);
		}
	}
	for (const lead of LEADS.values()) {
		const sub = lead.sub?.held;
		const parent = lead.root.held;
		if (
			sub &&
			parent &&
			lead.root.root === serverRoot &&
			lead.generation === generation &&
			lead.root.generation === generation
		) {
			held.push([sub.id, { prefixLen: sub.prefixLen, parent: parent.id }]);
		}
	}
	return held;
});

type TextPart = { type?: unknown; text?: unknown };

function textOf(content: unknown): string | undefined {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const parts = content as TextPart[];
		if (parts.every((part) => part?.type === "text")) {
			return parts.map((part) => String(part.text ?? "")).join("");
		}
	}
	return undefined;
}

/**
 * Lift the environment spans of a request's system turn into a user turn.
 *
 * Mutates `body`. Answers whether the request is a lead conversation's: a
 * system turn carrying spans is only ever built for one.
 */
export function hoistLeadEnvironment(body: Record<string, unknown>): boolean {
	const messages = body.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		return false;
	}
	const system = messages[0] as Record<string, unknown>;
	if (system?.role !== "system") {
		return false;
	}
	const text = textOf(system.content);
	const hoisted = text === undefined ? undefined : hoistPromptEnvironment(text);
	if (!hoisted) {
		return false;
	}
	const turns: unknown[] = [{ ...system, content: hoisted.system }];
	if (hoisted.environment) {
		turns.push({ role: "user", content: hoisted.environment });
	}
	body.messages = [...turns, ...messages.slice(1)];
	return Boolean(hoisted.environment);
}

function rootFor(
	baseUrl: string,
	fetchFn: typeof fetch,
	headers: Record<string, string> | undefined,
	key: string,
): LeadRoot {
	const root = polykvRoot(baseUrl);
	const fullKey = `${root}\n${key}`;
	let entry = ROOTS.get(fullKey);
	if (!entry) {
		entry = {
			key: fullKey,
			root,
			client: createPolykvClient({
				baseUrl: root,
				fetch: fetchFn,
				...(headers ? { headers } : {}),
			}),
			sessions: new Set(),
			generation: polykvRootGeneration(root),
		};
		ROOTS.set(fullKey, entry);
	}
	return entry;
}

async function releasePool(client: PolykvClient, id: string): Promise<void> {
	await client.unpin(id).catch(() => undefined);
	await client.releasePool(id).catch(() => undefined);
}

async function detach(lead: LeadSession): Promise<void> {
	const sub = await lead.sub?.pool.catch(() => undefined);
	lead.sub = undefined;
	// An id from before a restart is not ours to release: the new server may
	// have given that number to someone else's pool.
	if (sub && lead.generation === polykvRootGeneration(lead.root.root)) {
		await releasePool(lead.root.client, sub.id);
	}
	const root = lead.root;
	root.sessions.delete(lead.sessionId);
	if (root.sessions.size === 0 && ROOTS.get(root.key) === root) {
		ROOTS.delete(root.key);
		const pool = await root.pool?.catch(() => undefined);
		// A shared root is every process's: another window may be attached to it
		// right now. The engine's ephemeral sweep releases it once nothing is.
		if (
			pool &&
			!pool.shared &&
			root.generation === polykvRootGeneration(root.root)
		) {
			await releasePool(root.client, pool.id);
		}
	}
}

/**
 * The pool this lead request attaches to, creating what it needs.
 *
 * Call after `hoistLeadEnvironment` answered `true`, so the request is
 * `[system, environment, ...conversation]`. `undefined` means "run unpooled":
 * the server has no pools, or the prefix could not be made shareable -- slower,
 * never wrong.
 */
export async function prepareLeadPool(
	options: PrepareLeadPoolOptions,
): Promise<LeadAttach | undefined> {
	// A restart noticed while this was resolving -- a pool created on the old
	// server, answered after the new one was seen -- is one more pass, under
	// the new generation. Never an id of the old one.
	for (let pass = 0; pass < 3; pass++) {
		const attach = await prepareLeadPoolOnce(options);
		if (
			!attach ||
			attach.generation === polykvRootGeneration(options.baseUrl)
		) {
			return attach;
		}
	}
	if (getPolykvSession(options.sessionId)?.layout === "lead") {
		clearPolykvSession(options.sessionId);
	}
	return undefined;
}

interface PrepareLeadPoolOptions {
	baseUrl: string;
	fetch: typeof fetch;
	headers?: Record<string, string>;
	body: Record<string, unknown>;
	/** The conversation's session id, as the host knows it. */
	sessionId: string;
	now?: number;
}

async function prepareLeadPoolOnce(
	options: PrepareLeadPoolOptions,
): Promise<LeadAttach | undefined> {
	const { body, sessionId } = options;
	const now = options.now ?? Date.now();
	const messages = body.messages as Array<Record<string, unknown>>;
	const tools = body.tools as unknown[] | undefined;
	if (
		messages[0]?.role !== "system" ||
		messages[1]?.role !== "user" ||
		messages[2]?.role !== "user"
	) {
		return undefined;
	}
	const props = await probeOpencotiProps(options.baseUrl, options.fetch).catch(
		() => undefined,
	);
	if (!props?.poolsEnabled) {
		return undefined;
	}
	const fields = templateFieldsOf(body);
	const rootKey = hashString(
		JSON.stringify([
			body.model ?? "",
			tools ?? [],
			messages[0],
			templateSignature(fields),
		]),
	);
	let lead = LEADS.get(sessionId);
	if (lead && lead.root.key !== `${polykvRoot(options.baseUrl)}\n${rootKey}`) {
		// The static prompt changed under the conversation -- a tool set that
		// grew with an MCP server, a template edited mid-session. Its tree is
		// for a prefix it no longer has.
		await detach(lead);
		LEADS.delete(sessionId);
		lead = undefined;
	}
	if (!lead) {
		const root = rootFor(
			options.baseUrl,
			options.fetch,
			options.headers,
			rootKey,
		);
		root.sessions.add(sessionId);
		lead = {
			sessionId,
			root,
			windowLive: false,
			generation: root.generation,
			lastUsed: now,
		};
		LEADS.set(sessionId, lead);
	}
	const root = lead.root;

	if (now - lead.lastUsed > POLYKV_LEAD_RECHECK_MS) {
		const held = await root.client.listPoolIds().catch(() => undefined);
		if (held) {
			const rootPool = await root.pool?.catch(() => undefined);
			if (root.pool && (!rootPool || !held.has(rootPool.id))) {
				root.pool = undefined;
			}
			const sub = await lead.sub?.pool.catch(() => undefined);
			if (lead.sub && (!sub || !held.has(sub.id))) {
				// Released with the window it lived in. The window is re-booked by
				// this very request (the resume rule sends `num_ctx`); the
				// sub-pool follows on the next one.
				lead.sub = undefined;
				lead.windowLive = false;
			}
		}
	}
	lead.lastUsed = now;

	// Is this still the server the tree was built on? Shared with the swarm:
	// asked at most every couple of seconds per server, and at once after a
	// fault (a dropped turn, a turn without `X-Context-Window`).
	await verifyPolykvRoot(root.root, options.fetch, options.headers).catch(
		() => undefined,
	);
	const generation = polykvRootGeneration(root.root);
	if (root.generation !== generation) {
		// The server restarted: the root's id is from the old one. Nothing is
		// released -- there is nothing left, and the number may be someone
		// else's now. The root is found or made again below.
		root.pool = undefined;
		root.held = undefined;
		root.generation = generation;
	}
	if (lead.generation !== generation) {
		// Its sub-pool and its window went with the old server. The window is
		// re-booked by this request; the sub-pool follows on the next one.
		lead.sub = undefined;
		lead.windowLive = false;
		lead.generation = generation;
		if (getPolykvSession(sessionId)?.layout === "lead") {
			clearPolykvSession(sessionId);
		}
	}

	const sharedRoot = hasOpencotiFeature(
		props.features,
		OPENCOTI_FEATURES.sharedRoot,
	);
	root.pool ??= (async () => {
		const prompt = await renderLayer(root.client, [messages[0]], tools, fields);
		if (!prompt) {
			return undefined;
		}
		// Find-or-create where the server has it: every process -- two VS Code
		// windows, the CLI -- converges on one root, and the engine owns its
		// life. Ephemeral and unpinned, it is swept once nothing references it
		// (no sub-pool, no attach for 60 s), so no process has to decide when
		// the others are done and a crash leaks nothing. Without it, the root is
		// this process's own: pinned, and released with its last conversation.
		const pool = sharedRoot
			? await root.client.createPool({ prompt, shared: true, ephemeral: true })
			: await root.client.createPool({ prompt, pin: true });
		return {
			id: pool.pool_id,
			prompt,
			prefixLen: pool.prefix_len,
			shared: sharedRoot,
		};
	})().catch(() => undefined);
	const rootPool = await root.pool;
	if (!rootPool) {
		return undefined;
	}
	if (root.generation === generation) {
		root.held = { id: rootPool.id, prefixLen: rootPool.prefixLen };
	}

	let attach = { id: rootPool.id, prefixLen: 0, shared: rootPool.prefixLen };
	if (lead.windowLive) {
		const subKey = hashString(`${rootKey}\n${JSON.stringify(messages[1])}`);
		if (lead.sub?.key !== subKey) {
			const stale = lead.sub;
			lead.sub = undefined;
			const old = await stale?.pool.catch(() => undefined);
			if (old) {
				await releasePool(root.client, old.id);
			}
			lead.sub = {
				key: subKey,
				pool: (async () => {
					const prompt = await renderLayer(
						root.client,
						messages.slice(0, 2),
						tools,
						fields,
					);
					// Never attach a layer that does not extend its parent: it is
					// created, pinned and attached, and shares nothing.
					if (!prompt || !prompt.startsWith(rootPool.prompt)) {
						return undefined;
					}
					const pool = await root.client.forkPool(rootPool.id, {
						prompt,
						session_id: engineSessionId(sessionId),
						pin: true,
					});
					return { id: pool.pool_id, prefixLen: pool.prefix_len };
				})().catch(() => undefined),
			};
		}
		const current = lead.sub;
		const sub = await current?.pool;
		if (sub) {
			if (current) {
				current.held = sub;
			}
			attach = { ...sub, shared: sub.prefixLen };
		}
	}
	setPolykvSession(sessionId, {
		poolId: attach.id,
		prefixTokens: attach.prefixLen,
		layout: "lead",
	});
	return {
		poolId: attach.id,
		sharedTokens: attach.shared,
		privateWindow: hasOpencotiFeature(
			props.features,
			OPENCOTI_FEATURES.privateWindow,
		),
		generation,
	};
}

/**
 * One pool of this conversation's chain is gone while the process stayed up
 * (`pool_unknown` under an unchanged boot id): its sub-pool, released with a
 * window that lapsed on the idle TTL, or the root it forks from, swept.
 *
 * Only that chain is dropped. A lost sub-pool goes with its window (the
 * resume rule re-books it on the next request, and the sub-pool follows on
 * the one after -- as when a lapse is found by the recheck). A lost root
 * takes the sub-pools forked from it, for every conversation on it. Nothing
 * is released: the server no longer holds it. Returns whether the id was
 * this conversation's.
 */
export function forgetPolykvLeadPool(
	sessionId: string,
	poolId: string,
): boolean {
	const lead = LEADS.get(sessionId);
	if (!lead) {
		return false;
	}
	const root = lead.root;
	if (root.held?.id === poolId) {
		root.pool = undefined;
		root.held = undefined;
		for (const other of LEADS.values()) {
			if (other.root === root) {
				other.sub = undefined;
			}
		}
	} else if (lead.sub?.held?.id === poolId) {
		lead.sub = undefined;
		lead.windowLive = false;
	} else {
		return false;
	}
	if (getPolykvSession(sessionId)?.layout === "lead") {
		clearPolykvSession(sessionId);
	}
	return true;
}

/**
 * The conversation now holds a window: the next request may own a sub-pool.
 *
 * Called on a successful response to a request that asked for one.
 */
export function markLeadWindowLive(sessionId: string): void {
	const lead = LEADS.get(sessionId);
	if (lead) {
		lead.windowLive = true;
	}
}

/**
 * End a conversation's place in the lead tree.
 *
 * Its sub-pool goes, and the shared root with the last conversation on it. A
 * no-op for a session that never attached.
 */
export async function releasePolykvLead(sessionId: string): Promise<void> {
	const lead = LEADS.get(sessionId);
	if (!lead) {
		return;
	}
	LEADS.delete(sessionId);
	if (getPolykvSession(sessionId)?.layout === "lead") {
		clearPolykvSession(sessionId);
	}
	await detach(lead);
}

/** Test seam: what the lead tree holds. */
export function polykvLeadState(): Array<{
	root: string;
	sessions: string[];
}> {
	return [...ROOTS.values()].map((root) => ({
		root: root.key,
		sessions: [...root.sessions],
	}));
}

/** Test seam, and process shutdown. */
export async function releaseAllPolykvLeads(): Promise<void> {
	await Promise.all([...LEADS.keys()].map((id) => releasePolykvLead(id)));
}
