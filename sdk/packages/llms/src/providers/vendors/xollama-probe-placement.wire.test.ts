// The reasoning-replay probe through the real vendor, with a stubbed xOllama:
// it is the first request to reach the model, so it asks for the size the
// conversation's turns will ask for, and the engine loads the model once.
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../gateway";
import { resetReasoningReinjection } from "../reasoning-history";
import { resetPolykvSessions } from "./polykv";
import { resetXollamaProbes } from "./xollama";

afterEach(() => {
	resetReasoningReinjection();
	resetXollamaProbes();
	resetPolykvSessions();
});

function stubServer(features: string[]) {
	const chats: Array<Record<string, unknown>> = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	const fetchStub = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = new URL(typeof input === "string" ? input : String(input));
		if (url.pathname === "/api/xollama") {
			return json({ xollama: true, version: "0.40.6-xollama.1", features });
		}
		if (url.pathname === "/api/show") {
			return json({ xollama: {}, capabilities: ["completion", "tools"] });
		}
		if (url.pathname === "/api/engine") {
			return json({ status: 404, body: {} });
		}
		if (url.pathname === "/api/chat") {
			chats.push(JSON.parse(String(init?.body ?? "{}")));
			return json({ prompt_eval_count: 45 });
		}
		return json({ error: "not found" }, 404);
	}) as typeof fetch;
	return { chats, fetchStub };
}

async function probeBodies(
	features: string[],
	options: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
	const { chats, fetchStub } = stubServer(features);
	const gateway = createGateway({
		providerConfigs: [
			{
				providerId: "xollama",
				baseUrl: `http://127.0.0.1:${22000 + Math.floor(Math.random() * 999)}`,
				fetch: fetchStub,
				options: { polykvSessionId: "lead-1", ...options },
			},
		],
	});
	try {
		for await (const _event of await gateway.stream({
			providerId: "xollama",
			modelId: "m",
			maxTokens: 8000,
			messages: [
				{
					id: "m1",
					role: "user",
					content: [{ type: "text", text: "hi" }],
					createdAt: 0,
				},
			],
		})) {
			// drain
		}
	} catch {
		// The stub's chat answer is not a stream; only the probe is under test.
	}
	return chats.filter(
		(chat) => (chat.options as { num_predict?: number })?.num_predict === 1,
	);
}

describe("xOllama: the reasoning-replay probe", () => {
	const UNBOOKED = ["context_window_v1", "context_window_unbooked_v1"];

	it("asks for the size set, not held, with booking off", {
		timeout: 60_000,
	}, async () => {
		const probes = await probeBodies(UNBOOKED, {
			requestedContextWindow: 192_000,
			polykv: { dynamicContextSize: false },
		});
		expect(probes).toHaveLength(2);
		for (const probe of probes) {
			expect(probe.placement).toEqual({
				num_ctx: 192_000,
				num_ctx_min: 1024,
				num_ctx_hold: false,
			});
		}
	});

	it("asks for no window from a server that cannot leave one unheld", {
		timeout: 60_000,
	}, async () => {
		const probes = await probeBodies(["context_window_v1"], {
			requestedContextWindow: 192_000,
		});
		expect(probes).toHaveLength(2);
		for (const probe of probes) {
			expect(probe.placement ?? {}).not.toHaveProperty("num_ctx_hold");
		}
	});
});
