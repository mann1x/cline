import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ProviderStatusState, ProviderStatusView } from "@/hooks/useProviderStatus"

/**
 * The small status dot beside the API Provider label: grey until a check has
 * answered (or for a provider that cannot be checked), green when the
 * endpoint answered, red when it did not. Pressing it checks again.
 */

const COLOR: Record<ProviderStatusState, string> = {
	unknown: "var(--vscode-descriptionForeground)",
	ready: "var(--vscode-testing-iconPassed, #73c991)",
	fail: "var(--vscode-errorForeground)",
}

const LABEL: Record<ProviderStatusState, string> = {
	unknown: "Status unknown",
	ready: "Ready",
	fail: "Not working",
}

export function ProviderStatusDot({ status }: { status: ProviderStatusView }) {
	const { state, detail, checking, recheck } = status
	const label = checking ? "Checking…" : LABEL[state]
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-busy={checking}
					aria-label={`Provider status: ${label}. ${detail} Press to check again.`}
					className="inline-flex items-center justify-center p-0.5 rounded-full bg-transparent border-0 cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					// Not data-state: the tooltip trigger writes its own there.
					data-status={state}
					data-testid="provider-status-dot"
					onClick={recheck}
					type="button">
					<span
						style={{
							display: "inline-block",
							width: 8,
							height: 8,
							borderRadius: "50%",
							backgroundColor: COLOR[state],
							opacity: checking ? 0.45 : 1,
							transition: "opacity 150ms",
						}}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 p-1">
					<strong>{label}</strong>
					<span>{detail}</span>
					<span className="text-description">Click to check again.</span>
				</div>
			</TooltipContent>
		</Tooltip>
	)
}
