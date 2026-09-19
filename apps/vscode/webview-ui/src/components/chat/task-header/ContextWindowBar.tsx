import type { ContextBreakdown } from "@shared/ExtensionMessage"

/**
 * The context bar, coloured by what the tokens are.
 *
 * One bar and one number is what the header showed, and on a local model most
 * of that bar is a price nobody typed: measured on pandorum against a
 * 65,536-token window, 21,000-24,000 tokens of system prompt and tool schemas
 * before the first message, of which the prompt is 1,607. Told only a total,
 * a user watching the bar start a third full has no way to see that the
 * remedy is a tool switch rather than a shorter conversation.
 *
 * Three fixed slices and the conversation, in the order they are paid:
 * the system prompt, the agent's own tool schemas, the MCP servers' schemas,
 * and then the messages. The colours come from VS Code's chart palette so they
 * hold in both themes; the conversation takes the editor foreground, which is
 * the theme's reading of "the ordinary one".
 */
export const CONTEXT_SEGMENT_COLORS = {
	systemPrompt: "var(--vscode-charts-green)",
	builtinTools: "var(--vscode-charts-blue)",
	mcpTools: "var(--vscode-charts-purple)",
	messages: "var(--vscode-foreground)",
} as const

export type ContextSegmentKey = keyof typeof CONTEXT_SEGMENT_COLORS

export interface ContextSegment {
	key: ContextSegmentKey
	label: string
	tokens: number
	color: string
}

const SEGMENT_LABELS: Record<ContextSegmentKey, string> = {
	systemPrompt: "System prompt",
	builtinTools: "Tool schemas",
	mcpTools: "MCP tool schemas",
	messages: "Conversation",
}

/**
 * Split a request's tokens into the slices the bar draws.
 *
 * `used` is the provider's own count of the request; the breakdown is this
 * fork's estimate of the fixed part of it, made before the request went out.
 * They are two measurements of overlapping things and the estimate can come
 * out larger, so the fixed slices are scaled down to fit rather than allowed
 * to overrun into a negative conversation -- a bar that claims more tokens
 * than the request had is a wrong picture, and one with a missing slice is a
 * confusing one. Scaling keeps the proportions, which is what the colours are
 * for, and the hover card reports the measured numbers unscaled.
 *
 * Returns an empty list when there is nothing to colour, and the caller then
 * draws the plain bar it drew before.
 */
export function contextWindowSegments(used: number, breakdown?: ContextBreakdown): ContextSegment[] {
	if (!breakdown || used <= 0) {
		return []
	}
	const fixed = [
		{ key: "systemPrompt" as const, tokens: Math.max(0, breakdown.systemPromptTokens) },
		{ key: "builtinTools" as const, tokens: Math.max(0, breakdown.builtinToolSchemaTokens) },
		{ key: "mcpTools" as const, tokens: Math.max(0, breakdown.mcpToolSchemaTokens) },
	]
	const fixedTotal = fixed.reduce((sum, part) => sum + part.tokens, 0)
	if (fixedTotal <= 0) {
		return []
	}
	const scale = fixedTotal > used ? used / fixedTotal : 1
	const segments: ContextSegment[] = fixed
		.map(({ key, tokens }) => ({
			key,
			label: SEGMENT_LABELS[key],
			tokens: tokens * scale,
			color: CONTEXT_SEGMENT_COLORS[key],
		}))
		.filter((segment) => segment.tokens > 0)
	const messages = used - fixedTotal * scale
	if (messages > 0) {
		segments.push({
			key: "messages",
			label: SEGMENT_LABELS.messages,
			tokens: messages,
			color: CONTEXT_SEGMENT_COLORS.messages,
		})
	}
	return segments
}

interface ContextWindowBarProps {
	used: number
	max: number
	breakdown?: ContextBreakdown
}

/**
 * The bar itself. Falls back to one undivided fill whenever there is no
 * breakdown to draw, so a session running on a core that does not report one
 * looks exactly as it did.
 */
export const ContextWindowBar: React.FC<ContextWindowBarProps> = ({ used, max, breakdown }) => {
	const segments = max > 0 ? contextWindowSegments(used, breakdown) : []
	const percent = (tokens: number) => (max > 0 ? Math.min(100, (tokens / max) * 100) : 0)

	return (
		<div
			aria-label="Context window usage progress"
			aria-valuemax={max}
			aria-valuemin={0}
			aria-valuenow={Math.round(used)}
			className="relative flex h-3 w-full overflow-hidden rounded-full bg-code-foreground/20"
			data-testid="context-window-bar"
			role="progressbar">
			{segments.length > 0 ? (
				segments.map((segment) => (
					<div
						data-segment={segment.key}
						key={segment.key}
						style={{ width: `${percent(segment.tokens)}%`, backgroundColor: segment.color }}
						title={`${segment.label}: ${Math.round(segment.tokens).toLocaleString()} tokens`}
					/>
				))
			) : (
				<div
					data-segment="total"
					style={{ width: `${percent(used)}%`, backgroundColor: CONTEXT_SEGMENT_COLORS.messages }}
				/>
			)}
		</div>
	)
}
