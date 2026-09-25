import { type ContextMinimum, describeContextShortfall, estimateTokens, resolveContextMinimumForWindow } from "@cline/shared"
import { getContextWindowUsage } from "@shared/getApiMetrics"
import type { McpServer } from "@shared/mcp"
import { SELECTABLE_TOOLS } from "@shared/tool-selection"
import { useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderConfig } from "@/hooks/useProviderConfig"

/**
 * The system prompt's size when no task has measured it yet.
 *
 * The context bar's own segment is used whenever a task has one; this is the
 * figure it measured on pandorum on 2026-09-19 (5,784 characters, prompt
 * template included), for a panel opened before any task ran.
 */
export const SYSTEM_PROMPT_FALLBACK_TOKENS = 1_607

function positive(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * What the MCP servers' tool schemas cost, estimated the way a request is.
 *
 * Every tool of every server that is not switched off, serialized as it goes
 * on the wire -- name, description, input schema -- and counted with the same
 * estimator the request path uses.
 */
export function mcpSchemaTokens(servers: readonly McpServer[] | undefined): number {
	let chars = 0
	for (const server of servers ?? []) {
		if (server.disabled) {
			continue
		}
		for (const tool of server.tools ?? []) {
			chars += JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length
		}
	}
	return chars > 0 ? estimateTokens(chars) : 0
}

/**
 * The minimum context this profile needs for a given window.
 *
 * The fixed price is read from what already measures it rather than estimated
 * afresh: the system prompt from the context bar's segment when a task has
 * one, the built-in tools from the per-tool prices the Tools section shows
 * (so switching a tool off moves this number in the same render), and MCP
 * from the servers' own schemas. The output room is the resolved output cap
 * for that window -- a typed `num_predict` first, then the output budget.
 */
export function useContextMinimum(providerId: string, contextWindow: number | undefined): ContextMinimum | undefined {
	const { config } = useProviderConfig(providerId as never)
	const { clineMessages, mcpServers } = useExtensionState()
	const measuredSystemPrompt = useMemo(
		() => getContextWindowUsage(clineMessages ?? []).breakdown?.systemPromptTokens,
		[clineMessages],
	)
	const mcpTokens = useMemo(() => mcpSchemaTokens(mcpServers), [mcpServers])
	return useMemo(() => {
		if (config === undefined) {
			return undefined
		}
		const disabled = new Set(config.tools?.disabled ?? [])
		const toolSchemaTokens = SELECTABLE_TOOLS.filter((tool) => !disabled.has(tool.name)).reduce(
			(total, tool) => total + tool.tokens,
			0,
		)
		const budget = config.outputBudget as { mode?: "auto" | "manual"; maxTokens?: number } | undefined
		return resolveContextMinimumForWindow({
			contextWindow,
			systemPromptTokens: measuredSystemPrompt ?? SYSTEM_PROMPT_FALLBACK_TOKENS,
			toolSchemaTokens,
			mcpToolSchemaTokens: mcpTokens,
			explicitOutputCap: positive(config.sampling?.numPredict),
			outputBudget: {
				mode: budget?.mode === "manual" ? "manual" : "auto",
				...(positive(budget?.maxTokens) !== undefined ? { maxTokens: positive(budget?.maxTokens) } : {}),
			},
		})
	}, [config, contextWindow, measuredSystemPrompt, mcpTokens])
}

/**
 * The inline warning under a context-window field, when the window is below
 * what one turn needs. A warning, never a block: the value still saves.
 */
export const ContextMinimumWarning = ({
	providerId,
	contextWindow,
}: {
	providerId: string
	contextWindow: number | undefined
}) => {
	const minimum = useContextMinimum(providerId, contextWindow)
	const text = minimum ? describeContextShortfall(contextWindow, minimum) : undefined
	if (!text) {
		return null
	}
	return (
		<p
			className="text-xs mt-[4px] mb-[6px] text-(--vscode-editorWarning-foreground)"
			data-testid="context-minimum-warning"
			role="alert">
			<span className="codicon codicon-warning text-[11px] mr-[4px]" />
			{text}
		</p>
	)
}

export default ContextMinimumWarning
