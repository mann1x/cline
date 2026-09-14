import { existsSync } from "node:fs"
import { setTelemetryOptOutGlobally } from "@cline/core"
import { resolveGlobalSettingsPath } from "@cline/shared/storage"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { Logger } from "@/shared/services/Logger"

interface TelemetryStateManager {
	getGlobalSettingsKey(key: "telemetrySetting"): TelemetrySetting | boolean | undefined
	getRemoteConfigSettings(): { telemetrySetting?: TelemetrySetting }
	setGlobalState(key: "telemetrySetting", value: TelemetrySetting): void
}

/**
 * Telemetry is off in this fork, and not merely defaulted off.
 *
 * Upstream resolves this from the shared global settings file. Here there is
 * nowhere for it to go: the release workflow injects neither
 * `TELEMETRY_SERVICE_API_KEY` nor `ERROR_SERVICE_API_KEY`, and the ingest host
 * is hardcoded to Cline's own (`https://data.cline.bot`). So "enabled" could
 * only ever have meant "send this fork's usage to upstream", which is not
 * something a user of this fork asked for and not something they were asked
 * about -- the checkbox said "Help improve Cline".
 *
 * Forced here rather than by hiding the checkbox, because the checkbox is not
 * the only way the value is set: a `telemetrySetting` already stored as
 * "enabled", a settings file carried over from a Cline install, or an
 * organisation's remote config would each turn it back on with no UI involved.
 * `syncTelemetrySettingFromSharedGlobalSettings` writes this back over the
 * stored value on every start, so an inherited "enabled" is corrected once and
 * stays corrected.
 *
 * If this fork ever gets a telemetry endpoint of its own, this function and
 * `posthogConfig.host` are the two places that have to change together.
 */
export function telemetrySettingFromSharedGlobalSettings(): TelemetrySetting {
	return "disabled"
}

function normalizeLegacyTelemetrySetting(value: TelemetrySetting | boolean | undefined): TelemetrySetting | undefined {
	if (value === false) {
		return "disabled"
	}
	if (value === true) {
		return "enabled"
	}
	if (value === "disabled" || value === "enabled" || value === "unset") {
		return value
	}
	return undefined
}

export function syncTelemetrySettingFromSharedGlobalSettings(stateManager: TelemetryStateManager): void {
	try {
		const sharedSettingsPath = resolveGlobalSettingsPath()
		if (!existsSync(sharedSettingsPath)) {
			const legacyTelemetrySetting = normalizeLegacyTelemetrySetting(stateManager.getGlobalSettingsKey("telemetrySetting"))
			if (legacyTelemetrySetting !== undefined) {
				// One-time migration from the legacy VS Code globalState.json field into
				// the CLI/shared global settings file. Older builds stored this as a
				// boolean where false meant telemetry was disabled.
				// Do not emit opt-out telemetry for migration; this is not a new explicit
				// user action.
				setTelemetryOptOutGlobally(legacyTelemetrySetting === "disabled")
			}
		}

		const telemetrySetting = telemetrySettingFromSharedGlobalSettings()
		const remoteTelemetrySetting = stateManager.getRemoteConfigSettings().telemetrySetting
		if (remoteTelemetrySetting === undefined && stateManager.getGlobalSettingsKey("telemetrySetting") !== telemetrySetting) {
			// Keep the legacy in-memory state mirrored so existing VS Code telemetry
			// providers that still read StateManager observe the shared setting.
			stateManager.setGlobalState("telemetrySetting", telemetrySetting)
		}
	} catch (error) {
		Logger.warn(`[SdkController] Failed to sync shared telemetry setting: ${error}`)
	}
}
