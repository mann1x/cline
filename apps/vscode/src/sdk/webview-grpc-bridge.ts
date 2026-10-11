// Replaces classic message streaming from src/core/task/index.ts (see origin/main)
//
// Bridges SDK session events to the webview's gRPC streaming subscriptions.
// When the SDK emits session events (text chunks, tool calls, etc.), this
// module translates them to proto ClineMessages and pushes them through
// the subscribeToPartialMessage and subscribeToState streams the webview
// already listens on.

import type { CoreSessionEvent } from "@cline/core"
import { sendStateUpdate } from "@core/controller/state/subscribeToState"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import type { ClineMessage, ExtensionState } from "@shared/ExtensionMessage"
import type { ClineMessage as ProtoClineMessage } from "@shared/proto/cline/ui"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Logger } from "@shared/services/Logger"
import type { MessageTranslatorState } from "./message-translator"
import type { SessionEventListener } from "./sdk-message-coordinator"

/** The shortest time between two updates of a message that is still streaming. */
export const PARTIAL_MESSAGE_INTERVAL_MS = 50

/**
 * Manages the bridge between SDK session events and webview gRPC streams.
 *
 * When the SDK emits events, this bridge:
 * 1. Translates them to ClineMessage[] via the message translator
 * 2. Converts each ClineMessage to proto format
 * 3. Pushes them through the subscribeToPartialMessage gRPC stream
 * 4. Pushes state updates through the subscribeToState gRPC stream
 *    on significant events (turn complete, session ended)
 *
 * The bridge needs access to the controller's getStateToPostToWebview()
 * method to push state updates that include the current task's messages
 * and task history. Without this, state updates would have empty messages.
 */
export class WebviewGrpcBridge {
	/** Function to get the full ExtensionState from the controller */
	private getStateFn?: () => Promise<import("@shared/ExtensionMessage").ExtensionState>
	/** The newest held update of each message that is still streaming, by `ts`. */
	private readonly heldPartials = new Map<number, ClineMessage>()
	/** Running while streaming updates are being held back. */
	private partialTimer: ReturnType<typeof setTimeout> | undefined

	constructor(_translatorState: MessageTranslatorState) {
		// translatorState is kept as a constructor param for API compatibility
		// but translation is done in SdkController, not in the bridge
	}

	/**
	 * Set the function used to get ExtensionState for state updates.
	 * This should be called after the controller is fully initialized,
	 * passing `controller.getStateToPostToWebview.bind(controller)`.
	 */
	setGetStateFn(fn: () => Promise<import("@shared/ExtensionMessage").ExtensionState>): void {
		this.getStateFn = fn
	}

	/**
	 * Create a SessionEventListener that bridges events to the webview.
	 * This is passed to SdkController.onSessionEvent().
	 */
	createListener(): SessionEventListener {
		return (messages: ClineMessage[], event: CoreSessionEvent) => {
			this.handleSessionEvent(messages, event)
		}
	}

	/**
	 * Handle a session event by pushing translated messages to webview streams.
	 *
	 * NOTE: The messages are already translated by SdkController.handleSessionEvent().
	 * We do NOT re-translate here — that would double-emit messages and corrupt
	 * the MessageTranslatorState (e.g., state.reset() on iteration_start would
	 * clear streaming timestamps that the first translation used).
	 */
	private handleSessionEvent(messages: ClineMessage[], event: CoreSessionEvent): void {
		// Push each translated message through the partial message stream
		for (const message of messages) {
			this.queuePartialMessage(message)
		}

		// Check if we need to push a state update based on event type.
		// Do NOT call translateSessionEvent() again — the messages are already
		// translated. Just check the raw event type for state update triggers.
		const needsStateUpdate =
			event.type === "ended" ||
			(event.type === "agent_event" && (event.payload.event.type === "done" || event.payload.event.type === "error"))

		if (needsStateUpdate) {
			// Push state update asynchronously — don't block the event stream
			this.pushStateUpdate().catch((err) => {
				Logger.error("[WebviewGrpcBridge] Failed to push state update:", err)
			})
		}
	}

