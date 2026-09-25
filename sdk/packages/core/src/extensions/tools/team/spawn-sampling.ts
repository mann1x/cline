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
 */

import type { AgentConfig } from "@cline/shared";
import { z } from "zod";

export interface SpawnSampling {
	temperature?: number;
	seed?: number;
}

/** The two fields as a spawn tool's input schema states them. */
export const SpawnSamplingFields = {
	temperature: z
		.number()
		.nonnegative()
		.optional()
		.describe(
			"Sampling temperature for this agent, over its model's own. Omit to keep the model's.",
		),
	seed: z
		.number()
		.int()
		.optional()
		.describe(
			"Sampling seed for this agent. Omit to leave it unset. Covering several agents, each gets seed + its index among them (seed, seed+1, ...).",
		),
};

/** The one line each spawn tool's description gives the two options. */
export const SPAWN_SAMPLING_NOTE =
	"Optional `temperature` and `seed` set the sampler for the agents they cover, over their model's own; omit them to keep the model's. A `seed` that covers several agents is offset by each agent's index among them (seed, seed+1, ...), so they do not sample identically. ";

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * The sampler a tool input names, or `undefined` when it names none.
 *
 * Tolerant of the shapes a model sends: a numeric string is read as its
 * number, and anything that is not a usable number is dropped rather than
 * sent -- a negative temperature, a fractional seed.
 */
export function readSpawnSampling(input: unknown): SpawnSampling | undefined {
	if (!input || typeof input !== "object") {
		return undefined;
	}
	const record = input as { temperature?: unknown; seed?: unknown };
	const temperature = toNumber(record.temperature);
	const seed = toNumber(record.seed);
	const sampling: SpawnSampling = {
		...(temperature !== undefined && temperature >= 0 ? { temperature } : {}),
		...(seed !== undefined && Number.isInteger(seed) ? { seed } : {}),
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

/**
 * The sampler for the `index`th agent made from one entry.
 *
 * The seed is offset by the index so that N agents running one task do not
 * draw N identical samples; the temperature is the same for all of them.
 */
export function samplingForCopy(
	sampling: SpawnSampling | undefined,
	index: number,
): SpawnSampling | undefined {
	if (!sampling || sampling.seed === undefined || index === 0) {
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

/** The fields to spread into a tool input or result; nothing when unset. */
export function spawnSamplingFields(
	sampling: SpawnSampling | undefined,
): SpawnSampling {
	return {
		...(sampling?.temperature !== undefined
			? { temperature: sampling.temperature }
			: {}),
		...(sampling?.seed !== undefined ? { seed: sampling.seed } : {}),
	};
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
	sampling: SpawnSampling | undefined,
): T {
	const fields = spawnSamplingFields(sampling);
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
