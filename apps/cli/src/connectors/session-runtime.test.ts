import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetLastUsedProviderSettings,
	mockGetProviderSettings,
	mockResolveSystemPrompt,
	mockGetProviderCollection,
	mockGetBooleanFlagEnabled,
} = vi.hoisted(() => ({
	mockGetLastUsedProviderSettings: vi.fn(),
	mockGetProviderSettings: vi.fn(),
	mockResolveSystemPrompt: vi.fn(),
	mockGetProviderCollection: vi.fn(),
	mockGetBooleanFlagEnabled: vi.fn(),
}));

vi.mock("@cline/core", async () => {
	const actual =
		await vi.importActual<typeof import("@cline/core")>("@cline/core");
	return {
		...actual,
		ProviderSettingsManager: class {
			getLastUsedProviderSettings(options?: unknown) {
				return mockGetLastUsedProviderSettings(options);
			}

			getProviderSettings(providerId: string) {
				return mockGetProviderSettings(providerId);
			}
		},
		CoreSessionService: class {},
		SqliteSessionStore: class {},
		Llms: {
			...actual.Llms,
			getProviderCollection: mockGetProviderCollection,
		},
	};
});

vi.mock("../runtime/prompt", () => ({
	resolveSystemPrompt: mockResolveSystemPrompt,
}));

vi.mock("../utils/helpers", () => ({
	resolveWorkspaceRoot: vi.fn((cwd: string) => cwd),
}));

vi.mock("../utils/feature-flags", () => ({
	getCliFeatureFlagsService: () => ({
		getBooleanFlagEnabled: mockGetBooleanFlagEnabled,
	}),
}));

vi.mock("../commands/auth", async () => {
	const actual =
		await vi.importActual<typeof import("../commands/auth")>(
			"../commands/auth",
		);
	return {
		...actual,
		ensureOAuthProviderApiKey: vi.fn(),
	};
});

import {
	buildConnectorStartRequest,
	buildThreadStartRequest,
	isReusableConnectorSession,
} from "./session-runtime";

describe("buildConnectorStartRequest", () => {
	beforeEach(() => {
		mockGetBooleanFlagEnabled.mockReturnValue(false);
	});

	afterEach(() => {
		vi.clearAllMocks();
		delete process.env.OPENROUTER_API_KEY;
	});

	it("falls back to provider env vars when persisted settings have no api key", async () => {
		mockGetLastUsedProviderSettings.mockReturnValue({ provider: "openrouter" });
		mockGetProviderSettings.mockReturnValue({
			provider: "openrouter",
			model: "anthropic/claude-sonnet-4.6",
		});
		mockGetProviderCollection.mockReturnValue({
			provider: { env: ["OPENROUTER_API_KEY"] },
		});
		mockResolveSystemPrompt.mockResolvedValue("system");
		process.env.OPENROUTER_API_KEY = "env-openrouter-key";

		const request = await buildConnectorStartRequest({
			options: {
				cwd: "/tmp/work",
				mode: "act",
				enableTools: false,
			},
			io: { writeln: vi.fn(), writeErr: vi.fn() },
			loggerConfig: { enabled: false, level: "info", destination: "stdout" },
			systemRules: "Rules",
		});

		expect(request.provider).toBe("openrouter");
		expect(request.apiKey).toBe("env-openrouter-key");
		expect(request.model).toBe("anthropic/claude-sonnet-4.6");
		expect(mockGetLastUsedProviderSettings).toHaveBeenCalledWith({
			isClinePassEnabled: true,
		});
	});

	it("uses auth material resolved by provider settings manager", async () => {
		mockGetLastUsedProviderSettings.mockReturnValue({ provider: "cline-pass" });
		mockGetProviderSettings.mockReturnValue({
			provider: "cline-pass",
			auth: { accessToken: "workos:resolved-token" },
		});
		mockGetProviderCollection.mockReturnValue({
			provider: { env: ["CLINE_API_KEY"] },
		});
		mockResolveSystemPrompt.mockResolvedValue("system");

		const request = await buildConnectorStartRequest({
			options: {
				cwd: "/tmp/work",
				mode: "act",
				enableTools: false,
			},
			io: { writeln: vi.fn(), writeErr: vi.fn() },
			loggerConfig: { enabled: false, level: "info", destination: "stdout" },
			systemRules: "Rules",
			defaultModel: "cline-pass/glm-5.2",
		});

		expect(request.provider).toBe("cline-pass");
		expect(request.apiKey).toBe("workos:resolved-token");
		expect(request.model).toBe("cline-pass/glm-5.2");
	});

	it("uses auth material resolved by provider settings manager", async () => {
		mockGetLastUsedProviderSettings.mockReturnValue({ provider: "cline-pass" });
		mockGetProviderSettings.mockReturnValue({
			provider: "cline-pass",
			auth: { accessToken: "workos:resolved-token" },
		});
		mockGetProviderCollection.mockReturnValue({
			provider: { env: ["CLINE_API_KEY"] },
		});
		mockResolveSystemPrompt.mockResolvedValue("system");

		const request = await buildConnectorStartRequest({
			options: {
				cwd: "/tmp/work",
				mode: "act",
				enableTools: false,
			},
			io: { writeln: vi.fn(), writeErr: vi.fn() },
			loggerConfig: { enabled: false, level: "info", destination: "stdout" },
			systemRules: "Rules",
			defaultModel: "cline-pass/glm-5.2",
		});

		expect(request.provider).toBe("cline-pass");
		expect(request.apiKey).toBe("workos:resolved-token");
		expect(request.model).toBe("cline-pass/glm-5.2");
	});
});

