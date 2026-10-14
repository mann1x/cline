// Generation notices through the real vendors, with a stubbed server: the
// profile's `notices` reach the chat request only where the server says it
// supports them, and never on a call made outside the conversation.
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../gateway";
import { resetNoticeRequests } from "./generation-notices";

type Engine = "opencoti" | "xollama";

const NOTICE_BLOCK = { version: 1, marker: "[notice]" };

function stubServer(supported: boolean) {
	const chats: Record<string, unknown>[] = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	const features = supported ? ["generation_notice_v1"] : [];
	const fetchStub = (async (input: Parameters<typeof fetch>[0], init) => {
		const url = typeof input === "string" ? input : String(input);
		if (url.endsWith("/props")) {
			return json({
				build_info: "opencoti-0.10.5-c13-2610140733001",
				features,
				...(supported ? { generation_notice: NOTICE_BLOCK } : {}),
			});
		}
		if (url.endsWith("/api/xollama")) {
			return json({
				xollama: true,
				version: "0.40.3-xollama.5",
				features,
				...(supported ? { generation_notice: NOTICE_BLOCK } : {}),
			});
		}
		if (url.endsWith("/chat/completions") || url.endsWith("/api/chat")) {
			chats.push(JSON.parse(String(init?.body ?? "{}")));
			return json({ error: { message: "stub" } }, 400);
		}
		return json({ error: "not found" }, 404);
	}) as typeof fetch;
	return { chats, fetchStub };
}

async function lastChat(
	engine: Engine,
	options: {
		supported: boolean;
		notices?: Record<string, unknown>;
		extra?: Record<string, unknown>;
	},
): Promise<Record<string, unknown> | undefined> {
	const { chats, fetchStub } = stubServer(options.supported);
	const gateway = createGateway({
		providerConfigs: [
			{
				providerId: engine,
				apiKey: "test-key",
				baseUrl:
					engine === "opencoti"
						? `http://127.0.0.1:${8000 + Math.floor(Math.random() * 999)}/v1`
						: `http://127.0.0.1:${21000 + Math.floor(Math.random() * 999)}`,
				fetch: fetchStub,
				options: {
					polykvSessionId: "lead-1",
					...(options.notices ? { notices: options.notices } : {}),
					...options.extra,
				},
			},
		],
	});
	try {
		for await (const _event of await gateway.stream({
			providerId: engine,
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
		// The stub answers 400; only the request is under test.
	}
	return chats.at(-1);
}

afterEach(() => resetNoticeRequests());

describe.each([
	"opencoti",
	"xollama",
] as const)("%s: generation notices on the wire", (engine) => {
	it("asks for them when the profile turns them on and the server supports them", {
		timeout: 60_000,
	}, async () => {
		const body = await lastChat(engine, {
			supported: true,
			notices: { enabled: true, thinkSteps: [80, 90] },
		});
		expect(body?.notices).toEqual({
			key: expect.stringMatching(/^lead-1:/),
			think: [{ at_percent: 80 }, { at_percent: 90 }],
			answer: [60, 70, 80, 90].map((at) => ({ at_percent: at })),
		});
	});

	it("asks for nothing when the profile leaves them off", async () => {
		const body = await lastChat(engine, {
			supported: true,
			notices: { enabled: false },
		});
		expect(body).toBeDefined();
		expect(body).not.toHaveProperty("notices");
		const none = await lastChat(engine, { supported: true });
		expect(none).not.toHaveProperty("notices");
	});

	it("asks for nothing from a server that does not support them", async () => {
		const body = await lastChat(engine, {
			supported: false,
			notices: { enabled: true },
		});
		expect(body).toBeDefined();
		expect(body).not.toHaveProperty("notices");
	});

	it("asks for nothing on a call made for another conversation", async () => {
		const body = await lastChat(engine, {
			supported: true,
			notices: { enabled: true },
			extra: { polykvSideCallOf: "lead-0" },
		});
		expect(body).toBeDefined();
		expect(body).not.toHaveProperty("notices");
	});
});
