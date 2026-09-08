import { useExtensionState } from "@/context/ExtensionStateContext"
import ScopedModelTab from "./ScopedModelTab"

/**
 * The API configuration panel, pointed at the vision model.
 *
 * The vision model is a second model that reads an image and hands text back to
 * the primary one. Everything about how a tab holds its own configuration lives
 * in `ScopedModelTab`; this only says which configuration.
 */
const VisionModelTab = () => {
	const { visionModeApiConfiguration } = useExtensionState()
	return <ScopedModelTab setting="visionModeApiConfiguration" storedSnapshot={visionModeApiConfiguration} />
}

export default VisionModelTab
