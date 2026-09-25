import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CoreSessionConfig } from "@cline/core"
import * as LlmsModels from "@cline/llms"
import { OLLAMA_DEFAULT_REASONING_EFFORT } from "@cline/llms"
import { buildOutputBudgetSection } from "@cline/shared"
import {
	CATALOG_CONTEXT_WINDOW,
	NODE_MODEL_ID,
	NODE_WINDOW_CASES,
	opencotiNodeSnapshot,
} from "@shared/__tests__/scoped-context-window.fixtures"
import { scopedContextWindow, scopedProviderConfigFromProfile } from "@shared/api-config-snapshot"
import { snapshotProviderSettings } from "@shared/model-scope-config"
import { ApiFormat } from "@shared/proto/cline/models"
import { Logger } from "@shared/services/Logger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildDelegatedAgentConnection,
	buildResumeSessionInput,
	buildSessionConfig,
	buildStartSessionInput,
	composeSessionHooks,
	createHistoryItemFromSession,
	getDefaultModelIdForProvider,
	getHistoryItemById,
	normalizeProviderReasoningSettings,
	normalizeSdkBaseUrl,
	resolveApiKey,
	resolveCompactionPrompt,
	resolveOllamaProviderConfig,
	resolveThinkingAllowance,
	updateHistoryItem,
} from "./cline-session-factory"
import { parseProviderId } from "./model-catalog/provider-id"
import { createProviderConfigStore } from "./model-catalog/store"

const mocks = vi.hoisted(() => {
	const providerSettingsManager = {
		getFilePath: vi.fn(() => path.join(tempDir, "settings", "providers.json")),
		getLastUsedProviderSettings: vi.fn(() => undefined),
		getProviderSettings: vi.fn((_providerId?: string) => undefined),
		saveProviderSettings: vi.fn(),
	}

	return {
		getDistinctId: vi.fn(() => "test-distinct-id"),
		getProviderSettingsManager: vi.fn(() => providerSettingsManager),
		resolveOllamaThinkBudget: vi.fn(async (): Promise<{ level: string; budgetTokens: number } | undefined> => undefined),
		resolveOllamaImageSupport: vi.fn(async (): Promise<boolean | undefined> => undefined),
		resolveOllamaToolSupport: vi.fn(async (): Promise<boolean | undefined> => undefined),
		providerSettingsManager,
		stateManager: {
			getApiConfiguration: vi.fn(() => ({
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-sonnet-4-6",
				apiKey: "test-key",
			})),
			getGlobalSettingsKey: vi.fn((key: string): boolean | undefined => {
				if (key === "subagentsEnabled" || key === "useAutoCondense") {
					return false
				}
				return undefined
			}),
			setGlobalStateBatch: vi.fn(),
			setGlobalState: vi.fn(),
			setSecret: vi.fn(),
		},
	}
})

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => mocks.stateManager,
	},
}))

vi.mock("@/services/logging/distinctId", () => ({
	getDistinctId: mocks.getDistinctId,
}))

vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

vi.mock("./ollama-model-family", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ollama-model-family")>()),
	resolveOllamaThinkBudget: mocks.resolveOllamaThinkBudget,
	resolveOllamaImageSupport: mocks.resolveOllamaImageSupport,
	resolveOllamaToolSupport: mocks.resolveOllamaToolSupport,
}))

vi.mock("@shared/services/Logger", () => ({
	Logger: {
		debug: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * The shared `models.json` entry for the node fixtures' model, at
 * {@link CATALOG_CONTEXT_WINDOW} -- written the way the unscoped panel writes
 * it, through the store, so every reader of the registry sees it.
 */
function mockNodeCatalog(extra: Record<string, unknown> = {}): void {
	createProviderConfigStore().commitSelection(parseProviderId("opencoti"), "act", {
		providerId: parseProviderId("opencoti"),
		modelId: NODE_MODEL_ID,
		overrides: { contextWindow: CATALOG_CONTEXT_WINDOW, ...extra },
	})
}

let tempDir: string
const previousGlobalSettingsPath = process.env.CLINE_GLOBAL_SETTINGS_PATH
const previousDataDir = process.env.CLINE_DATA_DIR

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-session-factory-"))
	process.env.CLINE_DATA_DIR = tempDir
	process.env.CLINE_GLOBAL_SETTINGS_PATH = path.join(tempDir, "global-settings.json")
	vi.clearAllMocks()
	LlmsModels.resetRegistry()
	mocks.stateManager.getApiConfiguration.mockReturnValue({
		actModeApiProvider: "anthropic",
		actModeApiModelId: "claude-sonnet-4-6",
		apiKey: "test-key",
	})
	mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
		if (key === "subagentsEnabled" || key === "useAutoCondense") {
			return false
		}
		return undefined
	})
	mocks.providerSettingsManager.getFilePath.mockReturnValue(path.join(tempDir, "settings", "providers.json"))
	mocks.providerSettingsManager.getLastUsedProviderSettings.mockReturnValue(undefined)
	mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined)
})

