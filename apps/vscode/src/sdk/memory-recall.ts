import { createMemoryRecaller, type MemoryQueryExpander, type MemoryRecaller } from "@cline/core"
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
	if (!settings.hyde || !settings.hydeProfile) {
		return undefined
	}
	const profile = findApiConfigurationProfile(
		parseApiConfigurationProfiles(StateManager.get().getGlobalSettingsKey("apiConfigurationProfiles")),
		settings.hydeProfile,
	)
	if (!profile) {
		Logger.warn(`[Memory] The profile "${settings.hydeProfile}" named for the expansion is gone; searching without it`)
		return undefined
	}
	// Keys are not part of a profile: they come from the session's own
	// configuration, as for the Vision and Agents models.
	const configuration = buildScopedApiConfiguration(primary, JSON.stringify(profile.snapshot))
	if (!configuration) {
		Logger.warn(`[Memory] The profile "${profile.name}" names no provider; searching without the expansion`)
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

/** Installed on every session: it reads the Memory settings per message and does nothing while Memory is off. */
export function createSessionMemoryRecaller(primary: ApiConfiguration | undefined): MemoryRecaller {
	return createMemoryRecaller({
		getConfig: readMemoryToolsConfig,
		getExpander: () => readMemoryQueryExpander(primary),
		log: (message) => Logger.log(`[Memory] ${message}`),
	})
}
