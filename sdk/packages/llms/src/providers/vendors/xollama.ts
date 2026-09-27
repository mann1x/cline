// xOllama: an Ollama fork (mann1x/xollama) that may run opencoti as its
// engine, with PolyKV on some models and council chat. It speaks Ollama's
// native API, so it is served by the Ollama vendor; what is here is only
// what xOllama adds to that wire.
//
// The contract (xollama mail #370, 2026-09-26):
// - `GET /api/xollama` -> `{ xollama: true, version, features: [...] }`. A
//   stock Ollama answers 404. Gate on feature names, never on a version: a
//   dev build's `/api/version` is "0.0.0".
// - `/api/show` carries an `xollama` block per model (council, context, polykv).
// - `/api/chat` takes a top-level `session_id`: the engine session, for
//   opencoti's slot affinity and its running-session admission (0411: a
//   session that keeps sending its id is never floor-refused mid-run).
// - A tool's function object takes `x_read_only: true` (#372, D2): a council
//   offers researchers and critics only those, and only the synthesizer
//   writes. Unmarked means write.
// - `council_tags_v1` (#387): each thinking chunk of a council turn carries a
//   top-level `council: {role, index, round}`, counted from 0, and holds one
//   member's text. Content, state and done chunks carry none.
// - `council_chat_state_v1` (#403): a council turn sends `council_chat_state`
//   ("" the first time, then the newest blob the server sent). The server
//   answers with the blob on a chunk of its own after each step, and on the
//   done chunk. Resending the same request with the newest blob resumes a
//   broken-off turn; a missing or foreign blob is a fresh start, never an
//   error.
// - `council_tools_v1` (#404, #406): tools reach the council only on a
//   request that also carries `council_chat_state`. Without it a request with
//   tools is a plain chat. Calls come back in `message.tool_calls` with
//   member-keyed ids (`r1:…`, `s:…`) and `done_reason: "stop"`; the results go
//   back as `tool` messages with those ids.
// - PolyKV (#411, #414, #416): xOllama owns the pools of a council model and
//   the lead sends it no pool controls. On any other model the client drives
//   PolyKV itself, as against a bare opencoti, but only where the model has
//   seats for it (`/api/show` `xollama.session.client_pools` > 0; the engine
//   refuses every create otherwise). The control plane is `/api/engine`
//   (`xollama-engine.ts`); a turn attaches with a top-level
//   `placement: {pool_id}`.

import {
	type AgentToolDefinition,
	type BasicLogger,
	flattenPromptEnvironment,
} from "@cline/shared";
import {
	agentWindowFloorForBody,
	type OpencotiAgentWindow,
	readOpencotiAgentWindow,
} from "./opencoti-agent-window";
import { getPolykvGrantedWindow, recordPolykvGrantedWindow } from "./polykv";
import {
	hoistLeadEnvironment,
	markLeadWindowLive,
	prepareLeadPool,
} from "./polykv-lead";
import { engineSessionId } from "./polykv-swarm";
import {
	rememberXollamaRunner,
	xollamaEngineFetch,
	xollamaEngineRoot,
} from "./xollama-engine";

/** xOllama's default origin: its own port, so it can run beside a stock Ollama. */
export const XOLLAMA_DEFAULT_BASE_URL = "http://localhost:22434";

/**
 * How the request's session reaches the xOllama fetch layer. The AI SDK
 * passes per-call headers through to `fetch`, and nothing else from the
 * request gets that far; the layer moves it into the body and drops it.
 */
export const XOLLAMA_SESSION_HEADER = "x-cerebriline-engine-session";

/** The names of the request's read-only tools, as a JSON array. */
export const XOLLAMA_READ_ONLY_HEADER = "x-cerebriline-read-only-tools";

/** The feature that makes a council turn resumable and tool-capable. */
export const XOLLAMA_COUNCIL_STATE_FEATURE = "council_chat_state_v1";

/**
 * The server passes the engine's granted window back as `X-Context-Window` and
 * negotiates one from `placement.num_ctx` / `num_ctx_min` (#424).
 */
