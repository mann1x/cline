import { useRef } from "react"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { DebouncedTextField } from "./DebouncedTextField"

/**
 * The numbers this field shows, named here for the copy only.
 *
 * What reaches the wire is decided by `resolveOutputBudgetTokens` in
 * `@cline/shared`, which is the one authority on the range. That package cannot
 * be imported here — the webview bundle does not resolve its Node dependencies —
 * so these are restated rather than shared, and this file never decides what is
 * stored. Keep them in step with `output-budget.ts`.
 */
const AUTO_WINDOW_SHARE = 0.75
const CEILING_TOKENS = 512_000
/**
 * The point below which the gateway stops believing the cap.
 *
 * `GATEWAY_MIN_OUTPUT_TOKENS` in `sdk/packages/llms/src/providers/gateway.ts`.
 * Restated for the same reason as the two above, and the slider will not offer
 * a step under it: a cap the gateway treats as starved is not a setting.
 */
const MIN_OUTPUT_TOKENS = 1_024
/**
 * The most of the cap that may be spent thinking before the reply has nowhere
 * to go. Mirrors `OUTPUT_BUDGET_SAFE_SHARE` in `output-budget.ts`.
 */
const SAFE_THINK_SHARE = 0.75
/** Steps the slider moves in, as a share of the automatic figure. */
const STEP_PERCENT = 5

function parseTyped(value: string | number | undefined): number | undefined {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value
	if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
		return undefined
	}
	return parsed
}

/**
 * The floor the cap may not be tuned below, and why.
 *
 * `null` when only the gateway's own minimum applies. A number when the
 * thinking allowance is what binds — and that only happens for an explicitly
 * configured token count.
 *
 * A **level** (`high`, `medium`, …) needs no floor: the allowance is a fraction
 * of `min(num_predict, num_ctx)`, so lowering the cap lowers the allowance with
 * it and the reply always keeps its share. `high` on a 1,000-token cap is 500
 * tokens of thinking, not 8,000.
 *
 * A **bare token count** in `sampling.thinkBudget` is the opposite: it is sent
 * flat and never looks at the window, so it can be larger than the whole cap.
 * That is the failure this floor exists for — the turn spends its entire
 * allowance inside the thinking block, is cut mid-sentence, and no answer is
 * written. See `resolveLlamaCppThinkBudgetTokens`, which returns the parsed
 * number before the fraction table is ever consulted.
 */
export function thinkingFloorTokens(thinkBudget: string | number | undefined, thinkingEnabled: boolean): number | null {
	if (!thinkingEnabled) {
		return null
	}
	const raw = typeof thinkBudget === "string" ? thinkBudget.trim() : thinkBudget
	if (raw === undefined || raw === "") {
		return null
	}
	const asCount = Number(raw)
	// A level, not a count: it scales with the cap, so nothing to guard.
	if (!Number.isFinite(asCount) || asCount <= 0) {
		return null
	}
	// Room for the answer past the thinking, not merely room for the thinking.
	return Math.ceil(asCount / SAFE_THINK_SHARE)
}

/** The lowest step the slider offers, as a percentage of the automatic figure. */
export function minSliderPercent(autoValue: number, floorTokens: number): number {
	if (autoValue <= 0) {
		return 100
	}
	const exact = (floorTokens / autoValue) * 100
	const stepped = Math.ceil(exact / STEP_PERCENT) * STEP_PERCENT
	// A floor at or above the automatic figure leaves one position: the default.
	// Better a slider that cannot move than one that offers a cap which fails.
	return Math.min(100, Math.max(STEP_PERCENT, stepped))
}

/**
 * The per-turn output budget, per profile.
 *
 * One quantity under three names — Ollama's `num_predict`, llama.cpp's and
 * opencoti's `n_predict`, the catalog's `maxTokens` — which until now had two
 * settings and no owner. The advanced panel's `numPredict` was read for Ollama
 * alone, so an opencoti user's typed value was enforced by the server and
 * invisible to the system prompt and to compaction's budget: the model was told
 * one cap and held to another.
 *
 * Shown for every provider rather than a chosen few, for the same reason
 * `ParallelSessionsField` is: every endpoint holds a reply to some length, and
 * one field in one place is what stops two dozen panels disagreeing about what
 * it is called.
 *
 * **Automatic** asks for three quarters of the context window. Deliberately
 * generous — the cap's job is to avoid truncating a turn, not to ration one,
 * and a session measured on 2026-09-17 with 96,000 against a 128,000 window
 * actually spent 392 to 23,140 tokens per turn. It does not cost compaction
 * anything: what compaction reserves is sized from *measured* output, and the
 * declared cap only binds when it is the smaller of the two.
 *
 * The box is shown in both modes because it means something in both. Under
 * Automatic it is a ceiling of the user's own and may only lower the absolute
 * one; under Manual it is the cap itself.
 */
