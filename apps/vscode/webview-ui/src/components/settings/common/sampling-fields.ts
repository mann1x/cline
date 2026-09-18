import type { ProviderSamplingPatch } from "@shared/proto/cline/models"
import { useCallback, useEffect, useRef } from "react"
import { useApiConfigurationScope } from "@/components/settings/utils/ApiConfigurationScopeContext"
import { type ProviderConfigWritePatch, useProviderConfig } from "@/hooks/useProviderConfig"

/**
 * The sampler, once, for every engine that takes one.
 *
 * Ollama and llama.cpp accept the same parameters under different spellings —
 * `num_keep` against `n_keep`, `num_predict` against `n_predict` — so a panel
 * per engine would mean a description per engine, and two places for a range
 * check to disagree. The catalog holds the parameter; the dialect holds its
 * name.
 *
 * Every field is blank by default, and blank means "not sent". That is the
 * whole design: a local model carries its sampler in its Modelfile or on the
 * server's command line, usually one measured against that quant, and a
 * settings screen that shipped defaults would quietly replace it the first time
 * it was opened. Only what the user types is transmitted.
 */
export interface SamplingFieldSpec {
	readonly key: SamplingFieldKey
	readonly labels: { readonly ollama: string; readonly llamacpp: string | undefined }
	readonly kind: "number" | "integer"
	readonly hint: string
	readonly min?: number
	readonly max?: number
}

export type SamplingDialect = "ollama" | "llamacpp"

export type SamplingFieldKey =
	| "temperature"
	| "topK"
	| "topP"
	| "minP"
	| "typicalP"
	| "repeatLastN"
	| "repeatPenalty"
	| "presencePenalty"
	| "frequencyPenalty"
	| "seed"
	| "numPredict"
	| "numKeep"
	| "numGpu"

/**
 * In the order Ollama's API docs list them, which is also the order they were
 * shown in before this was shared.
 *
 * A `llamacpp` label of `undefined` means the parameter has no per-request form
 * on that engine and is therefore not offered there: `num_gpu` is decided by
 * `-ngl` when the server starts, so a field for it would be one the server does
 * not read. That is the same rule `LLAMACPP_SAMPLING_WIRE_NAMES` states on the
 * sending side, and the two lists must agree — a field offered here that is
 * absent there is a control that does nothing.
 */
