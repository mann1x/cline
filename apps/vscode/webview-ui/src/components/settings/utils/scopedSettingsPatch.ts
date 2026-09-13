import type { UpdateSettingsRequest } from "@shared/proto/cline/state"

/** The settings string a scoped tab stores its whole configuration in. */
export type ScopedModelSetting = "visionModeApiConfiguration" | "agentsModeApiConfiguration" | "escalationModeApiConfiguration"

/**
 * The settings field each scope stores its snapshot in.
 *
 * The scope names are what the profile bar and the tab switcher deal in; the
 * setting keys are what the state layer deals in. One map, so the two
 * vocabularies meet in exactly one place.
 */
export const SCOPED_MODEL_SETTINGS: Record<"vision" | "agents" | "escalation", ScopedModelSetting> = {
	vision: "visionModeApiConfiguration",
	agents: "agentsModeApiConfiguration",
	escalation: "escalationModeApiConfiguration",
}

/**
 * Which settings field a scoped tab's snapshot is written to.
 *
 * Spelled out per setting rather than computed from the key: a computed key
 * widens the object to an index signature, and `UpdateSettingsRequest.create`
 * then takes it without checking that the field exists at all — so a typo, or a
 * fourth tab whose key was never added here, would be accepted and silently
 * write nothing.
 *
 * A function of its own because getting it wrong is invisible in the UI and
 * expensive: the tab appears to save, the settings round-trip reports success,
 * and the model runs on the configuration of a *different* tab. Tested rather
 * than reviewed.
 */
export function scopedSettingsPatch(setting: ScopedModelSetting, json: string): Partial<UpdateSettingsRequest> {
	switch (setting) {
		case "agentsModeApiConfiguration":
			return { agentsModeApiConfiguration: json }
		case "escalationModeApiConfiguration":
			return { escalationModeApiConfiguration: json }
		case "visionModeApiConfiguration":
			return { visionModeApiConfiguration: json }
	}
}
