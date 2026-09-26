/**
 * A sampler the lead chose for the agents it spawns: `temperature` and `seed`.
 *
 * Both are optional, and absent is not a default. An agent spawned without
 * them runs on its connection's sampler exactly as before -- nothing here
 * writes a value the lead did not pass, because a local model's validated
 * sampler lives in its Modelfile and a client that invents one silently
 * replaces it.
 *
 * What the lead passes is applied last, in {@link buildDelegatedAgentConfig},
 * over whatever connection the agent was built on. That is the one point
 * after every other source has had its say -- the session's pushes through
 * `updateConnectionDefaults`, a profile, a node's connection (the priority-0
 * node clears `temperature` so the lead's own applies) -- so none of them can
 * move a value the lead asked for.
 *
 * Either may also be `"random"`, for a swarm experiment that wants its agents
 * to sample differently and wants to know afterwards how:
 *
 * - `seed: "random"` gives each agent its own independent seed.
 * - `temperature: "random"` gives each agent a draw from its model's own
 *   temperature +/- `temperature_range` percent (2 when not given). The
 *   model's own is read, never guessed (see {@link modelTemperatureOf}); when
 *   nothing states it the agent keeps the model's sampler and the row says so.
 * - A numeric `temperature` with a `temperature_range` is randomized around
 *   that number; `temperature_range` alone around the model's own.
 *
 * The lead's request is drawn once per agent ({@link drawSpawnSampling}) --
 * so a re-placement keeps the draw -- and realized at build, where the
 * connection and so the model's own temperature are known
 * ({@link realizeSpawnSampling}). What each agent really ran with goes to its
 * row, its result and, for a teammate, its persisted spec.
 */

import {
	primeDeclaredNumCtx,
	probeOpencotiProps,
	readDeclaredTemperature,
	readOpencotiDefaultTemperature,
} from "@cline/llms";
import type { AgentConfig } from "@cline/shared";
import { isOllamaNativeProvider } from "@cline/shared";
import { z } from "zod";

/** The keyword that asks for a per-agent random value. */
export const SPAWN_RANDOM = "random" as const;

/** Percent a random temperature may move either way when no range is given. */
export const DEFAULT_TEMPERATURE_RANGE_PERCENT = 2;

/** Seeds drawn for `seed: "random"` are in [0, this). Fits a signed int32. */
export const RANDOM_SEED_LIMIT = 2 ** 31;

/** The info line an agent gets when "random" had no temperature to start from. */
export const UNKNOWN_MODEL_TEMPERATURE_NOTE =
	"model temperature unknown; kept the model's sampler";

/** What a lead asked for: as the tool input states it, after tolerant reading. */
export interface SpawnSampling {
	temperature?: number | typeof SPAWN_RANDOM;
	seed?: number | typeof SPAWN_RANDOM;
	/** Percent, 0-100. Asks for a randomized temperature on its own. */
	temperature_range?: number;
}

/**
 * One agent's sampler, drawn: every random choice made, the model's own
 * temperature not yet read. A plain `{temperature, seed}` of numbers is one
 * with nothing random in it.
 */
export interface SpawnSamplingDraw {
	/** Fixed: used as given. */
	temperature?: number;
	seed?: number;
	/** The seed was drawn, not given. */
	seedRandom?: boolean;
	/**
	 * Randomize the temperature: `base` (or, absent, the model's own) moved by
	 * `draw * range` percent, `draw` uniform in [-1, 1].
	 */
	temperatureRandom?: { base?: number; range: number; draw: number };
}

/** What one agent ran with, for its row, its result and its record. */
export interface RealizedSpawnSampling {
	temperature?: number;
	seed?: number;
	/** The seed was drawn per agent (`seed: "random"`). */
	seedRandom?: boolean;
	/** Present when the temperature was randomized: what it was drawn around. */
	temperatureBase?: number;
	/** Percent, present when the temperature was randomized (or asked to be). */
	temperatureRange?: number;
	/** An info line for the row: why a requested value was not applied. */
	note?: string;
}

/** A source of uniform numbers in [0, 1). Injected by tests. */
export type SamplingRandom = () => number;