export const SAMPLING_FIELDS: readonly SamplingFieldSpec[] = [
	{
		key: "temperature",
		labels: { ollama: "temperature", llamacpp: "temperature" },
		kind: "number",
		hint: "Randomness of the next-token choice. Lower is more deterministic.",
		min: 0,
		max: 2,
	},
	{
		key: "topK",
		labels: { ollama: "top_k", llamacpp: "top_k" },
		kind: "integer",
		hint: "Sample from the K most likely tokens.",
		min: 0,
		max: 1000,
	},
	{
		key: "topP",
		labels: { ollama: "top_p", llamacpp: "top_p" },
		kind: "number",
		hint: "Sample from the smallest set whose probabilities sum to P.",
		min: 0,
		max: 1,
	},
	{
		key: "minP",
		labels: { ollama: "min_p", llamacpp: "min_p" },
		kind: "number",
		hint: "Drop tokens below this fraction of the most likely one.",
		min: 0,
		max: 1,
	},
	{
		key: "typicalP",
		labels: { ollama: "typical_p", llamacpp: "typical_p" },
		kind: "number",
		hint: "Locally typical sampling.",
		min: 0,
		max: 1,
	},
	{
		key: "repeatLastN",
		labels: { ollama: "repeat_last_n", llamacpp: "repeat_last_n" },
		kind: "integer",
		hint: "How far back the repeat penalty looks. 0 disables it, -1 uses the whole context.",
	},
	{
		key: "repeatPenalty",
		labels: { ollama: "repeat_penalty", llamacpp: "repeat_penalty" },
		kind: "number",
		hint: "Penalty applied within that window.",
		min: 0,
		max: 2,
	},
	{
		key: "presencePenalty",
		labels: { ollama: "presence_penalty", llamacpp: "presence_penalty" },
		kind: "number",
		hint: "Flat penalty for tokens already used, over the whole context.",
		min: -2,
		max: 2,
	},
	{
		key: "frequencyPenalty",
		labels: { ollama: "frequency_penalty", llamacpp: "frequency_penalty" },
		kind: "number",
		hint: "Penalty proportional to how often a token was used, over the whole context.",
		min: -2,
		max: 2,
	},
	{
		key: "seed",
		labels: { ollama: "seed", llamacpp: "seed" },
		kind: "integer",
		hint: "Fixes sampling for reproducible runs.",
	},
	{
		// Offered on Ollama only. On llama.cpp the reply length is the automatic
		// output budget's to decide -- it is computed against the window and what
		// the last request was actually capped to, and a second, fixed answer to
		// the same question sitting above it would silently win.
		key: "numPredict",
		labels: { ollama: "num_predict", llamacpp: undefined },
		kind: "integer",
		hint: "Maximum tokens to generate. -1 is unlimited.",
	},
	{
		key: "numKeep",
		labels: { ollama: "num_keep", llamacpp: "n_keep" },
		kind: "integer",
		hint: "Tokens kept from the prompt when the context is trimmed.",
	},
	{
		key: "numGpu",
		labels: { ollama: "num_gpu", llamacpp: undefined },
		kind: "integer",
		hint: "Model layers to put on the GPU. -1 lets Ollama's estimator decide, which is conservative and has been measured refusing layers that fit. 0 keeps the model on the CPU. Anything at least the model's layer count puts all of them on the GPU — layer counts vary by model and can exceed 100, so use a number you know covers it.",
		min: -1,
		max: 9999,
	},
]

/** The fields an engine offers, with the name that engine calls each one. */
export function samplingFieldsFor(dialect: SamplingDialect): readonly (SamplingFieldSpec & { label: string })[] {
	return SAMPLING_FIELDS.flatMap((field) => {
		const label = field.labels[dialect]
		return label === undefined ? [] : [{ ...field, label }]
	})
}

/** Sampling values as a panel edits them: raw text, so a half-typed number survives a render. */
export type SamplingDraft = Partial<Record<SamplingFieldKey | "stop" | "thinkBudget" | "thinkBudgetMessage", string>>

/**
 * Whether the text is a number the user has finished typing.
 *
 * `Number("0.")` is 0, so committing on every keystroke turns a half-typed
 * `0.9` into a stored `0` — and the stored value then renders back over the
 * field, so the remaining `9` lands on a `0` that the user thought still had a
 * decimal point after it. Measured on pandorum: `top_p` was typed as `0.9` and
 * stored as `9`, `temperature` as `0.4` and stored as `4`, `repeat_penalty` as
 * `1.05` and stored as `105`. Every request for the following 73 minutes ran at
 * temperature 4.0 with a repeat penalty of 105, which is noise, and it was
 * diagnosed as the model misbehaving.
 *
 * So a value is only committed once it is a complete number. A trailing `.`,
 * a lone sign, or a half-written exponent means the user is mid-keystroke.
 */
export function isCompleteNumber(raw: string): boolean {
	return /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(raw.trim())
}

/**
 * Why this value cannot be sent, if it cannot.
 *
 * The range check is the part that does not depend on catching the input race
 * above: whatever route a number takes to get here, `top_p: 9` is not a
 * probability and must never reach the server. Silence would be worse than a
 * refusal — the panel would look set while the request carried something else.
 */
