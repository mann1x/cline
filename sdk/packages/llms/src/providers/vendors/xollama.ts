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

import type { AgentToolDefinition, BasicLogger } from "@cline/shared";
import { engineSessionId } from "./polykv-swarm";

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

/** What `GET /api/xollama` answers. */
export interface XollamaServerInfo {
	version?: string;
	features: string[];
}

/** What `/api/show`'s `xollama` block says about one model. */
export interface XollamaModelInfo {
	/** The model answers chat turns with its council. */
	council: boolean;
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
			xollama?: { council?: { enabled?: unknown } };
		};
		return { council: body.xollama?.council?.enabled === true };
	})().catch(() => undefined);
	modelInfo.set(key, read);
	void read.then((info) => {
		if (info === undefined) {
			modelInfo.delete(key);
		}
	});
	return read;
}

/** Forget what was read, for tests and for a server that was replaced. */
export function resetXollamaProbes(): void {
	serverInfo.clear();
	modelInfo.clear();
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

/** Each tagged thinking chunk of an NDJSON chat stream, given its heading. */
function withCouncilHeadings(response: Response): Response {
	if (
		!response.ok ||
		!response.body ||
		!/ndjson/i.test(response.headers.get("content-type") ?? "")
	) {
		return response;
	}
	const deliberation = new CouncilDeliberation();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let partial = "";
	const line = (raw: string): string => {
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
		return raw;
	};
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(bytes, controller) {
				partial += decoder.decode(bytes, { stream: true });
				const lines = partial.split("\n");
				partial = lines.pop() ?? "";
				if (lines.length > 0) {
					controller.enqueue(encoder.encode(`${lines.map(line).join("\n")}\n`));
				}
			},
			flush(controller) {
				partial += decoder.decode();
				if (partial !== "") {
					controller.enqueue(encoder.encode(line(partial)));
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

/**
 * xOllama's request fields, added to each `/api/chat` body: `session_id` from
 * the request's session, `x_read_only` on its read-only tools, and, for a
 * council model, the history without the council's past deliberation. A body
 * that is not a chat body goes out untouched. A chat's streamed answer comes
 * back with each council member's span of thinking under its own heading.
 */
export function withXollamaRequestFields(
	baseFetch: typeof fetch,
	options?: { logger?: BasicLogger },
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
		try {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			if (Array.isArray(parsed.messages)) {
				const council =
					root !== undefined && typeof parsed.model === "string"
						? (await readXollamaModel(root, parsed.model, baseFetch))
								?.council === true
						: false;
				const names = readOnlyNames(readOnly);
				// A body with nothing to add goes out as it came, byte for byte.
				if (council || session !== undefined || names.size > 0) {
					body = JSON.stringify({
						...parsed,
						...(council ? { messages: withoutThinking(parsed.messages) } : {}),
						...(session !== undefined ? { session_id: session } : {}),
						...(parsed.tools !== undefined
							? { tools: markReadOnly(parsed.tools, names) }
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
		return root === undefined ? response : withCouncilHeadings(response);
	}) as typeof fetch;
}
