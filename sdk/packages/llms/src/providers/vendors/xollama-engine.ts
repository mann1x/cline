/**
 * An opencoti engine behind xOllama, addressed as if it were a bare opencoti.
 *
 * xOllama runs one engine per loaded model and exposes its control plane at
 * `/api/engine?model=M&endpoint=<route>`, answering with the engine's reply
 * wrapped: `200 {status, body | text}` (xollama mail #414). Everything in
 * `polykv.ts`, `polykv-lead.ts` and `polykv-swarm.ts` speaks to a root as
 * `${root}/<route>`, so rather than teach each of them a second transport,
 * this gives each model a root of its own -- `${origin}/xollama-engine/<model>`
 * -- and a fetch that turns a call on it into the proxied one and unwraps the
 * answer. Caches keyed by root are then per model, which is right: pools, boot
 * ids and features belong to one engine.
 *
 * One route is not proxied. `/apply-template` renders with the ENGINE's chat
 * template, but a chat through xOllama may be rendered by xOllama itself (a
 * Modelfile TEMPLATE, a renderer) before the engine sees a prompt, and a pool
 * built from the other rendering shares nothing while reporting success. So it
 * becomes a render-only chat (`_debug_render_only`, `chat_render_v1`), which is
 * xOllama's own answer to "what will you send the engine for this".
 *
 * That render schedules the model with the request's `options` before it
 * renders. The fields the pool code forwards are the chat body's own, options
 * included, so the render asks for the runner the chat will use -- a render
 * with a different `num_ctx` would reload the model.
 *
 * And one route is translated. A swarm opens an owner session with an
 * OpenAI-shaped `POST /v1/chat/completions` (`polykv-swarm.ts`), which the
 * engine proxy does not carry: it becomes a native `/api/chat` with the window
 * in `placement` and a one-token cap. Its `options` and `think` are the ones
 * the model's chats were last sent with (see {@link rememberXollamaRunner}):
 * Ollama reloads a runner whose options differ, and an owner open that reloads
 * the model under a running swarm drops every session on it.
 */

const ENGINE_PATH = "/xollama-engine/";

function originOf(baseUrl: string): string {
	return baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/(?:v1|api)$/, "");
}

/** The root the PolyKV code is given for one model's engine. */
export function xollamaEngineRoot(baseUrl: string, model: string): string {
	return `${originOf(baseUrl)}${ENGINE_PATH}${encodeURIComponent(model)}`;
}

/** The model and route a root call names, or nothing for any other URL. */
export function parseXollamaEngineUrl(
	url: string,
):
	| { origin: string; model: string; endpoint: string; query: URLSearchParams }
	| undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const at = parsed.pathname.indexOf(ENGINE_PATH);
	if (at < 0) {
		return undefined;
	}
	const rest = parsed.pathname.slice(at + ENGINE_PATH.length);
	const slash = rest.indexOf("/");
	const model = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
	const endpoint = slash < 0 ? "" : rest.slice(slash + 1);
	if (!model) {
		return undefined;
	}
	return {
		origin: `${parsed.origin}${parsed.pathname.slice(0, at)}`,
		model,
		endpoint,
		query: parsed.searchParams,
	};
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.href;
	}
	return (input as Request).url;
}

