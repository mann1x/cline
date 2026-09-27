import { markPromptEnvironment } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import { resetPolykvAvailability } from "./polykv";
import { releaseAllPolykvLeads } from "./polykv-lead";
import {
	resetXollamaProbes,
	withXollamaRequestFields,
	XOLLAMA_SESSION_HEADER,
} from "./xollama";
import {
	parseXollamaEngineUrl,
	readXollamaEngines,
	xollamaEngineFetch,
	xollamaEngineRoot,
} from "./xollama-engine";

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});

/**
 * A stub xOllama in front of one opencoti engine: `/api/show` with the
 * model's seats, `/api/engine` wrapping the engine's answers, and a render-only
 * chat that renders one delimited block per turn.
 */
function stubXollama(
	options: { clientPools?: number; council?: boolean; loaded?: boolean } = {},
) {
	const calls: Array<{
		path: string;
		query: URLSearchParams;
		body: Record<string, unknown>;
	}> = [];
	const chats: Record<string, unknown>[] = [];
	const renders: Record<string, unknown>[] = [];
	let nextPool = 0;
	const pools = new Set<number>();
	const render = (messages: Array<{ role: string; content: unknown }>) =>
		messages.map((m) => `<|${m.role}|>${String(m.content)}<|end|>`).join("");
	const engine = (
		method: string,
		endpoint: string,
		body: Record<string, unknown>,
	) => {
		if (endpoint === "props") {
			return {
				status: 200,
				body: {
					build_info: "opencoti-0.10.5-c8-2609270000001",
					features: [],
					opencoti: { boot_id: "boot-1", polykv: { pools_enabled: true } },
				},
			};
		}
		if (endpoint === "polykv/pools" && method === "POST") {
			const id = nextPool++;
			pools.add(id);
			return {
				status: 200,
				body: { pool_id: id, parent: -1, prefix_len: 100, prompt: body.prompt },
			};
		}
		if (endpoint === "polykv/pools") {
			return {
				status: 200,
				body: { pools: [...pools].map((id) => ({ pool_id: id })) },
			};
		}
		return { status: 200, body: {} };
	};
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		calls.push({ path: url.pathname, query: url.searchParams, body });
		if (url.pathname === "/api/show") {
			return json({
				xollama: {
					council: { enabled: options.council === true },
					session: { client_pools: options.clientPools ?? 0 },
				},
			});
		}
		if (url.pathname === "/api/xollama") {
			return json({
				xollama: true,
				features: ["client_placement_v1", "chat_render_v1"],
			});
		}
		if (url.pathname === "/api/engine") {
			if (options.loaded === false) {
				return json({ error: 'model "m" is not loaded' }, 404);
			}
			const endpoint = url.searchParams.get("endpoint") ?? "";
			const method = (init?.method ?? "GET").toUpperCase();
			const answer = engine(method, endpoint, body);
			return json({
				model: url.searchParams.get("model"),
				engine: "opencoti",
				method,
				endpoint,
				...answer,
			});
		}
		if (url.pathname === "/api/chat" && body._debug_render_only === true) {
			renders.push(body);
			return json({
				model: body.model,
				done: true,
				_debug_info: {
					rendered_template: render(
						body.messages as Array<{ role: string; content: unknown }>,
					),
				},
			});
		}
		if (url.pathname === "/api/chat") {
			chats.push(body);
			return new Response(
				`${JSON.stringify({ done: true, message: { role: "assistant", content: "ok" } })}\n`,
				{
					status: 200,
					headers: { "content-type": "application/x-ndjson" },
				},
			);
		}
		return json({ error: "no route" }, 404);
	}) as typeof fetch;
	return { calls, chats, renders, fetchImpl };
}

afterEach(async () => {
	await releaseAllPolykvLeads().catch(() => undefined);
	resetPolykvAvailability();
	resetXollamaProbes();
});

