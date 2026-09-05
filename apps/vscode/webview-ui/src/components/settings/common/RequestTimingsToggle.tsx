import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "../utils/settingsHandlers"

/**
 * The switch that decides whether requests show what they cost in time.
 *
 * One setting, offered from the panels of the providers it says the most
 * about, rather than one setting per provider. A per-provider flag would give
 * a chat where some requests carry the panel and others do not, which reads as
 * a bug in the panel rather than as a choice — and the measurements Cline
 * makes itself are the same for every provider anyway.
 *
 * Off by default. What is recorded does not depend on it: the numbers are
 * written to every request either way, so turning this on shows the requests
 * already made and turning it off hides them again without losing anything.
 */
export const RequestTimingsToggle = ({ engineNote }: { engineNote?: string }) => {
	const { showRequestTimings } = useExtensionState()

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor="showRequestTimings">
					Show request timings
				</Label>
				<Switch
					checked={showRequestTimings === true}
					className="shrink-0"
					id="showRequestTimings"
					onCheckedChange={(checked) => updateSetting("showRequestTimings", checked)}
					size="default"
				/>
			</div>
			<p className="text-xs mt-0 mb-0 text-description">
				Adds a line under each request in the chat with how long it took, how fast it generated, and how long it waited
				for the first token. {engineNote} Applies to every provider; off by default because it is a row of numbers under
				every request.
			</p>
		</div>
	)
}

export default RequestTimingsToggle