export const XOLLAMA_CONTEXT_WINDOW_FEATURE = "context_window_v1";

/**
 * What a conversation on xOllama asks of the engine's window, read off the
 * provider config the way opencoti's is (`resolveOpencotiWindow`):
 *
 * - a session already granted a window asks for exactly that one again -- a
 *   resumed conversation never negotiates down under a history that no longer
 *   fits;
 * - an agent on a node with an "Agent window" share asks for the node's
 *   window, floored at its share measured off the request;
 * - a conversation whose profile turned "Book a context window" on asks for
 *   the model's window, floored at "Never go below" (all or nothing without);
 * - anything else asks for nothing, and the engine decides.
 *
 * Never through `options.num_ctx`: that is the model load, and changing it
 * reloads the runner (#424).
 */
export interface XollamaWindowOptions {
	dynamicContextSize?: boolean;
	contextFloor?: number;
	contextWindow?: number;
	agentWindow?: OpencotiAgentWindow;
}

export function readXollamaWindowOptions(
	options: Readonly<Record<string, unknown>> | undefined,
	contextWindow: number | undefined,
): XollamaWindowOptions {
	const polykv = (options?.polykv ?? {}) as {
		dynamicContextSize?: unknown;
		contextFloor?: unknown;
	};
	const agentWindow = readOpencotiAgentWindow(
		options?.agentWindow,
		contextWindow,
	);
	return {
		...(polykv.dynamicContextSize === true ? { dynamicContextSize: true } : {}),
		...(isPositive(polykv.contextFloor)
			? { contextFloor: Math.floor(polykv.contextFloor) }
			: {}),
		...(isPositive(contextWindow)
			? { contextWindow: Math.floor(contextWindow) }
			: {}),
		...(agentWindow ? { agentWindow } : {}),
	};
}

function isPositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The window fields of this turn's `placement`, or nothing to ask. */
function windowAsk(
	session: string,
	body: Record<string, unknown>,
	window: XollamaWindowOptions,
): { num_ctx: number; num_ctx_min: number } | undefined {
	const granted = getPolykvGrantedWindow(session);
	if (granted !== undefined) {
		return { num_ctx: granted, num_ctx_min: granted };
	}
	if (window.agentWindow) {
		const cap = (body.options as { num_predict?: unknown } | undefined)
			?.num_predict;
		const floor = agentWindowFloorForBody(
			body,
			window.agentWindow,
			isPositive(cap) ? Math.floor(cap) : undefined,
		);
		const ask = window.agentWindow.contextWindow;
		return { num_ctx: ask, num_ctx_min: Math.min(floor ?? ask, ask) };
	}
	if (window.dynamicContextSize && window.contextWindow !== undefined) {
		const ask = window.contextWindow;
		return {
			num_ctx: ask,
			num_ctx_min: Math.min(window.contextFloor ?? ask, ask),
		};
	}
	return undefined;
}

/**
 * A delegated agent's engine session: `~agent-`, `~teammate-` or a swarm
 * worker's `:swarm:`. Its turns are plain chats even on a council model; the
 * council is the lead's (user ruling, 2026-09-27).
 */
export function isDelegatedEngineSession(session: string | undefined): boolean {
	return session !== undefined && /~agent-|~teammate-|:swarm:/.test(session);
}

/**
 * The newest council state per server, model and session. Kept in memory: a
 * lost blob is a fresh start on the server's side, not an error, so a reload
 * costs at most a council step redone.
 */
const COUNCIL_STATES = new Map<string, string>();

function councilStateKey(
	root: string,
	model: string,
	session: string | undefined,
): string {
	return `${origin(root)}::${model}::${session ?? ""}`;
}

/** What `GET /api/xollama` answers. */
export interface XollamaServerInfo {
	version?: string;
	features: string[];
}

/** What `/api/show`'s `xollama` block says about one model. */
export interface XollamaModelInfo {
	/** The model answers chat turns with its council. */
	council: boolean;
	/**
	 * Pool seats the model keeps for a client's own pools
	 * (`session.client_pools`). 0 on an older xOllama, which has none.
	 */
	clientPools: number;
}