/** The engine's reply out of xOllama's wrapper, as the engine would have sent it. */
async function unwrap(response: Response): Promise<Response> {
	const type = response.headers.get("content-type") ?? "";
	// An error from xOllama itself (model not loaded, engine starting) and a
	// passed-through stream are already the answer.
	if (!response.ok || type.includes("text/event-stream")) {
		return response;
	}
	let wrapped: { status?: unknown; body?: unknown; text?: unknown };
	try {
		wrapped = (await response.json()) as typeof wrapped;
	} catch {
		return new Response(
			"xOllama answered /api/engine with something that is not JSON",
			{
				status: 502,
			},
		);
	}
	const status =
		typeof wrapped.status === "number" &&
		wrapped.status >= 200 &&
		wrapped.status <= 599
			? wrapped.status
			: 502;
	if (wrapped.body !== undefined) {
		return new Response(JSON.stringify(wrapped.body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}
	return new Response(typeof wrapped.text === "string" ? wrapped.text : "", {
		status,
		headers: { "content-type": "text/plain" },
	});
}

/** `/apply-template` as xOllama renders it: a render-only chat of the same body. */
async function render(
	baseFetch: typeof fetch,
	origin: string,
	model: string,
	init: RequestInit | undefined,
): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(
			typeof init?.body === "string" ? init.body : "{}",
		) as Record<string, unknown>;
	} catch {
		return new Response("apply-template body is not JSON", { status: 400 });
	}
	// The generation prompt is the template's business on this side: the pool
	// code cuts the rendering at its own sentinel turn, before it.
	const { add_generation_prompt: _generation, ...fields } = body;
	const response = await baseFetch(`${origin}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...fields,
			model,
			stream: false,
			_debug_render_only: true,
		}),
		...(init?.signal ? { signal: init.signal } : {}),
	});
	if (!response.ok) {
		return response;
	}
	const answer = (await response.json()) as {
		_debug_info?: { rendered_template?: unknown };
	};
	const prompt = answer._debug_info?.rendered_template;
	if (typeof prompt !== "string") {
		return new Response(
			"xOllama's render-only chat returned no rendered_template",
			{
				status: 502,
			},
		);
	}
	return new Response(JSON.stringify({ prompt }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** The runner a model's chats ask for, per origin and model. */
const RUNNERS = new Map<
	string,
	{ options?: Record<string, unknown>; think?: unknown }
>();

const runnerKey = (origin: string, model: string) =>
	`${originOf(origin)}\n${model}`;

/**
 * The `options` and `think` a chat on `model` went out with, so a request this
 * module makes on its own asks for the same runner. `num_predict` is the
 * turn's, not the runner's, and is left out.
 */
export function rememberXollamaRunner(
	origin: string,
	model: string,
	body: Readonly<Record<string, unknown>>,
): void {
	const options =
		body.options && typeof body.options === "object"
			? { ...(body.options as Record<string, unknown>) }
			: undefined;
	if (options) {
		delete options.num_predict;
	}
	RUNNERS.set(runnerKey(origin, model), {
		...(options ? { options } : {}),
		...(body.think !== undefined ? { think: body.think } : {}),
	});
}

export function resetXollamaRunners(): void {
	RUNNERS.clear();
}

/** An owner open, as the native chat xOllama carries to the engine. */
async function openOwner(
	baseFetch: typeof fetch,
	origin: string,
	model: string,
	init: RequestInit | undefined,
): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(
			typeof init?.body === "string" ? init.body : "{}",
		) as Record<string, unknown>;
	} catch {
		return new Response("chat body is not JSON", { status: 400 });
	}
	const runner = RUNNERS.get(runnerKey(origin, model));
	const placement: Record<string, unknown> = {};
	for (const field of ["pool_id", "num_ctx", "num_ctx_min"] as const) {
		if (typeof body[field] === "number") {
			placement[field] = body[field];
		}
	}
	const cap = typeof body.max_tokens === "number" ? body.max_tokens : 1;
	return baseFetch(`${origin}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			messages: body.messages,
			...(body.tools !== undefined ? { tools: body.tools } : {}),
			...(typeof body.session_id === "string"
				? { session_id: body.session_id }
				: {}),
			...(Object.keys(placement).length > 0 ? { placement } : {}),
			options: { ...(runner?.options ?? {}), num_predict: cap },
			...(runner?.think !== undefined ? { think: runner.think } : {}),
			stream: false,
		}),
		...(init?.signal ? { signal: init.signal } : {}),
	});
}

/**
 * A fetch that serves engine roots through xOllama and passes every other
 * URL to `baseFetch` untouched.
 */
export function xollamaEngineFetch(baseFetch: typeof fetch): typeof fetch {
	return (async (input, init) => {
		const target = parseXollamaEngineUrl(urlOf(input));
		if (!target) {
			return baseFetch(input, init);
		}
		if (target.endpoint === "apply-template") {
			return render(baseFetch, target.origin, target.model, init);
		}
		if (target.endpoint === "v1/chat/completions") {
			return openOwner(baseFetch, target.origin, target.model, init);
		}
		const query = new URLSearchParams(target.query);
		query.set("model", target.model);
		query.set("endpoint", target.endpoint);
		const method = (init?.method ?? "GET").toUpperCase();
		const response = await baseFetch(`${target.origin}/api/engine?${query}`, {
			...init,
			method,
			// A GET with a body is refused by fetch outright.
			...(method === "GET" ? { body: undefined } : {}),
		});
		return unwrap(response);
	}) as typeof fetch;
}

/** Which engine serves each loaded model, from `GET /api/engine`. */
export async function readXollamaEngines(
	baseUrl: string,
	fetchImpl: typeof fetch,
): Promise<Map<string, string>> {
	const engines = new Map<string, string>();
	try {
		const response = await fetchImpl(`${originOf(baseUrl)}/api/engine`);
		if (!response.ok) {
			return engines;
		}
		const body = (await response.json()) as { models?: unknown };
		if (Array.isArray(body.models)) {
			for (const entry of body.models as Array<Record<string, unknown>>) {
				if (
					typeof entry?.model === "string" &&
					typeof entry.engine === "string"
				) {
					engines.set(entry.model, entry.engine);
				}
			}
		}
	} catch {
		// An older xOllama or a server that is down: no engine is known.
	}
	return engines;
}
