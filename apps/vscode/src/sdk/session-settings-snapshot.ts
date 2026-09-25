import { getPolykvWindowGrant } from "@cline/llms"
import { Logger } from "@shared/services/Logger"
import { WINDOW_GRANT_SETTINGS_KEY } from "./context-window-grant"
import { resolveDataDir } from "./legacy-state-reader"
import { toSdkProviderId } from "./model-catalog/sdk-provider-id"
import { getProviderSettingsManager } from "./provider-migration"

/**
 * What a session ran with, recorded when it starts.
 *
 * The history list can say which provider and model a session used, because
 * the manifest carries both. It could say nothing about *how* the model was
 * called -- the sampler, the context window, the output budget, which tools
 * were in -- and those are the settings that decide whether two runs of the
 * same prompt on the same model behave the same way. Reading them back off
 * providers.json later answers a different question: what the provider is
 * configured with *now*.
 *
 * So the values are copied into the session's own metadata at start. A session
 * resumed after a settings change is re-stamped, which is correct: it really
 * did run again, with those.
 *
 * Credentials never enter this. `apiKey` and friends are not in the list
 * below, and neither are `headers` (which routinely carry an Authorization
 * line), `aws` or `gcp`. A session record is exported, pasted into issues and
 * synced between machines.
 */
export const SESSION_SETTINGS_METADATA_KEY = "settings"

/**
 * The providers.json fields worth recording, which is every one that changes
 * what the model is asked to do.
 *
 * Deliberately a subset of `PROVIDER_CONFIG_PROFILE_KEYS`: that list exists to
 * restore a panel, so it also carries how the endpoint is reached. This one
 * exists to explain a run.
 */
const RECORDED_SETTING_KEYS = [
	"contextWindow",
	"maxToolResultChars",
	"parallelSessions",
	"reasoning",
	"sampling",
	"polykv",
	"outputBudget",
	"tools",
	"apiLine",
] as const

/**
 * True for `undefined`, `""`, `[]`, `{}` and objects whose values are all empty.
 *
 * `false` is NOT empty. `reasoning.enabled: false` is the statement "thinking
 * was off", which is exactly the kind of thing the card exists to say. What is
 * worth a row is decided when the rows are built, not here: this only keeps a
 * key that was never set out of the record.
 */
function isEmptyValue(value: unknown): boolean {
	if (value === undefined || value === null || value === "") {
		return true
	}
	if (Array.isArray(value)) {
		return value.length === 0
	}
	if (typeof value === "object") {
		const entries = Object.values(value as Record<string, unknown>)
		return entries.length === 0 || entries.every(isEmptyValue)
	}
	return false
}

/**
 * Read the provider's stored settings and keep the part that explains the run.
 *
 * Returns `undefined` rather than an empty object when there is nothing to
 * record, so a session with nothing configured carries no key at all and the
 * reader can tell "not recorded" from "recorded, and there was nothing".
 */
export function captureSessionSettings(providerId: string | undefined, sessionId?: string): Record<string, unknown> | undefined {
	if (!providerId) {
		return undefined
	}
	// The window opencoti granted this conversation, when one is known -- on a
	// resume it was hydrated from the record this snapshot is about to replace.
	// Re-stamping without it would forget the one setting that has to survive:
	// the window the conversation must ask for again.
	const grant = sessionId ? getPolykvWindowGrant(sessionId) : undefined
	let stored: Record<string, unknown> | undefined
	try {
		stored = getProviderSettingsManager(resolveDataDir()).getProviderSettings(toSdkProviderId(providerId)) as
			| Record<string, unknown>
			| undefined
	} catch (error) {
		// A session must start whether or not providers.json can be read.
		Logger.warn("[SessionSettings] Failed to read provider settings for the session record:", error)
		return grant ? { [WINDOW_GRANT_SETTINGS_KEY]: { ...grant } } : undefined
	}
	const recorded: Record<string, unknown> = {}
	for (const key of RECORDED_SETTING_KEYS) {
		const value = stored?.[key]
		if (!isEmptyValue(value)) {
			recorded[key] = value
		}
	}
	if (grant) {
		recorded[WINDOW_GRANT_SETTINGS_KEY] = { ...grant }
	}
	return Object.keys(recorded).length > 0 ? recorded : undefined
}

/** One line of the history list's hover card. */
export interface SessionSettingRow {
	label: string
	value: string
}

