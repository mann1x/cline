import type { StringRequest } from "@shared/proto/cline/common"
import { Empty } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Signs an MCP server in again with an account the user chooses.
 *
 * Authenticate is answered by stored tokens that still work, and a browser
 * that already has a session signs in with it unasked, so a wrong account
 * could not be replaced. This forgets the tokens first and opens the
 * provider's account chooser.
 */
export async function switchMcpServerAccount(controller: Controller, request: StringRequest): Promise<Empty> {
	const serverName = request.value
	if (!serverName) {
		throw new Error("Server name is required")
	}
	try {
		await controller.mcpHub?.initiateOAuth(serverName, { switchAccount: true })
		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to switch the account for MCP server ${serverName}:`, error)
		throw error
	}
}
