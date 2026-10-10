import { DEFAULT_MESSAGE_HISTORY_LIMIT, MAX_MESSAGE_HISTORY_LIMIT } from "@shared/message-history"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import React from "react"
import { Input } from "@/components/ui/input"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

/**
 * The message box's history and draft.
 *
 * A switch and not only a count, because the two say different things: a
 * count of one still writes what was typed to disk, and someone who does not
 * want their messages kept means none of them.
 */
const MessageHistorySetting: React.FC = () => {
	const { messageHistoryEnabled, messageHistoryLimit } = useExtensionState()
	const enabled = messageHistoryEnabled !== false
	const limit = messageHistoryLimit ?? DEFAULT_MESSAGE_HISTORY_LIMIT

	return (
		<div className="mb-[5px] mt-4">
			<VSCodeCheckbox
				checked={enabled}
				onChange={(event) => updateSetting("messageHistoryEnabled", (event.target as HTMLInputElement).checked)}>
				<span className="text-base font-medium">Message history</span>
			</VSCodeCheckbox>
			<p className="text-sm text-description mt-1">
				Keeps the messages you send and what you have typed but not sent. Ctrl+Up and Ctrl+Down in the message box walk
				through the sent messages, and an unsent message is still there after the window reloads. Switching this off
				deletes what was kept.
			</p>
			{enabled && (
				<div className="mt-2 flex items-center gap-2">
					<label className="text-sm" htmlFor="message-history-limit">
						Messages to keep
					</label>
					<Input
						className="w-24"
						defaultValue={limit}
						id="message-history-limit"
						key={limit}
						max={MAX_MESSAGE_HISTORY_LIMIT}
						min={1}
						onBlur={(event) => {
							const value = Math.floor(Number(event.target.value))
							if (Number.isFinite(value) && value >= 1 && value !== limit) {
								updateSetting("messageHistoryLimit", Math.min(value, MAX_MESSAGE_HISTORY_LIMIT))
							} else if (value !== limit) {
								event.target.value = String(limit)
							}
						}}
						step={1}
						type="number"
					/>
				</div>
			)}
		</div>
	)
}

export default React.memo(MessageHistorySetting)
