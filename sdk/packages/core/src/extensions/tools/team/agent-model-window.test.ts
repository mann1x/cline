import {
	forgetDeclaredModelInfo,
	OLLAMA_DEFAULT_CONTEXT_WINDOW,
} from "@cline/llms";
import { beforeEach, describe, expect, it } from "vitest";
import {
	primeAgentModelWindow,
	withAgentModelWindow,
} from "./agent-model-window";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
} from "./delegated-agent";

const BASE = "http://192.168.1.100:11434";
const SESSION_MODEL = "deepseek-v4.1-flash:cloud";
const AGENT_MODEL = "mannix/bonsai-2-27b:mtp-vision-ptq1_0";

/** The session's connection as mann1x/cline#118 had it: a window for its own model only. */
const session = (modelId: string) => ({
	providerId: "ollama",
	modelId,
	baseUrl: BASE,
	knownModels: {},
	providerConfig: {
		providerId: "ollama",
		modelId,
		baseUrl: BASE,
		knownModels: {
			[SESSION_MODEL]: { id: SESSION_MODEL, contextWindow: 1_048_576 },
		},
	},
});

const showing = (parameters: string) =>
	(async () =>
		new Response(
			JSON.stringify({ parameters, details: { family: "qwen35" } }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		)) as unknown as typeof fetch;

const windowOf = (connection: ReturnType<typeof session>, id: string) => ({
	top: (connection.knownModels as Record<string, { contextWindow?: number }>)[
		id
	]?.contextWindow,
	provider: (
		connection.providerConfig.knownModels as Record<
			string,
			{ contextWindow?: number }
		>
	)[id]?.contextWindow,
});

describe("an agent on a model the session does not run", () => {
	beforeEach(() => forgetDeclaredModelInfo());

	it("gets the window its requests are sent with: Ollama's default when the model declares none", () => {
		const connection = withAgentModelWindow(session(AGENT_MODEL));
		expect(windowOf(connection, AGENT_MODEL)).toEqual({
			top: OLLAMA_DEFAULT_CONTEXT_WINDOW,
			provider: OLLAMA_DEFAULT_CONTEXT_WINDOW,
		});
		// The session's own entry is kept as it was.
		expect(windowOf(connection, SESSION_MODEL).provider).toBe(1_048_576);
	});

	it("gets the window the model declares once /api/show was read", async () => {
		const raw = session(AGENT_MODEL);
		await primeAgentModelWindow(raw, showing("num_ctx 65536\ntemperature 0.6"));
		expect(windowOf(withAgentModelWindow(raw), AGENT_MODEL).top).toBe(65_536);
	});

	it("leaves the session's model alone: its window is already stated", () => {
		const raw = session(SESSION_MODEL);
		expect(withAgentModelWindow(raw)).toBe(raw);
	});

	it("leaves other providers alone", () => {
		const raw = { ...session(AGENT_MODEL), providerId: "anthropic" };
		expect(withAgentModelWindow(raw)).toBe(raw);
	});

	it("does not read /api/show for a model whose window is stated", async () => {
		let asked = 0;
		const counting = (async () => {
			asked++;
			return new Response("{}");
		}) as unknown as typeof fetch;
		await primeAgentModelWindow(session(SESSION_MODEL), counting);
		expect(asked).toBe(0);
	});

	it("reaches the agent's config through the build funnel", () => {
		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "deploy it",
			tools: [],
			configProvider: createDelegatedAgentConfigProvider(session(AGENT_MODEL)),
		});
		expect(config.knownModels?.[AGENT_MODEL]?.contextWindow).toBe(
			OLLAMA_DEFAULT_CONTEXT_WINDOW,
		);
	});
});
