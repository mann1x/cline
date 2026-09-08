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

/**
 * Send a state update to all active subscribers
 * @param state The state to send
 */
export async function sendStateUpdate(state: ExtensionState): Promise<void> {
	let stateJson: string
	try {
		stateJson = JSON.stringify(state)
	} catch (error) {
		Logger.error("Error serializing state update:", error)
		return
	}

	recordStateSizeTelemetry(Buffer.byteLength(stateJson, "utf8"))

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
