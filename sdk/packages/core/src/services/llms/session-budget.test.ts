import { describe, expect, it, vi } from "vitest";
import {
	resolveSessionOutputCap,
	resolveSessionThinkingAllowance,
	sessionThinkingEngine,
} from "./session-budget";

describe("resolveSessionOutputCap", () => {
	// The number the plugin sends for omni-council-kv3-384k, and the one the CLI
	// did not: three quarters of the window, under the 96,000 ceiling.
	it("takes three quarters of the window, under the ceiling", () => {
		expect(resolveSessionOutputCap({ contextWindow: 196_608 })).toBe(96_000);
		expect(resolveSessionOutputCap({ contextWindow: 65_536 })).toBe(49_152);
	});

	it("puts a configured num_predict, then a per-turn cap, then manual first", () => {
		const window = { contextWindow: 196_608 };
		expect(
			resolveSessionOutputCap({
				...window,
				configuredNumPredict: 8_000,
				maxTokensPerTurn: 9_000,
			}),
		).toBe(8_000);
		expect(
			resolveSessionOutputCap({ ...window, maxTokensPerTurn: 9_000 }),
		).toBe(9_000);
		expect(
			resolveSessionOutputCap({
				...window,
				outputBudget: { mode: "manual", maxTokens: 20_000 },
			}),
		).toBe(20_000);
	});

	it("lets an auto ceiling only lower the cap, and the model's own bound clamp it", () => {
		expect(
			resolveSessionOutputCap({
				contextWindow: 196_608,
				outputBudget: { mode: "auto", maxTokens: 40_000 },
			}),
		).toBe(40_000);
		expect(
			resolveSessionOutputCap({
				contextWindow: 196_608,
				modelMaxOutputTokens: 16_384,
			}),
		).toBe(16_384);
	});

	it("falls back to the gateway's default only with no window at all", () => {
		expect(resolveSessionOutputCap({})).toBe(32_000);
	});
});

describe("resolveSessionThinkingAllowance", () => {
	const base = {
		modelId: "omni",
		baseUrl: "http://e2g:22434",
		outputCap: 96_000,
		contextWindow: 196_608,
	};

	it("asks Ollama with the level, the cap and the window the session sends", async () => {
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						think_budget: "medium",
						think_budget_tokens: 24_000,
					}),
				),
		);
		const allowance = await resolveSessionThinkingAllowance({
			...base,
			providerId: "ollama",
			reasoningEffort: "medium",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(allowance).toEqual({ level: "medium", budgetTokens: 24_000 });
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://e2g:22434/api/show");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "omni",
			think: "medium",
			options: { num_predict: 96_000, num_ctx: 196_608 },
		});
	});

	it("uses a host's own probe when it brings one", async () => {
		const probeOllama = vi.fn(async () => ({
			level: "high",
			budgetTokens: 48_000,
		}));
		const fetchImpl = vi.fn();
		const allowance = await resolveSessionThinkingAllowance({
			...base,
			providerId: "ollama",
			reasoningEffort: "high",
			configuredNumPredict: 64_000,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			probeOllama,
		});
		expect(allowance?.budgetTokens).toBe(48_000);
		expect(probeOllama).toHaveBeenCalledWith("http://e2g:22434", "omni", {
			think: "high",
			numPredict: 64_000,
			numCtx: 196_608,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("computes a llama.cpp budget from the same table, with no request", async () => {
		const fetchImpl = vi.fn();
		const allowance = await resolveSessionThinkingAllowance({
			...base,
			providerId: "opencoti",
			reasoningEffort: "medium",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(allowance).toEqual({ level: "medium", budgetTokens: 24_000 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("states nothing with thinking off or on an engine without a budget", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		expect(
			await resolveSessionThinkingAllowance({
				...base,
				providerId: "ollama",
				thinking: false,
				fetchImpl,
			}),
		).toBeUndefined();
		expect(sessionThinkingEngine("anthropic")).toBeUndefined();
		expect(
			await resolveSessionThinkingAllowance({
				...base,
				providerId: "anthropic",
				fetchImpl,
			}),
		).toBeUndefined();
	});
});
