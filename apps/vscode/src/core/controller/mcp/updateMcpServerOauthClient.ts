import { McpServers, type UpdateMcpOauthClientRequest } from "@shared/proto/cline/mcp"
import { convertMcpServersToProtoMcpServers } from "@/shared/proto-conversions/mcp/mcp-server-conversion"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/**
 * Set, or clear, the OAuth client an existing server was issued.
 *
 * The way in for a server that will not register a client for us. Figma's
 * advertises a registration endpoint and answers every anonymous registration
 * with a bare `403 Forbidden`, so the client the user created in the
 * provider's own console is the only one that will ever work — and until this
 * existed it could only be supplied by hand-editing the settings file, on a
 * server the user cannot connect to in the first place (mann1x/cline#63).
 *
 * An empty `clientId` clears the entry and returns the server to dynamic
 * registration.
 */
export async function updateMcpServerOauthClient(
	controller: Controller,
	request: UpdateMcpOauthClientRequest,
): Promise<McpServers> {
	if (!request.serverName?.trim()) {
		throw new Error("A server name is required")
	}
	try {
		const mcpServers = await controller.mcpHub?.updateServerOAuthClientRPC(request.serverName, {
			clientId: request.clientId,
			clientSecret: request.clientSecret,
		})
		return McpServers.create({ mcpServers: convertMcpServersToProtoMcpServers(mcpServers) })
	} catch (error) {
		Logger.error(`Failed to set the OAuth client for ${request.serverName}:`, error)
		throw error
	}
}
