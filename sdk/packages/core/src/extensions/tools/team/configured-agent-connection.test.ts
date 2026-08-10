import { describe, expect, it } from "vitest";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import { buildAgentRuntimeConfig } from "./configured-agent-tool";
import type { DelegatedAgentRuntimeConfig } from "./delegated-agent";

const sessionFetch = (async () => new Response("")) as unknown as typeof fetch;

const BASE: DelegatedAgentRuntimeConfig = {
	providerId: "ollama",
	modelId: "lead-model",
	apiKey: "lead-key",
	baseUrl: "http://localhost:11434",
	providerConfig: {
		providerId: "ollama",
		modelId: "lead-model",
		modelInfo: { contextWindow: 128_000 },
		fetch: sessionFetch,
	} as never,
};

function agent(
	overrides: Partial<ConfiguredAgentConfig> = {},
): ConfiguredAgentConfig {
	return {
		name: "reviewer",
		description: "reviews code",
		systemPrompt: "You review code.",
		...overrides,
	};
}

describe("a configured agent's connection", () => {
	it("inherits the session's when the agent names nothing", () => {
		const runtime = buildAgentRuntimeConfig(BASE, agent());

		expect(runtime.providerId).toBe("ollama");
		expect(runtime.modelId).toBe("lead-model");
		expect(runtime.apiKey).toBe("lead-key");
	});

	// The gateway reads the model from `providerConfig` as well as from the top
	// level, so swapping only one of them leaves the request naming one model
	// and running another.
	it("swaps the model in both places when the provider is the session's", () => {
		const runtime = buildAgentRuntimeConfig(
			BASE,
			agent({ modelId: "small-reviewer" }),
		);

		expect(runtime.modelId).toBe("small-reviewer");
		expect((runtime.providerConfig as { modelId?: string }).modelId).toBe(
			"small-reviewer",
		);
		expect(runtime.apiKey).toBe("lead-key");
	});

	// The reported case: "we have multiple providers that I would like to create
	// agents to handle specific tasks". The agent used to get the new provider's
	// *id* with the lead's base URL, key and context window — a request to the
	// wrong server, which fails as an auth error or, worse, succeeds against a
	// model nobody chose.
	it("takes the second provider's own credentials and base URL", () => {
		const runtime = buildAgentRuntimeConfig(
			BASE,
			agent({ providerId: "anthropic", modelId: "claude-sonnet-4-6" }),
			() => ({
				apiKey: "anthropic-key",
				baseUrl: "https://api.anthropic.com",
				providerConfig: { providerId: "anthropic", modelId: "placeholder" },
			}),
		);

		expect(runtime.providerId).toBe("anthropic");
		expect(runtime.apiKey).toBe("anthropic-key");
		expect(runtime.baseUrl).toBe("https://api.anthropic.com");
		expect((runtime.providerConfig as { modelId?: string }).modelId).toBe(
			"claude-sonnet-4-6",
		);
		// The lead's 128k window belonged to the lead's model on the lead's
		// server; carrying it across is how a request gets sized for the wrong
		// one.
		expect(runtime.providerConfig).not.toHaveProperty("modelInfo");
	});

	// A second provider's stored settings carry no `fetch`. Dropping the
	// session's is how a corporate proxy or a self-signed CA stops working for
	// subagents only.
	it("keeps the host's fetch across a provider switch", () => {
		const runtime = buildAgentRuntimeConfig(
			BASE,
			agent({ providerId: "anthropic" }),
			() => ({ apiKey: "k", providerConfig: { providerId: "anthropic" } }),
		);

		expect((runtime.providerConfig as { fetch?: unknown }).fetch).toBe(
			sessionFetch,
		);
	});

	// Refused, not silently run on the lead's connection: that is the failure
	// this change is about, and an error naming the agent and the provider is
	// worth more than a request to a server the user did not choose.
	it.each([
		["the host supplies no resolver", undefined],
		["the store has never heard of it", () => undefined],
	])("refuses an agent on a provider %s", (_label, resolve) => {
		expect(() =>
			buildAgentRuntimeConfig(
				BASE,
				agent({ providerId: "anthropic" }),
				resolve as never,
			),
		).toThrow(/reviewer.*anthropic/s);
	});

	it("still applies the agent's iteration cap", () => {
		expect(
			buildAgentRuntimeConfig(BASE, agent({ maxIterations: 7 })).maxIterations,
		).toBe(7);
	});
});
