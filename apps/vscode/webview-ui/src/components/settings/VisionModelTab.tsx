import { useExtensionState } from "@/context/ExtensionStateContext"
import ScopedModelTab from "./ScopedModelTab"
import { useImageSupport } from "./utils/imageSupport"

/**
 * The API configuration panel, pointed at the vision model.
 *
 * The vision model is a second model that reads an image and hands text back to
 * the primary one. Everything about how a tab holds its own configuration lives
 * in `ScopedModelTab`; this only says which configuration.
 *
 * It also says when the model named here cannot do the job. Any provider and
 * any model can be picked, and one without a vision head describes nothing —
 * so the server that runs it is asked, and its "no" is shown where the model
 * was chosen rather than discovered in a book with no descriptions.
 */
const VisionModelTab = () => {
	const { visionModeApiConfiguration } = useExtensionState()
	const chosen = useImageSupport(visionModeApiConfiguration)?.visionTab
	return (
		<>
			{chosen?.images === "no" ? (
				<p className="text-sm mb-2 text-(--vscode-errorForeground)" role="alert">
					{chosen.model} does not read images: its server reports no vision capability. Pictures sent to it are not
					described. Pick a model that has one.
				</p>
			) : null}
			<ScopedModelTab setting="visionModeApiConfiguration" storedSnapshot={visionModeApiConfiguration} />
		</>
	)
}

export default VisionModelTab
