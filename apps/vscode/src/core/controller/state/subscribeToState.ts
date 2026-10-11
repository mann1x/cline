import { EmptyRequest } from "@shared/proto/cline/common"
import { State } from "@shared/proto/cline/state"
import { telemetryService } from "@/services/telemetry"
import { ExtensionState } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active state subscriptions
const activeStateSubscriptions = new Set<StreamingResponseHandler<State>>()

/**
 * Subscribe to state updates
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activeStateSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activeStateSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	// Send the initial state.
	//
	// Built inside the try, because this is the only state the webview ever
	// waits for: it renders nothing at all until the first push arrives, and it
	// has no timeout of its own. A throw out here used to leave the subscription
	// registered and the panel blank forever, with the failure recorded nowhere
	// — the extension host healthy, the task still running, and every log clean.
	// That is the shape of three separate "the panel went empty" reports.
	let initialStateJson: string
	try {
		const initialState = await controller.getStateToPostToWebview()
		initialStateJson = JSON.stringify(initialState)
	} catch (error) {
		Logger.error(
			`Failed to build the initial state for the webview: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		)
		activeStateSubscriptions.delete(responseStream)
		// Rethrown rather than swallowed: the gRPC handler turns it into an
		// error the webview's subscription can see, and seeing it is what lets
		// the webview try again instead of waiting on a stream that will never
		// speak.
		throw error
	}

	recordStateSizeTelemetry(Buffer.byteLength(initialStateJson, "utf8"))

	try {
		await responseStream(
			{
				stateJson: initialStateJson,
			},
			false, // Not the last message
		)
	} catch (error) {
		Logger.error("Error sending initial state:", error)
		activeStateSubscriptions.delete(responseStream)
	}
}

// Backpressure for full-state snapshots.
//
// A snapshot is the whole transcript as one JSON string, and delivery is
// fire-and-forget: nothing here knew whether the webview had absorbed the last
// one before the next was posted. On a long conversation the webview needs
// longer per snapshot than the interval they arrive at, and the unprocessed
// ones queued in its process as multi-megabyte strings until V8 ran out of
// memory and the panel went grey (2,738 MB heap, 1,633 MB of it large objects;
// pandorum, 2026-10-11).
//
// So a webview says when it has applied a snapshot (`state_applied`), and while
// one is outstanding the newest request is held and any older held one is
// dropped -- a snapshot is a whole state, so only the latest matters. The hold
// ends at the acknowledgement or after STATE_ACK_TIMEOUT_MS, whichever comes
// first, so a webview that is busy, hidden or gone delays state, never loses it.
//
// The gate arms itself on the first acknowledgement. A client that never sends
// one (an older webview, a host with no webview) is posted to exactly as before.
const STATE_ACK_TIMEOUT_MS = 2000
let stateAcksSeen = false
let stateOutstandingSince: number | undefined
let heldState: ExtensionState | undefined
let stateAckTimer: ReturnType<typeof setTimeout> | undefined

function releaseHeldState(): void {
	stateOutstandingSince = undefined
	if (stateAckTimer) {
		clearTimeout(stateAckTimer)
		stateAckTimer = undefined
	}
	const next = heldState
	heldState = undefined
	if (next) {
		void sendStateUpdate(next)
	}
}

/** A webview has applied the last state snapshot it was sent. */
export function acknowledgeStateUpdate(): void {
	stateAcksSeen = true
	releaseHeldState()
}

/** Test seam: forget every acknowledgement and anything held. */
export function resetStateUpdateGateForTests(): void {
	stateAcksSeen = false
	stateOutstandingSince = undefined
	heldState = undefined
	if (stateAckTimer) {
		clearTimeout(stateAckTimer)
		stateAckTimer = undefined
	}
}

/**
 * Send a state update to all active subscribers
 * @param state The state to send
 */
export async function sendStateUpdate(state: ExtensionState): Promise<void> {
	if (stateAcksSeen && stateOutstandingSince !== undefined && activeStateSubscriptions.size > 0) {
		// Newest wins: whatever was held is superseded by this one.
		heldState = state
		return
	}

	let stateJson: string
	try {
		stateJson = JSON.stringify(state)
	} catch (error) {
		Logger.error("Error serializing state update:", error)
		return
	}

	recordStateSizeTelemetry(Buffer.byteLength(stateJson, "utf8"))

	if (stateAcksSeen && activeStateSubscriptions.size > 0) {
		stateOutstandingSince = Date.now()
		if (stateAckTimer) {
			clearTimeout(stateAckTimer)
		}
		stateAckTimer = setTimeout(releaseHeldState, STATE_ACK_TIMEOUT_MS)
		stateAckTimer.unref?.()
	}

	// FIRE-AND-FORGET: do not await delivery to the webview (it may be hidden/reloaded/closed
	// and postMessage can hang or resolve false). The webview reconciles convergently from
	// whatever state snapshots it receives, gated by stateVersion/epoch.
	for (const responseStream of activeStateSubscriptions) {
		responseStream(
			{
				stateJson,
			},
			false, // Not the last message
		).catch((error) => {
			Logger.error("Error sending state update:", error)
			activeStateSubscriptions.delete(responseStream)
		})
	}
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "cline.StateService", "subscribeToState")
}