describe("isReusableConnectorSession", () => {
	it("rejects missing and terminal sessions", () => {
		expect(isReusableConnectorSession(undefined)).toBe(false);
		expect(isReusableConnectorSession({ sessionId: "" })).toBe(false);
		expect(
			isReusableConnectorSession({ sessionId: "s1", status: "completed" }),
		).toBe(false);
		expect(
			isReusableConnectorSession({ sessionId: "s1", status: "failed" }),
		).toBe(false);
		expect(
			isReusableConnectorSession({ sessionId: "s1", status: "aborted" }),
		).toBe(false);
		expect(
			isReusableConnectorSession({ sessionId: "s1", status: "cancelled" }),
		).toBe(false);
	});

	it("accepts live and status-omitted sessions", () => {
		expect(
			isReusableConnectorSession({ sessionId: "s1", status: "running" }),
		).toBe(true);
		expect(
			isReusableConnectorSession({ sessionId: "s1", status: "idle" }),
		).toBe(true);
		expect(isReusableConnectorSession({ sessionId: "s1" })).toBe(true);
	});
});

// A connector (Slack and the others) got the team tools whenever it had
// tools at all: eighteen of them, ~2.9k tokens a request, unasked.
describe("buildThreadStartRequest", () => {
	const base = {
		workspaceRoot: "/w",
		cwd: "/w",
		provider: "anthropic",
		model: "m",
		enableTools: true,
	} as Parameters<typeof buildThreadStartRequest>[0];

	it("leaves the teammates off with tools on, unless the start request asks", () => {
		expect(buildThreadStartRequest(base, {}).enableTeams).toBe(false);
		expect(buildThreadStartRequest(base, {}).enableSpawn).toBe(true);
		expect(
			buildThreadStartRequest({ ...base, enableTeams: true }, {}).enableTeams,
		).toBe(true);
		expect(
			buildThreadStartRequest(
				{ ...base, enableTeams: true },
				{ enableTools: false },
			).enableTeams,
		).toBe(false);
	});

	it("CLINE_TEAMMATES=1 on the connector process opts its threads in", async () => {
		mockGetLastUsedProviderSettings.mockReturnValue({ provider: "anthropic" });
		mockGetProviderSettings.mockReturnValue({ provider: "anthropic" });
		mockGetProviderCollection.mockReturnValue({ provider: { env: [] } });
		mockResolveSystemPrompt.mockResolvedValue("system");
		const start = () =>
			buildConnectorStartRequest({
				options: { cwd: "/w", mode: "act", enableTools: true, apiKey: "k" },
				io: { writeln: vi.fn(), writeErr: vi.fn() },
				loggerConfig: { enabled: false, level: "info", destination: "stdout" },
				systemRules: "Rules",
			});
		const previous = process.env.CLINE_TEAMMATES;
		try {
			delete process.env.CLINE_TEAMMATES;
			expect(buildThreadStartRequest(await start(), {}).enableTeams).toBe(
				false,
			);
			process.env.CLINE_TEAMMATES = "1";
			expect(buildThreadStartRequest(await start(), {}).enableTeams).toBe(
				true,
			);
		} finally {
			if (previous === undefined) delete process.env.CLINE_TEAMMATES;
			else process.env.CLINE_TEAMMATES = previous;
		}
	});
});
