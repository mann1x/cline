import { createMcpTools } from "@cline/core"
import type { AgentTool, AgentToolContext } from "@cline/shared"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

/**
 * MCP servers Cline did not start, borrowed from VS Code.
 *
 * A server configured in VS Code is already running, already authenticated and
 * already exposing its tools to any extension that asks. Cline's own MCP client
 * has to repeat all three, and for a server that refuses dynamic client
 * registration -- Figma's advertises a registration endpoint and 403s everyone
 * -- the second of those cannot be repeated at all: there is no way to obtain a
 * client id, so the server is simply unreachable from here. VS Code holds a
 * token for it. Invoking through VS Code is the only route to that server, and
 * it happens to be the cheaper route to every other one.
 *
 * The seam is `vscode.lm.tools` and `vscode.lm.invokeTool`. The doc comment on
 * `lm.tools` says the list is tools "registered by all extensions using
 * `lm.registerTool`", which reads as though an extension only sees its own and
 * is wrong on both counts. In `extHostLanguageModelTools.getTools` the list is
 * every tool the workbench knows about, filtered only for four internal ids
 * behind a proposed API; MCP servers reach it through
 * `mcpLanguageModelToolContribution._syncTools`, which registers each of their
 * tools into the same service. Checked at `main` and at the 1.101 typings this
 * extension compiles against.
 *
 * Identifying them is exact rather than heuristic: that contribution sets
 * `tags: ['mcp']` on every tool it registers and nothing else in the workbench
 * does, so the tag is the filter. The name is the tool's id, which VS Code
 * builds as `mcp_` + a server-derived prefix + the tool's own name.
 */

/** The tag `mcpLanguageModelToolContribution` puts on every tool it registers. */
const MCP_TAG = "mcp"

/** VS Code's own prefix on those ids, stripped so names do not say mcp twice. */
const VSCODE_MCP_ID_PREFIX = "mcp_"

/**
 * The server name these tools are grouped under.
 *
 * Not the originating MCP server: VS Code flattens that into the id and does
 * not hand the extension anything else to group by. What the model needs to
 * know is which side of the wall the tool lives on, and that is the honest
 * answer -- a `figma` server configured in both places produces
 * `figma__get_code` and `vscode__figma_get_code`, which is confusing only if
 * they were the same tool, and they are not.
 */
const VSCODE_MCP_SERVER_NAME = "vscode"

export function areVscodeMcpToolsEnabled(): boolean {
	return vscode.workspace.getConfiguration("cline").get<boolean>("vscodeMcpTools") !== false
}

/** What `lm.tools` reports for one MCP tool, reduced to what is used here. */
interface VscodeMcpTool {
	/** VS Code's tool id, and what `invokeTool` is called with. */
	id: string
	/** The id with `mcp_` removed, which is what the model sees. */
	exposedName: string
	description: string
	inputSchema: Record<string, unknown>
}