export const OutputBudgetField = ({ providerId }: { providerId: string }) => {
	const { config, write } = useProviderConfig(providerId as never)
	// What this panel has sent and not yet seen answered. The section is
	// written whole, and the panel does not see its own write until the host
	// answers -- so a cap typed straight after flipping the mode composed the
	// section from the pre-write state and put the mode back. Same fault, and
	// same fix, as the PolyKV section.
	const pending = useRef<Record<string, unknown> | undefined>(undefined)
	const inFlight = useRef(0)
	// Same reason the other cap fields wait: rendering before the config
	// resolves would show a blank over a stored number.
	if (config === undefined) {
		return null
	}
	const budget = (pending.current ?? config.outputBudget ?? {}) as NonNullable<typeof config.outputBudget>
	// Absent reads as automatic, which is what a profile written before this
	// setting existed means. Only an explicit "manual" turns it off.
	const auto = budget.mode !== "manual"
	const stored = parseTyped(budget.maxTokens)

	// Written whole, never merged: this panel owns the section and shows its
	// complete state, so a merge would make clearing the box impossible.
	const patch = (changes: { mode?: "auto" | "manual"; maxTokens?: number }) => {
		// Read at call time, not from the render this closure was made in: two
		// controls touched inside one round trip share a closure, so a section
		// captured at render is the stale one by the second of them.
		const base = (pending.current ?? config.outputBudget ?? {}) as { mode?: "auto" | "manual"; maxTokens?: number }
		const next = {
			mode: base.mode ?? "auto",
			// Zero is how the wire says "empty"; the host drops it rather than
			// storing a cap of nothing.
			maxTokens: parseTyped(base.maxTokens) ?? 0,
			...changes,
		}
		pending.current = next
		inFlight.current += 1
		void write({ outputBudget: next })
			.catch((error) => console.error("Failed to update output budget:", error))
			.finally(() => {
				inFlight.current -= 1
				// Only the last answer hands the section back to the config: an
				// earlier one landing first would drop everything typed since.
				if (inFlight.current === 0) {
					pending.current = undefined
				}
			})
	}

	const window = parseTyped(config.contextWindow)
	const autoValue = window ? Math.min(Math.floor(window * AUTO_WINDOW_SHARE), CEILING_TOKENS) : undefined

	// What the wire will actually carry, which is not necessarily this setting:
	// a `num_predict` in the Advanced sampler is read ahead of the budget and
	// wins. Shown rather than silently overridden, because a slider that moves
	// and changes nothing is worse than no slider.
	const numPredict = parseTyped(config.sampling?.numPredict as string | number | undefined)
	const thinkFloor = thinkingFloorTokens(
		config.sampling?.thinkBudget as string | number | undefined,
		config.reasoning?.enabled !== false,
	)
	const floorTokens = Math.max(MIN_OUTPUT_TOKENS, thinkFloor ?? 0)
	// The slider is a percentage *of the automatic figure*, so it needs one to
	// be a percentage of. With no window there is no such number and the box
	// below is the only honest control.
	const minPercent = autoValue ? minSliderPercent(autoValue, floorTokens) : 100
	const percent = autoValue
		? Math.min(
				100,
				Math.max(minPercent, stored ? Math.round(((stored / autoValue) * 100) / STEP_PERCENT) * STEP_PERCENT : 100),
			)
		: 100
	const sliderTokens = autoValue ? Math.min(autoValue, Math.floor((autoValue * percent) / 100)) : undefined

	return (
		<div className="flex flex-col gap-1 mb-[5px]">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor="output-budget-auto">
					Automatic output budget
				</Label>
				<Switch
					checked={auto}
					className="shrink-0"
					id="output-budget-auto"
					onCheckedChange={(checked) => patch({ mode: checked ? "auto" : "manual" })}
					size="default"
				/>
			</div>
			{/* Above the box because it drives it: the slider writes the same
			    ceiling the box holds, so the two are one value seen twice. A
			    512,000-token default is the right *bound* and the wrong thing
			    to hand a model that has started looping -- it will keep going
			    for as long as the cap allows, and until now the only way down
			    was to know the arithmetic and type the answer. */}
			{auto && autoValue !== undefined && (
				<div className="flex flex-col gap-1 mt-[6px]">
					<div className="flex items-center justify-between w-full">
						<Label className="text-xs font-medium text-foreground" htmlFor="output-budget-share">
							Share of the automatic budget
						</Label>
						<span className="text-xs text-description" data-testid="output-budget-percent">
							{percent}%
						</span>
					</div>
					<Slider
						aria-label="Share of the automatic output budget"
						id="output-budget-share"
						max={100}
						min={minPercent}
						onValueChange={([next]) => {
							// 100% is the absence of a ceiling, not a ceiling
							// that happens to equal the default: stored as a
							// number it would pin the cap to today's window and
							// stop tracking it.
							patch({ maxTokens: next >= 100 ? undefined : Math.floor((autoValue * next) / 100) })
						}}
						step={STEP_PERCENT}
						value={[percent]}
					/>
					{/* The number the percentage means. A slider whose effect is
					    a share of a figure shown nowhere is a slider nobody can
					    set deliberately. */}
					<div
						className="rounded-sm border border-(--vscode-panel-border) bg-(--vscode-textBlockQuote-background) px-[8px] py-[6px] text-xs text-description"
						data-testid="output-budget-readout">
						<div className="text-foreground">
							{percent === 100 ? "Caps each reply at " : "Caps each reply at "}
							<span className="font-semibold">{sliderTokens?.toLocaleString()}</span> tokens
						</div>
						<div className="mt-[2px]">
							{percent}% of the automatic {autoValue.toLocaleString()} ({AUTO_WINDOW_SHARE * 100}% of a{" "}
							{window?.toLocaleString()}-token window)
							{percent === 100 ? ", which is the default." : "."}
						</div>
						{thinkFloor !== null && (
							<div className="mt-[2px]">
								Floor {floorTokens.toLocaleString()}: thinkBudget is set to a flat{" "}
								{Number(config.sampling?.thinkBudget).toLocaleString()} tokens, which is sent whatever the cap is.
								Below this the turn spends its whole allowance thinking and is cut before it writes an answer. A
								level instead of a count scales with the cap and needs no floor.
							</div>
						)}
						{thinkFloor === null && minPercent > STEP_PERCENT && (
							<div className="mt-[2px]">
								Floor {MIN_OUTPUT_TOKENS.toLocaleString()}, below which the cap is treated as starved.
							</div>
						)}
						{numPredict !== undefined && (
							<div className="mt-[2px] text-(--vscode-editorWarning-foreground)">
								num_predict is set to {numPredict.toLocaleString()} in Advanced, and that goes on the wire ahead
								of this. Clear it for this slider to have any effect.
							</div>
						)}
					</div>
				</div>
			)}
			<DebouncedTextField
				initialValue={stored ? String(stored) : ""}
				numeric
				onChange={(value) => {
					const next = parseTyped(value)
					if (next === stored) {
						return
					}
					patch({ maxTokens: next })
				}}
				placeholder={auto ? `Default: ${CEILING_TOKENS}` : autoValue ? `Default: ${autoValue}` : "Default"}
				style={{ width: "100%" }}>
				<span className="font-semibold">{auto ? "Ceiling" : "Max output tokens"}</span>
			</DebouncedTextField>
			<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">{outputBudgetDescription(auto, autoValue)}</p>
		</div>
	)
}

/**
 * The copy under the field, for the mode it is in.
 *
 * Two sentences rather than one paragraph covering both: the box changes
 * meaning between the modes, and a description that has to be read twice to
 * work out which half applies is how a setting gets set wrong.
 */
export function outputBudgetDescription(auto: boolean, autoValue: number | undefined): string {
	if (!auto) {
		return (
			"The longest reply this profile will ask for — Ollama's num_predict, n_predict for llama.cpp and opencoti. " +
			`Sent as typed, up to ${CEILING_TOKENS.toLocaleString()}. Leave it empty to fall back to the automatic figure.`
		)
	}
	const target = autoValue ? `${autoValue.toLocaleString()} for this profile's window` : "three quarters of the context window"
	return (
		`Three quarters of the context window — ${target}. ` +
		`The box is a ceiling of your own and can only lower the ${CEILING_TOKENS.toLocaleString()} limit, never raise it: ` +
		"models that advertise a megatoken window start struggling well before they reach it, so a share of the window " +
		"stops being a safe rule past about half a million tokens."
	)
}

export default OutputBudgetField
