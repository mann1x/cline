/**
 * How a sub-agent is identified on screen: a label and a colour.
 *
 * Sub-agents were previously told apart only by the prompt quoted back at
 * them, which stops working the moment two of them are doing similar work at
 * once -- the thing sub-agents are for. A name and a colour give each row an
 * identity that survives a glance.
 */

/**
 * Hues for the agent tags, in assignment order.
 *
 * Red and green are absent on purpose: they mean failed and completed
 * everywhere else in this UI, and an agent that happens to be the red one
 * reads as an agent in trouble. The rest are far enough apart in hue to stay
 * distinct at the size of a tag, which mattered more than having many of them
 * -- six agents at once is already a crowded row.
 */
export const AGENT_HUES = [210, 275, 175, 40, 245, 315]

export interface SubagentIdentity {
	label: string
	/** Inline style for the tag, as an accent rather than a text colour. */
	style: { backgroundColor: string; borderColor: string }
}

/**
 * The tag for one sub-agent.
 *
 * Colour comes from the position, not from a hash of the name: within a row
 * position is unique, so no two visible agents can collide on a colour, which
 * a hash cannot promise. `index` is the 1-based index the status items carry.
 */
export function subagentIdentity(index: number, agentName?: string): SubagentIdentity {
	const hue = AGENT_HUES[(Math.max(1, index) - 1) % AGENT_HUES.length]
	const trimmed = agentName?.trim()
	return {
		label: trimmed || `Agent ${index}`,
		style: {
			backgroundColor: `hsl(${hue} 70% 50% / 0.18)`,
			borderColor: `hsl(${hue} 70% 50% / 0.55)`,
		},
	}
}

/**
 * What an agent runs on, as `provider/model`.
 *
 * Shown beside the agent's tag while it runs, not only once it is done: a
 * configured agent can name a provider and a model of its own, and a node
 * decides both for an agent placed on it, so the lead's are no guide. Either
 * half alone when that is all there is; nothing when neither is known.
 */
export function subagentModelLabel(item: { providerId?: string; modelId?: string }): string | undefined {
	const provider = item.providerId?.trim()
	const model = item.modelId?.trim()
	if (provider && model) {
		// A model id that already names its provider (an OpenRouter-style id)
		// would otherwise read `anthropic/anthropic/claude-…`.
		return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`
	}
	return model || provider || undefined
}

interface SamplingLike {
	temperature?: number
	seed?: number
	seedRandom?: boolean
	temperatureBase?: number
	temperatureRange?: number
	note?: string
}

/**
 * The sampler an agent ran with, compact: `seed 2847193 · T 0.713`.
 *
 * Only when the lead set one on the spawn; an agent on its model's own
 * sampler shows nothing. A random temperature the model could not supply a
 * base for shows as the model's (`T model`), which is what it ran on.
 */
export function subagentSamplingText(sampling: SamplingLike | undefined): string | undefined {
	if (!sampling) {
		return undefined
	}
	const parts = [
		sampling.seed !== undefined ? `seed ${sampling.seed}` : "",
		sampling.temperature !== undefined ? `T ${sampling.temperature}` : sampling.note ? "T model" : "",
	].filter(Boolean)
	return parts.length > 0 ? parts.join(" · ") : undefined
}

/** The same, in full, for its tooltip: which values were drawn, and around what. */
export function subagentSamplingTitle(sampling: SamplingLike | undefined): string | undefined {
	if (!sampling) {
		return undefined
	}
	const lines: string[] = []
	if (sampling.seed !== undefined) {
		lines.push(`Seed ${sampling.seed}${sampling.seedRandom ? " (random)" : ""}`)
	}
	if (sampling.temperature !== undefined) {
		const drawn =
			sampling.temperatureBase !== undefined && sampling.temperatureRange !== undefined
				? ` (random: ${sampling.temperatureBase} ± ${sampling.temperatureRange}%)`
				: ""
		lines.push(`Temperature ${sampling.temperature}${drawn}`)
	}
	if (sampling.note) {
		lines.push(`Temperature: ${sampling.note}`)
	}
	return lines.length > 0 ? lines.join("\n") : undefined
}