afterEach(() => {
	process.env.CLINE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath
	process.env.CLINE_DATA_DIR = previousDataDir
	fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeJson(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function makeBaseConfig(overrides: Partial<CoreSessionConfig> = {}): CoreSessionConfig {
	return {
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: "test-key",
		cwd: "/tmp/workspace",
		workspaceRoot: "/tmp/workspace",
		systemPrompt: "",
		mode: "act",
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// provider/model defaults
// ---------------------------------------------------------------------------

describe("getDefaultModelIdForProvider", () => {
	it("uses the SDK provider catalog for the Cerebriline default model", () => {
		expect(getDefaultModelIdForProvider("cline")).toBe(
			LlmsModels.MODEL_COLLECTIONS_BY_PROVIDER_ID.cline.provider.defaultModelId,
		)
	})

	it("uses the generated Gemini provider default", () => {
		expect(getDefaultModelIdForProvider("gemini")).toBe(
			LlmsModels.MODEL_COLLECTIONS_BY_PROVIDER_ID.gemini.provider.defaultModelId,
		)
	})

	it("returns undefined for unknown providers", () => {
		expect(getDefaultModelIdForProvider("unknown-provider")).toBeUndefined()
	})

	it("returns no default for local-model-source providers so a cloud-catalog model is never silently selected", () => {
		expect(getDefaultModelIdForProvider("ollama")).toBeUndefined()
		expect(getDefaultModelIdForProvider("lmstudio")).toBeUndefined()
	})

	it("resolves the OpenAI Compatible default through the extension's openai alias", () => {
		// The extension stores the OpenAI Compatible provider as "openai" while
		// the SDK catalog keys it as "openai-compatible". toSdkProviderId bridges
		// the two so the catalog default-model lookup resolves.
		expect(getDefaultModelIdForProvider("openai")).toBe("gpt-4o")
	})
})

// ---------------------------------------------------------------------------
// buildStartSessionInput
// ---------------------------------------------------------------------------

describe("buildStartSessionInput", () => {
	it("does not forward the prompt to start()", () => {
		const config = makeBaseConfig()
		const input = {
			prompt: "Hello, world!",
			cwd: "/tmp/workspace",
		}

		const result = buildStartSessionInput(config, input)

		expect(result.config).toBe(config)
		expect(result.prompt).toBeUndefined()
		expect(result.interactive).toBe(true)
		expect(result.userImages).toBeUndefined()
		expect(result.userFiles).toBeUndefined()
	})

	it("includes images and files when provided", () => {
		const config = makeBaseConfig()
		const input = {
			prompt: "Look at this",
			images: ["image1.png", "image2.jpg"],
			files: ["file1.ts"],
			cwd: "/tmp/workspace",
		}

		const result = buildStartSessionInput(config, input)

		expect(result.userImages).toEqual(["image1.png", "image2.jpg"])
		expect(result.userFiles).toEqual(["file1.ts"])
	})

	it("always sets interactive to true", () => {
		const config = makeBaseConfig()
		const input = { cwd: "/tmp/workspace" }

		const result = buildStartSessionInput(config, input)

		expect(result.interactive).toBe(true)
	})

	it("handles undefined prompt", () => {
		const config = makeBaseConfig()
		const input = { cwd: "/tmp/workspace" }

		const result = buildStartSessionInput(config, input)

		expect(result.prompt).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// buildResumeSessionInput
// ---------------------------------------------------------------------------

describe("buildResumeSessionInput", () => {
	it("builds resume input with session ID and prompt", () => {
		const result = buildResumeSessionInput("session-123", "Continue the task")

		expect(result.sessionId).toBe("session-123")
		expect(result.prompt).toBe("Continue the task")
		expect(result.userImages).toBeUndefined()
		expect(result.userFiles).toBeUndefined()
	})

	it("includes images and files when provided", () => {
		const result = buildResumeSessionInput("session-123", "Look at this", ["img.png"], ["file.ts"])

		expect(result.userImages).toEqual(["img.png"])
		expect(result.userFiles).toEqual(["file.ts"])
	})
})

// ---------------------------------------------------------------------------
// normalizeSdkBaseUrl
// ---------------------------------------------------------------------------

describe("normalizeSdkBaseUrl", () => {
	it("treats blank base URLs as unset so SDK provider defaults can apply", () => {
		expect(normalizeSdkBaseUrl("openai-compatible", "")).toBeUndefined()
		expect(normalizeSdkBaseUrl("openai-compatible", "   ")).toBeUndefined()
	})

	it("passes Ollama origins through unchanged (the native-API vendor appends /api itself)", () => {
		expect(normalizeSdkBaseUrl("ollama", "http://localhost:11434")).toBe("http://localhost:11434")
		expect(normalizeSdkBaseUrl("ollama", "http://localhost:11434/")).toBe("http://localhost:11434/")
		// Legacy 4.0.x configs may carry the OpenAI-compat /v1 suffix; it is
		// preserved here and rewritten to /api by the vendor.
		expect(normalizeSdkBaseUrl("ollama", "http://localhost:11434/v1")).toBe("http://localhost:11434/v1")
	})

	// Reported live: a remote Ollama at 192.168.1.100:30068 ended up stored
	// without its scheme, and every request died on
	// `Failed to parse URL from 192.168.1.100:30068/api/chat` with nothing on
	// screen connecting the two. `host:port` has one sensible reading.
	it("puts a scheme back on a base URL that lost one", () => {
		expect(normalizeSdkBaseUrl("ollama", "192.168.1.100:30068")).toBe("http://192.168.1.100:30068")
		expect(normalizeSdkBaseUrl("ollama", " localhost:11434 ")).toBe("http://localhost:11434")
		expect(normalizeSdkBaseUrl("ollama", "//192.168.1.100:30068")).toBe("http://192.168.1.100:30068")
	})

	it("leaves a scheme that is already there alone, including https", () => {
		expect(normalizeSdkBaseUrl("ollama", "https://ollama.example.com")).toBe("https://ollama.example.com")
		expect(normalizeSdkBaseUrl("openai", "https://example.com/custom")).toBe("https://example.com/custom")
	})

	it("preserves explicit user paths", () => {
		expect(normalizeSdkBaseUrl("openai", " https://example.com/custom ")).toBe("https://example.com/custom")
	})

	it("inherits the AskSage default /server path when the custom URL has no path", () => {
		expect(normalizeSdkBaseUrl("asksage", "https://asksage.internal.example")).toBe("https://asksage.internal.example/server")
		expect(normalizeSdkBaseUrl("asksage", "https://asksage.internal.example/custom")).toBe(
			"https://asksage.internal.example/custom",
		)
	})
})

// ---------------------------------------------------------------------------
// normalizeProviderReasoningSettings
// ---------------------------------------------------------------------------

describe("normalizeProviderReasoningSettings", () => {
	it("does not emit reasoningEffort when thinking is disabled", () => {
		const result = normalizeProviderReasoningSettings({ enabled: false, effort: "medium" })

		expect(result).toEqual({ thinking: false })
	})

	it("treats effort none as disabled thinking", () => {
		const result = normalizeProviderReasoningSettings({ effort: "none" })

		expect(result).toEqual({ thinking: false })
	})

	it("passes enabled reasoning with a concrete effort", () => {
		const result = normalizeProviderReasoningSettings({ enabled: true, effort: "high" })

		expect(result).toEqual({ thinking: true, reasoningEffort: "high" })
	})

	it("leaves explicit effort-only settings enabled by SDK/provider defaults", () => {
		const result = normalizeProviderReasoningSettings({ effort: "medium" })

		expect(result).toEqual({ reasoningEffort: "medium" })
	})

	it("honors a migrated legacy budget as thinking-on with a derived effort", () => {
		expect(normalizeProviderReasoningSettings({ budgetTokens: 1024 })).toEqual({
			thinking: true,
			reasoningEffort: "low",
		})
		expect(normalizeProviderReasoningSettings({ budgetTokens: 6000 })).toEqual({
			thinking: true,
			reasoningEffort: "medium",
		})
		expect(normalizeProviderReasoningSettings({ budgetTokens: 32_767 })).toEqual({
			thinking: true,
			reasoningEffort: "high",
		})
	})

	it("derives an effort from the budget when enabled without an effort", () => {
		const result = normalizeProviderReasoningSettings({ enabled: true, budgetTokens: 4096 })

		expect(result).toEqual({ thinking: true, reasoningEffort: "medium" })
	})

	it("prefers an explicit effort over a stored budget", () => {
		const result = normalizeProviderReasoningSettings({ enabled: true, effort: "xhigh", budgetTokens: 1024 })

		expect(result).toEqual({ thinking: true, reasoningEffort: "xhigh" })
	})

	it("keeps disabled reasoning off even with a stored budget", () => {
		const result = normalizeProviderReasoningSettings({ enabled: false, budgetTokens: 4096 })

		expect(result).toEqual({ thinking: false })
	})
})

// ---------------------------------------------------------------------------
// buildSessionConfig
// ---------------------------------------------------------------------------

describe("buildSessionConfig", () => {
	it("resolves Cline OAuth credentials after defaulting to the Cline provider", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({} as any)
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "cline",
			auth: {
				accessToken: "workos:test-access-token",
				refreshToken: "test-refresh-token",
			},
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("cline")
		expect(config.apiKey).toBe("workos:test-access-token")
		expect(config.systemPrompt).toContain("# Workspace Configuration")
		expect(config.systemPrompt).toContain(JSON.stringify("/tmp/workspace"))
	})

	it("resolves ClinePass from the shared Cerebriline OAuth credentials", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "cline") {
				return undefined
			}
			return {
				provider: "cline",
				auth: {
					accessToken: "workos:shared-cline-token",
					refreshToken: "shared-refresh-token",
				},
			} as any
		})

		const apiKey = resolveApiKey("cline-pass", {
			actModeApiProvider: "cline-pass",
		} as any)

		expect(apiKey).toBe("workos:shared-cline-token")
		expect(mocks.providerSettingsManager.getProviderSettings).toHaveBeenCalledWith("cline")
	})

	it("preserves explicit ClinePass API keys from state before OAuth storage", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "cline",
			auth: { accessToken: "workos:stored-token" },
		} as any)

		expect(resolveApiKey("cline-pass", { clineApiKey: "workos:configured-token" } as any)).toBe("workos:configured-token")
		expect(mocks.providerSettingsManager.getProviderSettings).not.toHaveBeenCalled()
	})

	it("preserves explicit Cline API keys from state before OAuth storage", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "cline",
			auth: { accessToken: "workos:stored-token" },
		} as any)

		expect(resolveApiKey("cline", { clineApiKey: "workos:configured-cline-token" } as any)).toBe(
			"workos:configured-cline-token",
		)
		expect(mocks.providerSettingsManager.getProviderSettings).not.toHaveBeenCalled()
	})

	it("resolves OpenAI Compatible API keys from migrated SDK provider settings", () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "openai-compatible") {
				return undefined
			}
			return {
				provider: "openai-compatible",
				apiKey: "migrated-openai-compatible-key",
			} as any
		})

		expect(resolveApiKey("openai", {} as any)).toBe("migrated-openai-compatible-key")
		expect(mocks.providerSettingsManager.getProviderSettings).toHaveBeenCalledWith("openai-compatible")
	})

	it("resolves the OpenAI Compatible base URL when the provider is stored under its SDK spelling", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openai-compatible",
			actModeApiModelId: "openai/gpt-4o-mini",
			openAiApiKey: "compat-key",
			openAiBaseUrl: "http://127.0.0.1:4141/v1",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("openai-compatible")
		// Without the base URL, ProviderConfig consumers that don't re-resolve
		// settings (e.g. the compaction summarizer) would hit the provider
		// default endpoint (api.openai.com) instead of the configured one.
		expect(config.baseUrl).toBe("http://127.0.0.1:4141/v1")
		expect(config.providerConfig).toMatchObject({
			providerId: "openai-compatible",
			baseUrl: "http://127.0.0.1:4141/v1",
		})
	})

	it("falls back to the providers.json base URL when legacy state has none", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "openai-compatible") {
				return undefined
			}
			return {
				provider: "openai-compatible",
				apiKey: "compat-key",
				baseUrl: "http://127.0.0.1:4141/v1",
			} as any
		})
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openai-compatible",
			actModeApiModelId: "openai/gpt-4o-mini",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.baseUrl).toBe("http://127.0.0.1:4141/v1")
		expect(config.providerConfig).toMatchObject({
			providerId: "openai-compatible",
			baseUrl: "http://127.0.0.1:4141/v1",
		})
	})

	it("reads the window from the shared entry when the profile is silent about it", async () => {
		// Reported: a profile switch left the session on the other profile's
		// window, and typing the right one into the panel did not move it. The
		// panel writes providers.json; the session was reading the profile
		// snapshot and, because the source was chosen with `??` on the object,
		// never looked at providers.json again for any field the snapshot
		// happened not to carry.
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "ollama") {
				return undefined
			}
			return { provider: "ollama", contextWindow: 65536 } as any
		})
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "ollama",
			actModeOllamaModelId: "v9-agentic",
			ollamaBaseUrl: "http://127.0.0.1:11434",
		} as any)
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string): any => {
			if (key === "subagentsEnabled" || key === "useAutoCondense") {
				return false
			}
			if (key === "apiConfigurationProfiles") {
				return JSON.stringify([
					{
						name: "silent",
						updatedAt: 1,
						// A profile with a provider config that says nothing about
						// the window. Saved before the field was captured, or saved
						// while the panel was still loading -- both leave this.
						snapshot: { global: {}, mode: {}, providerConfig: { baseUrl: "http://127.0.0.1:11434" } },
					},
				])
			}
			if (key === "activeApiConfigurationProfile") {
				return JSON.stringify({ act: "silent" })
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect((config.providerConfig as { modelInfo?: { contextWindow?: number } }).modelInfo?.contextWindow).toBe(65536)
	})

	it("still lets the profile's own window win over the shared entry", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "ollama") {
				return undefined
			}
			return { provider: "ollama", contextWindow: 65536 } as any
		})
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "ollama",
			actModeOllamaModelId: "v9-agentic",
			ollamaBaseUrl: "http://127.0.0.1:11434",
		} as any)
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string): any => {
			if (key === "subagentsEnabled" || key === "useAutoCondense") {
				return false
			}
			if (key === "apiConfigurationProfiles") {
				return JSON.stringify([
					{
						name: "loud",
						updatedAt: 1,
						snapshot: { global: {}, mode: {}, providerConfig: { contextWindow: 131072 } },
					},
				])
			}
			if (key === "activeApiConfigurationProfile") {
				return JSON.stringify({ act: "loud" })
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect((config.providerConfig as { modelInfo?: { contextWindow?: number } }).modelInfo?.contextWindow).toBe(131072)
	})

	// The same rule off Ollama. An opencoti lead read its window only from the
	// `models.json` entry for its model id -- an entry every scope naming that
	// id shares -- so a profile in force for this mode with its own window
	// still ran at whatever the last unscoped edit had put in the catalog.
	it.each([
		["contextWindow", { contextWindow: 128_000 }],
		["modelOverrides.contextWindow", { modelOverrides: { contextWindow: 128_000 } }],
	])("lets an opencoti profile's %s win over the models.json catalog", async (_label, providerConfig) => {
		mockNodeCatalog({ maxInputTokens: CATALOG_CONTEXT_WINDOW })
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "opencoti",
			actModeApiModelId: NODE_MODEL_ID,
		} as any)
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string): any => {
			if (key === "subagentsEnabled" || key === "useAutoCondense") {
				return false
			}
			if (key === "apiConfigurationProfiles") {
				return JSON.stringify([{ name: "node", updatedAt: 1, snapshot: { global: {}, mode: {}, providerConfig } }])
			}
			if (key === "activeApiConfigurationProfile") {
				return JSON.stringify({ act: "node" })
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.modelId).toBe(NODE_MODEL_ID)
		expect(config.knownModels?.[NODE_MODEL_ID]).toMatchObject({ contextWindow: 128_000, maxInputTokens: 128_000 })
	})

	it("keeps the opencoti lead on the catalog window when its profile names none", async () => {
		mockNodeCatalog()
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "opencoti",
			actModeApiModelId: NODE_MODEL_ID,
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.knownModels?.[NODE_MODEL_ID]?.contextWindow).toBe(CATALOG_CONTEXT_WINDOW)
	})

	it("carries the provider entry's tool selection onto the session", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "anthropic") {
				return undefined
			}
			return { provider: "anthropic", apiKey: "test-key", tools: { disabled: ["browser", "awk"] } } as any
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		// The runtime builder folds these into the session's tool policies, and
		// nothing else reads them -- so a selection that does not arrive here is
		// a selection the panel stored and the session ignored.
		expect(config.providerConfig).toMatchObject({ tools: { disabled: ["browser", "awk"] } })
	})

	it("leaves the tool selection off the session when nothing configured one", async () => {
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).not.toHaveProperty("tools")
	})

	it("resolves the AskSage base URL from the legacy asksageApiUrl state field", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "asksage",
			actModeApiModelId: "gpt-4o",
			asksageApiKey: "asksage-key",
			asksageApiUrl: "https://asksage.internal.example/server",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("asksage")
		// Without this mapping the custom URL saved in legacy state was
		// silently ignored and requests went to the builtin default
		// (https://api.asksage.ai/server).
		expect(config.baseUrl).toBe("https://asksage.internal.example/server")
		expect(config.providerConfig).toMatchObject({
			providerId: "asksage",
			baseUrl: "https://asksage.internal.example/server",
		})
	})

	it("falls back to the providers.json AskSage base URL when legacy state has none", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "asksage") {
				return undefined
			}
			return {
				provider: "asksage",
				apiKey: "asksage-key",
				baseUrl: "https://asksage.migrated.example/server",
			} as any
		})
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "asksage",
			actModeApiModelId: "gpt-4o",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.baseUrl).toBe("https://asksage.migrated.example/server")
		expect(config.providerConfig).toMatchObject({
			providerId: "asksage",
			baseUrl: "https://asksage.migrated.example/server",
		})
	})

	it("forwards the regional API line from legacy state so the gateway can route to the regional endpoint", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "zai",
			actModeApiModelId: "glm-5.2",
			zaiApiKey: "zai-key",
			zaiApiLine: "china",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("zai")
		expect(config.providerConfig).toMatchObject({
			providerId: "zai",
			apiLine: "china",
		})
		// No explicit base URL: the SDK gateway resolves the China endpoint
		// (open.bigmodel.cn) from apiLine; a pre-filled base URL would win
		// over that resolution.
		expect(config.baseUrl).toBeUndefined()
	})

	it("falls back to the providers.json apiLine when legacy state has none", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "moonshot") {
				return undefined
			}
			return {
				provider: "moonshot",
				apiKey: "moonshot-key",
				apiLine: "china",
			} as any
		})
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "moonshot",
			actModeApiModelId: "kimi-k3",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).toMatchObject({
			providerId: "moonshot",
			apiLine: "china",
		})
	})

	it("inherits the base provider's legacy apiLine for coding variants", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "zai-coding-plan",
			actModeApiModelId: "glm-5.2",
			zaiApiKey: "zai-key",
			zaiApiLine: "china",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).toMatchObject({
			providerId: "zai-coding-plan",
			apiLine: "china",
		})
	})

	it("prefers the coding variant's own providers.json apiLine over the shared legacy field", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) => {
			if (providerId !== "qwen-code") {
				return undefined
			}
			return {
				provider: "qwen-code",
				apiKey: "qwen-code-key",
				apiLine: "international",
			} as any
		})
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "qwen-code",
			actModeApiModelId: "qwen3-coder-plus",
			qwenApiLine: "china",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).toMatchObject({
			providerId: "qwen-code",
			apiLine: "international",
		})
	})

	it("omits apiLine for unrecognized values", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "qwen",
			actModeApiModelId: "qwen-plus-latest",
			qwenApiKey: "qwen-key",
			qwenApiLine: "mars",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).not.toHaveProperty("apiLine")
	})

	it("exposes knownModels at the top level so manual compaction can budget against the model catalog", async () => {
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		const providerConfigKnownModels = (config.providerConfig as { knownModels?: Record<string, unknown> }).knownModels
		expect(providerConfigKnownModels).toBeDefined()
		expect(config.knownModels).toBe(providerConfigKnownModels)
	})

	it("resolves OpenAI Codex through the shared OAuth provider registry", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "codex-oauth-token",
				refreshToken: "codex-refresh-token",
			},
		} as any)
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openai-codex",
			actModeApiModelId: "gpt-5.4",
			openAiNativeApiKey: "openai-api-key-should-not-be-used",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("openai-codex")
		expect(config.modelId).toBe("gpt-5.4")
		expect(config.apiKey).toBe("codex-oauth-token")
		expect(config.providerConfig).toMatchObject({
			providerId: "openai-codex",
			modelId: "gpt-5.4",
			apiKey: "codex-oauth-token",
		})
	})

	it("resolves SDK-backed provider API keys from provider-specific settings", async () => {
		const providers = [
			{ providerId: "poolside", modelId: "poolside/laguna-m.1" },
			{ providerId: "v0", modelId: "v0-1.5-md" },
			{ providerId: "xiaomi", modelId: "mimo-v2.5" },
			{ providerId: "zai-coding-plan", modelId: "glm-5.2" },
		] as const

		for (const { providerId, modelId } of providers) {
			mocks.providerSettingsManager.getProviderSettings.mockImplementation((requestedProviderId?: string) => {
				if (requestedProviderId !== providerId) {
					return undefined
				}
				return {
					provider: providerId,
					apiKey: `${providerId}-key`,
				} as any
			})
			mocks.stateManager.getApiConfiguration.mockReturnValue({
				actModeApiProvider: providerId,
				actModeApiModelId: modelId,
			} as any)

			const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

			expect(config.providerId).toBe(providerId)
			expect(config.modelId).toBe(modelId)
			expect(config.apiKey).toBe(`${providerId}-key`)
			expect(config.providerConfig).toMatchObject({
				providerId,
				modelId,
				apiKey: `${providerId}-key`,
			})
		}
	})

	it("does not treat OpenAI Codex as OpenAI Native API-key auth", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openai-codex",
			actModeApiModelId: "gpt-5.4",
			openAiNativeApiKey: "openai-api-key-should-not-be-used",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("openai-codex")
		expect(config.modelId).toBe("gpt-5.4")
		expect(config.apiKey).toBe("")
		expect(config.providerConfig).toMatchObject({ providerId: "openai-codex", modelId: "gpt-5.4" })
		expect(config.providerConfig).not.toHaveProperty("apiKey")
	})

	it("preserves rich SDK catalog entries without extension-side replacement", async () => {
		const expectedModel = structuredClone((await LlmsModels.getModelsForProvider("anthropic"))["claude-sonnet-4-6"])
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "anthropic",
			actModeApiModelId: "claude-sonnet-4-6",
			apiKey: "anthropic-key",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["claude-sonnet-4-6"]

		expect(knownModel).toEqual(expectedModel)
		expect(knownModel.capabilities).toEqual(
			expect.arrayContaining(["images", "files", "tools", "reasoning", "structured_output", "temperature", "prompt-cache"]),
		)
		expect(knownModel.pricing).toEqual(expectedModel.pricing)
		expect(knownModel.releaseDate).toBe(expectedModel.releaseDate)
		expect(knownModel.family).toBe(expectedModel.family)
	})

	it("injects cached LiteLLM max input tokens when the dynamic model is absent from the SDK registry", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "litellm",
			actModeLiteLlmModelId: "openai/grok-4.6",
			liteLlmApiKey: "litellm-key",
			actModeLiteLlmModelInfo: {
				name: "xai/grok-4.6",
				contextWindow: 500_000,
				maxInputTokens: 500_000,
				maxTokens: 64_000,
				supportsPromptCache: false,
			},
		} as any)
		const getModelsSpy = vi.spyOn(LlmsModels, "getModelsForProvider").mockResolvedValueOnce({})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["openai/grok-4.6"]

		expect(config.providerId).toBe("litellm")
		expect(knownModel).toMatchObject({
			id: "openai/grok-4.6",
			name: "xai/grok-4.6",
			contextWindow: 500_000,
			maxInputTokens: 500_000,
			maxTokens: 64_000,
		})
		expect(config.knownModels?.["openai/grok-4.6"]).toEqual(knownModel)
		getModelsSpy.mockRestore()
	})

	it("keeps an explicit max-input override ahead of cached LiteLLM metadata", async () => {
		const providerId = parseProviderId("litellm")
		const modelId = "openai/grok-4.6"
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "litellm",
			actModeLiteLlmModelId: modelId,
			liteLlmApiKey: "litellm-key",
			actModeLiteLlmModelInfo: {
				name: "xai/grok-4.6",
				contextWindow: 500_000,
				maxInputTokens: 500_000,
				supportsPromptCache: false,
			},
		} as any)
		createProviderConfigStore().commitSelection(providerId, "act", {
			providerId,
			modelId,
			overrides: { maxInputTokens: 300_000 },
		})
		const getModelsSpy = vi.spyOn(LlmsModels, "getModelsForProvider").mockResolvedValueOnce({})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels[modelId]

		expect(knownModel.contextWindow).toBe(500_000)
		expect(knownModel.maxInputTokens).toBe(300_000)
		getModelsSpy.mockRestore()
	})

	it("does not inject fabricated max input metadata for an unknown LiteLLM model", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "litellm",
			actModeLiteLlmModelId: "custom/no-metadata",
			liteLlmApiKey: "litellm-key",
		} as any)
		const getModelsSpy = vi.spyOn(LlmsModels, "getModelsForProvider").mockResolvedValueOnce({})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.knownModels).toBeUndefined()
		expect(config.providerConfig).not.toHaveProperty("knownModels")
		getModelsSpy.mockRestore()
	})

	it("keeps session creation non-fatal when known-model lookup fails", async () => {
		const lookupError = new Error("registry unavailable")
		const getModelsSpy = vi.spyOn(LlmsModels, "getModelsForProvider").mockRejectedValueOnce(lookupError)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).not.toHaveProperty("knownModels")
		expect(Logger.warn).toHaveBeenCalledWith(
			"[SessionFactory] Failed to resolve known models for provider=anthropic:",
			lookupError,
		)
		getModelsSpy.mockRestore()
	})

	it("passes OpenAI Compatible max output tokens as an explicit request limit", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "custom-reasoner",
			openAiApiKey: "openai-compatible-key",
			openAiBaseUrl: "https://openai-compatible.example/v1",
			actModeOpenAiModelInfo: {
				name: "Custom Reasoner",
				contextWindow: 16_000,
				maxTokens: 4_096,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("openai-compatible")
		expect(config.modelId).toBe("custom-reasoner")
		// knownModels is exposed both inside providerConfig (inference) and at
		// the top level (manual compaction budgets).
		expect(config.knownModels).toBeDefined()
		expect((config.providerConfig as any).knownModels).toBeDefined()
		// Mirrored onto providerConfig for the compaction summarizer (CLINE-2911).
		expect((config.providerConfig as any).maxOutputTokens).toBe(4_096)
		expect((config as any).maxTokensPerTurn).toBe(4_096)
	})

	it("uses OpenAI Compatible overrides from models.json for runtime request settings", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "custom-reasoner",
			openAiApiKey: "openai-compatible-key",
			openAiBaseUrl: "https://openai-compatible.example/v1",
			actModeOpenAiModelInfo: { supportsPromptCache: false },
		} as any)
		createProviderConfigStore().commitSelection(parseProviderId("openai"), "act", {
			providerId: parseProviderId("openai"),
			modelId: "custom-reasoner",
			overrides: {
				name: "Custom Reasoner",
				contextWindow: 16_000,
				maxInputTokens: 15_000,
				maxTokens: 1_234,
				capabilities: ["images", "reasoning", "streaming", "tools"],
				supportsVision: false,
				supportsAttachments: true,
				supportsReasoning: false,
				temperature: 0,
				inputPrice: 1,
				outputPrice: 2,
				cacheReadsPrice: 0.1,
				cacheWritesPrice: 0.5,
				apiFormat: ApiFormat.OPENAI_RESPONSES,
			},
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["custom-reasoner"]

		expect(config.providerId).toBe("openai-compatible")
		expect(config.modelId).toBe("custom-reasoner")
		expect((config as any).maxTokensPerTurn).toBe(1_234)
		expect((config as any).temperature).toBe(0)
		expect(knownModel).toMatchObject({
			id: "custom-reasoner",
			name: "Custom Reasoner",
			contextWindow: 16_000,
			maxInputTokens: 15_000,
			maxTokens: 1_234,
			capabilities: ["streaming", "tools", "files"],
			apiFormat: "openai-responses",
			temperature: 0,
			pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
		})
	})

	it("defaults tool-calling on for dynamic-list models without preserved SDK capabilities", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openrouter",
			actModeOpenRouterModelId: "mock/custom-model",
			openRouterApiKey: "openrouter-key",
			// Dynamic-list picker snapshot: legacy boolean flags but no SDK
			// capability list. The reconstructed capabilities array must still
			// carry "tools" — the SDK treats a populated list without it as
			// "cannot call tools" and silently drops every tool from the session
			// (the file-edit e2e regression).
			actModeOpenRouterModelInfo: {
				name: "Mock Custom Model",
				contextWindow: 16_000,
				supportsImages: true,
				supportsPromptCache: true,
				modalities: { input: ["text", "image"], output: ["text", "image"] },
				inputPrice: 0,
				outputPrice: 0,
			},
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["mock/custom-model"]

		expect(knownModel.capabilities).toEqual(expect.arrayContaining(["images", "prompt-cache", "tools"]))
		expect(knownModel.modalities).toEqual({ input: ["text", "image"], output: ["text", "image"] })
	})

	it("defaults tool-calling on when the preserved capability list is defined but empty", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openrouter",
			actModeOpenRouterModelId: "mock/empty-capabilities-model",
			openRouterApiKey: "openrouter-key",
			// A capabilities field that round-tripped through a boundary
			// defaulting the missing array to [] — same "no signal" state as
			// an absent one (modelHasCapability treats both as unspecified).
			// Before the fix, the strict `=== undefined` guard skipped the
			// tools seeding, supportsReasoning populated the array, and the
			// runtime gate silently dropped every tool definition (#13463).
			actModeOpenRouterModelInfo: {
				name: "Empty Capabilities Model",
				contextWindow: 16_000,
				// Required by the store's isModelInfo gate: without a boolean
				// supportsPromptCache the state snapshot is rejected and the
				// model never reaches knownModels at all.
				supportsPromptCache: false,
				supportsReasoning: true,
				capabilities: [],
			},
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["mock/empty-capabilities-model"]

		expect(knownModel.capabilities).toEqual(expect.arrayContaining(["reasoning", "tools"]))
	})

	/**
	 * Asking Ollama about images is what turns an unspecified capability list
	 * into a populated one, and a populated list answers every other capability
	 * too. A local vision model whose list said only "images" was declaring
	 * itself unable to call tools, and .58's runtime gate believed it: every
	 * call came back "No tools are available" while the system prompt still
	 * described the tools (mann1x/cline#63).
	 */
	describe("ollama capability probe", () => {
		const ollamaConfig = {
			actModeApiProvider: "ollama",
			actModeOllamaModelId: "local-vision-model",
			actModeOllamaBaseUrl: "http://localhost:11434",
		}

		it("keeps tool calling when the server reports vision but says nothing about tools", async () => {
			mocks.stateManager.getApiConfiguration.mockReturnValue(ollamaConfig as any)
			mocks.resolveOllamaImageSupport.mockResolvedValue(true)
			mocks.resolveOllamaToolSupport.mockResolvedValue(undefined)

			const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
			const knownModel = (config.providerConfig as any).knownModels["local-vision-model"]

			expect(knownModel.capabilities).toEqual(expect.arrayContaining(["images", "tools"]))
		})

		it("records what the server does report", async () => {
			mocks.stateManager.getApiConfiguration.mockReturnValue(ollamaConfig as any)
			mocks.resolveOllamaImageSupport.mockResolvedValue(true)
			mocks.resolveOllamaToolSupport.mockResolvedValue(true)

			const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
			const knownModel = (config.providerConfig as any).knownModels["local-vision-model"]

			expect(knownModel.capabilities).toEqual(expect.arrayContaining(["images", "tools"]))
		})

		// A server that says "no tools" is answering, not staying silent.
		it("keeps a reported absence of tool calling authoritative", async () => {
			mocks.stateManager.getApiConfiguration.mockReturnValue(ollamaConfig as any)
			mocks.resolveOllamaImageSupport.mockResolvedValue(true)
			mocks.resolveOllamaToolSupport.mockResolvedValue(false)

			const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
			const knownModel = (config.providerConfig as any).knownModels["local-vision-model"]

			expect(knownModel.capabilities).toContain("images")
			expect(knownModel.capabilities).not.toContain("tools")
		})
	})

	it("keeps legacy supportsTools=false authoritative for dynamic-list models", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openrouter",
			actModeOpenRouterModelId: "mock/no-tools-model",
			openRouterApiKey: "openrouter-key",
			actModeOpenRouterModelInfo: {
				name: "No Tools",
				supportsPromptCache: true,
				supportsTools: false,
			},
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["mock/no-tools-model"]

		expect(knownModel.capabilities).toContain("prompt-cache")
		expect(knownModel.capabilities).not.toContain("tools")
	})

	it("trusts a preserved SDK capability list instead of injecting tools", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openrouter",
			actModeOpenRouterModelId: "mock/media-model",
			openRouterApiKey: "openrouter-key",
			// A capability list preserved from the SDK catalog boundary is
			// authoritative: when it omits "tools", the session must not
			// re-enable tool calling.
			actModeOpenRouterModelInfo: {
				name: "Media Model",
				supportsPromptCache: false,
				capabilities: ["images"],
			},
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["mock/media-model"]

		expect(knownModel.capabilities).toContain("images")
		expect(knownModel.capabilities).not.toContain("tools")
	})

	it("keeps -1 OpenAI Compatible values out of request settings and fallback knownModels", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "custom-reasoner",
			openAiApiKey: "openai-compatible-key",
			openAiBaseUrl: "https://openai-compatible.example/v1",
			actModeOpenAiModelInfo: { supportsPromptCache: false },
		} as any)
		createProviderConfigStore().commitSelection(parseProviderId("openai"), "act", {
			providerId: parseProviderId("openai"),
			modelId: "custom-reasoner",
			overrides: {
				name: "Custom Reasoner",
				maxTokens: -1,
				temperature: -1,
			},
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect((config as any).maxTokensPerTurn).toBeUndefined()
		expect((config.providerConfig as any).maxOutputTokens).toBeUndefined()
		expect((config as any).temperature).toBeUndefined()
		const knownModel = (config.providerConfig as any).knownModels["custom-reasoner"]
		expect(knownModel).not.toHaveProperty("maxTokens")
		expect(knownModel).not.toHaveProperty("temperature", -1)
	})

	it("passes OCA reasoning effort from legacy mode settings to SDK sessions", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "oca",
			actModeOcaModelId: "oca-reasoner",
			ocaApiKey: "oca-key",
			actModeOcaReasoningEffort: " HIGH ",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("oca")
		expect(config.modelId).toBe("oca-reasoner")
		expect(config.thinking).toBe(true)
		expect(config.reasoningEffort).toBe("high")
	})

	it("lets legacy OCA none override stale provider reasoning settings", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			provider: "oca",
			reasoning: { enabled: true, effort: "medium" },
		} as any)
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "oca",
			actModeOcaModelId: "oca-reasoner",
			ocaApiKey: "oca-key",
			actModeOcaReasoningEffort: "none",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.thinking).toBe(false)
		expect(config.reasoningEffort).toBeUndefined()
	})

	it("builds structured SAP AI Core config from legacy ApiConfiguration fields", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "sapaicore",
			actModeApiModelId: "anthropic--claude-4.6-sonnet",
			sapAiCoreClientId: "sap-client",
			sapAiCoreClientSecret: "sap-secret",
			sapAiCoreBaseUrl: " https://api.ai.example.aws.ml.hana.ondemand.com ",
			sapAiCoreTokenUrl: " https://example.authentication.sap.hana.ondemand.com ",
			sapAiResourceGroup: " default ",
			sapAiCoreUseOrchestrationMode: false,
			actModeSapAiCoreDeploymentId: " deployment-id ",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("sapaicore")
		expect(config.modelId).toBe("anthropic--claude-4.6-sonnet")
		expect(config.apiKey).toBe("")
		expect(config.baseUrl).toBe("https://api.ai.example.aws.ml.hana.ondemand.com")
		expect(config.providerConfig).toMatchObject({
			providerId: "sapaicore",
			modelId: "anthropic--claude-4.6-sonnet",
			baseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
			sap: {
				clientId: "sap-client",
				clientSecret: "sap-secret",
				tokenUrl: "https://example.authentication.sap.hana.ondemand.com",
				resourceGroup: "default",
				deploymentId: "deployment-id",
				useOrchestrationMode: false,
			},
		})
		expect(config.providerConfig).not.toHaveProperty("apiKey")
	})

	it("defaults SAP AI Core to orchestration mode and omits deployment id when mode is unset", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "sapaicore",
			actModeApiModelId: "anthropic--claude-4.6-sonnet",
			sapAiCoreClientId: "sap-client",
			sapAiCoreClientSecret: "sap-secret",
			sapAiCoreBaseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
			sapAiCoreTokenUrl: "https://example.authentication.sap.hana.ondemand.com",
			sapAiResourceGroup: "default",
			actModeSapAiCoreDeploymentId: "foundation-deployment-id",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).toMatchObject({
			providerId: "sapaicore",
			sap: {
				clientId: "sap-client",
				clientSecret: "sap-secret",
				tokenUrl: "https://example.authentication.sap.hana.ondemand.com",
				resourceGroup: "default",
				useOrchestrationMode: true,
			},
		})
		expect((config.providerConfig as any).sap).not.toHaveProperty("deploymentId")
	})

	it("omits SAP AI Core deployment id when orchestration mode is enabled", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "sapaicore",
			actModeApiModelId: "anthropic--claude-4.6-sonnet",
			sapAiCoreClientId: "sap-client",
			sapAiCoreClientSecret: "sap-secret",
			sapAiCoreBaseUrl: "https://api.ai.example.aws.ml.hana.ondemand.com",
			sapAiCoreTokenUrl: "https://example.authentication.sap.hana.ondemand.com",
			sapAiResourceGroup: "default",
			sapAiCoreUseOrchestrationMode: true,
			actModeSapAiCoreDeploymentId: "foundation-deployment-id",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect((config.providerConfig as any).sap).toMatchObject({
			resourceGroup: "default",
			useOrchestrationMode: true,
		})
		expect((config.providerConfig as any).sap).not.toHaveProperty("deploymentId")
	})

	it("falls back to legacy SAP-specific model fields when the generic model field is absent", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "sapaicore",
			actModeSapAiCoreModelId: "anthropic--claude-3.5-sonnet",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("sapaicore")
		expect(config.modelId).toBe("anthropic--claude-3.5-sonnet")
	})

	it("preserves an explicitly cleared SAP base URL so stored settings cannot fill it back in", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "sapaicore",
			actModeApiModelId: "anthropic--claude-4.6-sonnet",
			sapAiCoreBaseUrl: "   ",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.baseUrl).toBe("")
		expect(config.providerConfig).toMatchObject({
			providerId: "sapaicore",
			baseUrl: "",
		})
		expect(config.providerConfig).not.toHaveProperty("sap")
	})

	it("does not emit partial SAP overrides when SAP strings are absent", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "sapaicore",
			actModeApiModelId: "anthropic--claude-4.6-sonnet",
			sapAiCoreUseOrchestrationMode: false,
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).toMatchObject({
			providerId: "sapaicore",
		})
		expect(config.providerConfig).not.toHaveProperty("baseUrl")
		expect(config.providerConfig).not.toHaveProperty("sap")
	})

	it("uses ClinePass model storage and omits empty nested apiKey so SDK OAuth can fill it", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "cline-pass",
			actModeClinePassModelId: "cline-pass/glm-5.2",
		} as any)
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("cline-pass")
		expect(config.modelId).toBe("cline-pass/glm-5.2")
		expect(config.apiKey).toBe("")
		expect(config.providerConfig).toMatchObject({ providerId: "cline-pass", modelId: "cline-pass/glm-5.2" })
		expect(config.providerConfig).not.toHaveProperty("apiKey")
	})

	it("enables agentic SDK compaction when global useAutoCondense is true", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return true
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "agentic",
			// Which cut runs, and therefore which of the two prompts the
			// summarizer is given. On is the current behaviour: the summary is a
			// preface to a recency tail rather than a replacement for it.
			keepRecentMessages: true,
			// The second compaction phase, on by default.
			thinkingSummaryEnabled: true,
			councilEnabled: true,
			// And the condenser, which travels here but does not belong to
			// compaction; also on by default.
			cappedThinkingEnabled: true,
		})
	})

	// The shape assertions above pin the defaults. This one is the behaviour:
	// the tickbox chooses which cut runs and therefore which of the two prompts
	// the summarizer is given, and a setting that is stored but never read is
	// this repository's most repeated bug.
	it("carries a disabled recency tail, and its prompt, through to the SDK", async () => {
		// Typed through `unknown` because this is the one case in the file that
		// reads a string setting as well as booleans, and the mock's inferred
		// signature comes from the boolean-only implementations above it.
		mocks.stateManager.getGlobalSettingsKey.mockImplementation(((key: string) => {
			if (key === "useAutoCondense") {
				return true
			}
			if (key === "keepRecentMessagesAtCompaction") {
				return false
			}
			if (key === "fullCompactionPrompt") {
				return "my own no-tail prompt"
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		}) as unknown as (key: string) => boolean | undefined)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction?.keepRecentMessages).toBe(false)
		expect(config.compaction?.fullSummaryPrompt).toBe("my own no-tail prompt")
		// The other strategy's prompt is not sent in its place: each cut gets
		// the prompt written for it, and a blank field falls back to that cut's
		// built-in rather than to the other one's.
		expect(config.compaction?.summaryPrompt).toBeUndefined()
	})

	it("uses the configured SDK compaction strategy when auto condense is enabled", async () => {
		writeJson(process.env.CLINE_GLOBAL_SETTINGS_PATH!, { compactionStrategy: "basic" })
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return true
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "basic",
			keepRecentMessages: true,
			// The second compaction phase, on by default.
			thinkingSummaryEnabled: true,
			councilEnabled: true,
			cappedThinkingEnabled: true,
		})
	})

	it("falls back to agentic SDK compaction for an invalid stored strategy", async () => {
		writeJson(process.env.CLINE_GLOBAL_SETTINGS_PATH!, { compactionStrategy: "invalid" })
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return true
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "agentic",
			keepRecentMessages: true,
			// The second compaction phase, on by default.
			thinkingSummaryEnabled: true,
			councilEnabled: true,
			// And the condenser, which travels here but does not belong to
			// compaction; also on by default.
			cappedThinkingEnabled: true,
		})
	})

	it("does not enable SDK compaction when global useAutoCondense is false", async () => {
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		// The object is still sent, and `enabled` is the whole of what turns
		// compaction off: the runtime builds no compaction pass without it.
		expect(config.compaction?.enabled).toBe(false)
		// This used to assert `strategy` and `summaryPrompt` were absent, which
		// was the bug written down as the contract. `enabled: false` already
		// stops an automatic compaction; withholding the rest only blinded the
		// *manual* one, which force-enables the pass and spreads this same
		// object. The settings describe how a compaction is done, so they travel
		// whether or not one happens on its own.
		expect(config.compaction?.strategy).toBe("agentic")
	})

	it("keeps the capped-thinking condenser configured with auto condense off", async () => {
		// The condenser reads its settings out of the compaction config but has
		// nothing to do with compaction — it rewrites one turn's abandoned
		// reasoning whatever the transcript is doing. Omitting the object when
		// auto-condense was off took the condenser with it, silently.
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction?.cappedThinkingEnabled).toBe(true)
	})

	it("keeps the compaction council configured with auto condense off", async () => {
		// Same shape as the condenser above, one field over. The council belongs
		// to the agentic strategy, and a manual compaction runs that strategy:
		// `sdk-compaction.ts` force-enables the pass and spreads this object for
		// everything else. Sending the flag only when auto-condense was on meant
		// a manual compaction never saw it, and the strategy tests
		// `councilEnabled === false` — so absent read as on and the switch was
		// ignored, at three extra model calls per manual compaction.
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction?.enabled).toBe(false)
		expect(config.compaction?.councilEnabled).toBe(true)
	})

	it("carries a council switched off into a manual-only configuration", async () => {
		// The direction that actually costs money: off must survive the trip,
		// or the switch is decorative with Auto Compact off.
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "councilCompactionEnabled") {
				return false
			}
			if (key === "subagentsEnabled" || key === "useAutoCondense") {
				return false
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction?.councilEnabled).toBe(false)
	})

	it("carries every how-a-compaction-is-done setting with auto condense off", async () => {
		// `councilEnabled` was one field of a seven-field fault. `enabled` is the
		// only one that means "automatic"; the rest describe HOW a compaction is
		// done, and a manual compaction is a compaction. Dropped, they cost a
		// second unwanted model call (`thinkingSummaryEnabled !== false` gates
		// `generateThinkingSummary`) and silently swapped the user's strategy and
		// custom prompts for the defaults.
		// The mock is typed for the boolean keys; these are the string and number
		// settings the same store serves.
		mocks.stateManager.getGlobalSettingsKey.mockImplementation(((key: string) => {
			if (key === "useAutoCondense" || key === "subagentsEnabled") {
				return false
			}
			if (key === "thinkingCompactionEnabled") {
				return false
			}
			if (key === "compactionPrompt") {
				return "my replay prompt"
			}
			if (key === "thinkingCompactionPrompt") {
				return "my thinking prompt"
			}
			if (key === "keepRecentMessagesAtCompaction") {
				return 7
			}
			return undefined
		}) as unknown as (key: string) => boolean | undefined)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		// The only field that legitimately tracks Auto Compact.
		expect(config.compaction?.enabled).toBe(false)
		// The one that costs a model call when it goes missing.
		expect(config.compaction?.thinkingSummaryEnabled).toBe(false)
		expect(config.compaction?.strategy).toBeDefined()
		expect(config.compaction?.keepRecentMessages).toBe(7)
		expect(config.compaction?.summaryPrompt).toBe("my replay prompt")
		expect(config.compaction?.thinkingSummaryPrompt).toBe("my thinking prompt")
	})

	// The guard for the class, not the instance. This has now been fixed
	// narrowly three times -- 5ed673b5d (2026-08-08) hoisted the outer object
	// and declared "`enabled` is what turns compaction off, and it is the only
	// thing the runtime consults", then left the inner spread; ea9d75e41 moved
	// `councilEnabled` out and left five more. Enumerating today's fields would
	// only catch today's, so this asserts the invariant itself: turning Auto
	// Compact off changes `enabled` and nothing else. Any field put back inside
	// a conditional fails here, including one that does not exist yet.
	it("differs from the auto-condense-on config in `enabled` alone", async () => {
		const settings: Record<string, unknown> = {
			subagentsEnabled: false,
			thinkingCompactionEnabled: false,
			councilCompactionEnabled: false,
			compactionPrompt: "my replay prompt",
			fullCompactionPrompt: "my full prompt",
			thinkingCompactionPrompt: "my thinking prompt",
			compactionStrategy: "basic",
			keepRecentMessagesAtCompaction: 7,
			forceFullFromCompaction: 2,
		}
		const build = async (useAutoCondense: boolean) => {
			mocks.stateManager.getGlobalSettingsKey.mockImplementation(((key: string) =>
				key === "useAutoCondense" ? useAutoCondense : settings[key]) as never)
			const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
			return config.compaction as Record<string, unknown>
		}

		const on = await build(true)
		const off = await build(false)

		expect(on.enabled).toBe(true)
		expect(off.enabled).toBe(false)
		// Compared by key set and by value, so a field that vanishes and one
		// that quietly changes are both caught.
		const strip = (o: Record<string, unknown>) => {
			const { enabled: _enabled, ...rest } = o
			return rest
		}
		expect(strip(off)).toEqual(strip(on))
		// And the settings really were carried, rather than both being empty --
		// two objects that are equally blank would satisfy the comparison above.
		// `strategy` is not asserted by value here because it comes from the
		// global settings file rather than this mock; the comparison covers it,
		// since a conditional field would differ between the two builds.
		expect(off.strategy).toBeDefined()
		expect(off.summaryPrompt).toBe("my replay prompt")
		expect(off.councilEnabled).toBe(false)
		expect(off.thinkingSummaryEnabled).toBe(false)
	})

	it("lets task useAutoCondense override the global setting", async () => {
		let globalUseAutoCondense = true
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return globalUseAutoCondense
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		// Task `false` overrides global `true`.
		const disabledConfig = await buildSessionConfig({
			cwd: "/tmp/workspace",
			taskSettings: { useAutoCondense: false },
		})

		// Task `true` overrides global `false`.
		globalUseAutoCondense = false
		const enabledConfig = await buildSessionConfig({
			cwd: "/tmp/workspace",
			taskSettings: { useAutoCondense: true },
		})

		expect(disabledConfig.compaction?.enabled).toBe(false)
		expect(enabledConfig.compaction).toEqual({
			enabled: true,
			strategy: "agentic",
			keepRecentMessages: true,
			// The second compaction phase, on by default.
			thinkingSummaryEnabled: true,
			councilEnabled: true,
			cappedThinkingEnabled: true,
		})
	})

	// The toggle stored a value nothing read. Everything else was already built
	// -- agent files in `.cline/agents`, a tool per agent, a connection for them
	// and a slot gate to bound them -- and these two fields were written into the
	// session config as the literal `false`, so the settings page showed the
	// feature on and the model was never offered a subagent.
	it("offers no subagents while the toggle is off", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) =>
			key === "subagentsEnabled" ? false : undefined,
		)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.enableSpawnAgent).toBe(false)
		expect(config.enableAgentTeams).toBe(false)
	})

	// Both from one setting: a user who turns subagents on wants to delegate,
	// and which mechanism carries the delegation is not a choice they have any
	// way to make.
	it("offers subagents and teams once the toggle is on", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) =>
			key === "subagentsEnabled" ? true : undefined,
		)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.enableSpawnAgent).toBe(true)
		expect(config.enableAgentTeams).toBe(true)
	})

	// Never written is off. Delegation spends tokens on a second model, so it is
	// not something to start doing unasked.
	it("leaves subagents off when the setting has never been written", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation(() => undefined)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.enableSpawnAgent).toBe(false)
	})

	it("lets a task's own subagent setting override the global one", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) =>
			key === "subagentsEnabled" ? false : undefined,
		)

		const config = await buildSessionConfig({
			cwd: "/tmp/workspace",
			taskSettings: { subagentsEnabled: true },
		})

		expect(config.enableSpawnAgent).toBe(true)
	})

	it("emits the shared mode-tag instructions in both act and plan system prompts", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({} as any)

		const actConfig = await buildSessionConfig({ cwd: "/tmp/workspace", mode: "act" })
		const planConfig = await buildSessionConfig({ cwd: "/tmp/workspace", mode: "plan" })

		// The shared prompt builder now owns the mode semantics: the
		// <user_input mode> / <mode_notice> explanation goes to both modes, the
		// plan-mode contract (read-only run_commands included) only to plan.
		expect(actConfig.systemPrompt).toContain("# Plan / Act Modes")
		expect(actConfig.systemPrompt).toContain("<mode_notice>")
		expect(actConfig.systemPrompt).not.toContain("# Plan Mode\n")

		expect(planConfig.systemPrompt).toContain("# Plan / Act Modes")
		expect(planConfig.systemPrompt).toContain("# Plan Mode\n")
		expect(planConfig.systemPrompt).toContain(
			"run_commands tool remains available in plan mode strictly for read-only inspection",
		)
		expect(planConfig.systemPrompt).toContain("switch_to_act_mode")
	})

	// ---------------------------------------------------------------------
	// The escalation scope: a costlier model the session's own can hand a
	// stuck task to. The fourth configuration to need a snapshot of its own,
	// after Vision and Agents, and for the same reason -- `providers.json`
	// holds one entry per provider and the session's model owns it.
	// ---------------------------------------------------------------------

	const escalationSnapshot = (providerConfig?: Record<string, unknown>) =>
		JSON.stringify({
			global: {},
			mode: { apiProvider: "ollama", actModeOllamaModelId: "the-expert" },
			...(providerConfig ? { providerConfig } : {}),
		})

	// Off is off: no expert on the config means the tool is never offered and
	// no guard can hand over to one. That is every previous build's behaviour
	// and it has to survive the setting existing.
	it("carries no expert while the escalation toggle is off", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "escalationModelEnabled") {
				return false
			}
			if (key === "escalationModeApiConfiguration") {
				return escalationSnapshot() as never
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.escalation?.connection).toBeUndefined()
	})

	// The point of the tab. The expert is usually a larger model than the
	// session's, so it needs a window of its own as much as the agents model
	// needs a smaller one.
	it("resolves the expert from the escalation tab's own snapshot", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "ollama",
			ollamaApiOptionsCtxNum: "8192",
		} as never)
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "escalationModelEnabled") {
				return true
			}
			if (key === "escalationModeApiConfiguration") {
				return escalationSnapshot({ selectedModelId: "the-expert", contextWindow: 131_072 }) as never
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.escalation?.connection?.modelId).toBe("the-expert")
		expect(config.escalation?.connection?.providerConfig?.modelInfo?.contextWindow).toBe(131_072)
	})

	// The budgets and switches the Escalation tab edits. A stored value that
	// nobody reads back is the shape of bug this codebase keeps finding: the
	// panel writes it, the run uses a default, and nothing says so.
	it("carries the tab's budgets and switches onto the session", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "escalationModelEnabled") {
				return true
			}
			if (key === "escalationModeApiConfiguration") {
				return escalationSnapshot({ selectedModelId: "the-expert" }) as never
			}
			if (key === "escalationSettings") {
				return {
					requireApproval: true,
					closeAfterEscalation: true,
					maxEscalations: 2,
					maxFollowUps: 7,
				} as never
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.escalation?.requireApproval).toBe(true)
		expect(config.escalation?.closeAfterEscalation).toBe(true)
		expect(config.escalation?.maxEscalations).toBe(2)
		expect(config.escalation?.maxFollowUps).toBe(7)
	})

	// The same journey for the trigger's own numbers. These decide whether the
	// escalation path is entered at all, so a panel that writes them and a run
	// that ignores them would be the worst version of that bug: the feature
	// would be on, configured, and never fire.
	it("carries the tab's trigger thresholds onto the session", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "escalationModelEnabled") {
				return true
			}
			if (key === "escalationModeApiConfiguration") {
				return escalationSnapshot({ selectedModelId: "the-expert" }) as never
			}
			if (key === "escalationSettings") {
				return {
					struggleFailedCalls: 2,
					struggleDistressHits: 1,
					struggleWindow: 25,
					struggleMinIteration: 8,
					struggleMaxPerTask: 4,
				} as never
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.escalation?.struggleThresholds).toEqual({
			failedCalls: 2,
			distressHits: 1,
			window: 25,
			minIteration: 8,
			maxPerTask: 4,
		})
	})

	// An unset threshold must not travel as a field, because core reads a
	// present-but-zero number as a real setting on the way in and only the
	// absence means "your default".
	it("sends no thresholds when the tab holds none", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "escalationModelEnabled") {
				return true
			}
			if (key === "escalationModeApiConfiguration") {
				return escalationSnapshot({ selectedModelId: "the-expert" }) as never
			}
			if (key === "escalationSettings") {
				return { maxEscalations: 2, struggleWindow: 0 } as never
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.escalation?.struggleThresholds).toBeUndefined()
	})

	// `requireApproval` with nowhere to ask can only refuse, so the host that
	// has a window supplies the way to ask alongside the setting.
	it("gives the session somewhere to put the approval", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "escalationModelEnabled") {
				return true
			}
			if (key === "escalationModeApiConfiguration") {
				return escalationSnapshot({ selectedModelId: "the-expert" }) as never
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(typeof config.escalation?.approve).toBe("function")
	})

	// Enabled with nothing named is not the same as enabled: there is nothing
	// to call. Said in the log rather than left to be inferred from a failed
	// escalation, because a tab holding a provider and no model reads as
	// configured to anyone looking at it.
	it("carries no expert when the toggle is on but the tab names no model", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "escalationModelEnabled") {
				return true
			}
			if (key === "escalationModeApiConfiguration") {
				return JSON.stringify({ global: {}, mode: { apiProvider: "ollama" } }) as never
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.escalation?.connection).toBeUndefined()
		expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining("[Escalation]"))
	})
})

