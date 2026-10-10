import {
	type MessageHistoryAction,
	type MessageHistoryCursor,
	type MessageHistorySnapshot,
	messageHistoryDirection,
	pushMessageHistory,
	stepMessageHistory,
} from "@shared/message-history"
import { StringRequest } from "@shared/proto/cline/common"
import type React from "react"
import { useCallback, useEffect, useRef } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"

/** How long the box is left alone before the draft is written. */
const DRAFT_SAVE_DELAY_MS = 500

/**
 * The message box's history and draft (Settings > General > Message history).
 *
 * - What is typed and not sent is kept by the extension, and put back when
 *   the box opens empty: after a window reload, or a closed and reopened panel.
 * - Ctrl+Up and Ctrl+Down walk the messages sent before. Ctrl rather than the
 *   bare arrows, which move the caret in a box of several lines and choose in
 *   the mention and command menus. On macOS, Cmd as well: see
 *   `messageHistoryDirection` for when.
 *
 * Off, nothing is read, kept or bound.
 */
export function useMessageHistory(inputValue: string, setInputValue: (value: string) => void) {
	const { messageHistoryEnabled, messageHistoryLimit, platform } = useExtensionState()
	const mac = platform === "darwin"
	const enabled = messageHistoryEnabled !== false
	const limit = messageHistoryLimit ?? 50

	const history = useRef<string[]>([])
	const cursor = useRef<MessageHistoryCursor | undefined>(undefined)
	// The text this hook put in the box. Anything else in it is the user's.
	const placed = useRef<string | undefined>(undefined)
	const current = useRef(inputValue)
	const loaded = useRef(false)
	const restored = useRef(false)
	const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	const call = useCallback(async (action: MessageHistoryAction): Promise<MessageHistorySnapshot | undefined> => {
		try {
			const response = await StateServiceClient.messageHistoryAction(
				StringRequest.create({ value: JSON.stringify(action) }),
			)
			const snapshot = JSON.parse(response.value) as MessageHistorySnapshot
			if (Array.isArray(snapshot.history)) {
				history.current = snapshot.history
			}
			return snapshot
		} catch (error) {
			console.error("Message history is unavailable:", error)
			return undefined
		}
	}, [])

	// biome-ignore lint/correctness/useExhaustiveDependencies: `limit` reloads a history the extension has just trimmed
	useEffect(() => {
		loaded.current = false
		cursor.current = undefined
		if (!enabled) {
			history.current = []
			return
		}
		let cancelled = false
		void call({ op: "load" }).then((snapshot) => {
			if (cancelled || !snapshot) {
				return
			}
			loaded.current = true
			// Once per panel, and only into an empty box: text typed while the
			// answer was on its way is newer than the draft.
			if (!restored.current) {
				restored.current = true
				if (snapshot.draft && current.current === "") {
					placed.current = undefined
					setInputValue(snapshot.draft)
				}
			}
		})
		return () => {
			cancelled = true
		}
	}, [enabled, limit, call, setInputValue])

	useEffect(() => {
		current.current = inputValue
		if (inputValue !== placed.current) {
			// The user typed: the walk is over, and the next one starts from this.
			cursor.current = undefined
			placed.current = undefined
		}
		if (!enabled || !loaded.current) {
			return
		}
		clearTimeout(draftTimer.current)
		draftTimer.current = setTimeout(() => {
			void call({ op: "draft", text: inputValue })
		}, DRAFT_SAVE_DELAY_MS)
		return () => clearTimeout(draftTimer.current)
	}, [inputValue, enabled, call])

	/** Ctrl+Up / Ctrl+Down. True when the key was taken. */
	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
			if (!enabled) {
				return false
			}
			const box = event.currentTarget
			const direction = messageHistoryDirection(event, {
				mac,
				walking: cursor.current !== undefined,
				selectionStart: box.selectionStart ?? 0,
				selectionEnd: box.selectionEnd ?? 0,
				length: box.value.length,
			})
			if (!direction) {
				return false
			}
			const step = stepMessageHistory(history.current, cursor.current, direction, current.current)
			// Taken even when there is nowhere to go, so the key never falls
			// through to something else at the end of the list.
			event.preventDefault()
			event.stopPropagation()
			if (step) {
				cursor.current = step.cursor
				placed.current = step.cursor ? step.text : undefined
				setInputValue(step.text)
			}
			return true
		},
		[enabled, mac, setInputValue],
	)

	/** A message is being sent: add it and drop the draft. */
	const recordSent = useCallback(
		(text: string) => {
			cursor.current = undefined
			placed.current = undefined
			if (!enabled || !text.trim()) {
				return
			}
			clearTimeout(draftTimer.current)
			history.current = pushMessageHistory(history.current, text, limit)
			void call({ op: "push", text })
		},
		[enabled, limit, call],
	)

	return { onKeyDown, recordSent }
}