/** The fields as a spawn tool's input schema states them. */
export const SpawnSamplingFields = {
	temperature: z
		.union([z.number().nonnegative(), z.literal(SPAWN_RANDOM)])
		.optional()
		.describe(
			"Sampling temperature for this agent, over its model's own. \"random\": the model's own temperature +/- `temperature_range`% per agent. Omit to keep the model's.",
		),
	seed: z
		.union([z.number().int(), z.literal(SPAWN_RANDOM)])
		.optional()
		.describe(
			'Sampling seed for this agent. Omit to leave it unset. Covering several agents, each gets seed + its index among them (seed, seed+1, ...). "random": an independent seed per agent.',
		),
	temperature_range: z
		.number()
		.min(0)
		.max(100)
		.optional()
		.describe(
			"Percent (default 2) each agent's temperature is randomized by, either way, around `temperature` -- or around the model's own when `temperature` is omitted or \"random\".",
		),
};

/** The one line each spawn tool's description gives the options. */
export const SPAWN_SAMPLING_NOTE =
	'Optional `temperature` and `seed` set the sampler for the agents they cover, over their model\'s own; omit them to keep the model\'s. A `seed` that covers several agents is offset by each agent\'s index among them (seed, seed+1, ...), so they do not sample identically. Either may be "random": `seed: "random"` gives each agent its own seed; `temperature: "random"` gives each the model\'s temperature +/- `temperature_range` percent (default 2), and a numeric `temperature` with `temperature_range` is randomized around that number. ';

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRandomKeyword(value: unknown): boolean {
	return (
		typeof value === "string" && value.trim().toLowerCase() === SPAWN_RANDOM
	);
}

/**
 * The sampler a tool input names, or `undefined` when it names none.
 *
 * Tolerant of the shapes a model sends: a numeric string is read as its
 * number, "Random" as "random", a range of "2%" as 2, and `temperatureRange`
 * as `temperature_range`. Anything that is not usable is dropped rather than
 * sent -- a negative temperature, a fractional seed, a range over 100.
 */
export function readSpawnSampling(input: unknown): SpawnSampling | undefined {
	if (!input || typeof input !== "object") {
		return undefined;
	}
	const record = input as {
		temperature?: unknown;
		seed?: unknown;
		temperature_range?: unknown;
		temperatureRange?: unknown;
	};
	const temperature = isRandomKeyword(record.temperature)
		? SPAWN_RANDOM
		: toNumber(record.temperature);
	const seed = isRandomKeyword(record.seed)
		? SPAWN_RANDOM
		: toNumber(record.seed);
	const range = toPercent(record.temperature_range ?? record.temperatureRange);
	const sampling: SpawnSampling = {
		...(temperature === SPAWN_RANDOM ||
		(temperature !== undefined && temperature >= 0)
			? { temperature }
			: {}),
		...(seed === SPAWN_RANDOM || (seed !== undefined && Number.isInteger(seed))
			? { seed }
			: {}),
		...(range !== undefined && range >= 0 && range <= 100
			? { temperature_range: range }
			: {}),
	};
	return Object.keys(sampling).length > 0 ? sampling : undefined;
}