function origin(baseUrl: string | undefined): string {
	const trimmed = (baseUrl?.trim() || XOLLAMA_DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	return trimmed.replace(/\/(?:v1|api)$/, "");
}

const serverInfo = new Map<string, Promise<XollamaServerInfo | undefined>>();

/**
 * The server's xOllama answer, once per origin. `undefined` is a server that
 * is not xOllama (a stock Ollama 404s the route) or did not answer; a failed
 * read is not cached, so a server that comes up later is found.
 */
export function probeXollama(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
): Promise<XollamaServerInfo | undefined> {
	const key = origin(baseUrl);
	const cached = serverInfo.get(key);
	if (cached) {
		return cached;
	}
	const read = (async () => {
		const response = await fetchImpl(`${key}/api/xollama`);
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as {
			xollama?: unknown;
			version?: unknown;
			features?: unknown;
		};
		if (body.xollama !== true) {
			return undefined;
		}
		return {
			...(typeof body.version === "string" ? { version: body.version } : {}),
			features: Array.isArray(body.features)
				? body.features.filter((f): f is string => typeof f === "string")
				: [],
		};
	})().catch(() => undefined);
	serverInfo.set(key, read);
	void read.then((info) => {
		if (info === undefined) {
			serverInfo.delete(key);
		}
	});
	return read;
}

const modelInfo = new Map<string, Promise<XollamaModelInfo | undefined>>();

/** One model's `xollama` block, once per origin and model. */
export function readXollamaModel(
	baseUrl: string | undefined,
	modelId: string,
	fetchImpl: typeof fetch,
): Promise<XollamaModelInfo | undefined> {
	const key = `${origin(baseUrl)}::${modelId}`;
	const cached = modelInfo.get(key);
	if (cached) {
		return cached;
	}
	const read = (async () => {
		const response = await fetchImpl(`${origin(baseUrl)}/api/show`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: modelId }),
		});
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as {
			xollama?: {
				council?: { enabled?: unknown };
				session?: { client_pools?: unknown };
			};
		};
		const seats = body.xollama?.session?.client_pools;
		return {
			council: body.xollama?.council?.enabled === true,
			clientPools:
				typeof seats === "number" && Number.isInteger(seats) && seats > 0
					? seats
					: 0,
		};
	})().catch(() => undefined);
	modelInfo.set(key, read);
	void read.then((info) => {
		if (info === undefined) {
			modelInfo.delete(key);
		}
	});
	return read;
}

/**
 * The provider's auth headers on every request to the xOllama server.
 *
 * xOllama can require a local key on every route (`api_key_v1`, #421):
 * `Authorization: Bearer <key>`, `/api/engine` included. The chat itself gets
 * it from the Ollama package's headers, but the rest of what this provider
 * sends -- the feature and `/api/show` probes, the `num_ctx` and reinjection
 * probes, the render-only chat and every `/api/engine` call of PolyKV -- goes
 * through the bare fetch, and on a keyed server each of them is a 401.
 *
 * Only to that server's origin, so a key never travels with a request that
 * happens to share the fetch. A header the request already carries wins: an
 * explicit one is the caller's decision.
 */
export function withXollamaAuth(
	baseFetch: typeof fetch,
	baseUrl: string | undefined,
	headers: Readonly<Record<string, string>>,
): typeof fetch {
	const names = Object.keys(headers);
	if (names.length === 0) {
		return baseFetch;
	}
	const home = origin(baseUrl);
	return (async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		let sameOrigin = false;
		try {
			sameOrigin = new URL(url).origin === new URL(home).origin;
		} catch {
			sameOrigin = false;
		}
		if (!sameOrigin) {
			return baseFetch(input, init);
		}
		const merged = new Headers(init?.headers);
		for (const name of names) {
			if (!merged.has(name)) {
				merged.set(name, headers[name] as string);
			}
		}
		return baseFetch(input, { ...init, headers: merged });
	}) as typeof fetch;
}