export function samplingProblem(field: { label: string; min?: number; max?: number }, raw: string): string | undefined {
	const trimmed = raw.trim()
	if (trimmed === "" || !isCompleteNumber(trimmed)) {
		return undefined
	}
	const value = Number(trimmed)
	if (field.min !== undefined && value < field.min) {
		return `${field.label} cannot be below ${field.min}.`
	}
	if (field.max !== undefined && value > field.max) {
		return `${field.label} cannot be above ${field.max}. Did you mean ${
			value >= 10 ? (value / 10 ** Math.ceil(Math.log10(value / field.max))).toString() : field.max
		}?`
	}
	return undefined
}

export function parseSamplingNumber(raw: string | undefined, kind: "number" | "integer"): number | undefined {
	const trimmed = raw?.trim()
	if (!trimmed) {
		return undefined
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) {
		return undefined
	}
	return kind === "integer" ? Math.trunc(parsed) : parsed
}

/** What is stored, as the panels read it back. */
export type StoredSampling = Record<string, unknown> | undefined

/**
 * The sampling section that the next write must be composed from.
 *
 * The store replaces this section wholesale rather than merging it field by
 * field, so every writer has to send the whole thing — and can therefore only
 * ever be as correct as the copy it composed from. `config.sampling` is a round
 * trip behind: two controls touched before the first answer comes back both
 * compose from the state of the render they were created in, and the second
 * write puts the first one's field back where it started. That is what a
 * setting that will not stay changed looks like from the chair, and it is the
 * same defect that was measured on the PolyKV toggle.
 *
 * The thinking level and the sampler are two such controls, on the same panel,
 * writing the same section — so the in-flight value has to be visible to both
 * of them, not private to one component. It is held here, keyed by the entry it
 * belongs to, and dropped once the last write for that entry has settled.
 */
const pendingSampling = new Map<string, { value: Record<string, unknown>; inFlight: number }>()

/** Test seam: the map outlives a render, so a test that writes must clear it. */
export function resetPendingSampling(): void {
	pendingSampling.clear()
}

/**
 * Which stored entry a panel is writing.
 *
 * Plan and Act share `providers.json`; Vision, Agents and Escalation each hold
 * a settings string of their own. Keying on the provider alone would let a
 * scoped tab's in-flight sampler compose into the session's write.
 */
function samplingEntryKey(providerId: string, scopeKey: string | undefined): string {
	return `${providerId}::${scopeKey ?? "session"}`
}

export interface SamplingWrite {
	/** The provider entry this is reading, so a caller needs only one hook. */
	readonly config: ReturnType<typeof useProviderConfig>["config"]
	/** The entry's own writer, for patches that touch no sampler field. */
	readonly write: ReturnType<typeof useProviderConfig>["write"]
	/** What is stored, with any in-flight write applied over it, at render time. */
	readonly sampling: Record<string, unknown> | undefined
	/** Whether the provider entry has resolved yet. */
	readonly loaded: boolean
	/**
	 * Composes the whole section from one control's draft and writes it.
	 *
	 * The composition happens here, when the control is used, rather than in
	 * the component that renders it. Nothing re-renders a component because
	 * another one has a write in flight, so a section composed at render time
	 * is composed from before that write — and this is the one moment where
	 * that difference is the bug.
	 */
	readonly composeAndWrite: (draft: SamplingDraft, alongside?: ProviderConfigWritePatch) => void
	/**
	 * Replaces the section, and keeps the value visible until the write lands.
	 *
	 * `alongside` rides in the same patch, for the writes that change the
	 * sampler and something else at once — the thinking level clears
	 * `think_budget` as it sets an effort, and splitting that into two writes
	 * would leave a window in which both answers are stored.
	 */
	readonly writeSampling: (next: ProviderSamplingPatch, alongside?: ProviderConfigWritePatch) => void
}

