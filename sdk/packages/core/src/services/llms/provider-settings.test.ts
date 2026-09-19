import { describe, expect, it } from "vitest";
import { safeParseSettings, toProviderConfig } from "./provider-settings";

describe("provider settings", () => {
	it("formats Cline OAuth access tokens for runtime API keys", () => {
		const config = toProviderConfig({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			auth: {
				accessToken: "oauth-access-token",
			},
		});

		expect(config.apiKey).toBe("workos:oauth-access-token");
		expect(config.accessToken).toBe("oauth-access-token");
	});

	it("accepts the Bedrock apikey authentication alias", () => {
		const result = safeParseSettings({
			provider: "bedrock",
			model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			aws: {
				authentication: "apikey",
				region: "us-east-1",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected Bedrock apikey settings to parse");
		}

		expect(toProviderConfig(result.data).aws).toEqual(
			expect.objectContaining({
				authentication: "apikey",
			}),
		);
	});

	it("resolves the regional endpoint from apiLine when no base URL is set", () => {
		expect(
			toProviderConfig({ provider: "zai", apiLine: "china" }),
		).toMatchObject({
			apiLine: "china",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		});

		expect(
			toProviderConfig({ provider: "moonshot", apiLine: "china" }),
		).toMatchObject({
			baseUrl: "https://api.moonshot.cn/v1",
		});

		expect(
			toProviderConfig({ provider: "qwen", apiLine: "international" }),
		).toMatchObject({
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		});
	});

	it("lets an explicit base URL win over apiLine", () => {
		expect(
			toProviderConfig({
				provider: "zai",
				apiLine: "china",
				baseUrl: "https://proxy.example.com/v4",
			}),
		).toMatchObject({
			baseUrl: "https://proxy.example.com/v4",
		});
	});

	it("keeps the provider default base URL when no apiLine is set", () => {
		expect(toProviderConfig({ provider: "zai" })).toMatchObject({
			baseUrl: "https://api.z.ai/api/paas/v4",
		});
		expect(toProviderConfig({ provider: "moonshot" })).toMatchObject({
			baseUrl: "https://api.moonshot.ai/v1",
		});
	});
});

describe("reasoning history", () => {
	it("carries the configured replay setting into the provider config", () => {
		// Stored beside the other reasoning controls rather than at the top
		// level, because it is one: how much of the model's own thinking goes
		// back to it. The gateway reads it off `ProviderConfig.reasoningHistory`,
		// and a value that is written but never read is the failure mode this
		// tree keeps hitting.
		const config = toProviderConfig({
			provider: "ollama",
			reasoning: { enabled: true, reasoningHistory: "last" },
		} as never);
		expect(config.reasoningHistory).toBe("last");
	});

	it("leaves it unset when the profile does not choose, which means auto", () => {
		const config = toProviderConfig({
			provider: "ollama",
			reasoning: { enabled: true },
		} as never);
		expect(config.reasoningHistory).toBeUndefined();
	});

	it("accepts every mode the resolver understands and refuses anything else", () => {
		for (const mode of ["auto", "all", "last", "none"]) {
			const parsed = safeParseSettings({
				provider: "ollama",
				reasoning: { reasoningHistory: mode },
			});
			expect(parsed.success, mode).toBe(true);
		}
		expect(
			safeParseSettings({
				provider: "ollama",
				reasoning: { reasoningHistory: "sometimes" },
			}).success,
		).toBe(false);
	});

	it("carries the inline-fallback switch, and unset means on", () => {
		// The gate over the goose fallback. Unset has to reach the resolver as
		// unset rather than as `false`, because the resolver is where "on by
		// default" is decided -- spelling the default here as well would be two
		// places to change it and one of them would be missed.
		expect(
			toProviderConfig({
				provider: "ollama",
				reasoning: { reasoningInline: false },
			} as never).reasoningInline,
		).toBe(false);
		expect(
			toProviderConfig({
				provider: "ollama",
				reasoning: { enabled: true },
			} as never).reasoningInline,
		).toBeUndefined();
	});
});

describe("per-turn output budget", () => {
	// `outputBudget` is a field of the shared providers.json schema, but until
	// now every reader of it lived in `apps/vscode`. A CLI profile that set it
	// was parsed, stored and then dropped, so the gateway synthesised its flat
	// anchor instead and the harness ran every arm at 32,000 -- the ladder that
	// ended run 0405 at the 8,000 floor.
	it("carries a manual output budget into the provider config", () => {
		const config = toProviderConfig({
			provider: "ollama",
			model: "v9-agentic-ac_tb:27b-q4km-128k",
			outputBudget: { mode: "manual", maxTokens: 82500 },
		});

		expect(config.defaultMaxOutputTokens).toBe(82500);
	});

	// Manual needs no window, but auto is a share of one, and a bare CLI profile
	// has none. `undefined` is the honest answer there -- inventing a number
	// would be the same defect in the other direction.
	it("sizes an auto output budget from the configured window, and declines without one", () => {
		const windowed = toProviderConfig({
			provider: "ollama",
			model: "v9-agentic-ac_tb:27b-q4km-128k",
			contextWindow: 131072,
			outputBudget: { mode: "auto" },
		});
		expect(windowed.defaultMaxOutputTokens).toBeGreaterThan(32_000);

		const bare = toProviderConfig({
			provider: "ollama",
			model: "v9-agentic-ac_tb:27b-q4km-128k",
			outputBudget: { mode: "auto" },
		});
		expect(bare.defaultMaxOutputTokens).toBeUndefined();
	});

	// A profile written before the setting existed carries its cap in
	// `sampling.numPredict` and nowhere else. It is what actually goes on the
	// wire, so it has to win, exactly as it does in the VS Code factory.
	it("prefers a configured numPredict over the output budget", () => {
		const config = toProviderConfig({
			provider: "ollama",
			model: "v9-agentic-ac_tb:27b-q4km-128k",
			contextWindow: 131072,
			sampling: { numPredict: 40000 },
			outputBudget: { mode: "manual", maxTokens: 82500 },
		});

		expect(config.defaultMaxOutputTokens).toBe(40000);
	});
});

describe("thinking budget for capped-thinking detection", () => {
	// `compaction.thinkingBudgetTokens` is what arms the capped-thinking
	// condenser: without an allowance it cannot tell a turn that ran out of
	// thinking budget from one that simply stopped, so it stands down -- with no
	// note and no failure. The VS Code factory resolves the allowance itself;
	// every other host had `reasoning.budgetTokens` as its only source, and the
	// panel (and the harness) write `sampling.thinkBudget` instead.
	it("resolves a think budget level against the session's output cap", () => {
		const config = toProviderConfig({
			provider: "opencoti",
			model: "/m/v9.gguf",
			contextWindow: 131072,
			outputBudget: { mode: "auto" },
			sampling: { thinkBudget: "max" },
		});

		// 0.75 * 131072 = 98304 output cap, of which `max` is 4/5.
		expect(config.defaultMaxOutputTokens).toBe(98304);
		expect(config.thinkingBudgetTokens).toBe(78643);
	});

	// An explicit count is the user typing a number, and it is not a share of
	// anything -- it must survive untouched.
	it("keeps an explicit reasoning budget ahead of a level", () => {
		const config = toProviderConfig({
			provider: "opencoti",
			model: "/m/v9.gguf",
			contextWindow: 131072,
			outputBudget: { mode: "auto" },
			reasoning: { budgetTokens: 12345 },
			sampling: { thinkBudget: "max" },
		});

		expect(config.thinkingBudgetTokens).toBe(12345);
	});

	// No level and no count is not "guess one". A budget invented here would
	// arm the detector against a bound the server was never given.
	it("resolves nothing when no budget was configured", () => {
		const config = toProviderConfig({
			provider: "opencoti",
			model: "/m/v9.gguf",
			contextWindow: 131072,
			outputBudget: { mode: "auto" },
		});

		expect(config.thinkingBudgetTokens).toBeUndefined();
	});
});
