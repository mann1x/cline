import { DEFAULT_UPDATE_CHANNEL, type UpdateChannel } from "@shared/UpdateSettings"
import React from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

/**
 * How Cerebriline keeps itself current.
 *
 * It lives here, in the plugin's own General settings, rather than only in VS
 * Code's settings UI. The two are not interchangeable for this: someone who
 * installed a `.vsix` and is wondering why it never updates looks in the
 * extension they are using, not in a list of every setting the editor has.
 */
const OPTIONS: Array<{ value: UpdateChannel; label: string; blurb: string }> = [
	{ value: "off", label: "Off", blurb: "Never check. Install a .vsix yourself when you want a new version." },
	{
		value: "notify",
		label: "Notify",
		blurb: "Check once a day and say when a newer release exists. Nothing is downloaded until you ask.",
	},
	{
		value: "auto",
		label: "Auto",
		blurb: "Check once a day and install a newer release as soon as one is found, then offer to reload.",
	},
]

const UpdateChannelSetting: React.FC = () => {
	const { updateChannel } = useExtensionState()
	const current = updateChannel ?? DEFAULT_UPDATE_CHANNEL
	const blurb = OPTIONS.find((option) => option.value === current)?.blurb ?? ""

	return (
		<div className="mb-[5px]">
			<label className="block mb-1 text-base font-medium" htmlFor="update-channel-dropdown">
				Check for Updates
			</label>
			<Select onValueChange={(value) => updateSetting("updateChannel", value)} value={current}>
				<SelectTrigger className="w-full" id="update-channel-dropdown">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{OPTIONS.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="text-sm text-description mt-1">
				{blurb} Cerebriline is not on the VS Code Marketplace, so VS Code will not update a .vsix install on its own; this
				check reads the GitHub releases and verifies the download against the SHA-256 published with it. If you installed
				from Open VSX your editor already keeps it current and this will find nothing to report.
			</p>
		</div>
	)
}

export default React.memo(UpdateChannelSetting)
