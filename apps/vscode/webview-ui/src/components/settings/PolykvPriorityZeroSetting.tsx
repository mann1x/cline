import { polykvPriorityZeroAvailable } from "@shared/agent-nodes"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { useOpencotiEngineMode } from "./common/ParallelSessionsField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"
import { getModeSpecificFields } from "./utils/providerUtils"

/**
 * "Use PolyKV agents as Priority 0" (PLANS §9g).
 *
 * Agents run first as sub-pools of the Model's own opencoti session --
 * priority 0, above every node, at most eight -- and overflow into the nodes
 * below once those are taken. Shown only when it can do something: the Model
 * provider is opencoti AND its server's `/props` confirmed `pools_enabled`.
 * Anything else, including a server that could not be asked, hides it; the
 * host asks the same question again before applying it.
 *
 * Off by default, because on it spends the conversation's own window: the
 * lead and its agents compact against one window's pressure.
 */
const PolykvPriorityZeroSetting = () => {
	const { apiConfiguration, mode, polykvAgentsPriorityZero } = useExtensionState()
	const leadProviderId = getModeSpecificFields(apiConfiguration, mode).apiProvider
	const engine = useOpencotiEngineMode(leadProviderId)
	if (!polykvPriorityZeroAvailable({ leadProviderId, poolsEnabled: engine === "polykv" })) {
		return null
	}
	return (
		<div className="mb-3">
			<SettingsCheckbox
				checked={polykvAgentsPriorityZero === true}
				onChange={async (checked: boolean) => {
					await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ polykvAgentsPriorityZero: checked }))
				}}>
				Use PolyKV agents as Priority 0
			</SettingsCheckbox>
			<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
				Agents run first as sub-pools of the Model's own PolyKV session, up to 8, ahead of every node. When those are
				taken, or the conversation's window is running short, they go to the nodes below. The agents share the
				conversation's window, so a large swarm makes it compact sooner.
			</p>
		</div>
	)
}

export default PolykvPriorityZeroSetting