// ---------------------------------------------------------------------------
// createHistoryItemFromSession
// ---------------------------------------------------------------------------

describe("createHistoryItemFromSession", () => {
	it("creates a HistoryItem from session data", () => {
		const item = createHistoryItemFromSession(
			"session-abc",
			"Fix the bug in main.ts",
			"claude-sonnet-4-6",
			"/home/user/project",
		)

		expect(item.id).toBe("session-abc")
		expect(item.task).toBe("Fix the bug in main.ts")
		expect(item.modelId).toBe("claude-sonnet-4-6")
		expect(item.cwdOnTaskInitialization).toBe("/home/user/project")
		expect(item.tokensIn).toBe(0)
		expect(item.tokensOut).toBe(0)
		expect(item.totalCost).toBe(0)
		expect(item.ts).toBeGreaterThan(0)
	})

	it("handles missing optional fields", () => {
		const item = createHistoryItemFromSession("session-xyz", "Simple task")

		expect(item.modelId).toBeUndefined()
		expect(item.cwdOnTaskInitialization).toBeUndefined()
	})

	it("creates unique timestamps for different calls", () => {
		const item1 = createHistoryItemFromSession("s1", "Task 1")
		const item2 = createHistoryItemFromSession("s2", "Task 2")

		// Timestamps should be at least as large (may be same if called in same ms)
		expect(item2.ts).toBeGreaterThanOrEqual(item1.ts)
	})
})

