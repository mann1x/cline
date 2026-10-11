import type { ClineMessage } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useExtensionState } from "../../../../../context/ExtensionStateContext"
import {
	type ButtonActionType,
	getButtonConfigFromState,
	hasPartialSayTail,
	withCancelWhileRunning,
} from "../../shared/buttonConfig"
import type { ButtonActionInvocation, ChatState, DraftSnapshot, MessageHandlers } from "../../types/chatTypes"
import { isPendingResponseUnconfirmed } from "../../utils/pendingResponse"

function createActionInvocation(action: ButtonActionType, getDraftSnapshot: () => DraftSnapshot): ButtonActionInvocation {
	switch (action) {
		case "approve":
		case "reject":
		case "proceed":
			return { type: action, draft: getDraftSnapshot() }
		default:
			return { type: action }
	}
}

interface ActionButtonsProps {
	task?: ClineMessage
	messages: ClineMessage[]
	chatState: ChatState
	messageHandlers: MessageHandlers
	mode: Mode
}

/**
 * Action buttons area including approve/reject buttons
 */
export const ActionButtons: React.FC<ActionButtonsProps> = ({ task, messages, chatState, mode, messageHandlers }) => {
	const { getDraftSnapshot, setSendingDisabled } = chatState
	const { turnState, foregroundCommandRunning } = useExtensionState()

	// Tracks the ask the user last acted on. Clicking a footer button latches this so the
	// buttons disable immediately (and survive the trailing bookkeeping re-renders before the
	// backend advances the turn). It is a ref, not state, so it can be compared against the
	// current ask during render without scheduling an extra update.
	const processedAskRef = useRef<string | undefined>(undefined)
	// Forces a re-render when the latch flips; the counter value itself is unused.
	const [, bumpRender] = useState(0)

	// Memoize the last message to avoid unnecessary recalculation
	const lastMessage = useMemo(() => messages.at(-1), [messages])

	// Button configuration is driven by the authoritative backend TurnState when present (SDK
	// path); otherwise it falls back to the legacy tail-walking heuristic. This makes the footer
	// buttons immune to trailing bookkeeping messages and never disagree with the thinking
	// indicator (RC1).
	//
	// The loader, however, can be up while the phase still describes the previous turn: an
	// unacknowledged submission shows it optimistically, and a partial reasoning/text row renders
	// as a live row whatever the phase. Cancel follows the loader, not the phase (#83).
	const pendingResponseUnconfirmed = isPendingResponseUnconfirmed(chatState.pendingResponse, turnState, messages.length)
	const buttonConfig = useMemo(() => {
		const fromState = getButtonConfigFromState(messages, turnState, mode, foregroundCommandRunning)
		return withCancelWhileRunning(
			fromState,
			turnState,
			{ pendingResponseUnconfirmed, partialTail: hasPartialSayTail(messages) },
			foregroundCommandRunning,
		)
	}, [messages, turnState, mode, foregroundCommandRunning, pendingResponseUnconfirmed])

	// Identity of the ask that currently owns the footer buttons. The button config objects are
	// shared singletons (e.g. BUTTON_CONFIGS.tool_approve), so two consecutive identical asks
	// (approve → approve) return the same reference. The anchored turn timestamp (or the last
	// message) changes on every new ask, making it the reliable signal that a fresh decision is
	// due even when the config object is identical. Folding the config's button text in also
	// covers a same-anchor transition between different button sets.
	const askIdentity = `${turnState?.seq ?? ""}:${turnState?.anchorTs ?? lastMessage?.ts ?? ""}:${buttonConfig.primaryText ?? ""}:${buttonConfig.secondaryText ?? ""}`

	// The buttons are "processing" only while the user's click is being handled for the current
	// ask. Because the latch is keyed on the ask identity, a new ask (even one reusing the same
	// shared config object) is never seen as already-processed, so its buttons are interactive
	// again.
	const isProcessing = processedAskRef.current === askIdentity

	// Mirror the config's sending-disabled flag into chat state whenever the active button set
	// changes.
	useEffect(() => {
		setSendingDisabled(buttonConfig.sendingDisabled)
	}, [buttonConfig, setSendingDisabled])

	const handleActionClick = useCallback(
		(invocation: ButtonActionInvocation) => {
			if (processedAskRef.current === askIdentity) {
				return
			}
			// Latch this ask as processed and force a render so the buttons disable immediately.
			processedAskRef.current = askIdentity
			bumpRender((n) => n + 1)

			const releaseLatch = () => {
				if (processedAskRef.current === askIdentity) {
					processedAskRef.current = undefined
					bumpRender((n) => n + 1)
				}
			}
			void messageHandlers
				.executeButtonAction(invocation)
				.then((started) => {
					if (!started) {
						releaseLatch()
					}
				})
				.catch(releaseLatch)
		},
		[messageHandlers, askIdentity],
	)

	// Keyboard event handler
	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault()
				event.stopPropagation()
				handleActionClick({ type: "cancel" })
			}
		},
		[handleActionClick],
	)

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown)
		return () => window.removeEventListener("keydown", handleKeyDown)
	}, [handleKeyDown])

	if (!task) {
		return null
	}

	const { primaryText, secondaryText, primaryAction, secondaryAction, enableButtons } = buttonConfig
	const hasButtons = primaryText || secondaryText
	const isStreaming = task.partial === true
	const canInteract = enableButtons && !isProcessing && !messageHandlers.recoveryActionInFlight

	if (!hasButtons) {
		return null
	}

	const opacity = canInteract || isStreaming ? 1 : 0.5

	return (
		<div className="flex px-3.5" style={{ opacity }}>
			{primaryText && primaryAction && (
				<VSCodeButton
					appearance="primary"
					className={secondaryText ? "flex-1 mr-[6px]" : "flex-2"}
					disabled={!canInteract}
					onClick={() => handleActionClick(createActionInvocation(primaryAction, getDraftSnapshot))}>
					{primaryText}
				</VSCodeButton>
			)}
			{secondaryText && secondaryAction && (
				<VSCodeButton
					appearance="secondary"
					className={primaryText ? "flex-1" : "flex-2"}
					disabled={!canInteract}
					onClick={() => handleActionClick(createActionInvocation(secondaryAction, getDraftSnapshot))}>
					{secondaryText}
				</VSCodeButton>
			)}
		</div>
	)
}
