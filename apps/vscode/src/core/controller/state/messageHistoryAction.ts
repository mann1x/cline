import {
	clampMessageHistoryLimit,
	MAX_MESSAGE_HISTORY_ENTRY_CHARS,
	type MessageHistoryAction,
	type MessageHistorySnapshot,
	pushMessageHistory,
} from "@shared/message-history"
import { String as ProtoString, type StringRequest } from "@shared/proto/cline/common"
import type { Controller } from ".."

/**
 * The message box's one call: load the history and draft, keep the draft as
 * it is typed, add a message as it is sent. Each answers with what is stored
 * after it.
 *
 * Its own call rather than a setting, because a setting update posts the
 * whole state to the webview and the draft is written as the user types.
 * While the history is switched off nothing is written and nothing is
 * returned.
 */
export async function messageHistoryAction(controller: Controller, request: StringRequest): Promise<ProtoString> {
	const state = controller.stateManager
	const enabled = state.getGlobalSettingsKey("messageHistoryEnabled") !== false
	const limit = clampMessageHistoryLimit(state.getGlobalSettingsKey("messageHistoryLimit"))
	const snapshot = (): MessageHistorySnapshot => ({
		enabled,
		limit,
		history: enabled ? (state.getGlobalStateKey("messageHistory") ?? []) : [],
		draft: enabled ? (state.getGlobalStateKey("messageDraft") ?? "") : "",
	})
	if (!enabled) {
		return ProtoString.create({ value: JSON.stringify(snapshot()) })
	}
	let action: MessageHistoryAction | undefined
	try {
		action = JSON.parse(request.value) as MessageHistoryAction
	} catch {
		action = undefined
	}
	if (action?.op === "draft" && typeof action.text === "string") {
		// An oversized draft is not kept, and neither is the one before it: a
		// reload must not bring back text the box no longer holds.
		state.setGlobalState("messageDraft", action.text.length > MAX_MESSAGE_HISTORY_ENTRY_CHARS ? "" : action.text)
	} else if (action?.op === "push" && typeof action.text === "string") {
		state.setGlobalState(
			"messageHistory",
			pushMessageHistory(state.getGlobalStateKey("messageHistory") ?? [], action.text, limit),
		)
		state.setGlobalState("messageDraft", "")
	}
	return ProtoString.create({ value: JSON.stringify(snapshot()) })
}
