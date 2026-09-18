import { useRef } from "react"
import { Label } from "@/components/ui/label"
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

function parseTyped(value: string | number | undefined): number | undefined {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value
	if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
		return undefined
	}
	return parsed
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
			<DebouncedTextField
				initialValue={stored ? String(stored) : ""}
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
