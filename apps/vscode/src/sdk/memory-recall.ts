import {
	buildMemoryDistillPrompt,
	createMemoryRecaller,
	MEMORY_DISTILL_SYSTEM_PROMPT,
	type MemoryQueryExpander,
	type MemoryRecaller,
	sharedMemory,
} from "@cline/core"
import type { ApiConfiguration } from "@shared/api"
import { findApiConfigurationProfile, parseApiConfigurationProfiles } from "@shared/api-config-profiles"
import { Logger } from "@shared/services/Logger"
import { StateManager } from "@/core/storage/StateManager"
import { readMemorySettings, readMemoryToolsConfig } from "./library-config"
import { buildApiHandler } from "./sdk-api-handler"
import { buildScopedApiConfiguration } from "./vision-model"

/**
 * Memory's automatic recall, for a session.
 *
 * The search itself is core's. What the host adds is the second model: the
 * expansion (HyDE) is written by the model of a saved profile, picked in the
 * Memory panel -- a cheap, fast one, which need not be the session's and
 * usually is not.
 */

/**
 * The expander for the profile the Memory panel names, or `undefined` when
 * none is named or the name no longer exists. Read on every message, so a
 * profile picked or re-saved mid-session is the one used.
 */
export function readMemoryQueryExpander(primary: ApiConfiguration | undefined): MemoryQueryExpander | undefined {
	const settings = readMemorySettings()
	if (!settings.hyde) {
		return undefined
	}
	return readMemoryProfileModel(primary, settings.hydeProfile)
}

/**
 * The model of the profile the Memory panel names, as one call: a system
 * prompt and a request in, the text out. Undefined when no profile is named
 * or it is gone. For the expansion and the distillation of expired notes.
 */
function readMemoryProfileModel(primary: ApiConfiguration | undefined, profileName: string): MemoryQueryExpander | undefined {
	const settings = { hydeProfile: profileName }
	if (!settings.hydeProfile) {
		return undefined
	}
	const profile = findApiConfigurationProfile(
		parseApiConfigurationProfiles(StateManager.get().getGlobalSettingsKey("apiConfigurationProfiles")),
		settings.hydeProfile,
	)
	if (!profile) {
		Logger.warn(`[Memory] The profile "${settings.hydeProfile}" named in the Memory panel is gone; going without its model`)
		return undefined
	}
	// Keys are not part of a profile: they come from the session's own
	// configuration, as for the Vision and Agents models.
	const configuration = buildScopedApiConfiguration(primary, JSON.stringify(profile.snapshot))
	if (!configuration) {
		Logger.warn(`[Memory] The profile "${profile.name}" names no provider; going without its model`)
		return undefined
	}
	const providerSettings = profile.snapshot.providerConfig as Record<string, unknown> | undefined
	return async ({ system, prompt, signal }) => {
		// The profile's own provider entry, so the base URL, window and
		// sampler are the ones saved with it.
		const handler = buildApiHandler(configuration, "act", { visionProviderSettings: providerSettings })
		try {
			handler.setAbortSignal?.(signal)
			let text = ""
			for await (const chunk of handler.createMessage(system, [{ role: "user", content: prompt } as never])) {
				if (chunk.type === "text") {
					text += chunk.text
				} else if (chunk.type === "done" && chunk.success === false) {
					throw new Error(chunk.error || "the model returned an error")
				}
			}
			return text.trim() || undefined
		} finally {
			handler.setAbortSignal?.(undefined)
		}
	}
}

/** How often expired notes are looked for: an hour, and only when a session starts. */
const EXPIRY_INTERVAL_MS = 60 * 60 * 1000
const DISTILL_TIMEOUT_MS = 120_000
let lastExpiry = 0

/**
 * Distil each memory's expired notes into one and remove them, at most once
 * an hour. Off while Memory is off or notes never expire. With no profile
 * named, nothing is removed: an expired note waits for a model to keep what
 * it found.
 */
export async function runMemoryExpiry(primary: ApiConfiguration | undefined, nowMs = Date.now()): Promise<void> {
	const settings = readMemorySettings()
	if (!settings.enabled || settings.noteTtlDays <= 0 || nowMs - lastExpiry < EXPIRY_INTERVAL_MS) {
		return
	}
	lastExpiry = nowMs
	const model = readMemoryProfileModel(primary, settings.hydeProfile)
	const config = readMemoryToolsConfig()
	const outcomes = await sharedMemory().expire({
		nowMs,
		...(config?.embedding ? { endpoints: { embedding: config.embedding } } : {}),
		distill: async (notes) => {
			if (!model) {
				throw new Error("no profile is named in the Memory panel to distil them")
			}
			const abort = new AbortController()
			const timer = setTimeout(() => abort.abort(), DISTILL_TIMEOUT_MS)
			try {
				return await model({
					system: MEMORY_DISTILL_SYSTEM_PROMPT,
					prompt: buildMemoryDistillPrompt(notes),
					signal: abort.signal,
				})
			} finally {
				clearTimeout(timer)
			}
		},
	})
	for (const outcome of outcomes) {
		Logger.log(
			outcome.distilled
				? `[Memory] Distilled ${outcome.removed} expired note(s) of "${outcome.memory}" into ${outcome.distilled}`
				: `[Memory] Kept the expired notes of "${outcome.memory}": ${outcome.kept}`,
		)
	}
}

/** Installed on every session: it reads the Memory settings per message and does nothing while Memory is off. */
export function createSessionMemoryRecaller(primary: ApiConfiguration | undefined): MemoryRecaller {
	void runMemoryExpiry(primary).catch((error) => Logger.warn(`[Memory] Expiring notes stopped: ${error}`))
	return createMemoryRecaller({
		getConfig: readMemoryToolsConfig,
		getExpander: () => readMemoryQueryExpander(primary),
		log: (message) => Logger.log(`[Memory] ${message}`),
	})
}
