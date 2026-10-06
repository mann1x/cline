import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CouncilDeliberation,
	councilHeading,
	probeXollama,
	readXollamaModel,
	resetXollamaProbes,
	withXollamaAuth,
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
		const wire = withXollamaRequestFields((async (url, init) => {
			// The council lookup goes to /api/show; only the chat is asserted.
			if (String(url).endsWith("/api/chat")) {
				sent.push(init ?? {});
			}
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
		const wire = withXollamaRequestFields((async (url, init) => {
			// The council lookup goes to /api/show; only the chat is asserted.
			if (String(url).endsWith("/api/chat")) {
				sent.push(init ?? {});
			}
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
		const wire = withXollamaRequestFields((async (url, init) => {
			// The council lookup goes to /api/show; only the chat is asserted.
			if (String(url).endsWith("/api/chat")) {
				sent.push(init ?? {});
			}
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

describe("a council's past deliberation", () => {
	// Mail #375 and the user: a council's thinking is its deliberation; sent
	// back it only fills the window. A plain model keeps its thinking.
	const history = [
		{ role: "user", content: "q1" },
		{ role: "assistant", content: "a1", thinking: "plan, findings, critiques" },
		{ role: "user", content: "q2" },
	];
	const chatThrough = async (council: boolean) => {
		const chats: Record<string, unknown>[] = [];
		const wire = withXollamaRequestFields((async (url, init) => {
			if (String(url).endsWith("/api/show")) {
				return json({ xollama: { council: { enabled: council } } });
			}
			chats.push(JSON.parse(String(init?.body)));
			return json({});
		}) as typeof fetch);
		await wire(`http://gpu2:22434/api/chat`, {
			method: "POST",
			body: JSON.stringify({
				model: council ? "omni-council" : "qwen",
				messages: history,
			}),
		});
		return chats[0]?.messages as Array<Record<string, unknown>>;
	};

	it("is not sent back to a council", async () => {
		const messages = await chatThrough(true);
		expect(messages[1]).toEqual({ role: "assistant", content: "a1" });
	});

	it("is left alone for a plain model", async () => {
		const messages = await chatThrough(false);
		expect(messages[1]?.thinking).toBe("plan, findings, critiques");
	});
});

describe("a council's deliberation", () => {
	const researcher2 = { role: "researcher", index: 1, round: 0 };
	const critic1 = { role: "critic", index: 0, round: 0 };

	it("names each member as people count, from 1", () => {
		expect(councilHeading({ role: "planner", index: 0, round: 0 })).toBe(
			"#### Planner · round 1",
		);
		expect(councilHeading(researcher2)).toBe("#### Researcher 2 · round 1");
	});

	// xOllama's own heading line is for clients that ignore tags, and it can
	// arrive in pieces: nothing of it may leak once ours stands in its place.
	it("replaces the server's heading line with its own, however it is split", () => {
		const d = new CouncilDeliberation();
		const out = [
			d.thinking(researcher2, "### Rese"),
			d.thinking(researcher2, "archer 2"),
			d.thinking(researcher2, "\n\nThe loop "),
			d.thinking(researcher2, "is in foo.ts."),
			d.thinking(critic1, "No heading here."),
			d.close(),
		].join("");
		expect(out).toBe(
			"#### Researcher 2 · round 1\n\nThe loop is in foo.ts." +
				"\n\n#### Critic 1 · round 1\n\nNo heading here.",
		);
	});

	it("drops a heading line whose span ended before the line did", () => {
		const d = new CouncilDeliberation();
		const out = [
			d.thinking(researcher2, "### Researcher 2"),
			d.thinking(critic1, "Fine."),
		].join("");
		expect(out).toBe(
			"#### Researcher 2 · round 1\n\n\n\n#### Critic 1 · round 1\n\nFine.",
		);
	});

	it("reaches the stream: tagged thinking gets headings, the answer is untouched", async () => {
		const lines = [
			{
				council: researcher2,
				message: {
					role: "assistant",
					content: "",
					thinking: "### Researcher 2\nfound it",
				},
			},
			{
				council: critic1,
				message: { role: "assistant", content: "", thinking: "agreed" },
			},
			{ message: { role: "assistant", content: "The answer." } },
			{ done: true, message: { role: "assistant", content: "" } },
		];
		const ndjson = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
		// Delivered in awkward pieces, as a socket would.
		const bytes = new TextEncoder().encode(ndjson);
		const wire = withXollamaRequestFields((async (url) => {
			if (String(url).endsWith("/api/show")) {
				return json({ xollama: { council: { enabled: true } } });
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						for (let at = 0; at < bytes.length; at += 7) {
							controller.enqueue(bytes.slice(at, at + 7));
						}
						controller.close();
					},
				}),
				{ headers: { "content-type": "application/x-ndjson" } },
			);
		}) as typeof fetch);
		const response = await wire("http://gpu2:22434/api/chat", {
			method: "POST",
			body: JSON.stringify({ model: "omni-council", messages: [] }),
		});
		const got = (await response.text())
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(got.map((c) => c.message.thinking)).toEqual([
			"#### Researcher 2 · round 1\n\nfound it",
			"\n\n#### Critic 1 · round 1\n\nagreed",
			undefined,
			undefined,
		]);
		expect(got[2].message.content).toBe("The answer.");
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
			clientPools: 0,
		});
		const plain = (async () => json({ details: {} })) as typeof fetch;
		expect(await readXollamaModel(undefined, "qwen3:8b", plain)).toEqual({
			council: false,
			clientPools: 0,
		});
	});
});

describe("the council's own tool name", () => {
	it("is left out of a council turn's tools, and kept on a plain model's", async () => {
		const sent = async (council: boolean) => {
			const chats: Record<string, unknown>[] = [];
			const wire = withXollamaRequestFields((async (url, init) => {
				if (String(url).endsWith("/api/show")) {
					return json({ xollama: { council: { enabled: council } } });
				}
				if (String(url).endsWith("/api/xollama")) {
					return json({ xollama: true, features: [] });
				}
				chats.push(JSON.parse(String(init?.body)));
				return json({});
			}) as typeof fetch);
			await wire("http://gpu2:22434/api/chat", {
				method: "POST",
				body: JSON.stringify({
					model: council ? "omni-council" : "qwen",
					messages: [{ role: "user", content: "q" }],
					tools: [
						{ type: "function", function: { name: "council_evidence" } },
						{ type: "function", function: { name: "read_files" } },
					],
				}),
			});
			resetXollamaProbes();
			return (chats[0]?.tools as Array<{ function: { name: string } }>).map(
				(tool) => tool.function.name,
			);
		};
		expect(await sent(true)).toEqual(["read_files"]);
		expect(await sent(false)).toEqual(["council_evidence", "read_files"]);
	});
});

describe("a plain model's pool seats", () => {
	it("reads session.client_pools, and anything else as none", async () => {
		const seats = (value: unknown) =>
			(async () =>
				json({
					xollama: { session: { client_pools: value } },
				})) as typeof fetch;
		expect(
			(await readXollamaModel(undefined, "a", seats(4)))?.clientPools,
		).toBe(4);
		resetXollamaProbes();
		expect(
			(await readXollamaModel(undefined, "a", seats("4")))?.clientPools,
		).toBe(0);
		resetXollamaProbes();
		expect(
			(await readXollamaModel(undefined, "a", seats(-1)))?.clientPools,
		).toBe(0);
	});
});

describe("the Ollama vendor's stream config", () => {
	// The import is the slow part: the vendor module is loaded here for the
	// first time, and on a busy machine that alone ran past the default five
	// seconds (2 of 3 runs, load average 9.8). The bound is for the load.
	it("names the session for xOllama, and never for Ollama", {
		timeout: 60_000,
	}, async () => {
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

describe("the council's state (council_chat_state_v1)", () => {
	const ndjson = (lines: unknown[]) =>
		new Response(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, {
			headers: { "content-type": "application/x-ndjson" },
		});
	/** A council server: what each chat request carried, and what it answers. */
	const server = (
		answers: unknown[][],
		options: { features?: string[]; council?: boolean } = {},
	) => {
		const chats: Record<string, unknown>[] = [];
		const wire = withXollamaRequestFields((async (url, init) => {
			const path = String(url);
			if (path.endsWith("/api/show")) {
				return json({
					xollama: { council: { enabled: options.council ?? true } },
				});
			}
			if (path.endsWith("/api/xollama")) {
				return json({
					xollama: true,
					features: options.features ?? ["council_chat_state_v1"],
				});
			}
			chats.push(JSON.parse(String(init?.body)));
			return ndjson(answers[chats.length - 1] ?? []);
		}) as typeof fetch);
		const turn = async (session?: string) => {
			const response = await wire("http://gpu2:22434/api/chat", {
				method: "POST",
				headers: session ? { [XOLLAMA_SESSION_HEADER]: session } : {},
				body: JSON.stringify({
					model: "omni-council",
					messages: [{ role: "user", content: "fix it" }],
					tools: [{ type: "function", function: { name: "read_files" } }],
				}),
			});
			return (await response.text())
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		};
		return { chats, turn };
	};

	it("sends an empty state first, then the newest blob the server sent", async () => {
		const { chats, turn } = server([
			[
				{
					council_chat_state: "AAA",
					message: { role: "assistant", content: "" },
				},
				{ message: { role: "assistant", content: "done." } },
				{
					done: true,
					done_reason: "stop",
					council_chat_state: "BBB",
					message: { role: "assistant", content: "" },
				},
			],
			[],
		]);
		const got = await turn("lead-1");
		// The state-only chunk never reaches the chat; the done chunk does,
		// without the blob.
		expect(got).toEqual([
			{ message: { role: "assistant", content: "done." } },
			{
				done: true,
				done_reason: "stop",
				message: { role: "assistant", content: "" },
			},
		]);
		await turn("lead-1");
		expect(chats.map((c) => c.council_chat_state)).toEqual(["", "BBB"]);
	});

	// #403: a connection dropped mid-turn resumes from the newest step.
	it("keeps the newest blob of a turn that broke off", async () => {
		const { chats, turn } = server([
			[
				{
					council_chat_state: "after-plan",
					message: { role: "assistant", content: "" },
				},
				{
					council_chat_state: "after-r1",
					message: { role: "assistant", content: "" },
				},
			],
			[],
		]);
		await turn("lead-1");
		await turn("lead-1");
		expect(chats[1]?.council_chat_state).toBe("after-r1");
	});

	it("keeps one state per session", async () => {
		const { chats, turn } = server([
			[
				{
					done: true,
					council_chat_state: "for-a",
					message: { role: "assistant", content: "" },
				},
			],
			[],
		]);
		await turn("lead-a");
		await turn("lead-b");
		expect(chats[1]?.council_chat_state).toBe("");
	});

	// The council is the lead's: an agent on the same model runs a plain chat
	// (no state, so its tools do not reach the council; its thinking is kept).
	it("sends no state for a delegated agent's turn", async () => {
		const { chats, turn } = server([[]]);
		await turn("lead-1~agent-abc123");
		expect(chats[0]).not.toHaveProperty("council_chat_state");
	});

	it("sends no state to a server that does not resume councils", async () => {
		const { chats, turn } = server([[]], { features: [] });
		await turn("lead-1");
		expect(chats[0]).not.toHaveProperty("council_chat_state");
	});

	it("sends no state for a plain model", async () => {
		const { chats, turn } = server([[]], { council: false });
		await turn("lead-1");
		expect(chats[0]).not.toHaveProperty("council_chat_state");
	});
});

describe("xOllama's local API key", () => {
	const seen = () => {
		const calls: Array<{ url: string; auth: string | null }> = [];
		const fetchImpl = (async (input: unknown, init?: RequestInit) => {
			calls.push({
				url: String(input),
				auth: new Headers(init?.headers).get("authorization"),
			});
			return json({});
		}) as typeof fetch;
		return { calls, fetchImpl };
	};

	it("goes on every request to the server, and nowhere else", async () => {
		const { calls, fetchImpl } = seen();
		const authed = withXollamaAuth(fetchImpl, "http://gpu2:22434/api", {
			Authorization: "Bearer k1",
		});
		await authed("http://gpu2:22434/api/engine?model=m&endpoint=props");
		await authed("http://gpu2:22434/api/show", { method: "POST" });
		await authed("https://ollama.com/api/me", { method: "POST" });
		expect(calls.map((c) => c.auth)).toEqual(["Bearer k1", "Bearer k1", null]);
	});

	it("leaves a header the request already carries", async () => {
		const { calls, fetchImpl } = seen();
		const authed = withXollamaAuth(fetchImpl, "http://gpu2:22434", {
			Authorization: "Bearer k1",
		});
		await authed("http://gpu2:22434/api/chat", {
			headers: { Authorization: "Bearer mine" },
		});
		expect(calls[0]?.auth).toBe("Bearer mine");
	});

	it("is the bare fetch when there is no key", () => {
		const { fetchImpl } = seen();
		expect(withXollamaAuth(fetchImpl, "http://gpu2:22434", {})).toBe(fetchImpl);
	});
});
