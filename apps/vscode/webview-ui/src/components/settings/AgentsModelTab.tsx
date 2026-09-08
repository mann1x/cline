import { useExtensionState } from "@/context/ExtensionStateContext"
import ScopedModelTab from "./ScopedModelTab"

/**
 * The API configuration panel, pointed at the model delegated agents run on.
 *
 * Subagents and teammates inherited the session's whole connection config —
 * provider, model, sampler, and the context window with it — so there was no
 * way to run a team of small agents under a large lead, and no way to give them
 * a window of their own. Everything about how a tab holds its own configuration
 * lives in `ScopedModelTab`; this only says which configuration.
 */
const AgentsModelTab = () => {
	const { agentsModeApiConfiguration } = useExtensionState()
	return <ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={agentsModeApiConfiguration} />
}

export default AgentsModelTab