export function useSamplingWrite(providerId: string, dialect: SamplingDialect = "llamacpp"): SamplingWrite {
	const { config, write } = useProviderConfig(providerId as never)
	const scope = useApiConfigurationScope()
	const entryKey = samplingEntryKey(providerId, scope?.scopeKey)
	// Read when a control is used, not when it was rendered -- for the same
	// reason the pending record exists.
	const storedRef = useRef<Record<string, unknown> | undefined>(undefined)
	storedRef.current = config?.sampling as Record<string, unknown> | undefined

	// A pending value belongs to the panel that is writing. Leaving one behind
	// would compose it into the next panel's first write.
	useEffect(
		() => () => {
			pendingSampling.delete(entryKey)
		},
		[entryKey],
	)

	const stored = config?.sampling as Record<string, unknown> | undefined
	const sampling = pendingSampling.get(entryKey)?.value ?? stored

	const writeSampling = useCallback(
		(next: ProviderSamplingPatch, alongside?: ProviderConfigWritePatch) => {
			const entry = pendingSampling.get(entryKey) ?? { value: {}, inFlight: 0 }
			entry.value = next as unknown as Record<string, unknown>
			entry.inFlight += 1
			pendingSampling.set(entryKey, entry)
			void write({ ...alongside, sampling: next })
				.catch((error) => console.error("Failed to update sampling:", error))
				.finally(() => {
					entry.inFlight -= 1
					if (entry.inFlight === 0 && pendingSampling.get(entryKey) === entry) {
						pendingSampling.delete(entryKey)
					}
				})
		},
		[write, entryKey],
	)

	const composeAndWrite = useCallback(
		(draft: SamplingDraft, alongside?: ProviderConfigWritePatch) => {
			const base = pendingSampling.get(entryKey)?.value ?? storedRef.current
			writeSampling(buildSamplingPatch({ dialect, stored: base, draft }), alongside)
		},
		[writeSampling, entryKey, dialect],
	)

	return { config, write, sampling, loaded: config !== undefined, writeSampling, composeAndWrite }
}

/**
 * The whole section, with one draft applied over what is stored.
 *
 * The patch shape is the proto one, where `stop` is a plain repeated field and
 * therefore always present; every other parameter is optional and stays absent
 * when the user left it blank. An object with nothing set is how the section is
 * cleared — the write path reads "no parameters set" as "stop sending any".
 */
export function buildSamplingPatch(input: {
	dialect: SamplingDialect
	stored: Record<string, unknown> | undefined
	draft: SamplingDraft
}): ProviderSamplingPatch {
	const { dialect, stored, draft } = input
	const next: ProviderSamplingPatch = { stop: [] }
	// Every field in the catalog, not only this dialect's: a value set on one
	// engine and then read on another is still the user's, and dropping it here
	// would clear it the first time any other control on the panel was touched.
	for (const field of SAMPLING_FIELDS) {
		const storedValue = stored?.[field.key]
		const raw = draft[field.key] ?? (storedValue !== undefined && storedValue !== null ? String(storedValue) : "")
		// A half-typed or out-of-range value is not sent at all: leaving the
		// parameter absent keeps the model's own value in force, which is the
		// right answer while the user is still typing and the only safe one for
		// a value that cannot be valid.
		const label = field.labels[dialect] ?? field.labels.ollama
		if (raw.trim() !== "" && (!isCompleteNumber(raw) || samplingProblem({ ...field, label }, raw) !== undefined)) {
			continue
		}
		const parsed = parseSamplingNumber(raw, field.kind)
		if (parsed !== undefined) {
			next[field.key] = parsed
		}
	}
	const storedStop = Array.isArray(stored?.stop) ? (stored.stop as string[]) : []
	const stopRaw = draft.stop ?? storedStop.join("\n")
	next.stop = stopRaw
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")
	for (const key of ["thinkBudget", "thinkBudgetMessage"] as const) {
		const storedText = typeof stored?.[key] === "string" ? (stored[key] as string) : ""
		const raw = (draft[key] ?? storedText).trim()
		if (raw !== "") {
			next[key] = raw
		}
	}
	return next
}

/** How many parameters the section is actually sending. */
export function countSampling(stored: Record<string, unknown> | undefined): number {
	if (!stored) {
		return 0
	}
	return Object.entries(stored).filter(([, value]) =>
		Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "",
	).length
}
