import { normalizeAgentWindowShare, resolveAgentWindowFloor } from "@cline/shared"
import { useRef } from "react"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useContextMinimum } from "./ContextMinimumWarning"

/** Steps the slider moves in, as the output budget's does. */
const STEP_PERCENT = 5

function positive(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * "Agent window", per agent node: the least window a delegated agent accepts.
 *
 * Ruled 2026-09-25, in the user's words: "a percentage slider like the share
 * in automatic budget; 100% is the context set by the user, 0% is the minimum
 * needed for thinking/max_gen_tokens plus the system prompt/tools/mcp surface.
 * So if the user sets 50% it's going to be the right value whatever context he
 * sets." So it is a share *between* two ends, and the token count beside it is
 * `minimum + share × (window − minimum)` -- the same function the opencoti
 * fetch floors each agent's session at (`resolveAgentWindowFloor`).
 *
 * On the wire it is `num_ctx` = the node's window and `num_ctx_min` = this
 * floor: the engine grants the largest window that fits, never below it, and
 * below it the agent waits. Only opencoti negotiates; on Ollama and llama.cpp
 * the node's window is simply what is sent, so the slider is shown disabled
 * and says so.
 *
 * Stored in the node's own provider settings as `agentWindow.sharePercent`,
 * written whole, and carried by profiles like the rest of them. Absent reads
 * as 50%.
 */
export const AgentWindowField = ({
	providerId,
	negotiates,
}: {
	providerId: string
	/** Whether this node's provider negotiates a window (opencoti). */
	negotiates: boolean
}) => {
	const { config, write } = useProviderConfig(providerId as never)
	// What this field has sent and not yet seen answered; the section is
	// written whole, so a second nudge inside one round trip must compose from
	// the first rather than from the render before it.
	const pending = useRef<{ sharePercent: number } | undefined>(undefined)
	const inFlight = useRef(0)
	// The node's window as its tab stores it -- the box's `contextWindow`, or
	// the selection override the same box writes. The model info's figure is
	// not used: on a node tab it is the safe default, not what the host
	// resolves, and a floor shown against it would be a number nobody books.
	const window =
		positive(config?.contextWindow) ??
		positive((config as { selectedModelOverrides?: { contextWindow?: unknown } } | undefined)?.selectedModelOverrides?.contextWindow)
	const minimum = useContextMinimum(providerId, window)
	if (config === undefined) {
		return null
	}
	const stored = (config as { agentWindow?: { sharePercent?: unknown } }).agentWindow
	const percent = normalizeAgentWindowShare(pending.current?.sharePercent ?? stored?.sharePercent)
	const floor =
		window !== undefined && minimum !== undefined
			? resolveAgentWindowFloor({ contextWindow: window, minimumTokens: minimum.minimumTokens, sharePercent: percent })
			: undefined

	const setShare = (sharePercent: number) => {
		const next = { sharePercent: normalizeAgentWindowShare(sharePercent) }
		pending.current = next
		inFlight.current += 1
		void write({ agentWindow: next } as never)
			.catch((error) => console.error("Failed to update the agent window:", error))
			.finally(() => {
				inFlight.current -= 1
				if (inFlight.current === 0) {
					pending.current = undefined
				}
			})
	}

	return (
		<div className="flex flex-col gap-1 mb-[10px]" data-testid="agent-window-field">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor="agent-window-share">
					Agent window
				</Label>
				<span className="text-xs text-description" data-testid="agent-window-percent">
					{percent}%{negotiates && floor !== undefined ? ` · ${floor.toLocaleString("en-US")} tokens` : ""}
				</span>
			</div>
			<Slider
				aria-label="Agent window"
				disabled={!negotiates}
				id="agent-window-share"
				max={100}
				min={0}
				onValueChange={([next]) => setShare(next)}
				step={STEP_PERCENT}
				value={[percent]}
			/>
			{negotiates ? (
				<p className="text-xs mt-[2px] mb-0 text-description" data-testid="agent-window-readout">
					{floor !== undefined && minimum !== undefined && window !== undefined
						? `Each agent asks for this node's ${window.toLocaleString("en-US")}-token window and accepts no less than ` +
							`${floor.toLocaleString("en-US")}: ${percent}% of the way from the ${Math.min(minimum.minimumTokens, window).toLocaleString("en-US")} ` +
							"a turn needs (system prompt, tools, MCP and the output cap) to the whole window. Below that it waits for room."
						: "Set this node's Model Context Window to see the floor this share gives."}
				</p>
			) : (
				<p className="text-xs mt-[2px] mb-0 text-description" data-testid="agent-window-inert">
					Only opencoti negotiates a window per agent; this node sends its context window as set, so the share has no
					effect here.
				</p>
			)}
		</div>
	)
}

export default AgentWindowField