	/**
	 * Send a message now, or hold it for the next flush.
	 *
	 * An update to a message that is still streaming carries the whole text so
	 * far, not the new token, so a long reply re-sends itself once per token:
	 * the rig measured 8 GB posted in seven minutes at 60 tokens a second. Each
	 * one supersedes the last, so only the newest per message is worth sending,
	 * and at most one per PARTIAL_MESSAGE_INTERVAL_MS is.
	 *
	 * The first update goes out at once and so does anything that is not a
	 * streaming update. Held updates are sent ahead of it, in the order their
	 * messages first appeared, so nothing overtakes anything -- except a held
	 * update of the very message now arriving complete, which is dropped.
	 */
	private queuePartialMessage(message: ClineMessage): void {
		if (message.partial !== true) {
			this.heldPartials.delete(message.ts)
			this.flushHeldPartials()
			void this.pushPartialMessage(message)
			return
		}
		if (this.partialTimer === undefined) {
			void this.pushPartialMessage(message)
			this.armPartialTimer()
			return
		}
		this.heldPartials.set(message.ts, message)
	}

	private armPartialTimer(): void {
		this.partialTimer = setTimeout(() => {
			this.partialTimer = undefined
			if (this.heldPartials.size > 0) {
				this.flushHeldPartials()
				this.armPartialTimer()
			}
		}, PARTIAL_MESSAGE_INTERVAL_MS)
		this.partialTimer.unref?.()
	}

	private flushHeldPartials(): void {
		if (this.heldPartials.size === 0) {
			return
		}
		const held = [...this.heldPartials.values()]
		this.heldPartials.clear()
		for (const message of held) {
			void this.pushPartialMessage(message)
		}
	}

	/**
	 * Push a ClineMessage to the webview via the subscribeToPartialMessage stream.
	 */
	private async pushPartialMessage(message: ClineMessage): Promise<void> {
		try {
			const protoMessage: ProtoClineMessage = convertClineMessageToProto(message)
			await sendPartialMessageEvent(protoMessage)
		} catch (error) {
			Logger.error("[WebviewGrpcBridge] Failed to push partial message:", error)
		}
	}

	/**
	 * Push a state update to the webview via the subscribeToState stream.
	 * This is called on significant events (turn complete, session ended).
	 *
	 * Uses the controller's getStateToPostToWebview() when available,
	 * which includes the current task's messages and task history.
	 * Falls back to a minimal state update without task data.
	 */
	private async pushStateUpdate(): Promise<void> {
		try {
			if (this.getStateFn) {
				// Use the controller's getStateToPostToWebview() which
				// includes messages, currentTaskItem, and task history
				const state = await this.getStateFn()
				await sendStateUpdate(state)
			} else {
				// Fallback: build a minimal state without task data
				const { getStateToPostToWebview } = await import("@core/controller/state/getStateToPostToWebview")
				const { StateManager } = await import("@core/storage/StateManager")
				const stateManager = StateManager.get()
				const state = await getStateToPostToWebview({
					task: undefined,
					stateManager,
					mcpHub: undefined,
					backgroundCommandRunning: false,
					foregroundCommandRunning: false,
					backgroundCommandTaskId: undefined,
				})
				await sendStateUpdate(state)
			}
		} catch (error) {
			Logger.error("[WebviewGrpcBridge] Failed to push state update:", error)
		}
	}

	/**
	 * Push a state update using the controller's getStateToPostToWebview method.
	 * This is the preferred way when the controller is available.
	 */
	async pushStateUpdateFromController(getState: () => Promise<ExtensionState>): Promise<void> {
		try {
			const state = await getState()
			await sendStateUpdate(state)
		} catch (error) {
			Logger.error("[WebviewGrpcBridge] Failed to push state update from controller:", error)
		}
	}
}

/**
 * Standalone function to push a ClineMessage to the webview.
 * Useful for one-off messages outside the bridge's event loop.
 */
export async function pushMessageToWebview(message: ClineMessage): Promise<void> {
	try {
		const protoMessage: ProtoClineMessage = convertClineMessageToProto(message)
		await sendPartialMessageEvent(protoMessage)
	} catch (error) {
		Logger.error("[WebviewGrpcBridge] Failed to push message to webview:", error)
	}
}
