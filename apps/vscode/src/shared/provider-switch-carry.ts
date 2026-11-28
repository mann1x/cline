import type { Mode } from "@shared/storage/types"
import {
	captureProviderConfigSnapshot,
	PROVIDER_CONFIG_MODEL_OVERRIDES_KEY,
	providerConfigPatchForProfile,
} from "./api-config-snapshot"

/**
 * Carrying the panel across a provider switch inside one family.
 *
 * `providers.json` keeps one entry per provider, and the panel shows the entry
 * of whichever provider is selected. Switching provider only changed the id, so
 * the panel then showed the *target's* entry: whatever was last written there,
 * usually by an unrelated profile loaded on that provider days earlier. Measured
 * on pandorum (2026-11-28): a solidpc profile moved from Ollama to xOllama came
 * up showing the "pandorumx - Bonsai ptq1" profile's server (127.0.0.1:22434),
 * model and 192k window, and Update saved that over the solidpc profile.
 *
 * Within a family the two providers speak the same API with the same fields,
 * and a switch means "same server, upgraded or under test", so the panel moves
 * with it: base URL, model, context window, sampler, reasoning and the rest of
 * what the panel shows. The base URL goes too. The user will often change it
 * next, and the starting point should be the server they were just looking at,
 * not one left over from another profile.
 *
 * Settings only one side has stay with the target: xOllama's and opencoti's
 * PolyKV, notices and parallel sessions mean nothing on Ollama or llama.cpp, and
 * the other way round. Switching to a provider outside the family carries
 * nothing; the fields differ there and the target's entry is the right start.
 */
export const PROVIDER_FAMILIES: ReadonlyArray<ReadonlyArray<string>> = [
	["ollama", "xollama"],
	["opencoti", "llamacpp"],
]

/**
 * The fields that stay with the target provider on a family switch.
 *
 * Profile keys that are not carried: each is a feature of one engine, or a
 * per-node share, so the source's value (or its absence, which the profile
 * patch turns into a clear) would be wrong on the other side.
 */
export const PROVIDER_SWITCH_TARGET_KEYS = ["polykv", "notices", "parallelSessions", "agentWindow"] as const

/** Whether two provider ids are the two halves of one family. */
export function sameProviderFamily(from: string | undefined, to: string | undefined): boolean {
	if (!from || !to || from === to) {
		return false
	}
	return PROVIDER_FAMILIES.some((family) => family.includes(from) && family.includes(to))
}

export interface ProviderSwitchCarry {
	/** The providers.json patch for the target entry, with clears for what the source does not hold. */
	patch: Record<string, unknown>
	/** The model to commit on the target, per mode; absent where the source had none. */
	selections: Partial<Record<Mode, { modelId: string; overrides?: Record<string, unknown> }>>
}

/**
 * What a family switch writes onto the target, read from the source's entry.
 *
 * `undefined` when the switch is not inside a family or the source entry has
 * not been read yet; the switch then behaves as it always did.
 *
 * The patch is built the way a profile load builds one, so a field the source
 * does not hold clears the target's instead of letting the target's old value
 * through: that inherited value is exactly the bug.
 */
export function providerSwitchCarry(
	from: string | undefined,
	to: string | undefined,
	sourceConfig: unknown,
	modes: readonly Mode[],
): ProviderSwitchCarry | undefined {
	if (!sameProviderFamily(from, to) || !sourceConfig || typeof sourceConfig !== "object") {
		return undefined
	}
	const captured = captureProviderConfigSnapshot(sourceConfig, modes[0] ?? "act") ?? {}
	const carried: Record<string, unknown> = { ...captured }
	delete carried[PROVIDER_CONFIG_MODEL_OVERRIDES_KEY]
	for (const key of PROVIDER_SWITCH_TARGET_KEYS) {
		delete carried[key]
	}
	const patch = providerConfigPatchForProfile(carried)
	// The profile patch fills a clear for every section it does not see,
	// including the target's own ones removed above. Those must not be touched.
	for (const key of PROVIDER_SWITCH_TARGET_KEYS) {
		delete patch[key]
	}

	const source = sourceConfig as Record<string, unknown>
	const selections: ProviderSwitchCarry["selections"] = {}
	for (const mode of modes) {
		const selection = source[mode === "plan" ? "planSelection" : "actSelection"] as
			| { modelId?: unknown; overrides?: Record<string, unknown> }
			| undefined
		const modelId = typeof selection?.modelId === "string" ? selection.modelId.trim() : ""
		if (!modelId) {
			continue
		}
		const overrides = captureProviderConfigSnapshot(sourceConfig, mode)?.[PROVIDER_CONFIG_MODEL_OVERRIDES_KEY] as
			| Record<string, unknown>
			| undefined
		selections[mode] = overrides ? { modelId, overrides } : { modelId }
	}
	return { patch, selections }
}
