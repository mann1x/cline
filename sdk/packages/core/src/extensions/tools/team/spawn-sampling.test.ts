import type { AgentConfig } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createAgentModelFromConfig } from "../../../services/llms/handler-factory";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
	type DelegatedAgentRuntimeConfig,
} from "./delegated-agent";
import { expandAgentCounts, toSwarmInput } from "./spawn-agent-tool";
import {
	applySpawnSampling,
	DEFAULT_TEMPERATURE_RANGE_PERCENT,
	describeRealizedSampling,
	drawSpawnSampling,
	modelTemperatureOf,
	primeModelTemperature,
	RANDOM_SEED_LIMIT,
	type RealizedSpawnSampling,
	readSpawnSampling,
	realizeSpawnSampling,
	type SpawnSamplingDraw,
	samplingForCopy,
	UNKNOWN_MODEL_TEMPERATURE_NOTE,
} from "./spawn-sampling";
import { workerSampling } from "./spawn-swarm-tool";
import { reportSubagentSampling } from "./subagent-progress";

/**
 * The request body a delegated agent built with `sampling` actually sends.
 *
 * Driven through the real handler factory and gateway with a stubbed fetch,
 * so what is asserted is the wire, not a config field that might never reach
 * it -- the sampler has been lost between the two before.
 */
