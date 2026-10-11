export interface WebviewMessage {
	/** `dock_chat` comes from the sidebar's placeholder while the chat is undocked. */
	/**
	 * `state_applied` is the webview saying it has applied the last state
	 * snapshot it was sent, which is what lets the host hold the next one
	 * instead of queueing it in the webview's memory.
	 */
	type: "grpc_request" | "grpc_request_cancel" | "dock_chat" | "state_applied"
	grpc_request?: GrpcRequest
	grpc_request_cancel?: GrpcCancel
}

export type GrpcRequest = {
	service: string
	method: string
	message: any // JSON serialized protobuf message
	request_id: string // For correlating requests and responses
	is_streaming: boolean // Whether this is a streaming request
}

export type GrpcCancel = {
	request_id: string // ID of the request to cancel
}

export type ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"

export type ClineCheckpointRestore = "task" | "workspace" | "taskAndWorkspace"

export type TaskFeedbackType = "thumbs_up" | "thumbs_down"
