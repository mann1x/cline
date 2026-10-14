import { StringRequest } from "@shared/proto/cline/common"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ModelsServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./DebouncedTextField"
import { useSamplingWrite } from "./sampling-fields"
import { useUserCheckboxChange } from "./useUserCheckboxChange"

/**
 * The levels, in the order they escalate, and spelled the way Ollama's panel
 * spells them.
 *
 * Deliberately the same list and the same words: the two engines resolve a
 * level with the same arithmetic — the fractions are Ollama's own
 * `thinkBudgetFraction`, ported verbatim — so a level that reads as one thing
 * in one panel and another thing in the next would be describing identical
 * behaviour with two vocabularies.
 *
 * `xhigh` is Ollama's alias for `max`, not a seventh level, so it is stored
 * under the name the top of the scale already has and never offered twice.
 */
export const THINKING_LEVELS = ["unset", "minimal", "low", "medium", "high", "xhigh", "custom"] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
	unset: "Default (unbounded)",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Max",
	custom: "Custom (reasoning_budget_tokens)",
}

/**
 * The level the *stored* config names, or `undefined` when it names none.
 *
 * The dropdown is the master and is stored in two mutually exclusive places so
 * it cannot disagree with what is sent: a level lives on `reasoning.effort`, a
 * count on `sampling.thinkBudget`. Neither is set when the budget is meant to
 * be unbounded — and neither is set the instant Custom is picked either, which
 * is why this returns `undefined` rather than guessing "unset" for the caller.
 *
 * Shared with the Ollama panel: the two dropdowns offer the same levels and
 * must read a stored profile the same way.
 */
export function readStoredThinkingLevel(source: { effort?: string; thinkBudget?: string }): ThinkingLevel | undefined {
	if (source.effort && (THINKING_LEVELS as readonly string[]).includes(source.effort)) {
		return source.effort as ThinkingLevel
	}
	if ((source.thinkBudget ?? "").trim() !== "") {
		return "custom"
	}
	return undefined
}

/**
 * The llama.cpp servers: the generic OpenAI-compatible provider, which is how
 * llama.cpp is reached, and opencoti. They hand a top-level `reasoning_effort`
 * to the chat template as the model's level.
 */
const TEMPLATE_LEVEL_PROVIDERS = new Set(["openai-compatible", "opencoti"])

/** The Reasoning effort dropdown's "send no level" entry. */
const REASONING_LEVEL_DEFAULT = "__default__"

/**
 * The levels the server's chat template states, read through the host from
 * `/props`. Asked again when the base URL changes; the template is the loaded
 * model's.
 */
function useTemplateReasoningLevels(providerId: string, enabled: boolean, baseUrl: string | undefined) {
	const [read, setRead] = useState<{ levels: string[]; defaultLevel?: string }>({ levels: [] })
	useEffect(() => {
		if (!enabled) {
			setRead({ levels: [] })
			return
		}
		let cancelled = false
		void ModelsServiceClient.readTemplateReasoningLevels(StringRequest.create({ value: providerId }))
			.then((response) => {
				if (!cancelled) {
					setRead({ levels: response?.levels ?? [], defaultLevel: response?.defaultLevel })
				}
			})
			.catch(() => {
				if (!cancelled) {
					setRead({ levels: [] })
				}
			})
		return () => {
			cancelled = true
		}
	}, [providerId, enabled, baseUrl])
	return read
}

/**
 * How much of a reply a llama.cpp-family server may spend thinking.
 *
 * The budget is `reasoning_budget_tokens`, an absolute count, which bounds
 * monotonically (512 → 1,650 characters of reasoning, 256 → 1,057, 128 → 768,
 * 64 → 400 on the same seed and prompt). A budget word is resolved to a count
 * on this side, using Ollama's fractions, and only that count goes on the wire.
 *
 * It is never sent as `reasoning_effort`: llama.cpp (and opencoti from c13)
 * hands that field to the chat template as the model's level, so "high" set
 * the level too, and failed the turn on a template that lists only
 * xhigh/medium/low (eleven2go, 2026-10-14). The level is the Reasoning effort
 * dropdown above it, offered from the template's own list.
 *
 * **Default means unbounded here, and that is the difference from Ollama.**
 * On Ollama an absent budget hands the decision to the model's own
 * `think_budget` parameter. This engine has no such fallback: send nothing and
 * nothing bounds the thinking, unless the server itself was started with a
 * budget flag. Which is why it is worth saying on screen rather than leaving
 * "Default" to be read as "something sensible".
 */
