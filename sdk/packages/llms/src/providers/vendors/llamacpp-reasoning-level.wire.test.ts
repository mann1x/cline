// The model's thinking level and the thinking budget on llama.cpp servers,
// through the real adapters with a stubbed fetch.
//
// Measured on eleven2go, 2026-10-14, against a template that lists
// xhigh/medium/low: upstream llama.cpp hands a top-level `reasoning_effort`
// to the chat template, so the budget dropdown's word sent there also set the
// model's level, and "high" made the template raise (HTTP 500, turn failed).
// The budget goes as `reasoning_budget_tokens` only; the level, a separate
// setting (`sampling.reasoningLevel`), goes as `reasoning_effort`.
import type { GatewayStreamRequest } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createGateway } from "../gateway";

async function wireBody(input: {
	providerId: "openai-compatible" | "opencoti";
	reasoning: GatewayStreamRequest["reasoning"];
	sampling?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchStub = (async (_input, init) => {
		body = JSON.parse((init?.body as string) ?? "{}");
		return new Response(JSON.stringify({ error: { message: "stub" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const gateway = createGateway({
		providerConfigs: [
			{
				providerId: input.providerId,
				apiKey: "test-key",
				baseUrl: "http://127.0.0.1:8080/v1",
				fetch: fetchStub,
				...(input.sampling ? { options: { sampling: input.sampling } } : {}),
			},
		],
	});
	try {
		for await (const _event of await gateway.stream({
			providerId: input.providerId,
			modelId: "m",
			reasoning: input.reasoning,
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
	if (!body) {
		throw new Error("the stubbed fetch was never called");
	}
	return body;
}

describe.each([
	"openai-compatible",
	"opencoti",
] as const)("%s: level and budget are separate", (providerId) => {
	it("sends the budget word as a budget only, never as reasoning_effort", async () => {
		for (const effort of ["low", "high"] as const) {
			const body = await wireBody({
				providerId,
				reasoning: { enabled: true, effort },
			});
			expect(body).not.toHaveProperty("reasoning_effort");
			expect(body.reasoning_budget_tokens).toEqual(expect.any(Number));
		}
	});

	it("sends a picked level as reasoning_effort, beside the budget", async () => {
		const body = await wireBody({
			providerId,
			reasoning: { enabled: true, effort: "high" },
			sampling: { reasoningLevel: "low" },
		});
		expect(body.reasoning_effort).toBe("low");
		expect(body.reasoning_budget_tokens).toEqual(expect.any(Number));
	});

	it("sends a level alone when no budget is chosen", async () => {
		const body = await wireBody({
			providerId,
			reasoning: { enabled: true },
			sampling: { reasoningLevel: "xhigh" },
		});
		expect(body.reasoning_effort).toBe("xhigh");
		expect(body).not.toHaveProperty("reasoning_budget_tokens");
	});

	it("sends neither when thinking is on and nothing is chosen", async () => {
		// "Default (unbounded)": no budget, and no level for the template.
		const body = await wireBody({ providerId, reasoning: { enabled: true } });
		expect(body).not.toHaveProperty("reasoning_effort");
		expect(body).not.toHaveProperty("reasoning_budget_tokens");
	});

	it("never sends the level with thinking off", async () => {
		const body = await wireBody({
			providerId,
			reasoning: { enabled: false },
			sampling: { reasoningLevel: "low" },
		});
		expect(body.reasoning_budget_tokens).toBe(0);
		expect(
			body.reasoning_effort === undefined || body.reasoning_effort === "none",
		).toBe(true);
	});
});
