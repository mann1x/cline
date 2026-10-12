import { describe, expect, it, vi } from "vitest";
import type { ProviderSettings } from "../types/provider-settings";
import { prepareLocalRuntimeBootstrap } from "./local-runtime-bootstrap";
import {
	type ResolvedSessionConfig,
	toReportValue,
} from "./resolved-session-config";

const MODEL = "anthropic/claude-haiku-4.5";

const STORED = {
	provider: "cline",
	baseUrl: "http://stored.test/v1",
	contextWindow: 50_000,
	sampling: { temperature: 0.3 },
} as unknown as ProviderSettings;

function bootstrap(
	config: Record<string, unknown> = {},
	stored: ProviderSettings | null = STORED,
) {
	const getProviderSettings = vi.fn(() => stored ?? undefined);
	const run = prepareLocalRuntimeBootstrap({
		input: {
			config: {
				providerId: "cline",
				modelId: MODEL,
				apiKey: "sk-very-secret",
				cwd: "/tmp/project",
				workspaceRoot: "/tmp/project",
				systemPrompt: "system",
				mode: "act" as const,
				enableTools: true,
				...config,
			},
		} as never,
		sessionId: "sess-1",
		providerSettingsManager: { getProviderSettings } as never,
		defaultTelemetry: undefined,
		defaultToolPolicies: undefined,
		onPluginEvent: () => {},
		onTeamEvent: () => {},
		createSpawnTool: () =>
			({
				name: "spawn",
				description: "",
				inputSchema: {},
				execute: vi.fn(),
			}) as never,
		readSessionMetadata: async () => undefined,
		writeSessionMetadata: async () => {},
	});
	return { run, getProviderSettings };
}

describe("what a session was built with", () => {
	it("says what the stored profile contributed", async () => {
		const { resolvedConfig, providerConfig } = await bootstrap().run;
		expect(providerConfig.baseUrl).toBe("http://stored.test/v1");
		expect(resolvedConfig.sources.storedProviderSettings).toBe("merged");
		expect(resolvedConfig.sources.inheritedFromStoredProfile).toEqual(
			expect.arrayContaining([
				"baseUrl",
				"sampling",
				"maxInputTokens",
				"budget.contextWindow",
			]),
		);
		expect(resolvedConfig.sampling).toEqual({ temperature: 0.3 });
		expect(resolvedConfig.contextWindow).toBe(50_000);
		// What the host passed itself is not something it inherited.
		expect(resolvedConfig.sources.inheritedFromStoredProfile).not.toContain(
			"apiKey",
		);
	});

	it("builds from the host's configuration alone when told to", async () => {
		const { run, getProviderSettings } = bootstrap({
			storedProviderSettings: "ignore",
		});
		const { resolvedConfig, providerConfig } = await run;
		expect(getProviderSettings).not.toHaveBeenCalled();
		expect(providerConfig.baseUrl).not.toBe("http://stored.test/v1");
		expect(providerConfig.sampling).toBeUndefined();
		expect(resolvedConfig.sources.storedProviderSettings).toBe("ignored");
		expect(resolvedConfig.sources.inheritedFromStoredProfile).toEqual([]);
		expect(resolvedConfig.sampling).toBeUndefined();
	});

	it("reports no profile as absent, with nothing inherited", async () => {
		const { resolvedConfig } = await bootstrap({}, null).run;
		expect(resolvedConfig.sources.storedProviderSettings).toBe("absent");
		expect(resolvedConfig.sources.inheritedFromStoredProfile).toEqual([]);
	});

	it("takes the context window the host names, over the profile's", async () => {
		const { resolvedConfig, providerConfig } = await bootstrap({
			contextWindow: 32_000,
		}).run;
		const entry = providerConfig.knownModels?.[MODEL] as {
			contextWindow?: number;
			maxInputTokens?: number;
		};
		// The catalog entry is what a request's `num_ctx` is read from.
		expect(entry.contextWindow).toBe(32_000);
		expect(entry.maxInputTokens).toBeUndefined();
		expect(providerConfig.maxInputTokens).toBe(32_000);
		expect(resolvedConfig.contextWindow).toBe(32_000);
		expect(resolvedConfig.sources.inheritedFromStoredProfile).not.toContain(
			"budget.contextWindow",
		);
		expect(resolvedConfig.sources.inheritedFromStoredProfile).not.toContain(
			"maxInputTokens",
		);
	});

	it("hands the report over before the session exists, and a refusal stops it", async () => {
		let seen: ResolvedSessionConfig | undefined;
		const built = await bootstrap({
			onConfigResolved: (resolved: ResolvedSessionConfig) => {
				seen = resolved;
			},
		}).run;
		expect(seen).toBe(built.resolvedConfig);
		expect(seen?.systemPrompt).toBe(built.config.systemPrompt);

		await expect(
			bootstrap({
				onConfigResolved: () => {
					throw new Error("not the configuration that was asked for");
				},
			}).run,
		).rejects.toThrow("not the configuration that was asked for");
	});

	it("is data: nothing live in it, and no secret", async () => {
		const { resolvedConfig } = await bootstrap({
			headers: { "X-Api-Token": "also-secret" },
		}).run;
		const text = JSON.stringify(resolvedConfig);
		expect(text).not.toContain("sk-very-secret");
		expect(text).not.toContain("also-secret");
		expect(resolvedConfig.provider.apiKey).toBe("[set]");
		expect(JSON.parse(text)).toEqual(resolvedConfig);
		expect(resolvedConfig.sources.dataDir).toBeTruthy();
		expect(resolvedConfig.sources.providerSettingsPath).toContain(
			"providers.json",
		);
	});
});

describe("a value fit for a report", () => {
	it("drops what is live and hides what is secret", () => {
		class Service {}
		expect(
			toReportValue({
				model: "m",
				apiKey: "k",
				accessToken: "",
				fetch: () => undefined,
				logger: { log: () => undefined },
				service: new Service(),
				headers: { Authorization: "Bearer x", "X-Trace": "abc" },
				nested: { refreshToken: "r", limit: 3, list: [1, () => 2, "a"] },
			}),
		).toEqual({
			model: "m",
			apiKey: "[set]",
			accessToken: "",
			headers: { Authorization: "[set]", "X-Trace": "[set]" },
			nested: { refreshToken: "[set]", limit: 3, list: [1, "a"] },
		});
	});
});
