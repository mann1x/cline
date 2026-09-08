import type { AddLocalMcpServerRequest } from "@shared/proto/cline/mcp"
import { McpServers } from "@shared/proto/cline/mcp"
import { convertMcpServersToProtoMcpServers } from "@/shared/proto-conversions/mcp/mcp-server-conversion"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Adds a locally-launched MCP server — one Cline starts itself and talks to
 * over stdio.
 *
 * The settings file has always accepted these; there was simply no way to add
 * one except by opening the JSON and writing it by hand, which is what this
 * replaces. The counterpart for servers Cline connects to over the network is
 * `addRemoteMcpServer`.
 */
export async function addLocalMcpServer(controller: Controller, request: AddLocalMcpServerRequest): Promise<McpServers> {
	try {
		if (!request.serverName) {
			throw new Error("Server name is required")
		}
		if (!request.command) {
			throw new Error("Command is required")
		}

		const servers = await controller.mcpHub?.addLocalServer(request.serverName, {
			command: request.command,
			args: request.args ?? [],
			env: request.env ?? {},
			cwd: request.cwd,
		})

		return McpServers.create({ mcpServers: convertMcpServersToProtoMcpServers(servers) })
	} catch (error) {
		Logger.error(`Failed to add local MCP server ${request.serverName}:`, error)

		throw error
	}
}