// ---------------------------------------------------------------------------
// getHistoryItemById
// ---------------------------------------------------------------------------

describe("getHistoryItemById", () => {
	it("returns undefined when task is not found", () => {
		const result = getHistoryItemById("nonexistent", tempDir)
		expect(result).toBeUndefined()
	})

	it("finds a task by ID", () => {
		const history = [
			{ id: "task-1", ts: Date.now(), task: "First task", tokensIn: 0, tokensOut: 0, totalCost: 0 },
			{ id: "task-2", ts: Date.now(), task: "Second task", tokensIn: 0, tokensOut: 0, totalCost: 0 },
		]
		writeJson(path.join(tempDir, "state", "taskHistory.json"), history)

		const result = getHistoryItemById("task-2", tempDir)
		expect(result).toBeDefined()
		expect(result?.id).toBe("task-2")
		expect(result?.task).toBe("Second task")
	})

	it("returns undefined for empty history", () => {
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [])

		const result = getHistoryItemById("task-1", tempDir)
		expect(result).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// updateHistoryItem
// ---------------------------------------------------------------------------

describe("updateHistoryItem", () => {
	it("adds a new item to history", () => {
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [])

		const newItem: import("@shared/HistoryItem").HistoryItem = {
			id: "task-new",
			ts: Date.now(),
			task: "New task",
			tokensIn: 100,
			tokensOut: 50,
			totalCost: 0.01,
		}

		const result = updateHistoryItem(newItem, tempDir)
		expect(result).toHaveLength(1)
		expect(result[0].id).toBe("task-new")
	})

	it("updates an existing item in history", () => {
		const existingItem = {
			id: "task-1",
			ts: Date.now(),
			task: "Original task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [existingItem])

		const updatedItem = {
			...existingItem,
			tokensIn: 500,
			tokensOut: 250,
			totalCost: 0.05,
		}

		const result = updateHistoryItem(updatedItem, tempDir)
		expect(result).toHaveLength(1)
		expect(result[0].tokensIn).toBe(500)
		expect(result[0].totalCost).toBe(0.05)
	})

	it("prepends new items to the beginning of history", () => {
		const existingItem = {
			id: "task-old",
			ts: Date.now() - 1000,
			task: "Old task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [existingItem])

		const newItem = {
			id: "task-new",
			ts: Date.now(),
			task: "New task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}

		const result = updateHistoryItem(newItem, tempDir)
		expect(result).toHaveLength(2)
		expect(result[0].id).toBe("task-new")
		expect(result[1].id).toBe("task-old")
	})
})

describe("buildOutputBudgetSection", () => {
	it("states the cap the reply will actually be truncated at", () => {
		const section = buildOutputBudgetSection(8_000, 200_000)

		expect(section).toContain("capped at 8000 tokens, thinking included")
		expect(section).toContain("The context window is 200000 tokens.")
		// No reason to reserve headroom: the cap is a small share of the window.
		expect(section).not.toContain("leave the remaining")
	})

	it("hands back a safe share when the cap is effectively the whole window", () => {
		// The default 32,000 cap against a 32,768-token model: filling it leaves
		// nothing for the conversation and forces a compaction round trip.
		const section = buildOutputBudgetSection(32_000, 32_768)

		expect(section).toContain("effectively the whole 32768-token context window")
		expect(section).toContain("keep each reply under 24000 tokens")
		expect(section).toContain("leave the remaining 25% free for compaction")
	})

	it("still states the cap when the context window is unknown", () => {
		const section = buildOutputBudgetSection(32_000, undefined)

		expect(section).toContain("capped at 32000 tokens")
		expect(section).not.toContain("context window is")
		expect(section).toContain("Prefer several focused tool calls")
	})

	it("names the separate thinking allowance when the provider enforces one", () => {
		// Ollama caps thinking at a fraction of the response cap, server-side.
		// A model told only the outer number reads all of it as room to think
		// in, and spends the turn doing exactly that.
		//
		// The figure is whatever the server reported; this only pins that the
		// sentence carries it through unchanged.
		const budgetTokens = 4321
		const section = buildOutputBudgetSection(32_000, 128_000, { level: "medium", budgetTokens })

		expect(section).toContain(`at most ${budgetTokens} tokens may be spent thinking (effort medium)`)
		expect(section).toContain("reach a decision inside it")
	})

	it("says nothing about thinking for providers that do not cap it", () => {
		const section = buildOutputBudgetSection(32_000, 128_000)

		expect(section).not.toContain("may be spent thinking")
	})

	it("omits the allowance rather than printing a zero", () => {
		const section = buildOutputBudgetSection(32_000, 128_000, { level: "none", budgetTokens: 0 })

		expect(section).not.toContain("may be spent thinking")
	})
})

describe("resolveOllamaProviderConfig", () => {
	// The window Ollama is actually loaded with. `ollama ps` on a live box
	// reported CONTEXT 110000 while the system prompt was telling the model
	// 128000 — the prompt read the resolved model selection (catalog, state
	// hint or fallback), which never consults this setting. Both sides read
	// this resolver now, so they cannot drift.
	it("takes the context window from providers.json", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValueOnce({
			contextWindow: 110_000,
		} as never)

		const resolved = resolveOllamaProviderConfig({} as never, "v7-coder_tb:vision-iq4_nl")

		expect(resolved.modelInfo?.contextWindow).toBe(110_000)
	})

	it("surfaces a configured num_predict, which is the cap the server enforces", () => {
		// `num_predict` goes on the wire ahead of the session's own cap and wins,
		// so it is the number the reply is actually truncated at — and therefore
		// the only number the system prompt may state. Saying the fallback while
		// sending something smaller is the same defect as the context window.
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			contextWindow: 110_000,
			sampling: { numPredict: 20_000 },
		} as never)

		const resolved = resolveOllamaProviderConfig({} as never, "v7-coder_tb:vision-iq4_nl")

		expect(resolved.sampling?.numPredict).toBe(20_000)
		expect(resolved.modelInfo?.contextWindow).toBe(110_000)
	})

	it("falls back to the legacy field only when providers.json carries nothing", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined as never)

		const resolved = resolveOllamaProviderConfig({ ollamaApiOptionsCtxNum: "64000" } as never, "v7-coder_tb:vision-iq4_nl")

		expect(resolved.modelInfo?.contextWindow).toBe(64_000)
	})

	// The legacy field is one global value, so a scoped configuration reaching
	// for it is how the setting behaved as a global one. The Vision tab holds
	// its own settings: when it names no window, the answer is the vision
	// model's own `num_ctx` or the default — never the primary model's number.
	// 4.100.25 stopped the panel doing this and left the request doing it, so
	// the tab displayed the right value and loaded the wrong one.
	it("does not borrow the global legacy window for a scoped configuration", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined as never)

		const resolved = resolveOllamaProviderConfig(
			{ ollamaApiOptionsCtxNum: "64000" } as never,
			"v7-coder_tb:vision-iq4_nl",
			{},
		)

		expect(resolved.modelInfo?.contextWindow).not.toBe(64_000)
	})

	it("still takes a scoped window from the settings it was handed", () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined as never)

		const resolved = resolveOllamaProviderConfig({ ollamaApiOptionsCtxNum: "64000" } as never, "v7-coder_tb:vision-iq4_nl", {
			contextWindow: 8_192,
		})

		expect(resolved.modelInfo?.contextWindow).toBe(8_192)
	})
})

