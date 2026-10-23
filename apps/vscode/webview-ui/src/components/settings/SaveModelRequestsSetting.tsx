import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import React from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

/**
 * Saving every model request's exact body and its response, for diagnosing a
 * turn: replayed on
 * a fresh server, the request that produced a garbled answer tells a model's
 * own sample apart from server state.
 */
const SaveModelRequestsSetting: React.FC = () => {
	const { saveModelRequests } = useExtensionState()
	return (
		<div className="mb-[5px] mt-4">
			<VSCodeCheckbox
				checked={saveModelRequests === true}
				onChange={(event) => updateSetting("saveModelRequests", (event.target as HTMLInputElement).checked)}>
				<span className="text-base font-medium">Save model requests</span>
			</VSCodeCheckbox>
			<p className="text-sm text-description mt-1">
				Writes the exact body of every request sent to the model, and the answer it streamed back, to{" "}
				<code>~/.cerebriline/data/logs/requests</code>, in a folder per conversation. For diagnosing a bad answer: the
				saved request can be sent again to see what the model makes of it. Prompts can be large, and files are not
				deleted, so switch it off when you are done. No API key is saved. On Ollama and xOllama it applies from the next
				request; on other providers, from the next conversation.
			</p>
		</div>
	)
}

export default React.memo(SaveModelRequestsSetting)
