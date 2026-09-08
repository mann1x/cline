import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProviderSettingsManager } from "@cline/core";
import { describe, expect, it, vi } from "vitest";
import {
	getPersistedProviderApiKey,
	normalizeAuthProviderId,
	parseAuthCommandArgs,
	saveOAuthProviderSettings,
} from "./auth";

describe("parseAuthCommandArgs", () => {
	it("parses Azure API version quick setup option", () => {
		expect(
			parseAuthCommandArgs([
				"--provider",
				"openai-compatible",
				"--apikey",
				"key",
				"--modelid",
				"gpt-4.1",
				"--baseurl",
				"https://example.openai.azure.com/openai/deployments/gpt-4.1",
				"--azure-api-version",
				"2025-01-01-preview",
			]),
		).toMatchObject({
			explicitProvider: "openai-compatible",
			apikey: "key",
			modelid: "gpt-4.1",
			baseurl: "https://example.openai.azure.com/openai/deployments/gpt-4.1",
			azureApiVersion: "2025-01-01-preview",
		});
	});
});

describe("saveOAuthProviderSettings", () => {
	it("preserves existing manual apiKey while updating OAuth tokens", () => {
		const save = vi.fn();
		const manager = {
			saveProviderSettings: save,
		} as unknown as ProviderSettingsManager;

		const merged = saveOAuthProviderSettings(
			manager,
			"cline",
			{
				provider: "cline",
				apiKey: "manual-key",
				auth: {
					accessToken: "workos:old-access",
					refreshToken: "old-refresh",
					accountId: "acct-old",
				},
			},
			{
				access: "new-access",
				refresh: "new-refresh",
				expires: 4_000_000_000_000,
				accountId: "acct-new",
			},
		);

		expect(merged).toMatchObject({
			provider: "cline",
			apiKey: "manual-key",
			auth: {
				accessToken: "workos:new-access",
				refreshToken: "new-refresh",
				accountId: "acct-new",
				expiresAt: 4_000_000_000_000,
			},
		});
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
				apiKey: "manual-key",
				auth: expect.objectContaining({
					accessToken: "workos:new-access",
				}),
			}),
			{ tokenSource: "oauth" },
		);
	});
});

describe("getPersistedProviderApiKey", () => {
	it("does not double-prefix persisted Cline OAuth tokens", () => {
		expect(
			getPersistedProviderApiKey("cline", {
				provider: "cline",
				auth: {
					accessToken: "workos:oauth-access",
				},
			}),
		).toBe("workos:oauth-access");
	});
});

describe("normalizeAuthProviderId", () => {
	it("keeps CLI-only codex shorthand in CLI parsing", () => {
		expect(normalizeAuthProviderId("codex")).toBe("openai-codex");
	});
});

/**
 * Quick setup used to hold a second opinion about what a provider takes: a key
 * was demanded from every provider, and a base URL was allowed for two named
 * ones. The registry already answers both questions, and it disagreed --
 * Ollama has no key and does have a base URL, and it is the provider most
 * likely of all of them to be running somewhere other than the default host.
 */
describe("ensureQuickSetupInputValid", () => {
	const catalog = {
		providers: [
			{
				id: "ollama",
				name: "Ollama",
				configFields: [{ path: "baseUrl" }, { path: "modelId" }],
			},
			{
				id: "anthropic",
				name: "Anthropic",
				configFields: [{ path: "apiKey" }, { path: "modelId" }],
			},
		],
	};

	async function validate(input: {
		provider: string;
		apikey?: string;
		baseurl?: string;
	}): Promise<string | undefined> {
		vi.doMock("../utils/provider-catalog", () => ({
			listLocalProviders: async () => catalog,
		}));
		vi.doMock("@cline/core", async (importOriginal) => ({
			...((await importOriginal()) as object),
			ensureCustomProvidersLoaded: async () => {},
		}));
		vi.resetModules();
		const { ensureQuickSetupInputValid } = await import("./auth");
		return await ensureQuickSetupInputValid(
			{
				provider: input.provider,
				apikey: input.apikey ?? "",
				modelid: "some-model",
				baseurl: input.baseurl,
			},
			{} as unknown as ProviderSettingsManager,
		);
	}

	it("accepts a base URL for a provider whose registry entry has one", async () => {
		expect(
			await validate({
				provider: "ollama",
				baseurl: "http://127.0.0.1:11439",
			}),
		).toBeUndefined();
	});

	it("does not demand a key from a provider that has none", async () => {
		expect(await validate({ provider: "ollama" })).toBeUndefined();
	});

	it("still demands a key from a provider that has one", async () => {
		expect(await validate({ provider: "anthropic" })).toBe(
			"auth quick setup requires --apikey <key>",
		);
	});

	it("refuses a base URL for a provider that takes none", async () => {
		expect(
			await validate({
				provider: "anthropic",
				apikey: "key",
				baseurl: "http://example.invalid",
			}),
		).toBe('base URL is not supported for provider "anthropic"');
	});
});

describe("loadAuthTuiRuntime", () => {
	it("loads OpenTUI React after provider catalog initialization", async () => {
		const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
		const script = `
import { ProviderSettingsManager, ensureCustomProvidersLoaded, listLocalProviders } from "@cline/core";
import { loadAuthTuiRuntime } from "./src/commands/auth.ts";
const manager = new ProviderSettingsManager();
await ensureCustomProvidersLoaded(manager);
await listLocalProviders(manager);
const runtime = await loadAuthTuiRuntime();
if (typeof runtime.createCliRenderer !== "function") throw new Error("missing createCliRenderer");
if (typeof runtime.createRoot !== "function") throw new Error("missing createRoot");
if (typeof runtime.OnboardingView !== "function") throw new Error("missing OnboardingView");
`;

		const result = spawnSync(
			"bun",
			["--conditions=development", "-e", script],
			{
				cwd: cliRoot,
				encoding: "utf8",
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});
