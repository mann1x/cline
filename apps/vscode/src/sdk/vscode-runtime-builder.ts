import { createBrowserTool, createCodeIntelTool, createListFilesTool, createMcpTools } from "@cline/core"
import type { AgentTool, AgentToolContext } from "@cline/shared"
import { createVscodeBrowserDriver, isBrowserToolEnabled } from "@/hosts/vscode/browser-support"
import { loadDocumentForDiagnostics, resolveLintCommand, runLintCommand } from "@/hosts/vscode/check-file-support"
import { createVscodeCodeIntelProvider } from "@/hosts/vscode/code-intel-support"
import { createVscodeWorkspaceLister } from "@/hosts/vscode/list-files-support"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import type { McpHub } from "@/services/mcp/McpHub"
import { resolveMcpServerTimeoutMs } from "@/services/mcp/timeout"
import { Logger } from "@/shared/services/Logger"
import { createCheckFileTool } from "./check-file-tool"
import { readQaCredentials } from "./qa-credentials-store"
import type { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import { createVscodeLmMcpTools } from "./vscode-lm-mcp-tools"
import { createVscodeRunCommandsTool, VSCODE_FOREGROUND_RUN_COMMANDS_TIMEOUT_MS } from "./vscode-run-commands-tool"

interface McpToolDescriptor {
	name: string
	description?: string
	inputSchema: Record<string, unknown>
}

export class McpHubToolProvider {
	constructor(private readonly mcpHub: McpHub) {}

	async listTools(serverName: string): Promise<readonly McpToolDescriptor[]> {
		const servers = this.mcpHub.getServers()
		const server = servers.find((entry) => entry.name === serverName)
		if (!server) {
			Logger.warn(`[McpHubToolProvider] Server not found: ${serverName}`)
			return []
		}

		return (server.tools ?? []).map((tool) => ({
			name: tool.name,
			description: tool.description ?? undefined,
			inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
				type: "object",
				properties: {},
			},
		}))
	}

	async callTool(request: {
		serverName: string
		toolName: string
		arguments?: Record<string, unknown>
		context?: AgentToolContext
	}): Promise<unknown> {
		const ulid = `sdk-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
		return this.mcpHub.callTool(request.serverName, request.toolName, request.arguments ?? {}, ulid, request.context?.signal)
	}
}

export interface VscodeExtraToolsOptions {
	cwd?: string
	/**
	 * Lazy factory for the VscodeTerminalManager.
	 * When provided, the custom `run_commands` tool replaces the SDK's
	 * built-in version with foreground/background terminal support.
	 */
	getTerminalManager?: () => VscodeTerminalManager
	/** Current VS Code terminal execution mode, captured when the session tools are built. */
	vscodeTerminalExecutionMode?: "vscodeTerminal" | "backgroundExec"
	/** Registry of in-flight foreground executions for "Proceed While Running". */
	foregroundCommands?: SdkForegroundCommandCoordinator
	/** Files read this session; see `ListFilesToolOptions.getReadPaths`. */
	getReadPaths?: () => string[]
}

export async function createVscodeExtraTools(mcpHub: McpHub, options?: VscodeExtraToolsOptions): Promise<AgentTool[]> {
	const provider = new McpHubToolProvider(mcpHub)
	const mcpTools = await Promise.all(
		mcpHub.getServers().map(async (server) => {
			try {
				return await createMcpTools({
					serverName: server.name,
					provider,
					// Keep the tool wrapper timeout in agreement with the MCP
					// request timeout: both derive from the server's config.
					timeoutMs: resolveMcpServerTimeoutMs(server.config),
				})
			} catch (error) {
				Logger.warn(
					`[VscodeRuntimeTools] Failed to load tools from MCP server "${server.name}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
				return []
			}
		}),
	)

	// The MCP servers VS Code is running, which Cline did not start and in one
	// important case could not: a server that refuses dynamic client
	// registration cannot be authenticated from here at all, and VS Code
	// already holds a token for it. Failure to read them is not failure to
	// build a session, so this never throws.
	const vscodeLmTools = await createVscodeLmMcpTools().catch((error) => {
		Logger.warn(
			`[VscodeRuntimeTools] Failed to adopt VS Code's MCP tools: ${error instanceof Error ? error.message : String(error)}`,
		)
		return [] as AgentTool[]
	})

	// No completion tool is exposed: the agent simply ends its turn with a text
	// response, and the turn-end inference in message-translator.ts styles that
	// final text as the completion feedback row.
	const tools: AgentTool[] = [...mcpTools.flat(), ...vscodeLmTools]

	// `check_file` needs no configuration and no terminal, so it is always
	// present: the shell commands it exists to displace are always available
	// too, and a tool that is only sometimes there is one a model learns not to
	// rely on.
	tools.push(
		createCheckFileTool({
			cwd: options?.cwd ?? process.cwd(),
			loadDocument: loadDocumentForDiagnostics,
			resolveLintCommand,
			runLintCommand,
		}),
	)

	// `code_intel` is likewise unconditional. It answers from whichever language
	// servers the user already has; a language nobody installed support for
	// returns nothing, which is a cheaper failure than the tool being absent.
	tools.push(
		createCodeIntelTool({
			cwd: options?.cwd ?? process.cwd(),
			provider: createVscodeCodeIntelProvider(),
			// The tool moved into core so both hosts share it; the logger did
			// not, so it is handed over rather than imported.
			onError: (message, error) => Logger.error(`${message}:`, error),
		}),
	)

	// `list_files` is unconditional for the same reason as the other two, and
	// for one more: the thing it displaces is a shell command that already
	// works. A model that finds the tool missing does not go without — it runs
	// `dir /s`, which is exactly the unscoped search this exists to prevent.
	tools.push(
		createListFilesTool({
			cwd: options?.cwd ?? process.cwd(),
			createLister: createVscodeWorkspaceLister,
			getReadPaths: options?.getReadPaths,
		}),
	)

	// `browser` is on unless the user turned it off, and the reflex it displaces
	// is asking the user whether the page works — so it is present by default,
	// like the other two. Chrome is not launched until the model calls it, so a
	// session that never browses costs nothing for having had the tool.
	if (isBrowserToolEnabled()) {
		tools.push(
			createBrowserTool({
				cwd: options?.cwd ?? process.cwd(),
				createDriver: createVscodeBrowserDriver,
				onError: (message, error) => Logger.error(`${message}:`, error),
			}),
		)
	} else {
		Logger.log("[VscodeRuntimeTools] browser tool omitted; cline.browserTool is false")
	}

	// Add the custom run_commands tool when a terminal manager is available.
	// This replaces the SDK's built-in run_commands, which is suppressed via
	// tool executor capabilities in VscodeSessionHost.
	if (options?.getTerminalManager) {
		const executionMode = options.vscodeTerminalExecutionMode ?? "vscodeTerminal"
		tools.push(
			createVscodeRunCommandsTool({
				cwd: options.cwd ?? process.cwd(),
				getTerminalManager: options.getTerminalManager,
				bashTimeoutMs: executionMode === "vscodeTerminal" ? VSCODE_FOREGROUND_RUN_COMMANDS_TIMEOUT_MS : undefined,
				vscodeTerminalExecutionMode: executionMode,
				foregroundCommands: options.foregroundCommands,
				qaCredentials: readQaCredentials,
			}),
		)
		Logger.log(
			`[VscodeRuntimeTools] Added custom run_commands tool (mode=${executionMode}, timeoutMs=${executionMode === "vscodeTerminal" ? VSCODE_FOREGROUND_RUN_COMMANDS_TIMEOUT_MS : "default"})`,
		)
	}

	Logger.log(`[VscodeRuntimeTools] Prepared ${tools.length} VSCode extra tools`)
	return tools
}