export const ThinkingBudgetField = ({ providerId }: { providerId: string }) => {
	// One hook, not two: the sampler write and the entry it composes from have
	// to be the same reader, or a panel writes through one copy and renders the
	// other.
	// The sampler section is written whole, and this panel is not its only
	// writer -- the Advanced section beside it writes the same section. The
	// shared hook is what makes each write compose from the last one rather
	// than from the copy the component rendered with, which is the difference
	// between clearing `think_budget` and undoing a temperature typed a moment
	// earlier.
	const { config, write, sampling: storedSampling, composeAndWrite } = useSamplingWrite(providerId)
	const storedThinkBudget = typeof storedSampling?.thinkBudget === "string" ? storedSampling.thinkBudget.trim() : ""

	// Custom is the only level with nothing of its own to store until a count
	// has been typed: it clears the level exactly as Default does, so on disk
	// the two are the same state. Remembering the pick here is what makes the
	// count field reachable at all — without it, choosing Custom read back as
	// Default and the field it exists to reveal never appeared.
	const [customPicked, setCustomPicked] = useState(false)

	// A stored answer always outranks that memory.
	const storedLevel = readStoredThinkingLevel({
		effort: config?.reasoning?.effort,
		thinkBudget: storedThinkBudget,
	})
	const thinkingLevel: ThinkingLevel = storedLevel ?? (customPicked ? "custom" : "unset")
	const thinkingEnabled = config?.reasoning?.enabled !== false

	// The model's own level, a separate setting from the budget: sent as
	// `reasoning_effort`, which the server hands to the chat template. Only the
	// levels the template states are offered -- it raises on any other.
	const offersLevel = TEMPLATE_LEVEL_PROVIDERS.has(providerId)
	const templateLevels = useTemplateReasoningLevels(providerId, offersLevel, config?.baseUrl)
	const storedReasoningLevel = typeof storedSampling?.reasoningLevel === "string" ? storedSampling.reasoningLevel.trim() : ""
	const reasoningLevelUnstated = storedReasoningLevel !== "" && !templateLevels.levels.includes(storedReasoningLevel)
	const handleReasoningLevelChange = useCallback(
		(value: string) => {
			void composeAndWrite({ reasoningLevel: value === REASONING_LEVEL_DEFAULT ? "" : value })
		},
		[composeAndWrite],
	)

	/**
	 * Sampling is replaced wholesale by the store, not merged field by field, so
	 * a patch carrying only `thinkBudget` would clear every other sampler value
	 * the user had set. Everything stored is carried forward and only this one
	 * field is changed.
	 */
	const handleEnabledChange = useCallback(
		(enabled: boolean) => {
			void write({
				reasoning: { enabled, effort: enabled ? (config?.reasoning?.effort ?? undefined) : undefined },
			}).catch((error) => console.error("Failed to update thinking:", error))
		},
		[write, config?.reasoning?.effort],
	)

	const handleLevelChange = useCallback(
		(level: ThinkingLevel) => {
			// Picking a level clears any count left over from Custom, in the same
			// write that sets the level. Two stored answers to one question is how
			// a panel comes to show one thing and send another.
			// "" rather than undefined, for both of the levels that mean "no
			// level": the store merges this section field by field and skips a
			// field that is undefined, so undefined left the previous level in
			// place and the dropdown snapped back. "" is the clear.
			setCustomPicked(level === "custom")
			if (level === "custom") {
				void write({ reasoning: { enabled: true, effort: "" } }).catch((error) =>
					console.error("Failed to update thinking level:", error),
				)
				return
			}
			composeAndWrite({ thinkBudget: "" }, { reasoning: { enabled: true, effort: level === "unset" ? "" : level } })
		},
		[write, composeAndWrite],
	)

	// Clicks only: the box also announces the panel's own re-render, and
	// storing that turned "not stated" into a stated answer.
	const onEnabledChange = useUserCheckboxChange(thinkingEnabled, handleEnabledChange)

	// Same reason the other provider fields wait: rendering before the config
	// resolves would show Default over a profile that says something else.
	if (config === undefined) {
		return null
	}

	return (
		<div className="flex flex-col gap-1">
			<VSCodeCheckbox checked={thinkingEnabled} onChange={onEnabledChange}>
				Enable thinking
			</VSCodeCheckbox>
			<p className="text-xs mt-0 mb-1 text-description">
				Asks the model to think in its own reasoning channel instead of into its answer, and bounds how much of a reply it
				may spend doing so. Turning it off asks for the smallest budget the server will take.
			</p>
			{thinkingEnabled && offersLevel && (templateLevels.levels.length > 0 || storedReasoningLevel !== "") && (
				<div className="mb-1">
					<Label className="text-xs font-medium">Reasoning effort</Label>
					<Select onValueChange={handleReasoningLevelChange} value={storedReasoningLevel || REASONING_LEVEL_DEFAULT}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={REASONING_LEVEL_DEFAULT}>
								{templateLevels.defaultLevel
									? `Default (${templateLevels.defaultLevel})`
									: "Default (model decides)"}
							</SelectItem>
							{templateLevels.levels.map((level) => (
								<SelectItem key={level} value={level}>
									{level}
								</SelectItem>
							))}
							{reasoningLevelUnstated && (
								<SelectItem value={storedReasoningLevel}>{storedReasoningLevel}</SelectItem>
							)}
						</SelectContent>
					</Select>
					<p className="text-xs mt-1 mb-0 text-description">
						The model's own thinking level, sent as <code>reasoning_effort</code> and handed to its chat template. The
						levels listed are the ones the loaded model's template states. It does not cap the thinking; the budget
						below does.
					</p>
					{reasoningLevelUnstated && (
						<p className="text-xs mt-1 mb-0 text-(--vscode-errorForeground)">
							The server's template does not state the level "{storedReasoningLevel}". A template that checks the
							level fails the request on one it does not list; pick Default or one of the template's levels.
						</p>
					)}
				</div>
			)}
			{thinkingEnabled && (
				<div className="mb-1">
					<Label className="text-xs font-medium">Thinking budget</Label>
					<Select onValueChange={(value) => handleLevelChange(value as ThinkingLevel)} value={thinkingLevel}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{THINKING_LEVELS.map((level) => (
								<SelectItem key={level} value={level}>
									{THINKING_LEVEL_LABELS[level]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs mt-1 mb-0 text-description">
						A budget is sent as <code>reasoning_budget_tokens</code>, its share of the reply this profile asks for:
						Minimal 1/16, Low 1/8, Medium 1/4, High 1/2, Max 4/5 — Ollama's own fractions, so a level means the same
						thing on both engines. <strong>Default sends no budget at all</strong>, which on this engine means
						unbounded unless the server was started with a budget flag of its own.
					</p>
					{thinkingLevel === "custom" && (
						<div className="mt-2">
							<DebouncedTextField
								className="w-full"
								initialValue={storedThinkBudget}
								numeric
								// Returned so the field's flush can be awaited.
								onChange={(value: string) => composeAndWrite({ thinkBudget: value })}
								placeholder="4096">
								<span className="font-medium text-xs">reasoning_budget_tokens</span>
							</DebouncedTextField>
							<p className="text-xs mt-1 mb-0 text-description">
								An absolute token count. Sent only while Custom is selected; picking any other level above clears
								it.
							</p>
						</div>
					)}
				</div>
			)}
		</div>
	)
}

export default ThinkingBudgetField