function listVscodeMcpTools(): VscodeMcpTool[] {
	// Guarded because this whole API is optional from this file's point of
	// view: an older VS Code, or a host that stubs `vscode` (the tests do),
	// should end up with no tools rather than a failed session.
	const available = vscode.lm?.tools
	if (!available) {
		return []
	}

	const tools: VscodeMcpTool[] = []
	for (const tool of available) {
		if (!tool.tags?.includes(MCP_TAG)) {
			continue
		}
		const exposedName = tool.name.startsWith(VSCODE_MCP_ID_PREFIX) ? tool.name.slice(VSCODE_MCP_ID_PREFIX.length) : tool.name
		if (!exposedName) {
			continue
		}
		tools.push({
			id: tool.name,
			exposedName,
			description: tool.description,
			// A tool with no schema takes no arguments; the empty object says
			// that, where `undefined` would be read as "unknown" by a provider
			// that then declines to call it.
			inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
		})
	}
	return tools
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Bridges an abort signal to VS Code's cancellation token.
 *
 * `invokeTool` takes a token and nothing else, and the agent runtime cancels
 * with a signal. Without this a stopped task leaves the tool running -- and an
 * MCP tool can be a long remote call, which is exactly the case where stopping
 * has to mean something.
 */
function tokenFor(signal: AbortSignal | undefined): {
	token: vscode.CancellationToken
	dispose: () => void
} {
	const source = new vscode.CancellationTokenSource()
	if (!signal) {
		return { token: source.token, dispose: () => source.dispose() }
	}
	if (signal.aborted) {
		source.cancel()
		return { token: source.token, dispose: () => source.dispose() }
	}
	const onAbort = () => source.cancel()
	signal.addEventListener("abort", onAbort, { once: true })
	return {
		token: source.token,
		dispose: () => {
			signal.removeEventListener("abort", onAbort)
			source.dispose()
		},
	}
}

/**
 * Flattens a `LanguageModelToolResult` into the shape a real MCP call returns.
 *
 * Everything downstream of the tool -- the transcript, the truncation, the
 * webview row -- already understands `{ content: [{ type, text }] }`, because
 * that is what Cline's own MCP client hands back. Returning the VS Code object
 * instead would work its way through as `[object Object]`.
 */
function flattenResult(result: vscode.LanguageModelToolResult): { content: { type: "text"; text: string }[] } {
	const parts: string[] = []
	for (const part of result.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) {
			parts.push(part.value)
			continue
		}
		// Anything else is a part type this extension does not render: a
		// prompt-tsx element, or a content type added after this was written.
		// Its JSON is worth more to the model than dropping it silently.
		try {
			parts.push(JSON.stringify(part))
		} catch {
			parts.push(String(part))
		}
	}
	return { content: [{ type: "text", text: parts.join("\n") }] }
}

/**
 * The MCP tools VS Code has, as Cline tools.
 *
 * Built through `createMcpTools` rather than by hand so these are named,
 * described and timed out exactly like the servers Cline runs itself: from the
 * model's side the only difference is the `vscode__` prefix.
 */
export async function createVscodeLmMcpTools(options?: { timeoutMs?: number }): Promise<AgentTool[]> {
	if (!areVscodeMcpToolsEnabled()) {
		return []
	}

	let discovered: VscodeMcpTool[]
	try {
		discovered = listVscodeMcpTools()
	} catch (error) {
		Logger.warn(
			`[VscodeLmMcpTools] Could not read vscode.lm.tools: ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}

	if (discovered.length === 0) {
		return []
	}

	const byExposedName = new Map(discovered.map((tool) => [tool.exposedName, tool]))

	const tools = await createMcpTools({
		serverName: VSCODE_MCP_SERVER_NAME,
		timeoutMs: options?.timeoutMs,
		provider: {
			listTools: async () =>
				discovered.map((tool) => ({
					name: tool.exposedName,
					description: tool.description,
					inputSchema: tool.inputSchema,
				})),
			callTool: async (request: {
				serverName: string
				toolName: string
				arguments?: Record<string, unknown>
				context?: AgentToolContext
			}) => {
				const tool = byExposedName.get(request.toolName)
				if (!tool) {
					throw new Error(`VS Code no longer offers the MCP tool "${request.toolName}"`)
				}
				const { token, dispose } = tokenFor(request.context?.signal)
				try {
					const result = await vscode.lm.invokeTool(
						tool.id,
						// `undefined` is the documented value here, not an
						// omission: the token ties a call to a chat request so
						// the chat view can draw a progress bar for it, and the
						// API says to pass undefined when invoking outside one.
						// It is required rather than optional so that a caller
						// has to have decided.
						{ toolInvocationToken: undefined, input: request.arguments ?? {} },
						token,
					)
					return flattenResult(result)
				} finally {
					dispose()
				}
			},
		},
	})

	Logger.log(
		`[VscodeLmMcpTools] Adopted ${tools.length} MCP tool(s) from VS Code: ${discovered.map((tool) => tool.id).join(", ")}`,
	)
	return tools
}
