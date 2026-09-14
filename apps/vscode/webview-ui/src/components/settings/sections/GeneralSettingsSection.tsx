import PreferredLanguageSetting from "../PreferredLanguageSetting"
import Section from "../Section"
import UpdateChannelSetting from "../UpdateChannelSetting"

interface GeneralSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

/**
 * There is deliberately no "Allow error and usage reporting" control here.
 *
 * This fork sends none: the release build injects no telemetry or error-service
 * key, and the ingest host in `posthog-config.ts` is Cline's own, so the only
 * thing the switch could ever have turned on was reporting this fork's usage
 * upstream -- under a label that read "Help improve Cline". Offering a switch
 * for something that does not happen is worse than offering none.
 *
 * The setting is forced off in `telemetry-settings-sync.ts` rather than merely
 * hidden, because a stored value, an inherited settings file or a remote config
 * can all set it without any UI. See the note there before changing either.
 */
const GeneralSettingsSection = ({ renderSectionHeader }: GeneralSettingsSectionProps) => {
	return (
		<div>
			{renderSectionHeader("general")}
			<Section>
				<PreferredLanguageSetting />

				<UpdateChannelSetting />
			</Section>
		</div>
	)
}

export default GeneralSettingsSection