/**
 * Forget one model's `/api/show` answer, so the next read asks again. For the
 * settings panel: a model given seats since it was read gets its pool on the
 * next turn rather than after a reload.
 */
export function forgetXollamaModel(
	baseUrl: string | undefined,
	modelId: string,
): void {
	modelInfo.delete(`${origin(baseUrl)}::${modelId}`);
}

/** Forget what was read, for tests and for a server that was replaced. */
export function resetXollamaProbes(): void {
	serverInfo.clear();
	modelInfo.clear();
	COUNCIL_STATES.clear();
}

/** The session to name on the wire for a request's session. */
export function xollamaSessionHeaders(
	sessionId: string | undefined,
): Record<string, string> {
	return sessionId
		? { [XOLLAMA_SESSION_HEADER]: engineSessionId(sessionId) }
		: {};
}

/** The request's read-only tools, named for the fetch layer to mark. */
export function xollamaReadOnlyHeaders(
	tools: readonly AgentToolDefinition[] | undefined,
): Record<string, string> {
	const names = (tools ?? [])
		.filter((tool) => tool.readOnly === true)
		.map((tool) => tool.name);
	return names.length > 0
		? { [XOLLAMA_READ_ONLY_HEADER]: JSON.stringify(names) }
		: {};
}

function readOnlyNames(value: string | undefined): Set<string> {
	if (!value) {
		return new Set();
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((n): n is string => typeof n === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

/** `x_read_only` on each named tool's function object. */
/**
 * The tool a council adds to its members' list and answers itself (#414): long
 * tool results travel between members by reference through it. A client tool
 * of the same name would be two tools under one name on a council turn.
 */
export const XOLLAMA_COUNCIL_TOOL = "council_evidence";

/** The request's tools without one named like the council's own. */
function withoutCouncilTool(tools: unknown): unknown[] | undefined {
	if (!Array.isArray(tools)) {
		return undefined;
	}
	const kept = tools.filter(
		(tool) =>
			(tool as { function?: { name?: unknown } } | null)?.function?.name !==
			XOLLAMA_COUNCIL_TOOL,
	);
	return kept.length === tools.length ? undefined : kept;
}

function markReadOnly(tools: unknown, names: Set<string>): unknown {
	if (!Array.isArray(tools) || names.size === 0) {
		return tools;
	}
	return tools.map((tool) => {
		const fn = (tool as { function?: { name?: unknown } } | null)?.function;
		return fn && typeof fn.name === "string" && names.has(fn.name)
			? { ...tool, function: { ...fn, x_read_only: true } }
			: tool;
	});
}

function headerValue(
	headers: RequestInit["headers"] | undefined,
	name: string,
): string | undefined {
	if (!headers) {
		return undefined;
	}
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key.toLowerCase() === name)?.[1];
	}
	const record = headers as Record<string, string | undefined>;
	const key = Object.keys(record).find((k) => k.toLowerCase() === name);
	return key ? record[key] : undefined;
}

function withoutHeaders(
	headers: RequestInit["headers"] | undefined,
	names: readonly string[],
): RequestInit["headers"] | undefined {
	if (!headers) {
		return headers;
	}
	const copy = new Headers(headers);
	for (const name of names) {
		copy.delete(name);
	}
	return copy;
}

/**
 * Each past assistant turn without its `thinking`.
 *
 * A council's thinking is its deliberation: several thousand tokens of plan,
 * findings and critiques per turn (xollama mail #375). Sent back, it fills the
 * window and brings the council's compaction on early, and nothing reads it;
 * what the council needs across turns travels in its sealed state instead.
 */
function withoutThinking(messages: unknown[]): unknown[] {
	return messages.map((message) => {
		if (
			!message ||
			typeof message !== "object" ||
			!("thinking" in message) ||
			(message as { role?: unknown }).role !== "assistant"
		) {
			return message;
		}
		const { thinking: _deliberation, ...rest } = message as Record<
			string,
			unknown
		>;
		return rest;
	});
}

/** The server root a chat URL was sent to, for the model lookup. */
function chatRoot(input: Parameters<typeof fetch>[0]): string | undefined {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	const at = url.search(/\/api\/chat(?:[?#]|$)/);
	return at >= 0 ? url.slice(0, at) : undefined;
}

/** A council member's tag, as `council_tags_v1` sends it. */
export interface XollamaCouncilTag {
	role: string;
	index: number;
	round: number;
}

function councilTagOf(value: unknown): XollamaCouncilTag | undefined {
	const tag = value as Partial<XollamaCouncilTag> | null | undefined;
	return tag &&
		typeof tag.role === "string" &&
		typeof tag.index === "number" &&
		typeof tag.round === "number"
		? { role: tag.role, index: tag.index, round: tag.round }
		: undefined;
}

/**
 * The heading a member's span opens with: its role, its number among its
 * peers where there are several, and the round, all counted from 1.
 */
export function councilHeading(tag: XollamaCouncilTag): string {
	const role = tag.role.charAt(0).toUpperCase() + tag.role.slice(1);
	const peers = tag.role === "researcher" || tag.role === "critic";
	return `#### ${role}${peers ? ` ${tag.index + 1}` : ""} · round ${tag.round + 1}`;
}

/**
 * A council turn's deliberation with a heading at each member's span.
 *
 * The thinking block renders as Markdown, so the tag becomes a heading there.
 * xOllama opens each span with its own `### Researcher 2` line for clients
 * that do not read tags; that line is dropped for ours, and it can arrive
 * split over several chunks, so a span's first text is held until its first
 * line is known.
 */
export class CouncilDeliberation {
	private span: string | undefined;
	private opening = false;
	private held = "";

	/** The thinking text to send for one chunk. */
	thinking(tag: XollamaCouncilTag, text: string): string {
		const key = `${tag.role}/${tag.index}/${tag.round}`;
		let out = "";
		if (key !== this.span) {
			out += this.close();
			out += `${this.span === undefined ? "" : "\n\n"}${councilHeading(tag)}\n\n`;
			this.span = key;
			this.opening = true;
			this.held = "";
		}
		if (!this.opening) {
			return out + text;
		}
		this.held += text;
		const start = this.held.trimStart();
		if (start === "") {
			return out;
		}
		if (!start.startsWith("#")) {
			this.opening = false;
			return out + start;
		}
		const eol = start.indexOf("\n");
		if (eol < 0) {
			return out;
		}
		this.opening = false;
		return out + start.slice(eol + 1).replace(/^\n+/, "");
	}

	/**
	 * What is held when the span ends. Held text that began with `#` and never
	 * finished its line was the span's own heading; anything else is kept.
	 */
	close(): string {
		const held = this.opening ? this.held.trimStart() : "";
		this.opening = false;
		this.held = "";
		return held.startsWith("#") ? "" : held;
	}
}

/**
 * The council state a chunk carries, taken out of it. `drop` is a chunk that
 * carried nothing else -- no text, thinking, tool call, or end -- and has no
 * business reaching the chat.
 */
function takeCouncilState(chunk: Record<string, unknown>): {
	state?: string;
	rest: Record<string, unknown>;
	drop: boolean;
} {
	if (typeof chunk.council_chat_state !== "string") {
		return { rest: chunk, drop: false };
	}
	const { council_chat_state: state, ...rest } = chunk;
	const message = rest.message as
		| { content?: unknown; thinking?: unknown; tool_calls?: unknown }
		| undefined;
	const empty =
		rest.done !== true &&
		!(typeof message?.content === "string" && message.content !== "") &&
		!(typeof message?.thinking === "string" && message.thinking !== "") &&
		!(Array.isArray(message?.tool_calls) && message.tool_calls.length > 0);
	return { state: state as string, rest, drop: empty };
}

/**
 * Each tagged thinking chunk of an NDJSON chat stream, given its heading, and
 * the council state taken out of the stream and handed to `onState`.
 */
function withCouncilHeadings(
	response: Response,
	onState?: (state: string) => void,
): Response {
	if (!response.ok || !response.body) {
		return response;
	}
	if (!/ndjson/i.test(response.headers.get("content-type") ?? "")) {
		return onState ? withCouncilStateFromJson(response, onState) : response;
	}
	const deliberation = new CouncilDeliberation();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let partial = "";
	const line = (raw: string): string | undefined => {
		if (raw.trim() === "") {
			return raw;
		}
		let chunk: {
			council?: unknown;
			message?: { thinking?: unknown };
		};
		try {
			chunk = JSON.parse(raw);
		} catch {
			return raw;
		}
		let changed = false;
		if (
			typeof (chunk as Record<string, unknown>).council_chat_state === "string"
		) {
			const taken = takeCouncilState(chunk as Record<string, unknown>);
			if (taken.state !== undefined) {
				onState?.(taken.state);
			}
			if (taken.drop) {
				return undefined;
			}
			chunk = taken.rest as typeof chunk;
			changed = true;
		}
		const tag = councilTagOf(chunk.council);
		if (tag && typeof chunk.message?.thinking === "string") {
			return JSON.stringify({
				...chunk,
				message: {
					...chunk.message,
					thinking: deliberation.thinking(tag, chunk.message.thinking),
				},
			});
		}
		return changed ? JSON.stringify(chunk) : raw;
	};
	const kept = (lines: string[]): string[] =>
		lines.map(line).filter((l): l is string => l !== undefined);
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(bytes, controller) {
				partial += decoder.decode(bytes, { stream: true });
				const lines = partial.split("\n");
				partial = lines.pop() ?? "";
				const out = kept(lines);
				if (out.length > 0) {
					controller.enqueue(encoder.encode(`${out.join("\n")}\n`));
				}
			},
			flush(controller) {
				partial += decoder.decode();
				if (partial !== "") {
					const last = line(partial);
					if (last !== undefined) {
						controller.enqueue(encoder.encode(last));
					}
				}
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/** A non-streamed chat answer: its council state kept, and taken out of it. */
function withCouncilStateFromJson(
	response: Response,
	onState: (state: string) => void,
): Response {
	const read = response.text().then((text) => {
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			const taken = takeCouncilState(parsed);
			if (taken.state === undefined) {
				return text;
			}
			onState(taken.state);
			return JSON.stringify(taken.rest);
		} catch {
			return text;
		}
	});
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(new TextEncoder().encode(await read));
			controller.close();
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * The environment spans of a system turn, folded back into its text.
 *
 * Kept in the system prompt for xOllama (`ai-sdk.ts`) so a pooled lead turn
 * can lift them into a turn of their own; every other turn sends exactly the
 * text a provider without pooling would have. Replaces `messages` only when
 * something changed, so an unmarked prompt goes out byte for byte.
 */
function flattenSystemEnvironment(body: Record<string, unknown>): void {
	const messages = body.messages as Array<Record<string, unknown>>;
	const system = messages[0];
	if (system?.role !== "system" || typeof system.content !== "string") {
		return;
	}
	const flat = flattenPromptEnvironment(system.content);
	if (flat !== system.content) {
		body.messages = [{ ...system, content: flat }, ...messages.slice(1)];
	}
}

/**
 * The lead conversation's pool on a plain model, as opencoti's lead tree
 * builds it (`polykv-lead.ts`): the static system prompt and tools shared by
 * every conversation on the model, rendered by xOllama and held once.
 *
 * Lifts the environment into its own turn (mutating `body`) only for a lead's
 * request, and answers the placement to send, or nothing -- a model not
 * loaded yet, an engine that is not opencoti, a refused create -- in which
 * case the turn runs unpooled and the next one asks again. Never fails a turn.
 */
/** Top-level `placement` on a plain turn (client_placement_v1, #424). */
interface XollamaPlacement {
	pool_id?: number;
	num_ctx?: number;
	num_ctx_min?: number;
}

/** The lead's pool, and what of its window the pool already holds. */
interface LeadAttach {
	placement: XollamaPlacement;
	/** The shared prefix, riding above a private budget where the engine says so. */
	sharedAboveBudget?: number;
}

async function leadPlacement(
	baseUrl: string,
	body: Record<string, unknown>,
	session: string,
	baseFetch: typeof fetch,
	logger: BasicLogger | undefined,
): Promise<LeadAttach | undefined> {
	const probe = {
		...body,
		messages: [...(body.messages as unknown[])],
	};
	if (!hoistLeadEnvironment(probe)) {
		return undefined;
	}
	try {
		const attach = await prepareLeadPool({
			baseUrl: xollamaEngineRoot(baseUrl, body.model as string),
			fetch: xollamaEngineFetch(baseFetch),
			body: probe,
			sessionId: session,
		});
		if (!attach || !/^\d+$/.test(attach.poolId)) {
			return undefined;
		}
		body.messages = probe.messages;
		return {
			placement: { pool_id: Number(attach.poolId) },
			...(attach.privateWindow && attach.sharedTokens > 0
				? { sharedAboveBudget: attach.sharedTokens }
				: {}),
		};
	} catch (error) {
		logger?.debug?.(
			`[xollama] lead pool unavailable, turn runs unpooled: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

/**
 * xOllama's request fields, added to each `/api/chat` body: `session_id` from
 * the request's session, `x_read_only` on its read-only tools, and, for a
 * council model, the history without the council's past deliberation. A body
 * that is not a chat body goes out untouched. A chat's streamed answer comes
 * back with each council member's span of thinking under its own heading.
 */
export function withXollamaRequestFields(
	baseFetch: typeof fetch,
	options?: { logger?: BasicLogger; window?: XollamaWindowOptions },
): typeof fetch {
	return (async (input, init) => {
		const session = headerValue(init?.headers, XOLLAMA_SESSION_HEADER);
		const readOnly = headerValue(init?.headers, XOLLAMA_READ_ONLY_HEADER);
		const root = chatRoot(input);
		if (
			typeof init?.body !== "string" ||
			(root === undefined && session === undefined && readOnly === undefined)
		) {
			return baseFetch(input, init);
		}
		const headers = withoutHeaders(init.headers, [
			XOLLAMA_SESSION_HEADER,
			XOLLAMA_READ_ONLY_HEADER,
		]);
		let body = init.body;
		let stateKey: string | undefined;
		/** The session whose granted window this turn's answer reports. */
		let windowSession: string | undefined;
		let leadPooled = false;
		let asked: number | undefined;
		let sharedAboveBudget: number | undefined;
		try {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			const original = parsed.messages;
			if (Array.isArray(parsed.messages)) {
				const model =
					root !== undefined && typeof parsed.model === "string"
						? await readXollamaModel(root, parsed.model, baseFetch)
						: undefined;
				// A delegated agent's turn is a plain chat, even on a council
				// model: its history keeps its thinking and it sends no state.
				const council =
					model?.council === true && !isDelegatedEngineSession(session);
				// A swarm agent's turn arrives placed by the worker layer outside
				// this one (`createPolykvWorkerFetch`): its pool and window are
				// that layer's, and nothing here adds to them.
				const placedOutside =
					parsed.placement !== null && typeof parsed.placement === "object";
				if (root !== undefined && typeof parsed.model === "string") {
					rememberXollamaRunner(root, parsed.model, parsed);
				}
				// The lead's pool, on a model that has seats for one. Any other
				// turn has its environment folded back into the system text,
				// which is what every provider but opencoti sends.
				const lead: LeadAttach | undefined =
					!council &&
					!placedOutside &&
					model !== undefined &&
					model.clientPools > 0 &&
					root !== undefined &&
					session !== undefined &&
					!isDelegatedEngineSession(session)
						? await leadPlacement(
								root,
								parsed,
								session,
								baseFetch,
								options?.logger,
							)
						: undefined;
				let placement: XollamaPlacement | undefined = lead?.placement;
				if (placement === undefined) {
					flattenSystemEnvironment(parsed);
				}
				leadPooled = placement !== undefined;
				// The window, on any plain turn of a server that negotiates one.
				if (
					!council &&
					!placedOutside &&
					model !== undefined &&
					root !== undefined &&
					session !== undefined &&
					options?.window &&
					(await probeXollama(root, baseFetch))?.features.includes(
						XOLLAMA_CONTEXT_WINDOW_FEATURE,
					) === true
				) {
					windowSession = session;
					const ask = windowAsk(session, parsed, options.window);
					// The window is the private budget where the engine says so,
					// and the pool's prefix rides above it: a new conversation
					// books its window less what it shares, as on opencoti, or a
					// window as large as the engine's whole KV is refused once any
					// pool holds a cell of it. A resume keeps its grant.
					if (
						ask?.num_ctx !== undefined &&
						lead?.sharedAboveBudget !== undefined &&
						getPolykvGrantedWindow(session) === undefined
					) {
						const budget = Math.max(1, ask.num_ctx - lead.sharedAboveBudget);
						sharedAboveBudget = ask.num_ctx - budget;
						ask.num_ctx = budget;
						if (ask.num_ctx_min !== undefined) {
							ask.num_ctx_min = Math.min(ask.num_ctx_min, budget);
						}
					}
					if (ask) {
						asked = ask.num_ctx;
						placement = { ...(placement ?? {}), ...ask };
					}
				}
				const councilSafe = council
					? withoutCouncilTool(parsed.tools)
					: undefined;
				if (councilSafe !== undefined) {
					options?.logger?.log(
						`[xollama] a tool named "${XOLLAMA_COUNCIL_TOOL}" was left out of a council turn: the council answers that name itself`,
					);
					parsed.tools = councilSafe;
				}
				// Only where the server resumes: an older xOllama took no state.
				const stateful =
					council &&
					root !== undefined &&
					(await probeXollama(root, baseFetch))?.features.includes(
						XOLLAMA_COUNCIL_STATE_FEATURE,
					) === true;
				if (stateful && root !== undefined) {
					stateKey = councilStateKey(root, parsed.model as string, session);
				}
				const names = readOnlyNames(readOnly);
				// A body with nothing to add goes out as it came, byte for byte.
				if (
					council ||
					session !== undefined ||
					names.size > 0 ||
					placement !== undefined ||
					councilSafe !== undefined ||
					parsed.messages !== original
				) {
					body = JSON.stringify({
						...parsed,
						...(placement !== undefined ? { placement } : {}),
						...(council ? { messages: withoutThinking(parsed.messages) } : {}),
						...(session !== undefined ? { session_id: session } : {}),
						...(parsed.tools !== undefined
							? { tools: markReadOnly(parsed.tools, names) }
							: {}),
						// "" the first time; then the newest blob, byte for byte.
						...(stateKey !== undefined
							? { council_chat_state: COUNCIL_STATES.get(stateKey) ?? "" }
							: {}),
					});
				}
			}
		} catch {
			options?.logger?.debug?.(
				"[xollama] request body is not JSON; sent without xOllama fields",
			);
		}
		const response = await baseFetch(input, { ...init, headers, body });
		// The window the engine granted this session, before the first byte.
		// Absent is "no guaranteed window", not "unchanged" -- nothing is
		// recorded then.
		const granted = Number(response.headers.get("x-context-window"));
		if (
			windowSession !== undefined &&
			Number.isInteger(granted) &&
			granted > 0
		) {
			recordPolykvGrantedWindow(windowSession, granted, {
				...(asked !== undefined ? { asked } : {}),
				...(sharedAboveBudget !== undefined
					? { sharedTokens: sharedAboveBudget }
					: {}),
			});
			// A lead holding a window can own its private sub-pool (the lead
			// tree's `Ls`); without one it attaches the shared root alone.
			if (leadPooled) {
				markLeadWindowLive(windowSession);
			}
		}
		if (root === undefined) {
			return response;
		}
		const key = stateKey;
		// Every blob seen is kept, the last one winning: a turn that breaks
		// off mid-deliberation resumes from the newest step it reached.
		return withCouncilHeadings(
			response,
			key === undefined
				? undefined
				: (state) => {
						COUNCIL_STATES.set(key, state);
					},
		);
	}) as typeof fetch;
}