describe("buildDelegatedAgentConnection", () => {
	function snapshot(providerConfig?: Record<string, unknown>): string {
		return JSON.stringify({
			global: {},
			mode: { apiProvider: "ollama", actModeOllamaModelId: "small-agent" },
			...(providerConfig ? { providerConfig } : {}),
		})
	}

	beforeEach(() => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined)
	})

	// The whole point of the tab. `providers.json` holds one entry per provider
	// and the session's model owns it, so agents on that same provider had the
	// session's window and no way to have another. Their own snapshot is what
	// makes a fourth window possible.
	it("takes the agents' context window from their own snapshot", async () => {
		const connection = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama", ollamaApiOptionsCtxNum: "128000" } as never,
			snapshot({ selectedModelId: "small-agent", contextWindow: 8_192 }),
		)

		expect(connection?.modelId).toBe("small-agent")
		expect(connection?.providerConfig?.modelInfo?.contextWindow).toBe(8_192)
	})

	// `ollamaApiOptionsCtxNum` is one global value. A scoped configuration
	// reaching for it is exactly how the setting behaved as a global one, and it
	// would put the session's 128k on an agent model that cannot hold it.
	it("does not borrow the session's global window", async () => {
		const connection = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama", ollamaApiOptionsCtxNum: "128000" } as never,
			snapshot({ selectedModelId: "small-agent" }),
		)

		expect(connection?.modelId).toBe("small-agent")
		expect(connection?.providerConfig?.modelInfo?.contextWindow).not.toBe(128_000)
	})

	// pandorum, 2026-09-23: the Agents tab (opencoti) had thinking off and the
	// lead (ollama) had it on at `high`. The tab's reasoning never reached the
	// override, so every agent ran at the lead's 32,000-token budget.
	it("carries the tab's thinking, sampler and output cap, not the lead's", async () => {
		const off = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama" } as never,
			snapshot({
				selectedModelId: "small-agent",
				reasoning: { enabled: false, effort: "xhigh" },
				sampling: { temperature: 0.7, repeatPenalty: 1.15 },
				outputBudget: { mode: "auto" },
			}),
		)

		expect(off?.thinking).toBe(false)
		expect(off?.reasoningEffort).toBeUndefined()
		// Present and undefined: that is what overrides the lead's budget and cap.
		expect(off && "thinkingBudgetTokens" in off).toBe(true)
		expect(off?.thinkingBudgetTokens).toBeUndefined()
		expect(off && "maxTokensPerTurn" in off).toBe(true)
		expect(off?.maxTokensPerTurn).toBeUndefined()
		expect(off?.temperature).toBe(0.7)
		expect(off?.providerConfig?.sampling).toMatchObject({ temperature: 0.7, repeatPenalty: 1.15 })
		expect(off?.providerConfig?.thinking).toBe(false)

		const on = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama" } as never,
			snapshot({
				selectedModelId: "small-agent",
				reasoning: { enabled: true, effort: "medium" },
				outputBudget: { mode: "manual", maxTokens: 8_000 },
			}),
		)
		expect(on?.thinking).toBe(true)
		expect(on?.reasoningEffort).toBe("medium")
		expect(on?.maxTokensPerTurn).toBe(8_000)
	})

	// A tab that states none of them keeps the session's, as before.
	it("leaves thinking, temperature and the cap to the session when the tab says nothing", async () => {
		const connection = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama" } as never,
			snapshot({ selectedModelId: "small-agent" }),
		)
		for (const key of ["thinking", "reasoningEffort", "thinkingBudgetTokens", "maxTokensPerTurn", "temperature"]) {
			expect(connection && key in connection).toBe(false)
		}
	})

	// "Agent window", ruled 2026-09-25: an opencoti node's agents floor their
	// sessions at the tab's share (`num_ctx_min`), measured at the wire against
	// the node's window. Default 50%.
	it("gives an opencoti node's agents its window share", async () => {
		const opencoti = (providerConfig: Record<string, unknown>) =>
			JSON.stringify({ global: {}, mode: { apiProvider: "opencoti" }, providerConfig })
		const stored = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama" } as never,
			opencoti({ selectedModelId: "agent-model", contextWindow: 131_072, agentWindow: { sharePercent: 20 } }),
		)
		expect(stored?.providerConfig?.agentWindow).toEqual({ sharePercent: 20 })

		const unset = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama" } as never,
			opencoti({ selectedModelId: "agent-model" }),
		)
		expect(unset?.providerConfig?.agentWindow).toEqual({ sharePercent: 50 })

		// The expert resolves through the same builder and has no slider.
		const expert = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama" } as never,
			opencoti({ selectedModelId: "agent-model", agentWindow: { sharePercent: 20 } }),
			"Escalation",
		)
		expect(expert?.providerConfig?.agentWindow).toBeUndefined()
	})

	// Ollama has no negotiation: the node's window is what is sent, whatever
	// the slider says.
	it("sends an Ollama node's plain window and no share", async () => {
		const connection = await buildDelegatedAgentConnection(
			{ actModeApiProvider: "ollama" } as never,
			snapshot({ selectedModelId: "small-agent", contextWindow: 16_384, agentWindow: { sharePercent: 10 } }),
		)
		expect(connection?.providerConfig?.modelInfo?.contextWindow).toBe(16_384)
		expect(connection?.providerConfig?.agentWindow).toBeUndefined()
	})

	// Not configured is not the same as configured badly: agents keep inheriting
	// the session's connection, which is the behaviour every build has had.
	it.each([
		["nothing is stored", undefined],
		["the tab names no model", JSON.stringify({ global: {}, mode: { apiProvider: "ollama" } })],
		["the tab names no provider", JSON.stringify({ global: {}, mode: {} })],
	])("reports no connection when %s", async (_label, stored) => {
		expect(await buildDelegatedAgentConnection({ actModeApiProvider: "ollama" } as never, stored)).toBeUndefined()
	})

	// pandorum, 2026-09-25: Node1 on opencoti, 128000 typed into the tab, the
	// agents running at 256000. Only Ollama resolved a window here; every other
	// provider took the shared `models.json` catalog, whose entry for this
	// model id came from an old unscoped edit and leaks into every scope that
	// names the same model.
	describe("a window on a non-Ollama node", () => {
		function catalog() {
			mockNodeCatalog({ maxInputTokens: CATALOG_CONTEXT_WINDOW, maxTokens: 16_000 })
		}

		it.each(
			NODE_WINDOW_CASES.filter((c) => c.expected !== undefined).map((c) => [c.label, c] as const),
		)("takes the tab's %s over the models.json catalog", async (_label, windowCase) => {
			catalog()
			const connection = await buildDelegatedAgentConnection(
				{ actModeApiProvider: "ollama" } as never,
				opencotiNodeSnapshot(windowCase.providerConfig),
			)

			expect(connection?.modelId).toBe(NODE_MODEL_ID)
			expect(connection?.providerConfig?.modelInfo).toMatchObject({
				id: NODE_MODEL_ID,
				contextWindow: windowCase.expected,
				maxInputTokens: windowCase.expected,
			})
			// And the catalog copy the runtime reads first (`knownModels[modelId]`
			// wins over `modelInfo` in the orchestrator), with the rest of the
			// catalog's facts about the model kept.
			for (const known of [connection?.knownModels, connection?.providerConfig?.knownModels]) {
				expect(known?.[NODE_MODEL_ID]).toMatchObject({
					contextWindow: windowCase.expected,
					maxInputTokens: windowCase.expected,
					maxTokens: 16_000,
				})
			}
		})

		// A profile files its window among `modelOverrides`. Loaded into Node1
		// it is stored the way the tab reads it; a build before the mapping
		// stored it verbatim. Both have to reach the agents.
		it.each([
			["as a load now stores it", scopedProviderConfigFromProfile({ modelOverrides: { contextWindow: 65_536 } })],
			["as an older load stored it", { modelOverrides: { contextWindow: 65_536 } }],
		])("uses a loaded profile's modelOverrides window %s", async (_label, providerConfig) => {
			catalog()
			const connection = await buildDelegatedAgentConnection(
				{ actModeApiProvider: "ollama" } as never,
				opencotiNodeSnapshot({ ...providerConfig, selectedModelId: NODE_MODEL_ID }),
			)

			expect(connection?.providerConfig?.modelInfo?.contextWindow).toBe(65_536)
			expect(connection?.knownModels?.[NODE_MODEL_ID]?.contextWindow).toBe(65_536)
		})

		it("leaves the catalog's window in place when the tab names none", async () => {
			catalog()
			const connection = await buildDelegatedAgentConnection(
				{ actModeApiProvider: "ollama" } as never,
				opencotiNodeSnapshot({ selectedModelId: NODE_MODEL_ID }),
			)

			expect(connection?.providerConfig?.modelInfo).toBeUndefined()
			expect(connection?.knownModels?.[NODE_MODEL_ID]?.contextWindow).toBe(CATALOG_CONTEXT_WINDOW)
		})

		// The contract with the panel: what the Agents tab shows for a snapshot
		// is `scopedContextWindow` of its provider config (asserted on the
		// webview side over these same fixtures), so the connection must resolve
		// exactly that -- including "none", where both fall through.
		it.each(
			NODE_WINDOW_CASES.map((c) => [c.label, c] as const),
		)("resolves what the tab shows for %s", async (_label, windowCase) => {
			catalog()
			const snapshot = opencotiNodeSnapshot(windowCase.providerConfig)
			const connection = await buildDelegatedAgentConnection({ actModeApiProvider: "ollama" } as never, snapshot)
			const shown = scopedContextWindow(snapshotProviderSettings(snapshot))

			expect(shown).toBe(windowCase.expected)
			expect(connection?.knownModels?.[NODE_MODEL_ID]?.contextWindow).toBe(shown ?? CATALOG_CONTEXT_WINDOW)
		})
	})
})