describe("an engine root behind xOllama", () => {
	it("names the model and route a root call is for", () => {
		const root = xollamaEngineRoot("http://gpu2:22434/api", "qwen3:8b");
		expect(root).toBe("http://gpu2:22434/xollama-engine/qwen3%3A8b");
		expect(
			parseXollamaEngineUrl(`${root}/polykv/pools/3/release?x=1`),
		).toMatchObject({
			origin: "http://gpu2:22434",
			model: "qwen3:8b",
			endpoint: "polykv/pools/3/release",
		});
		expect(parseXollamaEngineUrl("http://gpu2:22434/api/chat")).toBeUndefined();
	});

	it("sends a control-plane call through /api/engine and hands back the engine's own answer", async () => {
		const xo = stubXollama();
		const engineFetch = xollamaEngineFetch(xo.fetchImpl);
		const root = xollamaEngineRoot("http://gpu2:22434", "m");

		const created = await engineFetch(`${root}/polykv/pools`, {
			method: "POST",
			body: JSON.stringify({ prompt: "p\n", pin: true }),
		});
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({ pool_id: 0, prefix_len: 100 });
		const call = xo.calls.at(-1);
		expect(call?.path).toBe("/api/engine");
		expect(call?.query.get("model")).toBe("m");
		expect(call?.query.get("endpoint")).toBe("polykv/pools");
		expect(call?.body).toEqual({ prompt: "p\n", pin: true });

		const props = await engineFetch(`${root}/props`);
		expect(
			((await props.json()) as { opencoti: { boot_id: string } }).opencoti
				.boot_id,
		).toBe("boot-1");
	});

	it("passes xOllama's own refusal through, not a wrapped 200", async () => {
		const xo = stubXollama({ loaded: false });
		const response = await xollamaEngineFetch(xo.fetchImpl)(
			`${xollamaEngineRoot("http://gpu2:22434", "m")}/props`,
		);
		expect(response.status).toBe(404);
	});

	it("renders /apply-template with xOllama's renderer, carrying the chat's options", async () => {
		const xo = stubXollama();
		const response = await xollamaEngineFetch(xo.fetchImpl)(
			`${xollamaEngineRoot("http://gpu2:22434", "m")}/apply-template`,
			{
				method: "POST",
				body: JSON.stringify({
					options: { num_ctx: 65536 },
					think: true,
					messages: [{ role: "system", content: "S" }],
					add_generation_prompt: false,
				}),
			},
		);
		expect(await response.json()).toEqual({ prompt: "<|system|>S<|end|>" });
		// The render schedules the model with these: a different num_ctx would
		// reload it.
		expect(xo.renders[0]).toMatchObject({
			model: "m",
			stream: false,
			_debug_render_only: true,
			options: { num_ctx: 65536 },
			think: true,
		});
		expect(xo.renders[0]).not.toHaveProperty("add_generation_prompt");
	});

	it("reads which engine serves each loaded model", async () => {
		const fetchImpl = (async () =>
			json({
				models: [
					{ model: "a", engine: "opencoti" },
					{ model: "b", engine: "llamacpp" },
				],
			})) as unknown as typeof fetch;
		expect([
			...(await readXollamaEngines("http://gpu2:22434", fetchImpl)),
		]).toEqual([
			["a", "opencoti"],
			["b", "llamacpp"],
		]);
	});
});

describe("the lead's pool on a plain xOllama model", () => {
	const system = `You are Cline.\n\n${markPromptEnvironment("Working directory", "/w/a")}`;
	const chat = async (
		fetchImpl: typeof fetch,
		session = "task-1",
		model = "m",
	) => {
		const wire = withXollamaRequestFields(fetchImpl);
		await wire("http://gpu2:22434/api/chat", {
			method: "POST",
			headers: { [XOLLAMA_SESSION_HEADER]: session },
			body: JSON.stringify({
				model,
				options: { num_ctx: 32768 },
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: "fix it" },
				],
				tools: [{ type: "function", function: { name: "read_files" } }],
			}),
		});
	};

	it("attaches the turn to a pool of the static prompt, with the environment as its own turn", async () => {
		const xo = stubXollama({ clientPools: 2 });
		await chat(xo.fetchImpl);

		const sent = xo.chats[0] as {
			placement?: unknown;
			messages: Array<{ role: string; content: string }>;
		};
		expect(sent.placement).toEqual({ pool_id: 0 });
		expect(sent.messages[0]).toEqual({
			role: "system",
			content: "You are Cline.",
		});
		expect(sent.messages[1]?.role).toBe("user");
		expect(sent.messages[1]?.content).toContain("/w/a");
		expect(sent.messages[2]).toEqual({ role: "user", content: "fix it" });
		const create = xo.calls.find(
			(c) =>
				c.query.get("endpoint") === "polykv/pools" &&
				c.body.prompt !== undefined,
		);
		// Cut before the sentinel turn's text: the next turn's header is shared too.
		expect(create?.body.prompt).toBe("<|system|>You are Cline.<|end|><|user|>");
	});

	it("sends no pool controls and folds the environment back where the model has no seats", async () => {
		const xo = stubXollama({ clientPools: 0 });
		await chat(xo.fetchImpl);
		const sent = xo.chats[0] as {
			placement?: unknown;
			messages: Array<{ content: string }>;
		};
		expect(sent).not.toHaveProperty("placement");
		expect(sent.messages[0]?.content).toBe(
			"You are Cline.\n\n<environment>\n## Working directory\n/w/a\n</environment>",
		);
		expect(xo.calls.some((c) => c.path === "/api/engine")).toBe(false);
	});

	it("leaves a council model's pools to xOllama", async () => {
		const xo = stubXollama({ clientPools: 2, council: true });
		await chat(xo.fetchImpl);
		expect(xo.chats[0]).not.toHaveProperty("placement");
		expect(xo.calls.some((c) => c.path === "/api/engine")).toBe(false);
	});

	it("runs a turn unpooled while the model is not loaded, and pools the next", async () => {
		const xo = stubXollama({ clientPools: 2, loaded: false });
		await chat(xo.fetchImpl);
		expect(xo.chats[0]).not.toHaveProperty("placement");
		expect(
			(xo.chats[0] as { messages: Array<{ content: string }> }).messages[0]
				?.content,
		).toContain("<environment>");
	});

	it("gives a delegated agent no lead pool", async () => {
		const xo = stubXollama({ clientPools: 2 });
		await chat(xo.fetchImpl, "task-1~agent-2");
		expect(xo.chats[0]).not.toHaveProperty("placement");
	});
});
