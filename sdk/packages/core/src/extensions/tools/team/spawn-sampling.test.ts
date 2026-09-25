import type { AgentConfig } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createAgentModelFromConfig } from "../../../services/llms/handler-factory";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
	type DelegatedAgentRuntimeConfig,
} from "./delegated-agent";
import { expandAgentCounts, toSwarmInput } from "./spawn-agent-tool";
import { applySpawnSampling, type SpawnSampling } from "./spawn-sampling";
import { workerSampling } from "./spawn-swarm-tool";

/**
 * The request body a delegated agent built with `sampling` actually sends.
 *
 * Driven through the real handler factory and gateway with a stubbed fetch,
 * so what is asserted is the wire, not a config field that might never reach
 * it -- the sampler has been lost between the two before.
 */
async function wireBody(
	runtime: DelegatedAgentRuntimeConfig,
	sampling?: SpawnSampling,
	provider = createDelegatedAgentConfigProvider(runtime),
): Promise<Record<string, unknown>> {
	const bodies: Record<string, unknown>[] = [];
	const fetchStub = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : String(input);
		if (url.includes("/api/chat")) {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(
				`${JSON.stringify({ model: "m", created_at: "2024-01-01T00:00:00Z", done: true, done_reason: "stop", message: { role: "assistant", content: "ok" }, prompt_eval_count: 1, eval_count: 1 })}\n`,
				{ status: 200, headers: { "content-type": "application/x-ndjson" } },
			);
		}
		if (url.includes("/api/")) {
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("/chat/completions")) {
			bodies.push(JSON.parse(String(init?.body)));
		}
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof fetch;
	const config = buildDelegatedAgentConfig({
		kind: "subagent",
		prompt: "p",
		tools: [],
		configProvider: provider,
		...(sampling ? { sampling } : {}),
	});
	const model = createAgentModelFromConfig(
		{
			...config,
			providerConfig: {
				...(config.providerConfig as Record<string, unknown>),
				fetch: fetchStub,
			} as AgentConfig["providerConfig"],
		} as AgentConfig,
		undefined,
	);
	const stream = await model.stream({
		systemPrompt: "s",
		messages: [
			{
				id: "m1",
				role: "user",
				content: [{ type: "text", text: "hi" }],
				createdAt: 0,
			},
		],
		tools: [],
	});
	try {
		for await (const _event of stream) {
			// drain
		}
	} catch {
		// An empty stream may end in an error; only the request matters.
	}
	expect(bodies).toHaveLength(1);
	return bodies[0] as Record<string, unknown>;
}

const LLAMACPP: DelegatedAgentRuntimeConfig = {
	providerId: "openai-compatible",
	modelId: "local-model",
	apiKey: "k",
	baseUrl: "http://127.0.0.1:9/v1",
	providerConfig: {
		providerId: "openai-compatible",
		modelId: "local-model",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "k",
	} as AgentConfig["providerConfig"],
};