describe("resolveThinkingAllowance", () => {
	beforeEach(() => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined)
		mocks.resolveOllamaThinkBudget.mockResolvedValue(undefined)
	})

	it("reports the budget the server resolved, never one derived here", async () => {
		// The whole point: Ollama computes the budget from its own table, so
		// whatever it answers is the number the model is held to. Nothing on
		// this side recomputes it, and a changed fraction upstream cannot make
		// the prompt state a bound that is not enforced.
		mocks.resolveOllamaThinkBudget.mockResolvedValue({ level: "medium", budgetTokens: 4321 })

		const allowance = await resolveThinkingAllowance(
			"ollama",
			{ reasoningEffort: "medium" },
			32_000,
			128_000,
			"http://localhost:11434",
			"v7-coder",
		)

		expect(allowance).toEqual({ level: "medium", budgetTokens: 4321 })
	})

	it("asks about the think value and options the session will actually send", async () => {
		await resolveThinkingAllowance(
			"ollama",
			{ reasoningEffort: "high" },
			8_000,
			128_000,
			"http://localhost:11434",
			"v7-coder",
		)

		expect(mocks.resolveOllamaThinkBudget).toHaveBeenCalledWith("http://localhost:11434", "v7-coder", {
			think: "high",
			numPredict: 8_000,
			numCtx: 128_000,
		})
	})

	// opencoti and any other llama.cpp server take `reasoning_budget_tokens`, an
	// absolute count, and this fork already sends it. What it did not do is tell
	// the *session* what it sent: both this resolver and the budget-message read
	// were gated on `providerId === "ollama"`, so on opencoti the system prompt
	// stated no thinking bound and the discarded-turn retrospective had no
	// budget message to recognise a capped think by. The budget went out on the
	// wire and nothing on this side knew it existed.
	it("resolves a llama.cpp budget here, since that server resolves none", async () => {
		// No server round trip: llama.cpp has no effort levels and no endpoint
		// that would answer for one, so the level is resolved against the same
		// table Ollama uses -- `medium` is a quarter of the window.
		const allowance = await resolveThinkingAllowance(
			"opencoti",
			{ reasoningEffort: "medium" },
			8_000,
			128_000,
			"http://localhost:8080/v1",
			"lfm2.5-2.6b",
		)

		expect(allowance).toEqual({ level: "medium", budgetTokens: 2_000 })
		expect(mocks.resolveOllamaThinkBudget).not.toHaveBeenCalled()
	})

	it("takes the llama.cpp share of the output cap, not of the context", async () => {
		// A share of the context can exceed the output cap and then bounds
		// nothing: the model thinks for the whole reply and stops with no answer.
		const allowance = await resolveThinkingAllowance(
			"opencoti",
			{ reasoningEffort: "high" },
			4_000,
			262_144,
			"http://localhost:8080/v1",
			"lfm2.5-2.6b",
		)

		expect(allowance).toEqual({ level: "high", budgetTokens: 2_000 })
	})

	it("says nothing for a provider with no thinking budget at all", async () => {
		expect(
			await resolveThinkingAllowance("anthropic", { reasoningEffort: "medium" }, 8_000, 128_000, undefined, "claude"),
		).toBeUndefined()
	})

	it("asks about the level the vendor will fill in when none is set", async () => {
		// Asking about "no level" would answer for a request this session never
		// makes: the Ollama vendor supplies its default when reasoning is unset.
		await resolveThinkingAllowance("ollama", {}, 8_000, 128_000, "http://localhost:11434", "v7-coder")

		expect(mocks.resolveOllamaThinkBudget).toHaveBeenCalledWith(
			"http://localhost:11434",
			"v7-coder",
			expect.objectContaining({ think: OLLAMA_DEFAULT_REASONING_EFFORT }),
		)
	})

	it("prefers a configured num_predict as the cap the server will apply", async () => {
		mocks.providerSettingsManager.getProviderSettings.mockReturnValue({
			sampling: { numPredict: 4_000 },
		} as never)

		await resolveThinkingAllowance(
			"ollama",
			{ reasoningEffort: "medium" },
			32_000,
			128_000,
			"http://localhost:11434",
			"v7-coder",
		)

		expect(mocks.resolveOllamaThinkBudget).toHaveBeenCalledWith(
			"http://localhost:11434",
			"v7-coder",
			expect.objectContaining({ numPredict: 4_000 }),
		)
	})

	it("says nothing when the server reports no budget", async () => {
		// An older Ollama, or a model with no bound at all. Silence beats a
		// guess, because the guess would go into the system prompt as fact.
		mocks.resolveOllamaThinkBudget.mockResolvedValue(undefined)

		await expect(
			resolveThinkingAllowance("ollama", { reasoningEffort: "medium" }, 32_000, 128_000, undefined, "v7-coder"),
		).resolves.toBeUndefined()
	})

	it("never asks for providers that do not enforce a thinking cap", async () => {
		await expect(
			resolveThinkingAllowance("anthropic", { reasoningEffort: "medium" }, 32_000, 128_000, undefined, "claude"),
		).resolves.toBeUndefined()
		expect(mocks.resolveOllamaThinkBudget).not.toHaveBeenCalled()
	})

	it("never asks when thinking is switched off", async () => {
		await expect(
			resolveThinkingAllowance("ollama", { thinking: false }, 32_000, 128_000, undefined, "v7-coder"),
		).resolves.toBeUndefined()
		expect(mocks.resolveOllamaThinkBudget).not.toHaveBeenCalled()
	})

	it("never asks without a model to ask about", async () => {
		await expect(
			resolveThinkingAllowance("ollama", { reasoningEffort: "medium" }, 32_000, 128_000, undefined, undefined),
		).resolves.toBeUndefined()
		expect(mocks.resolveOllamaThinkBudget).not.toHaveBeenCalled()
	})
})

