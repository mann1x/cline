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

	it("measures prior-reasoning replay before the report, through the host's fetch", async () => {
		// automaticum #1833: `auto` never measured opencoti, because the probe
		// posted under `/v1`, and nothing told the host what it resolved to.
		const urls: string[] = [];
		const fetch = async (url: string) => {
			urls.push(String(url));
			return String(url).endsWith("/apply-template")
				? new Response(JSON.stringify({ prompt: "<start_of_turn>model\nhi" }))
				: new Response("not found", { status: 404 });
		};
		const { resolvedConfig } = await bootstrap(
			{
				providerId: "opencoti",
				modelId: "gemma-4",
				baseUrl: "http://resolved-probe.test:8261/v1",
				storedProviderSettings: "ignore",
				fetch,
			},
			null,
		).run;
		expect(urls).toContain("http://resolved-probe.test:8261/apply-template");
		expect(resolvedConfig.reasoningHistory).toEqual({
			setting: "auto",
			scope: "last",
			channel: "inline",
			decidedBy: "measured",
			inline: true,
			detail: "template drops reasoning",
		});
	});

	it("gives a host that names no switch the plugin's defaults", async () => {
		const { config, resolvedConfig } = await bootstrap({}, null).run;
		expect(config.compaction?.enabled).toBe(true);
		expect(config.checkpoint?.enabled).toBe(true);
		expect(config.taskProgress?.enabled).toBe(true);
		expect(resolvedConfig.session).toMatchObject({
			compaction: { enabled: true },
			checkpoint: { enabled: true },
			taskProgress: { enabled: true },
		});
	});

	it("keeps a switch a host turned off", async () => {
		const { config } = await bootstrap(
			{
				compaction: { enabled: false, strategy: "basic" },
				checkpoint: { enabled: false },
				taskProgress: { enabled: false },
			},
			null,
		).run;
		expect(config.compaction).toMatchObject({
			enabled: false,
			strategy: "basic",
		});
		expect(config.checkpoint?.enabled).toBe(false);
		expect(config.taskProgress?.enabled).toBe(false);
	});

	it("asks Ollama about the model before it budgets, as the plugin does", async () => {
		const fetch = async (url: string) =>
			String(url).endsWith("/api/show")
				? new Response(
						JSON.stringify({
							parameters: "num_ctx                        65536",
							capabilities: ["completion", "tools"],
							details: { family: "qwen3" },
						}),
					)
				: new Response("not found", { status: 404 });
		const { providerConfig, resolvedConfig } = await bootstrap(
			{
				providerId: "ollama",
				modelId: "qwen3:8b",
				baseUrl: "http://ask-before-budget.test:11434",
				storedProviderSettings: "ignore",
				fetch,
			},
			null,
		).run;
		// The window the model declares is the one the session budgets against.
		expect(resolvedConfig.contextWindow).toBe(65_536);
		const entry = providerConfig.knownModels?.["qwen3:8b"] as {
			contextWindow?: number;
			maxInputTokens?: number;
			maxTokens?: number;
			capabilities?: string[];
		};
		expect(entry.contextWindow).toBe(65_536);
		expect(entry.maxInputTokens).toBe(65_536);
		// Ollama publishes no cap, so the session's own is written for compaction.
		expect(entry.maxTokens).toBe(providerConfig.defaultMaxOutputTokens);
		// It said it calls tools and did not say it reads images.
		expect(entry.capabilities).toEqual(["tools"]);
	});

	it("stands client compaction down for an xOllama council", async () => {
		const fetch = async (url: string) =>
			String(url).endsWith("/api/show")
				? new Response(
						JSON.stringify({ xollama: { council: { enabled: true } } }),
					)
				: new Response("not found", { status: 404 });
		const { config } = await bootstrap(
			{
				providerId: "xollama",
				modelId: "council-a",
				baseUrl: "http://council.test:22434",
				storedProviderSettings: "ignore",
				compaction: { enabled: true, cappedThinkingEnabled: true },
				fetch,
			},
			null,
		).run;
		expect(config.compaction?.enabled).toBe(false);
		expect(config.compaction?.cappedThinkingEnabled).toBe(false);
		expect(config.staleReadRewrites).toBe(false);
	});

	it("reports a provider it does not probe as the standing default", async () => {
		const { resolvedConfig } = await bootstrap({}, null).run;
		expect(resolvedConfig.reasoningHistory).toMatchObject({
			setting: "auto",
			scope: "all",
			decidedBy: "standing-default",
		});
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