describe("a spawn's temperature and seed", () => {
	it("reach the provider's request body", async () => {
		const body = await wireBody(LLAMACPP, { temperature: 0.3, seed: 42 });
		expect(body.temperature).toBe(0.3);
		expect(body.seed).toBe(42);
	});

	it("reach an Ollama request's options", async () => {
		const ollama: DelegatedAgentRuntimeConfig = {
			providerId: "ollama",
			modelId: "local-model",
			baseUrl: "http://127.0.0.1:9",
			providerConfig: {
				providerId: "ollama",
				modelId: "local-model",
				baseUrl: "http://127.0.0.1:9",
				sampling: { topK: 20 },
			} as AgentConfig["providerConfig"],
		};
		const options = (await wireBody(ollama, { temperature: 0.3, seed: 42 }))
			.options as Record<string, unknown>;
		expect(options).toMatchObject({ temperature: 0.3, seed: 42, top_k: 20 });
		const untouched = (await wireBody(ollama)).options as Record<
			string,
			unknown
		>;
		expect(untouched).not.toHaveProperty("seed");
		expect(untouched).not.toHaveProperty("temperature");
	});

	it("leave the body untouched when the spawn names neither", async () => {
		const body = await wireBody(LLAMACPP);
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("seed");
	});

	it("keep the connection's sampler when the spawn names none", async () => {
		const body = await wireBody({
			...LLAMACPP,
			providerConfig: {
				...(LLAMACPP.providerConfig as Record<string, unknown>),
				sampling: { temperature: 0.6, topK: 20 },
			} as AgentConfig["providerConfig"],
		});
		expect(body.temperature).toBe(0.6);
		expect(body.top_k).toBe(20);
		expect(body).not.toHaveProperty("seed");
	});

	it("win over a profile's sampler, keeping the fields the spawn did not name", async () => {
		const body = await wireBody(
			{
				...LLAMACPP,
				temperature: 0.9,
				providerConfig: {
					...(LLAMACPP.providerConfig as Record<string, unknown>),
					sampling: { temperature: 0.6, topK: 20, seed: 1 },
				} as AgentConfig["providerConfig"],
			},
			{ temperature: 0.1, seed: 5 },
		);
		expect(body.temperature).toBe(0.1);
		expect(body.seed).toBe(5);
		expect(body.top_k).toBe(20);
	});

	it("survive the session pushing its connection defaults", async () => {
		const provider = createDelegatedAgentConfigProvider(LLAMACPP);
		provider.updateConnectionDefaults({
			temperature: 0.8,
			providerConfig: {
				...(LLAMACPP.providerConfig as Record<string, unknown>),
				sampling: { temperature: 0.8, seed: 99 },
			} as AgentConfig["providerConfig"],
		});
		const body = await wireBody(
			LLAMACPP,
			{ temperature: 0.2, seed: 3 },
			provider,
		);
		expect(body.temperature).toBe(0.2);
		expect(body.seed).toBe(3);
	});

	it("survive a node placement that clears the connection's temperature", async () => {
		// The priority-0 node sets `temperature: undefined` so the lead's own
		// applies; the spawn's value is not the connection's and must stay.
		const node = createDelegatedAgentConfigProvider({
			...LLAMACPP,
			temperature: undefined,
		});
		const body = await wireBody(LLAMACPP, { temperature: 0.4, seed: 11 }, node);
		expect(body.temperature).toBe(0.4);
		expect(body.seed).toBe(11);
	});
});

describe("applySpawnSampling", () => {
	it("returns the very config it was given when there is no sampler", () => {
		const config = { providerId: "x", modelId: "y" } as AgentConfig;
		expect(applySpawnSampling(config, undefined)).toBe(config);
		expect(applySpawnSampling(config, {})).toBe(config);
	});
});

describe("seed offsets for several agents", () => {
	it("gives a batch entry with count 3 and seed 7 the seeds 7, 8, 9", () => {
		const expanded = expandAgentCounts([
			{ name: "probe", task: "t", count: 3, seed: 7, temperature: 0.5 },
		]);
		expect(expanded.map((member) => member.seed)).toEqual([7, 8, 9]);
		expect(expanded.map((member) => member.temperature)).toEqual([
			0.5, 0.5, 0.5,
		]);
	});

	it("adds no seed to copies of an entry that named none", () => {
		const expanded = expandAgentCounts([{ task: "t", count: 2 }]);
		expect(expanded.every((member) => !("seed" in member))).toBe(true);
	});

	it("offsets a swarm's seed per worker, and uses a task's own as given", () => {
		expect(workerSampling({ seed: 10, temperature: 0.2 }, 0)).toEqual({
			seed: 10,
			temperature: 0.2,
		});
		expect(workerSampling({ seed: 10 }, 2)).toEqual({ seed: 12 });
		expect(workerSampling({ seed: 10 }, 2, { seed: 4 })).toEqual({ seed: 4 });
		expect(workerSampling({}, 3)).toBeUndefined();
	});

	it("carries a merged spawn's sampler to the swarm, per task and per call", () => {
		const swarm = toSwarmInput({
			temperature: 0.3,
			seed: 1,
			agents: expandAgentCounts([
				{ name: "a", task: "x", count: 2, seed: 50 },
				{ name: "b", task: "y" },
			]),
		});
		expect(swarm).toMatchObject({ temperature: 0.3, seed: 1 });
		const tasks = swarm.tasks as Array<Record<string, unknown>>;
		expect(tasks.map((task) => task.seed)).toEqual([50, 51, undefined]);
		expect(toSwarmInput({ task: "t" })).not.toHaveProperty("seed");
	});
});
