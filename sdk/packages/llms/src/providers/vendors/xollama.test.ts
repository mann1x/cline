import { afterEach, describe, expect, it, vi } from "vitest";
import {
	probeXollama,
	readXollamaModel,
	resetXollamaProbes,
	withXollamaRequestFields,
	XOLLAMA_READ_ONLY_HEADER,
	XOLLAMA_SESSION_HEADER,
	xollamaReadOnlyHeaders,
	xollamaSessionHeaders,
} from "./xollama";

afterEach(() => {
	resetXollamaProbes();
});

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("the xOllama request fields", () => {
	// opencoti 0411 admits a session's turns as a running session's only
	// while it keeps sending its id: every xOllama chat turn names it.
	it("moves the request's session into the chat body and drops the header", async () => {
		const sent: RequestInit[] = [];
		const wire = withXollamaRequestFields((async (_url, init) => {
			sent.push(init ?? {});
			return json({});
		}) as typeof fetch);
		await wire("http://x/api/chat", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...xollamaSessionHeaders("lead/agent-1"),
			},
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		const body = JSON.parse(String(sent[0]?.body));
		// Slash-free, as the engine's close route needs.
		expect(body.session_id).toBe("lead~agent-1");
		expect(new Headers(sent[0]?.headers).has(XOLLAMA_SESSION_HEADER)).toBe(
			false,
		);
	});

	it("leaves a request with no session as it was", async () => {
		const sent: RequestInit[] = [];
		const wire = withXollamaRequestFields((async (_url, init) => {
			sent.push(init ?? {});
			return json({});
		}) as typeof fetch);
		const body = JSON.stringify({ model: "m", messages: [] });
		await wire("http://x/api/chat", { method: "POST", body });
		expect(sent[0]?.body).toBe(body);
	});
});

describe("the council's read-only tools", () => {
	// #372 D2: researchers and critics get only what is marked; unmarked
	// means write, so a missing mark costs a tool, never grants a write.
	it("marks x_read_only on the tools named read-only, and only those", async () => {
		const sent: RequestInit[] = [];
		const wire = withXollamaRequestFields((async (_url, init) => {
			sent.push(init ?? {});
			return json({});
		}) as typeof fetch);
		const headers = xollamaReadOnlyHeaders([
			{ name: "read_files", description: "", inputSchema: {}, readOnly: true },
			{ name: "editor", description: "", inputSchema: {} },
			{
				name: "docs__search",
				description: "",
				inputSchema: {},
				readOnly: true,
				source: "mcp",
			},
		]);
		await wire("http://x/api/chat", {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "m",
				messages: [],
				tools: [
					{
						type: "function",
						function: { name: "read_files", parameters: {} },
					},
					{ type: "function", function: { name: "editor", parameters: {} } },
					{
						type: "function",
						function: { name: "docs__search", parameters: {} },
					},
				],
			}),
		});
		const body = JSON.parse(String(sent[0]?.body));
		expect(
			body.tools.map(
				(t: { function: { x_read_only?: boolean } }) => t.function.x_read_only,
			),
		).toEqual([true, undefined, true]);
		expect(body.session_id).toBeUndefined();
		expect(new Headers(sent[0]?.headers).has(XOLLAMA_READ_ONLY_HEADER)).toBe(
			false,
		);
	});

	it("names nothing when no tool is read-only", () => {
		expect(
			xollamaReadOnlyHeaders([
				{ name: "editor", description: "", inputSchema: {} },
			]),
		).toEqual({});
	});
});

describe("detecting xOllama", () => {
	it("reads the server's features, and a stock Ollama's 404 as not xOllama", async () => {
		const xollama = vi.fn(async () =>
			json({
				xollama: true,
				version: "0.34.2-xollama.2",
				features: ["council"],
			}),
		) as unknown as typeof fetch;
		expect(await probeXollama("http://gpu2:22434/api", xollama)).toEqual({
			version: "0.34.2-xollama.2",
			features: ["council"],
		});
		expect(vi.mocked(xollama).mock.calls[0]?.[0]).toBe(
			"http://gpu2:22434/api/xollama",
		);
		const stock = (async () =>
			new Response("404 page not found", { status: 404 })) as typeof fetch;
		expect(await probeXollama("http://box:11434", stock)).toBeUndefined();
	});

	it("reads whether a model is a council from /api/show", async () => {
		const show = (async () =>
			json({ xollama: { council: { enabled: true } } })) as typeof fetch;
		expect(await readXollamaModel(undefined, "omni-council", show)).toEqual({
			council: true,
		});
		const plain = (async () => json({ details: {} })) as typeof fetch;
		expect(await readXollamaModel(undefined, "qwen3:8b", plain)).toEqual({
			council: false,
		});
	});
});

describe("the Ollama vendor's stream config", () => {
	it("names the session for xOllama, and never for Ollama", async () => {
		const { buildOllamaStreamConfig } = await import("./ollama");
		const request = {
			providerId: "xollama",
			modelId: "m",
			sessionId: "lead",
			messages: [],
		} as never;
		const context = (providerId: string) =>
			({
				provider: { id: providerId },
				config: { providerId },
				model: { id: "m" },
			}) as never;
		expect(
			buildOllamaStreamConfig(request, context("xollama")).headers,
		).toMatchObject({ [XOLLAMA_SESSION_HEADER]: "lead" });
		expect(
			buildOllamaStreamConfig(request, context("ollama")).headers?.[
				XOLLAMA_SESSION_HEADER
			],
		).toBeUndefined();
	});
});
