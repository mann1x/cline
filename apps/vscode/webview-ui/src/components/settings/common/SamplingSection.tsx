import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { DebouncedTextArea } from "./DebouncedTextArea"
import { DebouncedTextField } from "./DebouncedTextField"
import {
	countSampling,
	isCompleteNumber,
	type SamplingDialect,
	type SamplingDraft,
	type SamplingFieldKey,
	samplingFieldsFor,
	samplingProblem,
	useSamplingWrite,
} from "./sampling-fields"

/** Placeholders are shown in a two-column grid in a sidebar; this is what fits. */
const SAMPLING_PLACEHOLDER_MAX_LENGTH = 48

interface SamplingSectionProps {
	providerId: string
	/** Which engine's parameter names and field list to show. */
	dialect: SamplingDialect
	/**
	 * What the selected model itself sets, keyed by the engine's own spelling,
	 * so a blank field can say which value it is leaving in force instead of
	 * only that it is leaving one. Ollama answers this from `/api/show`; a
	 * llama.cpp server does not report it, and the fields then read "model
	 * default" as they always did.
	 */
	modelParameters?: Record<string, string>
	/** Offered only where the engine reads it. */
	showThinkBudgetMessage?: boolean
	/**
	 * Discards the draft when it changes. The draft is the user's own text and
	 * deliberately outlives a write, so something has to end it: a different
	 * model, a different tab or a different profile is a different set of
	 * values, and carrying half-typed numbers across would show them as though
	 * they were stored.
	 */
	resetKey?: string
	/** Rendered at the end of the expanded body. */
	footer?: ReactNode
}

/**
 * The sampler, as a collapsible section.
 *
 * Collapsed by default: these are the model's own knobs and most sessions never
 * touch them, but when a model misbehaves they are the only thing that changes
 * its behaviour.
 *
 * Shared between Ollama and the OpenAI-compatible form, which is what llama.cpp
 * and opencoti are reached through. Both engines take the same parameters and
 * both were already given them on the wire; only this half was missing on the
 * second one.
 */
