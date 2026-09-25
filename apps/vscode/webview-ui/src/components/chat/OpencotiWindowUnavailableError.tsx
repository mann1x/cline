import { AskResponseRequest } from "@shared/proto/cline/task"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

export interface OpencotiWindowUnavailableDetails {
	asked?: number
	floor?: number
	largestAdmissible?: number
	resume?: boolean
}

/** `262144` -> `256k`, matching the provider's own wording. */
function windowK(tokens: number): string {
	return `${Math.max(0, Math.round(tokens / 1024))}k`
}

/**
 * opencoti could not give the conversation a window it can use (PLANS §9c).
 *
 * A resume must get the window it was opened with -- its history no longer
 * fits a smaller one -- so it is refused rather than shrunk, and the user
 * decides: Retry when capacity frees, or read the history meanwhile. Never
 * retried automatically. A new session gets the same card after its one wait.
 */
const OpencotiWindowUnavailableError = ({ details }: { details?: OpencotiWindowUnavailableDetails }) => {
	const { navigateToHistory } = useExtensionState()
	const resume = details?.resume === true
	const free =
		typeof details?.largestAdmissible === "number"
			? `The server has ${windowK(details.largestAdmissible)} free right now.`
			: "The server did not say how much it has free."
	const body =
		typeof details?.asked === "number"
			? resume
				? `It was opened with a ${windowK(details.asked)} window and needs the same to continue.`
				: `It needs at least a ${windowK(details.floor ?? details.asked)} window (configured ${windowK(details.asked)}).`
			: undefined

	const retry = useCallback(() => {
		TaskServiceClient.askResponse(AskResponseRequest.create({ responseType: "yesButtonClicked" })).catch((error) =>
			console.error("Failed to retry:", error),
		)
	}, [])

	return (
		<div
			className="p-2 border-none rounded-md mb-2 bg-(--vscode-textBlockQuote-background)"
			data-testid="opencoti-window-unavailable-error">
			<div className="text-error mb-2">{resume ? "Can't resume this conversation" : "Can't open this conversation"}</div>
			{body && <div className="text-(--vscode-descriptionForeground) text-xs wrap-anywhere">{body}</div>}
			<div className="text-(--vscode-descriptionForeground) text-xs mt-1">{free}</div>
			<div className="flex gap-2 mt-3">
				<VSCodeButton appearance="primary" className="flex-1" onClick={retry}>
					Retry
				</VSCodeButton>
				{resume && (
					<VSCodeButton appearance="secondary" className="flex-1" onClick={() => navigateToHistory()}>
						View history
					</VSCodeButton>
				)}
			</div>
		</div>
	)
}

export default OpencotiWindowUnavailableError