function toNumber(value: unknown): number | undefined {
	if (isFiniteNumber(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** A percent: a number, or a string with or without a trailing `%`. */
function toPercent(value: unknown): number | undefined {
	if (typeof value === "string") {
		return toNumber(value.trim().replace(/%$/, "").trim());
	}
	return toNumber(value);
}

/**
 * The sampler for the `index`th agent made from one entry.
 *
 * A numeric seed is offset by the index so that N agents running one task do
 * not draw N identical samples; a "random" one stays "random", and each agent
 * draws its own. The temperature is the same request for all of them.
 */
export function samplingForCopy(
	sampling: SpawnSampling | undefined,
	index: number,
): SpawnSampling | undefined {
	if (
		!sampling ||
		sampling.seed === undefined ||
		sampling.seed === SPAWN_RANDOM ||
		index === 0
	) {
		return sampling;
	}
	return { ...sampling, seed: sampling.seed + index };
}

/** `inner` over `outer`, field by field: an entry's own value beats the call's. */
export function mergeSpawnSampling(
	outer: SpawnSampling | undefined,
	inner: SpawnSampling | undefined,
): SpawnSampling | undefined {
	if (!outer) {
		return inner;
	}
	if (!inner) {
		return outer;
	}
	return { ...outer, ...inner };
}

/** The fields to spread into a tool input; nothing when unset. */
export function spawnSamplingFields(
	sampling: SpawnSampling | undefined,
): SpawnSampling {
	return {
		...(sampling?.temperature !== undefined
			? { temperature: sampling.temperature }
			: {}),
		...(sampling?.seed !== undefined ? { seed: sampling.seed } : {}),
		...(sampling?.temperature_range !== undefined
			? { temperature_range: sampling.temperature_range }
			: {}),
	};
}

/**
 * Make one agent's random choices: its seed, and where in the range its
 * temperature falls. Once per agent -- not per attempt -- so a re-placement
 * runs the same draw.
 */
export function drawSpawnSampling(
	sampling: SpawnSampling | undefined,
	random: SamplingRandom = Math.random,
): SpawnSamplingDraw | undefined {
	if (!sampling) {
		return undefined;
	}
	const draw: SpawnSamplingDraw = {};
	if (sampling.seed === SPAWN_RANDOM) {
		draw.seed = Math.floor(random() * RANDOM_SEED_LIMIT) % RANDOM_SEED_LIMIT;
		draw.seedRandom = true;
	} else if (sampling.seed !== undefined) {
		draw.seed = sampling.seed;
	}
	const randomize =
		sampling.temperature === SPAWN_RANDOM ||
		sampling.temperature_range !== undefined;
	if (randomize) {
		draw.temperatureRandom = {
			...(typeof sampling.temperature === "number"
				? { base: sampling.temperature }
				: {}),
			range: sampling.temperature_range ?? DEFAULT_TEMPERATURE_RANGE_PERCENT,
			draw: random() * 2 - 1,
		};
	} else if (typeof sampling.temperature === "number") {
		draw.temperature = sampling.temperature;
	}
	return Object.keys(draw).length > 0 ? draw : undefined;
}

type SamplingConnection = Pick<
	AgentConfig,
	"providerId" | "modelId" | "baseUrl" | "temperature" | "providerConfig"
>;

function samplingBagTemperature(
	providerConfig: AgentConfig["providerConfig"] | undefined,
): number | undefined {
	const bag = (providerConfig as { sampling?: { temperature?: unknown } })
		?.sampling;
	const value = bag?.temperature;
	return isFiniteNumber(value) && value >= 0 ? value : undefined;
}

/**
 * The temperature the agent's model runs at when the spawn names none, from
 * the first source that states one:
 *
 * 1. the connection's own `temperature` -- a node's or the session's setting;
 * 2. its sampler bag, `providerConfig.sampling.temperature` -- a profile's or
 *    a node's `settings.sampling`, which is what reaches the wire;
 * 3. for Ollama, the Modelfile's `temperature` parameter, from `/api/show`;
 * 4. for a llama.cpp/opencoti server, `/props`' default generation settings,
 *    when they have already been read.
 *
 * `undefined` when none of them does: nothing here guesses one.
 */
export function modelTemperatureOf(
	connection: SamplingConnection,
): number | undefined {
	if (isFiniteNumber(connection.temperature) && connection.temperature >= 0) {
		return connection.temperature;
	}
	const bag = samplingBagTemperature(connection.providerConfig);
	if (bag !== undefined) {
		return bag;
	}
	const baseUrl =
		connection.baseUrl ??
		(connection.providerConfig as { baseUrl?: string } | undefined)?.baseUrl;
	if (isOllamaNativeProvider(connection.providerId)) {
		return readDeclaredTemperature(baseUrl, connection.modelId);
	}
	return readOpencotiDefaultTemperature(baseUrl);
}

/**
 * Read the model's own temperature from its server, when a draw needs it and
 * no local setting states it: Ollama's `/api/show` (the same read its handler
 * makes before the first request, cached per model) or opencoti's `/props`
 * (read once per server at session start). Anything else is not asked.
 * Failure is not an error: the agent then keeps the model's sampler.
 */
export async function primeModelTemperature(
	draw: SpawnSamplingDraw | undefined,
	connection: SamplingConnection,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	if (
		!draw?.temperatureRandom ||
		draw.temperatureRandom.base !== undefined ||
		modelTemperatureOf(connection) !== undefined
	) {
		return;
	}
	const baseUrl =
		connection.baseUrl ??
		(connection.providerConfig as { baseUrl?: string } | undefined)?.baseUrl;
	try {
		if (isOllamaNativeProvider(connection.providerId)) {
			await primeDeclaredNumCtx(baseUrl, connection.modelId, fetchImpl);
		} else if (connection.providerId === "opencoti") {
			await probeOpencotiProps(baseUrl, fetchImpl);
		}
	} catch {
		// Unread is unknown, and unknown keeps the model's sampler.
	}
}

function roundTemperature(value: number): number {
	return Math.max(0, Math.round(value * 1000) / 1000);
}

/**
 * One agent's draw made concrete against its model's own temperature.
 *
 * A randomized temperature is `base * (1 + draw * range / 100)`, rounded to
 * three decimals and never below 0. With no base -- the spawn named none and
 * the model states none -- the temperature is left unset and `note` says so:
 * the model's sampler stands, and nothing is invented in its place.
 */
export function realizeSpawnSampling(
	draw: SpawnSamplingDraw | undefined,
	modelTemperature: number | undefined,
): RealizedSpawnSampling | undefined {
	if (!draw) {
		return undefined;
	}
	const realized: RealizedSpawnSampling = {
		...(draw.seed !== undefined ? { seed: draw.seed } : {}),
		...(draw.seedRandom ? { seedRandom: true } : {}),
	};
	const random = draw.temperatureRandom;
	if (random) {
		const base = random.base ?? modelTemperature;
		realized.temperatureRange = random.range;
		if (base === undefined) {
			realized.note = UNKNOWN_MODEL_TEMPERATURE_NOTE;
		} else {
			realized.temperatureBase = base;
			realized.temperature = roundTemperature(
				base * (1 + (random.draw * random.range) / 100),
			);
		}
	} else if (draw.temperature !== undefined) {
		realized.temperature = draw.temperature;
	}
	return Object.keys(realized).length > 0 ? realized : undefined;
}

/** The two values a realized sampler puts on the wire; nothing when unset. */
export function samplingValues(
	sampling: Pick<RealizedSpawnSampling, "temperature" | "seed"> | undefined,
): { temperature?: number; seed?: number } {
	return {
		...(sampling?.temperature !== undefined
			? { temperature: sampling.temperature }
			: {}),
		...(sampling?.seed !== undefined ? { seed: sampling.seed } : {}),
	};
}

/**
 * The compact line a row shows for a realized sampler: `seed 2847193 · T 0.713`.
 * `undefined` when there is nothing to show.
 */
export function describeRealizedSampling(
	sampling: RealizedSpawnSampling | undefined,
): string | undefined {
	if (!sampling) {
		return undefined;
	}
	const parts = [
		sampling.seed !== undefined ? `seed ${sampling.seed}` : "",
		sampling.temperature !== undefined ? `T ${sampling.temperature}` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * An agent config with the lead's sampler over its connection's.
 *
 * `temperature` goes to both places a provider reads it from: the config's
 * own field, which becomes the request's `temperature`, and the provider
 * config's `sampling` bag, which is what Ollama and llama.cpp/opencoti put on
 * the wire. Setting only the first would leave a profile's
 * `sampling.temperature` in the bag to contradict it. `seed` has only the bag:
 * no other route carries one.
 *
 * With no sampler the config is returned untouched -- the same object.
 */
export function applySpawnSampling<T extends AgentConfig>(
	config: T,
	sampling: Pick<RealizedSpawnSampling, "temperature" | "seed"> | undefined,
): T {
	const fields = samplingValues(sampling);
	if (Object.keys(fields).length === 0) {
		return config;
	}
	const providerConfig = (config.providerConfig ?? {
		providerId: config.providerId,
		modelId: config.modelId,
	}) as NonNullable<AgentConfig["providerConfig"]> & {
		sampling?: Record<string, unknown>;
	};
	return {
		...config,
		...(fields.temperature !== undefined
			? { temperature: fields.temperature }
			: {}),
		providerConfig: {
			...providerConfig,
			sampling: { ...(providerConfig.sampling ?? {}), ...fields },
		} as AgentConfig["providerConfig"],
	};
}