export const SamplingSection = ({
	providerId,
	dialect,
	modelParameters,
	showThinkBudgetMessage,
	resetKey,
	footer,
}: SamplingSectionProps) => {
	const { sampling, loaded, writeSampling, composeAndWrite } = useSamplingWrite(providerId, dialect)
	const [expanded, setExpanded] = useState(false)
	// Sampling is edited as text and committed once the number is complete:
	// these are values a user types digit by digit, and writing on every
	// keystroke would persist "0." and "1e" as settings.
	//
	// The draft outlives the write, which is the opposite of what an earlier
	// version did and the reason decimals could not be typed. `DebouncedTextField`
	// re-syncs its contents whenever `initialValue` changes and no user edit is
	// pending, and clears that pending flag *before* `onChange` runs -- so
	// committing and then emptying the draft let the store's echo land in an
	// unguarded window and overwrite what had been typed since. Keeping the
	// draft means `initialValue` is whatever the user last typed, so there is
	// nothing for the echo to overwrite.
	//
	// The cost is that a write from somewhere else does not show up in a field
	// that has been touched, until the section is reset or `resetKey` changes.
	// That is the right way round: the value on screen is the one being typed.
	const [draft, setDraft] = useState<SamplingDraft>({})
	// The same draft, readable without going through a state updater. A commit
	// runs from inside `onChange`, and reaching the latest draft by writing
	// through `setDraft` would issue the write from inside a render -- which
	// React reports as a nested update and which would make the order of two
	// keystrokes depend on when the render happened.
	const draftRef = useRef<SamplingDraft>({})

	// biome-ignore lint/correctness/useExhaustiveDependencies: the draft is cleared because this changed, so it is the dependency even though the body does not read it
	useEffect(() => {
		draftRef.current = {}
		setDraft({})
	}, [resetKey])

	const fields = samplingFieldsFor(dialect)

	const value = useCallback(
		(key: SamplingFieldKey | "stop" | "thinkBudget" | "thinkBudgetMessage"): string => {
			const drafted = draft[key]
			if (drafted !== undefined) {
				return drafted
			}
			if (!sampling) {
				return ""
			}
			if (key === "stop") {
				return (Array.isArray(sampling.stop) ? (sampling.stop as string[]) : []).join("\n")
			}
			const stored = sampling[key]
			return stored === undefined || stored === null ? "" : String(stored)
		},
		[draft, sampling],
	)

	const change = useCallback((key: SamplingFieldKey | "stop" | "thinkBudgetMessage", text: string) => {
		draftRef.current = { ...draftRef.current, [key]: text }
		setDraft(draftRef.current)
	}, [])

	const commitDraft = useCallback(() => {
		composeAndWrite(draftRef.current)
	}, [composeAndWrite])

	const reset = useCallback(() => {
		draftRef.current = {}
		setDraft({})
		// An empty patch is how the section is cleared: no parameter set means
		// nothing to send, which the write path stores as no sampling at all.
		writeSampling({ stop: [] })
	}, [writeSampling])

	const placeholder = useCallback(
		(name: string): string => {
			const raw = modelParameters?.[name]
			if (raw === undefined) {
				return "model default"
			}
			const collapsed = raw.replace(/\s+/g, " ").trim()
			return collapsed.length > SAMPLING_PLACEHOLDER_MAX_LENGTH
				? `${collapsed.slice(0, SAMPLING_PLACEHOLDER_MAX_LENGTH - 1)}…`
				: collapsed
		},
		[modelParameters],
	)

	// Rendering before the entry resolves would show an empty sampler over a
	// profile that says something else.
	if (!loaded) {
		return null
	}

	const count = countSampling(sampling)

	return (
		<div className="flex flex-col gap-1">
			<button
				aria-expanded={expanded}
				className="flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer text-left text-foreground"
				onClick={() => setExpanded((open) => !open)}
				type="button">
				<span className={`codicon codicon-chevron-${expanded ? "down" : "right"} text-xs`} />
				<span className="text-xs font-medium uppercase tracking-wider">Advanced</span>
				{count > 0 && (
					<span className="text-xs text-description">
						({count} sampling {count === 1 ? "parameter" : "parameters"} set)
					</span>
				)}
			</button>
			{expanded && (
				<div className="flex flex-col gap-2 mt-1">
					<p className="text-xs mt-0 mb-1 text-description">
						Sampling parameters sent with every request. Leave a field empty to not send it at all, which leaves
						whatever the model was built with in force — a Modelfile's own values, or the ones the server was started
						with, are not overwritten by an empty field here. Anything you do set overrides the model's value for this
						provider. A greyed value is the one the model itself sets; fields reading “model default” are not set by
						the model either, and fall back to the engine's own.
					</p>
					<div className="grid grid-cols-2 gap-2">
						{fields.map((field) => {
							const raw = value(field.key)
							const problem = samplingProblem(field, raw)
							return (
								<div key={field.key}>
									<DebouncedTextField
										className="w-full"
										initialValue={raw}
										numeric
										onChange={(text: string) => {
											change(field.key, text)
											// Committing a half-typed number stores it and
											// renders it back over the field, which is how
											// `0.9` became `9`. Wait until it is finished.
											if (text.trim() === "" || isCompleteNumber(text)) {
												commitDraft()
											}
										}}
										placeholder={placeholder(field.label)}>
										<span className="font-medium text-xs">{field.label}</span>
									</DebouncedTextField>
									{problem ? (
										<p className="text-xs mt-0 mb-0 text-error">{problem} Not sent.</p>
									) : (
										<p className="text-xs mt-0 mb-0 text-description">{field.hint}</p>
									)}
								</div>
							)
						})}
					</div>
					<div>
						<DebouncedTextField
							className="w-full"
							initialValue={value("stop")}
							onChange={(text: string) => {
								change("stop", text)
								commitDraft()
							}}
							placeholder={modelParameters?.stop ? placeholder("stop") : "one sequence per line"}>
							<span className="font-medium text-xs">stop</span>
						</DebouncedTextField>
						<p className="text-xs mt-0 mb-0 text-description">Sequences that end generation, one per line.</p>
					</div>
					{showThinkBudgetMessage && (
						<div>
							<DebouncedTextArea
								className="w-full"
								initialValue={value("thinkBudgetMessage")}
								onChange={(text: string) => {
									change("thinkBudgetMessage", text)
									commitDraft()
								}}
								// The model's own message runs to several paragraphs, so
								// the placeholder is the whole of it rather than the
								// truncated one line the other fields use: this is the
								// value the user is deciding whether to replace.
								placeholder={modelParameters?.think_budget_message ?? "the model's own message"}>
								<span className="font-medium text-xs">think_budget_message</span>
							</DebouncedTextArea>
							<p className="text-xs mt-0 mb-0 text-description">
								Written into the thinking block just before the closing tag is forced, so the model reads that it
								has to answer now rather than being cut off with no explanation.
							</p>
						</div>
					)}
					{count > 0 && (
						<VSCodeLink
							className="text-xs self-start"
							href="#"
							onClick={(event) => {
								event.preventDefault()
								reset()
							}}>
							Clear all sampling parameters
						</VSCodeLink>
					)}
					{footer}
				</div>
			)}
		</div>
	)
}
