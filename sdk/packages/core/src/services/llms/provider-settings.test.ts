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
