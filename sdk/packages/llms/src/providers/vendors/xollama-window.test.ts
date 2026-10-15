import { afterEach, describe, expect, it } from "vitest";
import { resetPolykvSessions } from "./polykv";
import {
	readXollamaWindowOptions,
	resetXollamaConversationRequests,
	resetXollamaProbes,
	withXollamaRequestFields,
	XOLLAMA_SESSION_HEADER,
	type XollamaWindowOptions,
} from "./xollama";

afterEach(() => {
	resetXollamaProbes();
	resetXollamaConversationRequests();
	resetPolykvSessions();
});

const json = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const PROMPT_TOKENS = 17_431;
const OUTPUT = 96_000;
const SET = 256_000;

/** A stub xOllama that negotiates windows and grants `grant` on every chat. */
function server(grant?: number) {
	const chats: Array<Record<string, unknown>> = [];
	const engine: string[] = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/xollama") {
			return json({ xollama: true, features: ["context_window_v1"] });
		}
		if (url.pathname === "/api/show") {
			return json({ xollama: {} });
		}
		if (url.pathname === "/api/engine") {
			const endpoint = url.searchParams.get("endpoint") ?? "";
			engine.push(endpoint);
			if (endpoint === "tokenize") {
				return json({
					status: 200,
					body: { tokens: new Array(PROMPT_TOKENS).fill(1) },
				});
			}
			return json({ status: 404, body: {} });
		}
		if (url.pathname === "/api/chat") {
			chats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return json(
				{ message: { content: "ok" } },
				200,
				grant ? { "x-context-window": String(grant) } : {},
			);
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return { chats, engine, fetch: fetchImpl };
}

const turn = async (
	fetchImpl: typeof fetch,
	session: string,
	window: XollamaWindowOptions,
	extra: Record<string, unknown> = {},
) => {
	const wire = withXollamaRequestFields(fetchImpl, { window });
	const response = await wire("http://pandorum:22434/api/chat", {
		method: "POST",
		headers: { [XOLLAMA_SESSION_HEADER]: session },
		body: JSON.stringify({
			model: "v7-coder_tb:iq4_nl",
			options: { num_predict: OUTPUT },
			messages: [
				{ role: "system", content: "You are Cerebriline." },
				{ role: "user", content: "inspect manic_miner.html", ...extra },
			],
		}),
	});
	await response.text();
};

const tokenizes = (engine: string[]) =>
	engine.filter((endpoint) => endpoint === "tokenize").length;

describe("a context size the user set, on xOllama", () => {
	it("is asked for with booking off, floored at what the turn needs", async () => {
		const xo = server();
		await turn(xo.fetch, "set-1", {
			contextWindow: SET,
			requestedWindow: SET,
		});
		expect(xo.chats[0]?.placement).toEqual({
			num_ctx: SET,
			// The prompt as the engine counts it, the output cap, and the slack
			// every booking of a turn carries.
			num_ctx_min: PROMPT_TOKENS + OUTPUT + 256,
		});
		expect(tokenizes(xo.engine)).toBe(1);
	});

	it("is floored at Never go below when the profile sets one, without counting", async () => {
		const xo = server();
		await turn(xo.fetch, "set-2", {
			dynamicContextSize: true,
			contextFloor: 131_072,
			contextWindow: SET,
			requestedWindow: SET,
		});
		expect(xo.chats[0]?.placement).toEqual({
			num_ctx: SET,
			num_ctx_min: 131_072,
		});
		expect(tokenizes(xo.engine)).toBe(0);
	});

	it("asks for exactly the window it was granted once it has one", async () => {
		const xo = server(180_000);
		const window = { contextWindow: SET, requestedWindow: SET };
		await turn(xo.fetch, "set-3", window);
		await turn(xo.fetch, "set-3", window);
		expect(xo.chats[1]?.placement).toEqual({
			num_ctx: 180_000,
			num_ctx_min: 180_000,
		});
		// Counted for the admission only.
		expect(tokenizes(xo.engine)).toBe(1);
	});

	it("stays all or nothing when the turn cannot be counted", async () => {
		const xo = server();
		await turn(
			xo.fetch,
			"set-4",
			{ contextWindow: SET, requestedWindow: SET },
			{ images: ["aGk="] },
		);
		expect(xo.chats[0]?.placement).toEqual({ num_ctx: SET, num_ctx_min: SET });
	});
});

describe("no context size set, on xOllama", () => {
	it("asks for nothing, and the engine sizes the request", async () => {
		const xo = server();
		// The session still runs on the model's own window, which is not a
		// size the user asked for.
		await turn(xo.fetch, "unset-1", { contextWindow: SET });
		expect(xo.chats[0]).not.toHaveProperty("placement");
		expect(tokenizes(xo.engine)).toBe(0);
	});

	it("books the model's window, all or nothing, when Book a context window is on", async () => {
		const xo = server();
		await turn(xo.fetch, "unset-2", {
			dynamicContextSize: true,
			contextWindow: SET,
		});
		expect(xo.chats[0]?.placement).toEqual({ num_ctx: SET, num_ctx_min: SET });
	});
});

describe("readXollamaWindowOptions", () => {
	it("reads the size the user set apart from the model's window", () => {
		expect(
			readXollamaWindowOptions({ requestedContextWindow: 256_000.4 }, 262_144),
		).toEqual({ contextWindow: 262_144, requestedWindow: 256_000 });
		expect(readXollamaWindowOptions({}, 262_144)).toEqual({
			contextWindow: 262_144,
		});
	});
});
