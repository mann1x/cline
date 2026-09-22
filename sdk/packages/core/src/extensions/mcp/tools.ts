import { type AgentTool, createTool } from "@cline/shared";
import { defaultMcpToolNameTransform } from "./name-transform";
import type { CreateMcpToolsOptions, McpToolDescriptor } from "./types";

/**
 * The description the model is given for an MCP tool.
 *
 * The server name has to be carried here, because it is carried nowhere else.
 * A provider takes a flat list of tools, so the only trace of which server a
 * tool came from is the `serverName__toolName` prefix -- and nothing tells the
 * model that the prefix denotes a server, or that the thing behind it is MCP
 * at all. Asked to "use the MCP LSP server" it does not connect the request to
 * the `lsp__*` tools in front of it.
 *
 * One clause per tool is the whole fix. It costs a handful of tokens on the
 * tools actually connected, where a prompt section naming every server would
 * be paid for on every request whether the servers are used or not -- and the
 * fixed price of tool schemas is already about a third of the window here.
 *
 * This used to return the server's own description untouched whenever it had
 * one, so the sentence naming the server was the branch that essentially never
 * ran: every real MCP server ships descriptions.
 */
function defaultMcpDescription(
	serverName: string,
	tool: McpToolDescriptor,
): string {
	const base = tool.description?.trim();
	const origin = `From the "${serverName}" MCP server.`;
	return base
		? `${base}\n\n${origin}`
		: `Execute MCP tool "${tool.name}". ${origin}`;
}

export async function createMcpTools(
	options: CreateMcpToolsOptions,
): Promise<AgentTool[]> {
	const descriptors = await options.provider.listTools(options.serverName);
	const nameTransform = options.nameTransform ?? defaultMcpToolNameTransform;

	return descriptors.map((descriptor) => {
		const agentToolName = nameTransform({
			serverName: options.serverName,
			toolName: descriptor.name,
		});

		return createTool({
			name: agentToolName,
			description: defaultMcpDescription(options.serverName, descriptor),
			inputSchema: descriptor.inputSchema,
			// Counted apart from the agent's own schemas in the request's fixed
			// price. Every MCP tool the session sees is built here, the editor
			// bridge included, so this is the one place that has to say so.
			source: "mcp",
			timeoutMs: options.timeoutMs,
			retryable: options.retryable,
			maxRetries: options.maxRetries,
			execute: async (input: unknown, context) =>
				options.provider.callTool({
					serverName: options.serverName,
					toolName: descriptor.name,
					arguments:
						input && typeof input === "object" && !Array.isArray(input)
							? (input as Record<string, unknown>)
							: undefined,
					context,
				}),
		});
	});
}
