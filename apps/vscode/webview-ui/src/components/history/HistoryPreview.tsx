import { StringRequest } from "@shared/proto/cline/common"
import { memo, useLayoutEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { hasReportableCost, useUsageCostVisibility } from "@/hooks/useUsageCostVisibility"
import { TaskServiceClient } from "@/services/grpc-client"

type HistoryPreviewProps = {
	showHistoryView: () => void
}

/** The list never shows fewer than this, even when it has to scroll to. */
export const MIN_PREVIEW_ROWS = 3

/** The host sends the 100 most recent; the home view has no use for more than this. */
const MAX_PREVIEW_ROWS = 30

/** `margin-bottom` of `.history-preview-item`, which `offsetHeight` leaves out. */
const ROW_GAP_PX = 8

/**
 * How many rows fit in `available` pixels, given the tallest row seen so far.
 *
 * The tallest, not the average: a row is one or two lines (the description
 * clamps at two), and sizing on the average would let the last row be cut.
 */
export function rowsThatFit(available: number, rowHeight: number): number {
	if (!(available > 0) || !(rowHeight > 0)) {
		return MIN_PREVIEW_ROWS
	}
	const fit = Math.floor((available + ROW_GAP_PX) / (rowHeight + ROW_GAP_PX))
	return Math.min(MAX_PREVIEW_ROWS, Math.max(MIN_PREVIEW_ROWS, fit))
}

const HistoryPreview = ({ showHistoryView }: HistoryPreviewProps) => {
	const { taskHistory } = useExtensionState()
	const isCostVisible = useUsageCostVisibility()
	const listRef = useRef<HTMLDivElement>(null)
	const [rowCount, setRowCount] = useState(MIN_PREVIEW_ROWS)
	// Only ever grows. Measured on the rows currently shown, so if dropping the
	// tallest row could shrink it, the count would rise, bring that row back,
	// and fall again -- a list that flickers between two lengths.
	const tallestRow = useRef(0)

	// Show as many as the space the home view leaves us holds. The list grows
	// into that space (see the flex settings below) and never shrinks under
	// the minimum; on a short window the home view scrolls instead.
	useLayoutEffect(() => {
		const list = listRef.current
		if (!list || typeof ResizeObserver === "undefined") {
			return
		}
		const measure = () => {
			const rows = Array.from(list.querySelectorAll<HTMLElement>(".history-preview-item"))
			tallestRow.current = rows.reduce((max, row) => Math.max(max, row.offsetHeight), tallestRow.current)
			setRowCount(rowsThatFit(list.clientHeight, tallestRow.current))
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(list)
		return () => observer.disconnect()
	}, [])
	const handleHistorySelect = (id: string) => {
		TaskServiceClient.showTaskWithId(StringRequest.create({ value: id })).catch((error) =>
			console.error("Error showing task:", error),
		)
	}

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp)
		return date?.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
		})
	}

	return (
		<div style={{ flex: "1 0 auto", display: "flex", flexDirection: "column" }}>
			<style>
				{`
					.history-preview-item {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 65%, transparent);
						border-radius: 4px;
						position: relative;
						overflow: hidden;
						cursor: pointer;
						margin-bottom: 8px;
						padding: 10px 12px;
						display: flex;
						align-items: flex-start;
						gap: 12px;
					}
					.history-preview-item:hover {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 100%, transparent);
						pointer-events: auto;
					}
					.history-task-content {
						flex: 1;
						display: flex;
						align-items: flex-start;
						gap: 8px;
						min-width: 0;
					}
					.history-task-description {
						flex: 1;
						overflow: hidden;
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						color: var(--vscode-foreground);
						font-size: var(--vscode-font-size);
						line-height: 1.4;
					}
					.history-meta-stack {
						display: flex;
						flex-direction: column;
						align-items: center;
						gap: 4px;
						flex-shrink: 0;
					}
					.history-date {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						white-space: nowrap;
					}
					.history-cost-chip {
						background-color: var(--vscode-badge-background);
						color: var(--vscode-badge-foreground);
						padding: 2px 8px;
						border-radius: 12px;
						font-size: 0.85em;
						font-weight: 500;
						white-space: nowrap;
					}
					.history-view-all-btn {
						background: none;
						border: none;
						padding: 4px 0 4px 8px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
						white-space: nowrap;
						display: flex;
						align-items: center;
						gap: 2px;
					}
					.history-view-all-btn .codicon {
						font-size: 1.2em;
					}
					.history-view-all-btn:hover {
						color: var(--vscode-foreground);
					}
				`}
			</style>

			<div
				className="history-header"
				style={{
					color: "var(--vscode-descriptionForeground)",
					margin: "10px 16px 10px 16px",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}>
				<div style={{ display: "flex", alignItems: "center" }}>
					<span
						className="codicon codicon-comment-discussion"
						style={{
							marginRight: "4px",
							transform: "scale(0.9)",
						}}
					/>
					<span
						style={{
							fontWeight: 500,
							fontSize: "0.85em",
							textTransform: "uppercase",
						}}>
						Recent
					</span>
				</div>
				{taskHistory.filter((item) => item.ts && item.task).length > 0 && (
					<button
						aria-label="View all history"
						className="history-view-all-btn"
						onClick={() => showHistoryView()}
						type="button">
						View All
						<span className="codicon codicon-chevron-right" />
					</button>
				)}
			</div>

			{
				<div className="px-4" ref={listRef} style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
					{taskHistory.filter((item) => item.ts && item.task).length > 0 ? (
						taskHistory
							.filter((item) => item.ts && item.task)
							.slice(0, rowCount)
							.map((item) => (
								<div className="history-preview-item" key={item.id} onClick={() => handleHistorySelect(item.id)}>
									<div className="history-task-content">
										{item.isFavorited && (
											<span
												aria-label="Favorited"
												className="codicon codicon-star-full"
												style={{
													color: "var(--vscode-button-background)",
													flexShrink: 0,
												}}
											/>
										)}
										<div className="history-task-description ph-no-capture">{item.task}</div>
										{item.isLegacy && <span className="history-cost-chip">Legacy</span>}
									</div>
									<div className="history-meta-stack">
										<span className="history-date">{formatDate(item.ts)}</span>
										{hasReportableCost(item.totalCost) && isCostVisible(item.apiProvider) && (
											<span className="history-cost-chip">${item.totalCost.toFixed(2)}</span>
										)}
									</div>
								</div>
							))
					) : (
						<div
							style={{
								textAlign: "center",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "var(--vscode-font-size)",
								padding: "10px 0",
							}}>
							No recent tasks
						</div>
					)}
				</div>
			}
		</div>
	)
}

export default memo(HistoryPreview)
