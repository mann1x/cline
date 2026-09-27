import { polykvPriorityZeroAvailable } from "@shared/agent-nodes"
import { OllamaReachabilityRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { useOpencotiEngineMode } from "./common/ParallelSessionsField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"
import { xollamaPoolsClients } from "./common/XollamaModelStrip"
import { getModeSpecificFields } from "./utils/providerUtils"

/**
 * "Use PolyKV agents as Priority 0" (PLANS §9g).
 *
 * Agents run first as sub-pools of the Model's own PolyKV session --
 * priority 0, above every node, at most eight -- and overflow into the nodes
 * below once those are taken. Shown only when it can do something: the Model
 * provider is opencoti AND its server's `/props` confirmed `pools_enabled`, or
 * xOllama AND the Model is a plain model whose engine the client drives.
 * Anything else, including a server that could not be asked, hides it; the
 * host asks the same question again before applying it.
 *
 * Off by default, because on it spends the conversation's own window: the
 * lead and its agents compact against one window's pressure.
 */
/**
 * Whether the client drives the selected xOllama model's engine: a plain model
 * with client pool seats on a server that negotiates windows. The host asks
 * the same of the server before it turns Priority 0 on.
 */
function useXollamaLeadDrives(leadProviderId: string | undefined, mode: string): boolean | undefined {
	const { config } = useProviderConfig("xollama" as never)
	const selection = (mode === "plan" ? config?.planSelection : config?.actSelection) as { modelId?: string } | undefined
	const modelId = selection?.modelId
	const [drives, setDrives] = useState<boolean | undefined>()
	useEffect(() => {
		setDrives(undefined)
		if (leadProviderId !== "xollama" || !modelId) {
			return
		}
		let cancelled = false
		ModelsServiceClient.readXollamaModelStatus(OllamaReachabilityRequest.create({ providerId: "xollama", modelId }))
			.then((status) => {
				if (!cancelled) {
					setDrives(status.reachable && xollamaPoolsClients(status) && status.windowNegotiation)
				}
			})
			.catch(() => {
				if (!cancelled) {
					setDrives(false)
				}
			})
		return () => {
			cancelled = true
		}
	}, [leadProviderId, modelId])
	return drives
}

const PolykvPriorityZeroSetting = () => {
	const { apiConfiguration, mode, polykvAgentsPriorityZero } = useExtensionState()
	const leadProviderId = getModeSpecificFields(apiConfiguration, mode).apiProvider
	const engine = useOpencotiEngineMode(leadProviderId)
	const xollamaDrives = useXollamaLeadDrives(leadProviderId, mode)
	const poolsEnabled = (leadProviderId as string | undefined) === "xollama" ? xollamaDrives === true : engine === "polykv"
	if (!polykvPriorityZeroAvailable({ leadProviderId, poolsEnabled })) {
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
