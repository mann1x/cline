import { describe, expect, it } from "vitest";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
} from "./delegated-agent";

function provider(
	pinned?: Parameters<typeof createDelegatedAgentConfigProvider>[1],
) {
	return createDelegatedAgentConfigProvider(
		{
			providerId: "ollama",
			modelId: "small",
			apiKey: "",
			baseUrl: "http://localhost:11434",
			providerConfig: { contextWindow: 8_192 },
			temperature: 0.2,
		},
		pinned,
	);
}

describe("createDelegatedAgentConfigProvider", () => {
	it("follows the session when nothing is pinned", () => {
		const config = provider();
		config.updateConnectionDefaults({ modelId: "large", apiKey: "refreshed" });
		expect(config.getConnectionConfig()).toMatchObject({
			modelId: "large",
			apiKey: "refreshed",
		});
	});

	// The agents have a connection of their own, and the host still pushes the
	// session's model at them on a mid-run switch. Taking that push would put
	// them back on the lead's model with the lead's context window, which is the
	// one window between four scopes that having their own configuration exists
	// to end.
	it("holds the fields the agents were given", () => {
		const config = provider(["modelId", "providerConfig"]);
		config.updateConnectionDefaults({
			modelId: "large",
			providerConfig: { contextWindow: 262_144 },
		});
		expect(config.getConnectionConfig()).toMatchObject({
			modelId: "small",
			providerConfig: { contextWindow: 8_192 },
		});
	});

	// Only the pinned fields. A refreshed key for a provider the agents do share
	// with the session still has to reach them, or an expired token ends their
	// runs with a raw 401.
	it("still takes what the override did not name", () => {
		const config = provider(["modelId"]);
		config.updateConnectionDefaults({
			modelId: "large",
			apiKey: "refreshed",
			baseUrl: "http://elsewhere:11434",
		});
		expect(config.getConnectionConfig()).toMatchObject({
			modelId: "small",
			apiKey: "refreshed",
			baseUrl: "http://elsewhere:11434",
		});
	});
});

describe("buildDelegatedAgentConfig", () => {
	it("inherits the parent distinctId and sessionId for telemetry grouping", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			distinctId: "user-123",
			sessionId: "sess-parent",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
			parentAgentId: "agent-lead",
		});

		expect(config.distinctId).toBe("user-123");
		expect(config.sessionId).toBe("sess-parent");
		expect(config.parentAgentId).toBe("agent-lead");
	});

	it("leaves identity fields undefined when the parent has none", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.distinctId).toBeUndefined();
		expect(config.sessionId).toBeUndefined();
	});
});
