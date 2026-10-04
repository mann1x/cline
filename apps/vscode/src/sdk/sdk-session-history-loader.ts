import { Logger } from "@/shared/services/Logger"
import { sanitizeInitialMessagesForSessionStart } from "./initial-message-sanitizer"
import { rebaseCompactionState, stashRebasedCompaction } from "./resumed-compaction"
import type { SdkInitialMessages, SdkSessionHost } from "./session-host"

export class SdkSessionHistoryLoader {
	/**
	 * Keep the session's saved compaction usable when the sanitizer reshaped
	 * the transcript it was saved against; see `resumed-compaction.ts`.
	 */
	private async carryCompaction(
		sessionHost: SdkSessionHost,
		taskId: string,
		stored: readonly unknown[],
		reshaped: readonly unknown[],
	): Promise<void> {
		stashRebasedCompaction(taskId, undefined)
		if (reshaped === stored || !sessionHost.readSessionCompactionState) {
			return
		}
		try {
			const state = await sessionHost.readSessionCompactionState(taskId)
			const rebased = rebaseCompactionState({
				sessionId: taskId,
				state,
				stored,
				reshaped,
				reshape: sanitizeInitialMessagesForSessionStart,
			})
			if (rebased === "fits") {
				return
			}
			if (rebased) {
				stashRebasedCompaction(taskId, rebased)
				Logger.log(
					`[SdkController] Compaction carried across the reshaped history for task: ${taskId} (${reshaped.length} messages, ${rebased.messages.length} after compaction)`,
				)
			} else if (state) {
				Logger.warn(
					`[SdkController] The saved compaction for task ${taskId} does not fit its history; the next request carries the whole conversation`,
				)
			}
		} catch (error) {
			Logger.warn("[SdkController] Failed to carry the saved compaction:", error)
		}
	}

	async loadInitialMessages(sessionHost: SdkSessionHost, taskId: string): Promise<SdkInitialMessages | undefined> {
		try {
			// Prefer the live in-memory conversation: the persisted transcript
			// only catches up at turn boundaries, so a rebuild right after
			// aborting a turn (e.g. a plan/act mode switch mid-approval) would
			// otherwise read an empty file and drop the task context.
			const sdkMessages = await (sessionHost.readLiveMessages?.(taskId) ?? sessionHost.readMessages(taskId))
			if (sdkMessages.length > 0) {
				const sanitizedMessages = sanitizeInitialMessagesForSessionStart(sdkMessages)
				if (sanitizedMessages !== sdkMessages) {
					Logger.log(
						`[SdkController] Sanitized legacy pairing in SDK-persisted history for task: ${taskId} (${sdkMessages.length} → ${sanitizedMessages.length} messages)`,
					)
				}
				await this.carryCompaction(sessionHost, taskId, sdkMessages, sanitizedMessages)
				Logger.log(`[SdkController] Loaded ${sanitizedMessages.length} SDK-persisted messages for task: ${taskId}`)
				return sanitizedMessages
			}
		} catch (error) {
			Logger.warn("[SdkController] Failed to read SDK-persisted messages:", error)
		}

		try {
			const { getSavedApiConversationHistory } = await import("@core/storage/disk")
			const apiHistory = await getSavedApiConversationHistory(taskId)
			if (apiHistory.length > 0) {
				const sanitizedMessages = sanitizeInitialMessagesForSessionStart(apiHistory as SdkInitialMessages)
				if (sanitizedMessages !== apiHistory) {
					Logger.log(
						`[SdkController] Sanitized legacy pairing in classic API history for task: ${taskId} (${apiHistory.length} → ${sanitizedMessages.length} messages)`,
					)
				}
				Logger.log(`[SdkController] Loaded ${sanitizedMessages.length} classic API messages for task: ${taskId}`)
				return sanitizedMessages
			}
		} catch (error) {
			Logger.warn("[SdkController] Failed to read classic API conversation history:", error)
		}

		return undefined
	}
}