const numberFormat = new Intl.NumberFormat("en-US")

function formatNumber(value: unknown): string | undefined {
	return typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** `repeatLastN` -> `repeat last n`, so the sampler reads as its own field names. */
function humanizeKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.toLowerCase()
}

function describeOutputBudget(budget: Record<string, unknown>): string | undefined {
	const mode = typeof budget.mode === "string" ? budget.mode : undefined
	const cap = formatNumber(budget.maxTokens)
	if (mode === "manual") {
		return cap ? `manual, ${cap} tokens` : "manual"
	}
	if (mode === "auto") {
		return cap ? `auto, ${cap} tokens` : "auto"
	}
	return cap
}

function describeReasoning(reasoning: Record<string, unknown>): string | undefined {
	if (reasoning.enabled === false) {
		return "off"
	}
	const parts: string[] = []
	if (typeof reasoning.effort === "string" && reasoning.effort) {
		parts.push(`effort ${reasoning.effort}`)
	}
	const budget = formatNumber(reasoning.budgetTokens)
	if (budget) {
		parts.push(`budget ${budget}`)
	}
	if (parts.length === 0) {
		return reasoning.enabled === true ? "on" : undefined
	}
	return parts.join(", ")
}

/**
 * Render a recorded snapshot as the rows the hover card shows.
 *
 * Only what was actually stored appears. providers.json holds a field once
 * something sets it, so "stored" and "not left at the default" are the same
 * statement for everything here -- with one exception handled explicitly:
 * a section every one of whose switches is off says nothing and is dropped by
 * {@link isEmptyValue} at capture time.
 *
 * `provider` and `model` lead, and come from the session record rather than
 * the snapshot, so a session recorded before any of this still gets two rows
 * instead of none.
 */
export function describeSessionSettings(input: { provider?: string; model?: string; settings?: unknown }): SessionSettingRow[] {
	const rows: SessionSettingRow[] = []
	if (input.provider) {
		rows.push({ label: "Provider", value: input.provider })
	}
	if (input.model) {
		rows.push({ label: "Model", value: input.model })
	}

	const settings = asRecord(input.settings)
	if (!settings) {
		return rows
	}

	const contextWindow = formatNumber(settings.contextWindow)
	if (contextWindow) {
		rows.push({ label: "Context window", value: `${contextWindow} tokens` })
	}

	const grant = asRecord(settings[WINDOW_GRANT_SETTINGS_KEY])
	const granted = grant && formatNumber(grant.granted)
	if (granted) {
		rows.push({ label: "Granted window", value: `${granted} tokens` })
	}

	const outputBudget = asRecord(settings.outputBudget)
	const budgetText = outputBudget && describeOutputBudget(outputBudget)
	if (budgetText) {
		rows.push({ label: "Output budget", value: budgetText })
	}

	const reasoning = asRecord(settings.reasoning)
	const reasoningText = reasoning && describeReasoning(reasoning)
	if (reasoningText) {
		rows.push({ label: "Reasoning", value: reasoningText })
	}

	const sampling = asRecord(settings.sampling)
	if (sampling) {
		for (const [key, value] of Object.entries(sampling)) {
			if (isEmptyValue(value)) {
				continue
			}
			rows.push({ label: humanizeKey(key), value: String(value) })
		}
	}

	const parallelSessions = formatNumber(settings.parallelSessions)
	if (parallelSessions) {
		rows.push({ label: "Parallel sessions", value: parallelSessions })
	}

	const maxToolResultChars = formatNumber(settings.maxToolResultChars)
	if (maxToolResultChars) {
		rows.push({ label: "Tool result cap", value: `${maxToolResultChars} chars` })
	}

	if (typeof settings.apiLine === "string" && settings.apiLine) {
		rows.push({ label: "API line", value: settings.apiLine })
	}

	const polykv = asRecord(settings.polykv)
	if (polykv) {
		const on = Object.entries(polykv)
			.filter(([, value]) => value === true)
			.map(([key]) => humanizeKey(key))
		if (on.length > 0) {
			rows.push({ label: "PolyKV", value: on.join(", ") })
		}
	}

	const tools = settings.tools
	if (Array.isArray(tools) && tools.length > 0) {
		rows.push({ label: "Tools", value: tools.join(", ") })
	}

	return rows
}
