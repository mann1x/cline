import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as LlmsModels from "@cline/llms";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderSettingsManager } from "./provider-settings-manager";

describe("ProviderSettingsManager", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		LlmsModels.resetRegistry();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists and restores provider settings", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings(
			{
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				apiKey: "test-key",
			},
			{ setLastUsed: true },
		);

		const reloaded = new ProviderSettingsManager({ filePath });
		expect(reloaded.getLastUsedProviderSettings()).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "test-key",
		});
		expect(reloaded.getProviderConfig("anthropic")?.providerId).toBe(
			"anthropic",
		);
		expect(reloaded.getProviderConfig("anthropic")?.modelId).toBe(
			"claude-sonnet-4-6",
		);
		expect(reloaded.getProviderConfig("anthropic")?.knownModels).toBeDefined();
		expect(
			reloaded.getProviderConfig("anthropic", { includeKnownModels: false }),
		).not.toHaveProperty("knownModels");
		expect(reloaded.read().providers.anthropic?.tokenSource).toBe("manual");
	});

	it("persists voice input selection independently of the chat provider", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings(
			{
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				apiKey: "chat-key",
			},
			{ setLastUsed: true },
		);
		manager.setVoiceInputSettings({
			providerId: "elevenlabs",
			modelId: "scribe_v2",
		});

		const reloaded = new ProviderSettingsManager({ filePath });
		expect(reloaded.getVoiceInputSettings()).toEqual({
			providerId: "elevenlabs",
			modelId: "scribe_v2",
		});
		const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<
			string,
			unknown
		>;
		expect(persisted).toMatchObject({
			modes: {
				voiceInput: {
					providerId: "elevenlabs",
					modelId: "scribe_v2",
				},
			},
		});
		expect(persisted).not.toHaveProperty("voiceInput");
		expect(reloaded.getLastUsedProviderSettings()?.provider).toBe("anthropic");

		reloaded.setVoiceInputSettings(undefined);
		expect(
			new ProviderSettingsManager({ filePath }).getVoiceInputSettings(),
		).toBe(undefined);
		expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({
			modes: {},
		});
	});

	it("writes atomically, leaving no temp file behind", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings(
			{ provider: "anthropic", apiKey: "test-key" },
			{ setLastUsed: true },
		);

		const siblings = readdirSync(tempDir);
		expect(siblings).toEqual(["provider-settings.json"]);
	});

	it("preserves the previous file when the staged write cannot be renamed", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });
		manager.saveProviderSettings(
			{ provider: "anthropic", apiKey: "before" },
			{ setLastUsed: true },
		);
		const before = readFileSync(filePath, "utf8");

		// Occupying the temp path with a directory makes writeFileSync fail,
		// simulating a mid-write crash: the destination must be untouched.
		mkdirSync(`${filePath}.${process.pid}.tmp`);
		expect(() =>
			manager.saveProviderSettings(
				{ provider: "anthropic", apiKey: "after" },
				{ setLastUsed: true },
			),
		).toThrow();
		rmSync(`${filePath}.${process.pid}.tmp`, { recursive: true, force: true });

		expect(readFileSync(filePath, "utf8")).toBe(before);
	});

	it("resolves auth storage settings for providers registered with a storage provider id", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings(
			{
				provider: "cline",
				model: "anthropic/claude-sonnet-4.6",
				baseUrl: "https://api.example.test",
				auth: {
					accessToken: "workos:shared-token",
					refreshToken: "shared-refresh",
				},
			},
			{ setLastUsed: false, tokenSource: "oauth" },
		);

		expect(manager.getProviderSettings("cline-pass")).toEqual({
			provider: "cline-pass",
			baseUrl: "https://api.example.test",
			auth: {
				accessToken: "workos:shared-token",
				refreshToken: "shared-refresh",
			},
		});
		expect(manager.getProviderConfig("cline-pass")).toMatchObject({
			providerId: "cline-pass",
			apiKey: "workos:shared-token",
			baseUrl: "https://api.example.test",
		});

		manager.saveProviderSettings(
			{
				provider: "cline-pass",
				model: "cline-pass/glm-5.2",
			},
			{ setLastUsed: true },
		);

		expect(manager.getProviderSettings("cline-pass")).toEqual({
			provider: "cline-pass",
			model: "cline-pass/glm-5.2",
			baseUrl: "https://api.example.test",
			auth: {
				accessToken: "workos:shared-token",
				refreshToken: "shared-refresh",
			},
		});
	});

	it("falls back to cline when last-used provider is cline-pass and the feature is disabled", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings(
			{
				provider: "cline",
				model: "anthropic/claude-sonnet-4.6",
				baseUrl: "https://api.example.test",
				auth: {
					accessToken: "workos:shared-token",
					refreshToken: "shared-refresh",
				},
			},
			{ setLastUsed: false, tokenSource: "oauth" },
		);
		manager.saveProviderSettings(
			{
				provider: "cline-pass",
				model: "cline-pass/glm-5.2",
			},
			{ setLastUsed: true },
		);

		expect(manager.getLastUsedProviderSettings()).toMatchObject({
			provider: "cline-pass",
			model: "cline-pass/glm-5.2",
		});
		expect(
			manager.getLastUsedProviderSettings({ isClinePassEnabled: false }),
		).toEqual({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			baseUrl: "https://api.example.test",
			auth: {
				accessToken: "workos:shared-token",
				refreshToken: "shared-refresh",
			},
		});
		expect(
			manager.getLastUsedProviderConfig({ isClinePassEnabled: false }),
		).toMatchObject({
			providerId: "cline",
			apiKey: "workos:shared-token",
			baseUrl: "https://api.example.test",
		});
	});

	it("returns default cline settings when cline-pass is last-used and no cline settings exist", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings(
			{
				provider: "cline-pass",
				model: "cline-pass/glm-5.2",
			},
			{ setLastUsed: true },
		);

		manager.saveProviderSettings(
			{
				provider: "cline",
			},
			{ setLastUsed: true },
		);

		expect(
			manager.getLastUsedProviderSettings({ isClinePassEnabled: false }),
		).toEqual({ provider: "cline" });
		expect(
			manager.getLastUsedProviderConfig({ isClinePassEnabled: false })
				?.providerId,
		).toBe("cline");
	});

	it("migrates legacy provider settings during manager construction", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "settings", "providers.json");

		writeFileSync(
			path.join(tempDir, "globalState.json"),
			JSON.stringify(
				{
					mode: "act",
					actModeApiProvider: "anthropic",
					actModeApiModelId: "claude-sonnet-4-6",
				},
				null,
				2,
			),
		);
		writeFileSync(
			path.join(tempDir, "secrets.json"),
			JSON.stringify({ apiKey: "legacy-key" }, null, 2),
		);

		const manager = new ProviderSettingsManager({ filePath, dataDir: tempDir });

		expect(manager.getLastUsedProviderSettings()).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "legacy-key",
		});
		expect(manager.read().providers.anthropic?.tokenSource).toBe("migration");
	});

	it("registers migrated custom providers during manager construction", async () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "settings", "providers.json");

		writeFileSync(
			path.join(tempDir, "globalState.json"),
			JSON.stringify(
				{
					mode: "act",
					actModeApiProvider: "openai",
					actModeOpenAiModelId: "gpt-oss-120b",
					openAiBaseUrl: "https://gateway.example.invalid/v1",
				},
				null,
				2,
			),
		);
		writeFileSync(
			path.join(tempDir, "secrets.json"),
			JSON.stringify({ openAiApiKey: "legacy-key" }, null, 2),
		);

		const manager = new ProviderSettingsManager({ filePath, dataDir: tempDir });
		const providers = await LlmsModels.getAllProviders();
		const models = await LlmsModels.getModelsForProvider("openai-compatible");
		const openAiProvider = providers.find(
			(provider) => provider.id === "openai-compatible",
		);

		expect(manager.getProviderSettings("openai-compatible")).toEqual({
			provider: "openai-compatible",
			model: "gpt-oss-120b",
			apiKey: "legacy-key",
			baseUrl: "https://gateway.example.invalid/v1",
		});
		expect(openAiProvider).toMatchObject({
			id: "openai-compatible",
			baseUrl: "https://gateway.example.invalid/v1",
			defaultModelId: "gpt-oss-120b",
		});
		expect(models["gpt-oss-120b"]).toMatchObject({
			id: "gpt-oss-120b",
			contextWindow: 128000,
			maxInputTokens: 128000,
			capabilities: ["streaming", "tools", "images"],
		});
	});

	it("registers non-built-in OpenAI-compatible providers from providers.json", async () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "settings", "providers.json");
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify(
				{
					version: 1,
					lastUsedProvider: "custom-provider",
					providers: {
						"custom-provider": {
							settings: {
								provider: "custom-provider",
								baseUrl: "https://custom.example.invalid/v1",
								model: "custom-model",
								apiKey: "test-key",
								capabilities: ["reasoning", "tools"],
							},
							updatedAt: new Date().toISOString(),
							tokenSource: "manual",
						},
					},
				},
				null,
				2,
			),
		);

		const manager = new ProviderSettingsManager({ filePath });
		const provider = await LlmsModels.getProvider("custom-provider");
		const models = await LlmsModels.getModelsForProvider("custom-provider");

		expect(manager.getProviderConfig("custom-provider")).toMatchObject({
			providerId: "custom-provider",
			baseUrl: "https://custom.example.invalid/v1",
			modelId: "custom-model",
		});
		expect(provider).toMatchObject({
			id: "custom-provider",
			baseUrl: "https://custom.example.invalid/v1",
			defaultModelId: "custom-model",
			client: "openai-compatible",
			source: "file",
		});
		expect(models["custom-model"]).toMatchObject({
			id: "custom-model",
		});
		expect(models["custom-model"]?.capabilities?.sort()).toEqual([
			"reasoning",
			"tools",
		]);
	});

	it("routes custom providers with the Responses API protocol through the OpenAI client", async () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "settings", "providers.json");
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify(
				{
					version: 1,
					lastUsedProvider: "custom-responses",
					providers: {
						"custom-responses": {
							settings: {
								provider: "custom-responses",
								baseUrl: "https://responses.example.invalid/v1",
								model: "responses-model",
								protocol: "openai-responses",
								apiKey: "test-key",
							},
							updatedAt: new Date().toISOString(),
							tokenSource: "manual",
						},
					},
				},
				null,
				2,
			),
		);

		const manager = new ProviderSettingsManager({ filePath });
		const provider = await LlmsModels.getProvider("custom-responses");

		expect(manager.getProviderConfig("custom-responses")).toMatchObject({
			providerId: "custom-responses",
			baseUrl: "https://responses.example.invalid/v1",
			modelId: "responses-model",
			routingProviderId: "openai-native",
		});
		expect(provider).toMatchObject({
			id: "custom-responses",
			protocol: "openai-responses",
			client: "openai",
			source: "file",
		});
	});

	it("refreshes provider registrations when providers.json changes on disk", async () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "settings", "providers.json");
		const manager = new ProviderSettingsManager({ filePath });
		mkdirSync(path.dirname(filePath), { recursive: true });

		expect(LlmsModels.hasProvider("disk-added-provider")).toBe(false);

		writeFileSync(
			filePath,
			JSON.stringify(
				{
					version: 1,
					providers: {
						"disk-added-provider": {
							settings: {
								provider: "disk-added-provider",
								baseUrl: "https://disk.example.invalid/v1",
								model: "disk-model",
							},
							updatedAt: new Date().toISOString(),
							tokenSource: "manual",
						},
					},
				},
				null,
				2,
			),
		);

		expect(manager.getProviderSettings("disk-added-provider")).toMatchObject({
			provider: "disk-added-provider",
			baseUrl: "https://disk.example.invalid/v1",
			model: "disk-model",
		});
		await expect(
			LlmsModels.getProvider("disk-added-provider"),
		).resolves.toMatchObject({
			id: "disk-added-provider",
			defaultModelId: "disk-model",
		});
	});

	it("tracks provider-specific settings while preserving last-used provider", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
		});
		manager.saveProviderSettings(
			{
				provider: "openai-native",
				model: "gpt-5",
			},
			{ setLastUsed: false },
		);

		expect(manager.getProviderSettings("anthropic")?.model).toBe(
			"claude-sonnet-4-6",
		);
		expect(manager.getProviderSettings("openai-native")?.model).toBe("gpt-5");
		expect(manager.getLastUsedProviderSettings()?.provider).toBe("anthropic");
		expect(manager.read().providers["openai-native"]?.tokenSource).toBe(
			"manual",
		);
	});

	it("allows overriding token source metadata", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		const manager = new ProviderSettingsManager({ filePath });

		manager.saveProviderSettings(
			{
				provider: "openai-codex",
				apiKey: "oauth-token",
			},
			{ tokenSource: "oauth" },
		);

		expect(manager.read().providers["openai-codex"]?.tokenSource).toBe("oauth");
	});

	it("ignores invalid persisted JSON and falls back to empty state", () => {
		const tempDir = mkdtempSync(
			path.join(os.tmpdir(), "core-provider-settings-"),
		);
		tempDirs.push(tempDir);
		const filePath = path.join(tempDir, "provider-settings.json");
		writeFileSync(filePath, "{ not-json", "utf8");

		const manager = new ProviderSettingsManager({ filePath });
		expect(manager.read()).toEqual({
			version: 1,
			modes: {},
			providers: {},
		});
	});

	describe("read() caching", () => {
		/** A manager over a file that already holds one saved provider. */
		function seeded(): { manager: ProviderSettingsManager; filePath: string } {
			const tempDir = mkdtempSync(
				path.join(os.tmpdir(), "core-provider-settings-cache-"),
			);
			tempDirs.push(tempDir);
			const filePath = path.join(tempDir, "provider-settings.json");
			const manager = new ProviderSettingsManager({ filePath });
			manager.saveProviderSettings({
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				apiKey: "test-key",
			});
			return { manager, filePath };
		}

		/**
		 * Swap the file's contents for something the same length.
		 *
		 * The point of the pair of tests below is what the manager does when the
		 * file's stat has not moved, so the timestamp is pinned on both sides of
		 * the swap rather than left to the clock. `utimesSync` truncates to the
		 * millisecond and `mtimeMs` carries sub-millisecond digits, so the pin
		 * has to be applied before the first read as well as after the swap --
		 * restoring a captured mtime afterwards does not reproduce it.
		 */
		function swapKeepingSize(
			filePath: string,
			from: string,
			to: string,
			stamp: Date,
		): void {
			expect(to).toHaveLength(from.length);
			const raw = readFileSync(filePath, "utf8");
			expect(raw).toContain(from);
			writeFileSync(filePath, raw.replace(from, to), "utf8");
			utimesSync(filePath, stamp, stamp);
		}

		it("does not read the file again while its stat has not moved", () => {
			const { manager, filePath } = seeded();
			const stamp = new Date(1_700_000_000_000);
			utimesSync(filePath, stamp, stamp);
			expect(manager.getProviderSettings("anthropic")?.apiKey).toBe("test-key");

			// The extension calls read() on every webview state post, which is
			// every streamed chunk: a readFileSync, a JSON.parse and a full
			// schema validation each time. Content the manager cannot have seen
			// is how that is detected from outside the class -- if it comes back,
			// the file was read again.
			swapKeepingSize(filePath, "test-key", "gone-key", stamp);
			for (let i = 0; i < 20; i += 1) {
				manager.read();
			}
			expect(manager.getProviderSettings("anthropic")?.apiKey).toBe("test-key");
		});

		it("reads again once the file's stat moves", () => {
			const { manager, filePath } = seeded();
			const stamp = new Date(1_700_000_000_000);
			utimesSync(filePath, stamp, stamp);
			expect(manager.getProviderSettings("anthropic")?.apiKey).toBe("test-key");

			swapKeepingSize(
				filePath,
				"test-key",
				"gone-key",
				new Date(1_700_000_001_000),
			);
			expect(manager.getProviderSettings("anthropic")?.apiKey).toBe("gone-key");
		});

		it("sees a write made by another process", () => {
			const { manager, filePath } = seeded();
			expect(manager.read().lastUsedProvider).toBe("anthropic");

			// What the CLI or the hub doing its own save looks like from here:
			// this manager never wrote, so only the file can say it changed.
			const other = new ProviderSettingsManager({ filePath });
			other.saveProviderSettings(
				{ provider: "openai", model: "gpt-5", apiKey: "other-key" },
				{ setLastUsed: true },
			);

			expect(manager.read().lastUsedProvider).toBe("openai");
			expect(manager.getProviderSettings("openai")?.apiKey).toBe("other-key");
		});

		it("hands out a copy, not the cached object", () => {
			const { manager } = seeded();

			// Callers here do mutate what they are given -- setVoiceInputSettings
			// assigns into `.modes` and writes the same object back -- so a cache
			// that returned its own value would be edited from under itself.
			const first = manager.read();
			first.lastUsedProvider = "tampered";
			delete first.providers["anthropic"];

			const second = manager.read();
			expect(second.lastUsedProvider).toBe("anthropic");
			expect(second.providers["anthropic"]).toBeDefined();
		});

		it("does not cache the empty fallback for an unparseable file", () => {
			const { manager, filePath } = seeded();
			writeFileSync(filePath, "{ not json", "utf8");
			expect(manager.read().providers).toEqual({});

			// Fixed up underneath it. The empty state was a fallback, not a
			// reading of the file, and caching it would outlive the problem.
			const repaired = new ProviderSettingsManager({
				filePath: path.join(path.dirname(filePath), "repaired.json"),
			});
			repaired.saveProviderSettings({
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				apiKey: "test-key",
			});
			writeFileSync(
				filePath,
				readFileSync(
					path.join(path.dirname(filePath), "repaired.json"),
					"utf8",
				),
				"utf8",
			);

			expect(manager.read().providers["anthropic"]).toBeDefined();
		});
	});
});
