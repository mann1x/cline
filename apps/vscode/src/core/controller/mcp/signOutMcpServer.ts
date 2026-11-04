import type { StringRequest } from "@shared/proto/cline/common"
import { Empty } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Signs an MCP server out: revokes its tokens where the provider supports it,
 * forgets them, and reconnects it so it shows as needing authentication.
 */
export async function signOutMcpServer(controller: Controller, request: StringRequest): Promise<Empty> {
	const serverName = request.value
	if (!serverName) {
		throw new Error("Server name is required")
	}
	try {
		await controller.mcpHub?.signOutMcpServer(serverName)
		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to sign out of MCP server ${serverName}:`, error)
		throw error
	}
}
