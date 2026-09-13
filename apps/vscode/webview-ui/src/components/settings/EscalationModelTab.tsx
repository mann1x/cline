import { useExtensionState } from "@/context/ExtensionStateContext"
import ScopedModelTab from "./ScopedModelTab"

/**
 * The API configuration panel, pointed at the expert a stuck session escalates to.
 *
 * The expert is the one model here that is deliberately *more* expensive than
 * the session's — a metered cloud account, or simply a larger local model that
 * has to be loaded. That is also why it needs a configuration of its own rather
 * than a share of the session's: an expert borrowing the lead's context window
 * would be sized down to whatever the small model was given, which is the
 * opposite of the point. Everything about how a tab holds its own configuration
 * lives in `ScopedModelTab`; this only says which configuration.
 */
const EscalationModelTab = () => {
	const { escalationModeApiConfiguration } = useExtensionState()
	return <ScopedModelTab setting="escalationModeApiConfiguration" storedSnapshot={escalationModeApiConfiguration} />
}

export default EscalationModelTab
