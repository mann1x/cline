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
 * xOllama's request fields, added to each `/api/chat` body: `session_id` from
 * the request's session, and `x_read_only` on its read-only tools. A body
 * that is not a chat body goes out untouched.
 */
export function withXollamaRequestFields(
	baseFetch: typeof fetch,
	options?: { logger?: BasicLogger },
): typeof fetch {
	return (async (input, init) => {
		const session = headerValue(init?.headers, XOLLAMA_SESSION_HEADER);
		const readOnly = headerValue(init?.headers, XOLLAMA_READ_ONLY_HEADER);
		if (session === undefined && readOnly === undefined) {
			return baseFetch(input, init);
		}
		const headers = withoutHeaders(init?.headers, [
			XOLLAMA_SESSION_HEADER,
			XOLLAMA_READ_ONLY_HEADER,
		]);
		let body = init?.body;
		if (typeof body === "string") {
			try {
				const parsed = JSON.parse(body) as Record<string, unknown>;
				if (Array.isArray(parsed.messages)) {
					body = JSON.stringify({
						...parsed,
						...(session !== undefined ? { session_id: session } : {}),
						...(parsed.tools !== undefined
							? { tools: markReadOnly(parsed.tools, readOnlyNames(readOnly)) }
							: {}),
					});
				}
			} catch {
				options?.logger?.debug?.(
					"[xollama] request body is not JSON; sent without xOllama fields",
				);
			}
		}
		return baseFetch(input, { ...init, headers, body });
	}) as typeof fetch;
}