async function wireBody(
	runtime: DelegatedAgentRuntimeConfig,
	sampling?: SpawnSamplingDraw,
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

/** A deterministic uniform source: the same sequence every run. */
function seededRandom(seed = 1): () => number {
	let state = seed >>> 0;
	return () => {
		// mulberry32
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Build one agent from `request` on `runtime`; what it realized and applied. */
function buildWith(
	runtime: DelegatedAgentRuntimeConfig,
	request: Record<string, unknown>,
	random: () => number,
): { realized?: RealizedSpawnSampling; config: AgentConfig } {
	let realized: RealizedSpawnSampling | undefined;
	const config = buildDelegatedAgentConfig({
		kind: "subagent",
		prompt: "p",
		tools: [],
		configProvider: createDelegatedAgentConfigProvider(runtime),
		sampling: drawSpawnSampling(readSpawnSampling(request), random),
		onSampling: (value) => {
			realized = value;
		},
	});
	return { realized, config };
}

const WITH_MODEL_TEMPERATURE: DelegatedAgentRuntimeConfig = {
	...LLAMACPP,
	providerConfig: {
		...(LLAMACPP.providerConfig as Record<string, unknown>),
		sampling: { temperature: 0.7, topK: 20 },
	} as AgentConfig["providerConfig"],
};

describe("reading the random keyword and the range", () => {
	it("reads the keyword in any case, and numbers from strings", () => {
		expect(
			readSpawnSampling({ seed: "Random", temperature: "RANDOM" }),
		).toEqual({ seed: "random", temperature: "random" });
		expect(readSpawnSampling({ seed: " random ", temperature: "0.7" })).toEqual(
			{
				seed: "random",
				temperature: 0.7,
			},
		);
	});

	it("reads a range as a percent, with or without the sign", () => {
		expect(readSpawnSampling({ temperature_range: "2%" })).toEqual({
			temperature_range: 2,
		});
		expect(readSpawnSampling({ temperature_range: " 5 % " })).toEqual({
			temperature_range: 5,
		});
		expect(readSpawnSampling({ temperatureRange: 3 })).toEqual({
			temperature_range: 3,
		});
	});

	it("drops what is not usable", () => {
		expect(readSpawnSampling({ temperature_range: 150 })).toBeUndefined();
		expect(readSpawnSampling({ temperature_range: -1 })).toBeUndefined();
		expect(readSpawnSampling({ seed: "randomly", temperature: "hot" })).toBe(
			undefined,
		);
		expect(readSpawnSampling({ seed: 1.5, temperature: -0.1 })).toBeUndefined();
	});

	it("keeps a random seed random for every copy", () => {
		expect(samplingForCopy({ seed: "random" }, 3)).toEqual({ seed: "random" });
		expect(
			expandAgentCounts([{ task: "t", count: 3, seed: "random" }]).map(
				(member) => member.seed,
			),
		).toEqual(["random", "random", "random"]);
	});
});

describe('seed: "random"', () => {
	it("gives each agent its own seed, a non-negative 32-bit integer", () => {
		const random = seededRandom(7);
		const seeds = Array.from(
			{ length: 50 },
			() => drawSpawnSampling({ seed: "random" }, random)?.seed,
		);
		expect(new Set(seeds).size).toBe(50);
		for (const seed of seeds) {
			expect(Number.isInteger(seed)).toBe(true);
			expect(seed).toBeGreaterThanOrEqual(0);
			expect(seed).toBeLessThan(RANDOM_SEED_LIMIT);
		}
	});

	it("is reported as drawn and reaches the wire", async () => {
		const draw = drawSpawnSampling({ seed: "random" }, () => 0.5);
		expect(draw).toEqual({ seed: 2 ** 30, seedRandom: true });
		expect(realizeSpawnSampling(draw, undefined)).toEqual({
			seed: 2 ** 30,
			seedRandom: true,
		});
		const body = await wireBody(LLAMACPP, draw);
		expect(body.seed).toBe(2 ** 30);
		expect(body).not.toHaveProperty("temperature");
	});
});

describe('temperature: "random"', () => {
	it("draws each agent within the model's own temperature +/- 2%", () => {
		const random = seededRandom(3);
		const temperatures = Array.from({ length: 40 }, () => {
			const { realized, config } = buildWith(
				WITH_MODEL_TEMPERATURE,
				{ temperature: "random" },
				random,
			);
			expect(realized).toMatchObject({
				temperatureBase: 0.7,
				temperatureRange: DEFAULT_TEMPERATURE_RANGE_PERCENT,
			});
			expect(config.temperature).toBe(realized?.temperature);
			return realized?.temperature as number;
		});
		for (const value of temperatures) {
			// Three decimals, inside [0.686, 0.714] up to that rounding.
			expect(Math.round(value * 1000) / 1000).toBe(value);
			expect(value).toBeGreaterThanOrEqual(0.686 - 0.0005);
			expect(value).toBeLessThanOrEqual(0.714 + 0.0005);
		}
		expect(new Set(temperatures).size).toBeGreaterThan(5);
	});

	it("reaches the edges of the range at the edges of the draw", () => {
		const low = buildWith(
			WITH_MODEL_TEMPERATURE,
			{ temperature: "random" },
			() => 0,
		);
		const high = buildWith(
			WITH_MODEL_TEMPERATURE,
			{ temperature: "random" },
			() => 0.999999,
		);
		expect(low.realized?.temperature).toBe(0.686);
		expect(high.realized?.temperature).toBe(0.714);
	});

	it("randomizes around an explicit temperature when a range is given", () => {
		const random = seededRandom(11);
		for (let index = 0; index < 30; index += 1) {
			const { realized } = buildWith(
				WITH_MODEL_TEMPERATURE,
				{ temperature: 1, temperature_range: 10 },
				random,
			);
			expect(realized).toMatchObject({
				temperatureBase: 1,
				temperatureRange: 10,
			});
			expect(realized?.temperature).toBeGreaterThanOrEqual(0.9);
			expect(realized?.temperature).toBeLessThanOrEqual(1.1);
		}
	});

	it("randomizes around the model's own when only a range is given", () => {
		const { realized } = buildWith(
			WITH_MODEL_TEMPERATURE,
			{ temperature_range: "50%" },
			() => 0,
		);
		expect(realized).toEqual({
			temperature: 0.35,
			temperatureBase: 0.7,
			temperatureRange: 50,
		});
	});

	it("keeps a number without a range fixed", () => {
		const { realized } = buildWith(
			WITH_MODEL_TEMPERATURE,
			{ temperature: 0.4 },
			() => 0,
		);
		expect(realized).toEqual({ temperature: 0.4 });
	});

	it("leaves the temperature unset, with an info line, when the model states none", () => {
		const { realized, config } = buildWith(
			LLAMACPP,
			{ temperature: "random", seed: 5 },
			() => 0.3,
		);
		expect(realized).toEqual({
			seed: 5,
			temperatureRange: 2,
			note: UNKNOWN_MODEL_TEMPERATURE_NOTE,
		});
		expect(config.temperature).toBeUndefined();
		expect(
			(config.providerConfig as { sampling?: unknown } | undefined)?.sampling,
		).toEqual({ seed: 5 });
		const updates: unknown[] = [];
		reportSubagentSampling((update) => updates.push(update), realized);
		// An info line: no severity, which the row shows as a warning.
		expect(updates).toEqual([
			{
				sampling: realized,
				activity: { text: UNKNOWN_MODEL_TEMPERATURE_NOTE },
			},
		]);
	});

	it("puts the drawn value on the wire", async () => {
		const draw = drawSpawnSampling({ temperature: "random" }, () => 1 - 1e-12);
		const body = await wireBody(WITH_MODEL_TEMPERATURE, draw);
		expect(body.temperature).toBe(0.714);
		expect(body.top_k).toBe(20);
	});
});

describe("the model's own temperature", () => {
	it("is read from the connection, then its sampler bag", () => {
		expect(
			modelTemperatureOf({ providerId: "x", modelId: "m", temperature: 0.3 }),
		).toBe(0.3);
		expect(
			modelTemperatureOf({
				providerId: "x",
				modelId: "m",
				providerConfig: {
					providerId: "x",
					modelId: "m",
					sampling: { temperature: 0.6 },
				} as AgentConfig["providerConfig"],
			}),
		).toBe(0.6);
		expect(modelTemperatureOf({ providerId: "x", modelId: "m" })).toBe(
			undefined,
		);
	});

	it("is read from an Ollama Modelfile through /api/show", async () => {
		// A model and server nothing else in this run has looked up.
		const connection = {
			providerId: "ollama",
			modelId: `tuned-${Date.now()}:latest`,
			baseUrl: "http://127.0.0.1:9",
		};
		const fetchStub = (async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/api/show")) {
				return Response.json({
					parameters: 'num_ctx 32768\ntemperature 0.6\nstop "<|im_end|>"',
				});
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const draw = drawSpawnSampling({ temperature: "random" }, () => 0.5);
		expect(modelTemperatureOf(connection)).toBeUndefined();
		await primeModelTemperature(draw, connection, fetchStub);
		expect(modelTemperatureOf(connection)).toBe(0.6);
		expect(realizeSpawnSampling(draw, modelTemperatureOf(connection))).toEqual({
			temperature: 0.6,
			temperatureBase: 0.6,
			temperatureRange: 2,
		});
	});

	it("is read from opencoti's /props default generation settings", async () => {
		const { resetPolykvAvailability } = await import("@cline/llms");
		resetPolykvAvailability();
		const connection = {
			providerId: "opencoti",
			modelId: "m",
			baseUrl: "http://127.0.0.1:9/v1",
		};
		const fetchStub = (async (input: unknown) => {
			if (String(input).endsWith("/props")) {
				return Response.json({
					default_generation_settings: { params: { temperature: 0.8 } },
				});
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		await primeModelTemperature(
			drawSpawnSampling({ temperature: "random" }),
			connection,
			fetchStub,
		);
		expect(modelTemperatureOf(connection)).toBe(0.8);
		resetPolykvAvailability();
	});

	it("is not asked for when nothing random needs it", async () => {
		let asked = 0;
		const fetchStub = (async () => {
			asked += 1;
			return new Response("{}");
		}) as unknown as typeof fetch;
		const connection = { providerId: "ollama", modelId: "m" };
		await primeModelTemperature(
			drawSpawnSampling({ temperature: 0.5, seed: "random" }),
			connection,
			fetchStub,
		);
		await primeModelTemperature(
			drawSpawnSampling({ temperature: 0.5, temperature_range: 4 }),
			connection,
			fetchStub,
		);
		expect(asked).toBe(0);
	});
});

describe("describeRealizedSampling", () => {
	it("is the row's compact line", () => {
		expect(
			describeRealizedSampling({
				seed: 2847193,
				temperature: 0.713,
				seedRandom: true,
			}),
		).toBe("seed 2847193 · T 0.713");
		expect(describeRealizedSampling({ note: "x" })).toBeUndefined();
	});
});
