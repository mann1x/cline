import type { HistoryItem } from "@shared/HistoryItem"
import { render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const captured = vi.hoisted(() => ({ tooltipContentProps: [] as Array<Record<string, unknown>> }))

// The real Radix content portals and measures; here only the props matter.
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	TooltipContent: (props: Record<string, unknown>) => {
		captured.tooltipContentProps.push(props)
		return <div>{props.children as React.ReactNode}</div>
	},
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ markTaskOpenedFromHistory: vi.fn() }),
}))
vi.mock("@/hooks/useUsageCostVisibility", () => ({
	useUsageCostVisibility: () => false,
	hasReportableCost: () => false,
}))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { showTaskWithId: vi.fn(), exportTaskWithId: vi.fn() } }))
vi.mock("@shared/proto/cline/common", () => ({ StringRequest: { create: (x: unknown) => x } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: (props: Record<string, unknown>) => <input type="checkbox" {...props} />,
}))

import HistoryViewItem from "./HistoryViewItem"

const item = {
	id: "task-1",
	ts: Date.now(),
	task: "check manic_miner.html",
	tokensIn: 1,
	tokensOut: 1,
	totalCost: 0,
	settings: [{ label: "Provider", value: "opencoti" }],
} as HistoryItem

const renderRow = () =>
	render(
		<HistoryViewItem
			handleDeleteHistoryItem={vi.fn()}
			handleHistorySelect={vi.fn()}
			index={0}
			item={item}
			pendingFavoriteToggles={{}}
			selectedItems={[]}
			toggleFavorite={vi.fn()}
		/>,
	)

describe("HistoryViewItem settings card", () => {
	beforeEach(() => {
		captured.tooltipContentProps = []
	})

	// The panel is a sidebar and a row spans nearly all of it, so there is no
	// room to either side. Radix cannot flip away from a collision it has
	// nowhere to flip to, and the card hung off the left edge with only its
	// right sliver visible. Vertically it has the full panel width.
	it("opens above the row, never beside it", () => {
		renderRow()

		expect(captured.tooltipContentProps).toHaveLength(1)
		expect(captured.tooltipContentProps[0].side).toBe("top")
	})

	// Nothing to say, nothing to cover the row with.
	it("renders no card for a session with no recorded settings", () => {
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={vi.fn()}
				handleHistorySelect={vi.fn()}
				index={0}
				item={{ ...item, settings: [] }}
				pendingFavoriteToggles={{}}
				selectedItems={[]}
				toggleFavorite={vi.fn()}
			/>,
		)

		expect(captured.tooltipContentProps).toHaveLength(0)
	})
})
