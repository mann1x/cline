import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useProviderConfig } from "@/hooks/useProviderConfig"

type Mode = "auto" | "all" | "last" | "none"

const MODES: { value: Mode; label: string }[] = [
	{ value: "auto", label: "Automatic" },
	{ value: "last", label: "Last block only" },
	{ value: "all", label: "Everything" },
	{ value: "none", label: "Nothing" },
]

/**
 * How much of the model's own prior thinking is sent back to it.
 *
 * Not a preference about verbosity — a question about the endpoint. A local
 * engine only re-renders reasoning into the prompt if its chat template says
 * so, and the same engine answers differently per model and between releases,
 * so **Automatic measures it** rather than assuming: ollama is asked the same
 * conversation twice and the prompt-token difference is the answer, and
 * llama.cpp/opencoti render a needle through `/apply-template` and are read.
 *
 * Measured 2026-09-18 on a live ollama, the same three messages cost 48 prompt
 * tokens without a thinking field and 929 with one, so this is worth several
 * hundred tokens a turn in either direction.
 *
 * Automatic never chooses **Everything**, and that is deliberate rather than
 * cautious: ollama re-renders every assistant think block that follows the last
 * *user* turn, and an agent run has exactly one user message, so Everything
 * puts the entire accumulated thinking history into every prompt. One measured
 * run produced 413,766 characters of reasoning in fifty turns.
 *
 * The explicit choices outrank the measurement, which is what makes a template
 * you are about to change testable, and what lets a provider nobody can probe
 * be set by hand.
 */
export const ReasoningHistoryField = ({ providerId }: { providerId: string }) => {
	const { config, write } = useProviderConfig(providerId as never)
	// Same reason the other provider fields wait for the config: rendering
	// before it resolves would show Automatic over a profile that says
	// something else, and the first change would persist the wrong value.
	if (config === undefined) {
		return null
	}
	// Absent means Automatic — which is what every profile written before this
	// setting existed means, and what clearing it goes back to.
	const selected = (config.reasoning?.reasoningHistory as Mode | undefined) ?? "auto"
	// On unless the profile says otherwise, the same way the resolver reads it.
	const inline = config.reasoning?.reasoningInline !== false

	return (
		<div className="flex flex-col gap-1 mb-[5px]">
			<label htmlFor="reasoning-history">
				<span className="font-semibold">Reasoning replay</span>
			</label>
			<VSCodeDropdown
				className="w-full"
				id="reasoning-history"
				onChange={(event) => {
					const next = (event.target as HTMLSelectElement).value as Mode
					if (next === selected) {
						return
					}
					void write({
						// Automatic is stored as cleared, so the resolver falls
						// through to the measurement instead of pinning a value
						// that was only ever a default.
						reasoning: { reasoningHistory: next === "auto" ? "" : next },
					}).catch((error) => console.error("Failed to update reasoning replay:", error))
				}}
				value={selected}>
				{MODES.map((mode) => (
					<VSCodeOption key={mode.value} value={mode.value}>
						{mode.label}
					</VSCodeOption>
				))}
			</VSCodeDropdown>
			<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">{reasoningHistoryDescription(selected)}</p>
			{selected === "auto" ? (
				<div className="mt-[5px]">
					<VSCodeCheckbox
						checked={inline}
						onChange={(event) => {
							const next = (event.target as HTMLInputElement).checked
							if (next === inline) {
								return
							}
							void write({ reasoning: { reasoningInline: next } }).catch((error) =>
								console.error("Failed to update reasoning inlining:", error),
							)
						}}>
						Inline thinking when the template drops it
					</VSCodeCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Only under Automatic, and only where the endpoint has been measured to render none of the reasoning field:
						the last block is folded into the assistant's own message as <code>&lt;think&gt;…&lt;/think&gt;</code>,
						which every chat template does render. Turn it off to send nothing rather than spend the tokens.
					</p>
				</div>
			) : null}
		</div>
	)
}

/**
 * The copy under the field, for the mode it is in.
 *
 * One sentence per mode rather than a paragraph covering all four: the modes
 * differ in what they cost, not in degree, and a description that has to be
 * read twice to find the half that applies is how a setting gets set wrong.
 */
export function reasoningHistoryDescription(mode: Mode): string {
	switch (mode) {
		case "all":
			return (
				"Every earlier thinking block goes back on every request. On a local engine that re-renders them, " +
				"an agent run has one user message, so this grows the prompt without limit — measured at 413,766 " +
				"characters in a fifty-turn run."
			)
		case "last":
			return "Only the most recent thinking block goes back, so the model keeps its train of thought without the prompt growing without limit."
		case "none":
			return "Prior thinking is never sent back. The model still thinks on every turn; it just starts each one without its earlier reasoning."
		default:
			return (
				"Asks the endpoint what it actually does with prior reasoning — whether it accepts it and whether it " +
				"renders it back into the prompt — and sends the last block only when it does. Providers that cannot be " +
				"measured keep what they have always done."
			)
	}
}

export default ReasoningHistoryField