describe("composeSessionHooks", () => {
	// The editor-diagnostics layer is the reason this function exists: it is the
	// only hook that reports a broken edit back to the model, and it is easy to
	// lose because losing it is silent — the model simply carries on against a
	// file that does not parse.
	it("layers the editor diagnostics hooks on top of the file hooks", async () => {
		const beforeTool = vi.fn(async () => undefined)
		const hooks = composeSessionHooks({ beforeTool }, "/workspace")

		expect(hooks?.beforeTool).toBeDefined()
		expect(hooks?.afterTool).toBeDefined()

		// Both layers run, and the caller's own layer is not displaced by the one
		// added here.
		await hooks?.beforeTool?.({ toolCall: { toolName: "read_files", toolCallId: "1" }, input: {} } as never)
		expect(beforeTool).toHaveBeenCalledOnce()
	})

	it("still supplies the diagnostics hooks when there are no file hooks", () => {
		const hooks = composeSessionHooks(undefined, "/workspace")

		expect(hooks?.beforeTool).toBeDefined()
		expect(hooks?.afterTool).toBeDefined()
	})
})

describe("resolveCompactionPrompt", () => {
	it("takes the matched template's section over the Features setting", () => {
		expect(resolveCompactionPrompt({ "council-critic": " from template " }, "council-critic", "from setting")).toBe(
			"from template",
		)
	})

	it("falls back to the setting where the template has no section, or a blank one", () => {
		expect(resolveCompactionPrompt({ replay: "   " }, "replay", " from setting ")).toBe("from setting")
		expect(resolveCompactionPrompt({ replay: "tpl" }, "full", "from setting")).toBe("from setting")
	})

	// "" is what leaves the config key unset, which is what makes core use its
	// built-in prompt.
	it("is empty when neither says anything", () => {
		expect(resolveCompactionPrompt({}, "council-writer", "")).toBe("")
	})
})
