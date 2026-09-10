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
const AGENT_HUES = [210, 275, 175, 40, 245, 315]

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
