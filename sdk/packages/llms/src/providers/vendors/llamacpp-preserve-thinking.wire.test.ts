// `chat_template_kwargs.preserve_thinking` on llama.cpp servers, through the
// real adapters with a stubbed server.
//
// The harness's own nudges are user messages. On a template that keeps
// reasoning only since the last user turn (Gemma-4's official, Qwen 3.6's),
// each nudge dropped the reasoning before it (automaticum #1848). The flag is
// sent only where the template was measured to need it.
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../gateway";
import {
	cachedReinjection,
	primeTemplateReinjection,
	resetReasoningReinjection,
} from "../reasoning-history";

afterEach(() => resetReasoningReinjection());

type Body = Record<string, unknown> & {
	messages?: Array<{ role: string }>;
	chat_template_kwargs?: { preserve_thinking?: boolean };
};

/**
 * A server whose template keeps reasoning after the last user message, and
 * before it only with `preserve_thinking` -- or ignores the flag.
 */
function server(honoursFlag: boolean) {
	const chats: Body[] = [];
	const fetchStub = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body ?? "{}")) as Body;
		if (url.endsWith("/apply-template")) {
			const last = body.messages?.at(-1)?.role;
			const kept =
				last !== "user" ||
				(honoursFlag && body.chat_template_kwargs?.preserve_thinking === true);
			return new Response(
				JSON.stringify({ prompt: kept ? JSON.stringify(body.messages) : "x" }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		chats.push(body);
		return new Response(JSON.stringify({ error: { message: "stub" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchStub, chats };
}

async function send(
	providerId: "openai-compatible" | "opencoti",
	fetchStub: typeof fetch,
): Promise<void> {
	const gateway = createGateway({
		providerConfigs: [
			{
				providerId,
				apiKey: "test-key",
				baseUrl: "http://127.0.0.1:8080/v1",
				fetch: fetchStub,
			},
		],
	});
	try {
		for await (const _event of await gateway.stream({
			providerId,
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
}

describe.each([
	"openai-compatible",
	"opencoti",
] as const)("%s: preserve_thinking", (providerId) => {
	it("is measured, and sent where the template needs it", async () => {
		const { fetchStub, chats } = server(true);
		await primeTemplateReinjection("http://127.0.0.1:8080/v1", "m", fetchStub);
		expect(cachedReinjection("http://127.0.0.1:8080", "m")).toMatchObject({
			reinjects: true,
			preservesThinking: true,
		});
		await send(providerId, fetchStub);
		expect(chats.at(-1)?.chat_template_kwargs).toEqual({
			preserve_thinking: true,
		});
	});

	it("is not sent to a template that ignores it", async () => {
		const { fetchStub, chats } = server(false);
		await primeTemplateReinjection("http://127.0.0.1:8080/v1", "m", fetchStub);
		expect(
			cachedReinjection("http://127.0.0.1:8080", "m")?.preservesThinking,
		).toBeUndefined();
		await send(providerId, fetchStub);
		expect(chats.at(-1)).not.toHaveProperty("chat_template_kwargs");
	});
});
