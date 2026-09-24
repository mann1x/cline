import { HistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/cline/common"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	ChevronsDownUpIcon,
	ChevronsUpDownIcon,
	CopyIcon,
	DownloadIcon,
	StarIcon,
	TrashIcon,
} from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { hasReportableCost, useUsageCostVisibility } from "@/hooks/useUsageCostVisibility"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { writeToClipboard } from "@/utils/clipboard"
import { formatLargeNumber, formatSize } from "@/utils/format"
import { HISTORY_SETTINGS_HOVER_DELAY_MS, HistorySettingsTooltip } from "./HistorySettingsTooltip"

type HistoryViewItemProps = {
	item: HistoryItem
	index: number
	selectedItems: string[]
	pendingFavoriteToggles: Record<string, boolean>
	handleDeleteHistoryItem: (id: string) => void
	toggleFavorite: (id: string, isCurrentlyFavorited: boolean) => void
	handleHistorySelect: (itemId: string, checked: boolean) => void
}

const HistoryViewItem = ({
	item,
	pendingFavoriteToggles,
	handleDeleteHistoryItem,
	toggleFavorite,
	handleHistorySelect,
	selectedItems,
}: HistoryViewItemProps) => {
	const [expanded, setExpanded] = useState(false)
	const isCostVisible = useUsageCostVisibility()
	const { markTaskOpenedFromHistory } = useExtensionState()

	const isFavoritedItem = useMemo(
		() => pendingFavoriteToggles[item.id] ?? item.isFavorited,
		[item.id, item.isFavorited, pendingFavoriteToggles],
	)

	const handleShowTaskWithId = useCallback(
		(id: string) => {
			markTaskOpenedFromHistory(id)
			TaskServiceClient.showTaskWithId(StringRequest.create({ value: id })).catch((error) =>
				console.error("Error showing task:", error),
			)
		},
		[markTaskOpenedFromHistory],
	)

	const formatDate = useCallback((timestamp: number) => {
		const date = new Date(timestamp)
		const today = new Date()
		const isToday = today.toDateString() === date.toDateString()

		return date
			.toLocaleString(
				"en-US",
				isToday
					? {
							hour: "numeric",
							minute: "2-digit",
							hour12: true,
						}
					: {
							month: "long",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
							hour12: true,
						},
			)
			.replace(", ", " ")
			.replace(" at", ",")
	}, [])

	return (
		<div className="history-item cursor-pointer flex group mb-1 hover:bg-list-hover border-b border-accent/10" key={item.id}>
			<VSCodeCheckbox
				checked={selectedItems.includes(item.id)}
				className="pl-3 pr-1 py-auto self-start mt-3"
				onClick={(e) => {
					e.preventDefault()
					e.stopPropagation()
					const checked = (e.target as HTMLInputElement).checked
					handleHistorySelect(item.id, checked)
				}}
			/>

			<Tooltip delayDuration={HISTORY_SETTINGS_HOVER_DELAY_MS}>
				<TooltipTrigger asChild>
					{/* A row that opens a session is a button, and saying so is
					    what lets the settings card be reached by keyboard at
					    all: a hover-only card does not exist for anyone not
					    using a pointer. */}
					{/* biome-ignore lint/a11y/useSemanticElements: it cannot be a <button> -- the row already contains the delete, export and favourite buttons, and a button inside a button is invalid HTML that browsers reparent. */}
					<div
						aria-label={item.task}
						className="flex flex-col gap-2 py-2 pl-2 pr-3 relative flex-grow min-w-0"
						onClick={(e) => {
							e.stopPropagation()
							handleShowTaskWithId(item.id)
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault()
								e.stopPropagation()
								handleShowTaskWithId(item.id)
							}
							// Copy the first prompt (the task text) to the clipboard.
							if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
								e.preventDefault()
								e.stopPropagation()
								void writeToClipboard(item.task)
							}
						}}
						role="button"
						tabIndex={0}>
						<div className="flex items-center gap-2">
							<div className="line-clamp-1 overflow-hidden break-words whitespace-pre-wrap flex-1 min-w-0">
								<span className="ph-no-capture">{item.task}</span>
							</div>
							{item.isLegacy && (
								<span className="text-xs uppercase rounded px-1.5 py-0.5 bg-accent/20 text-description flex-shrink-0">
									Legacy
								</span>
							)}
							<div className="flex gap-2 flex-shrink-0">
								<Button
									aria-label="Copy first prompt"
									className="p-0 opacity-0 group-hover:opacity-100 transition-opacity"
									onClick={(e) => {
										e.stopPropagation()
										void writeToClipboard(item.task)
									}}
									variant="ghost">
									<span className="flex items-center gap-1 text-xs">
										<CopyIcon className="stroke-1" />
									</span>
								</Button>
								<Button
									aria-label="Delete"
									className="p-0 opacity-0 group-hover:opacity-100 transition-opacity"
									disabled={isFavoritedItem}
									onClick={(e) => {
										e.stopPropagation()
										handleDeleteHistoryItem(item.id)
									}}
									variant="ghost">
									<span className="flex items-center gap-1 text-xs">
										<TrashIcon className="stroke-1" />
									</span>
								</Button>
								<Button
									aria-label={isFavoritedItem ? "Remove from favorites" : "Add to favorites"}
									className="p-0"
									disabled={pendingFavoriteToggles[item.id] !== undefined}
									onClick={(e) => {
										e.stopPropagation()
										toggleFavorite(item.id, isFavoritedItem)
									}}
									variant="icon">
									<StarIcon
										className={cn("opacity-70", {
											"text-button-background  fill-button-background opacity-100": isFavoritedItem,
										})}
									/>
								</Button>
							</div>
						</div>

						<Button
							className="p-0"
							onClick={(e) => {
								e.stopPropagation()
								setExpanded(!expanded)
							}}
							variant="icon">
							<div className="flex items-center justify-between w-full">
								<div className="text-description text-xs uppercase">{formatDate(item.ts)}</div>
								<div className="self-end flex items-center text-xs">
									{hasReportableCost(item.totalCost) && isCostVisible(item.apiProvider) && (
										<span className="text-description">${item.totalCost?.toFixed(4)}</span>
									)}
									{expanded ? (
										<ChevronsDownUpIcon className="text-description" />
									) : (
										<ChevronsUpDownIcon className="text-description hidden opacity-0 group-hover:opacity-100 transition-opacity group-hover:block" />
									)}
								</div>
							</div>
						</Button>
						{expanded && (
							<Button
								className="m-0 text-xs cursor-pointer p-2 bg-accent/10 w-full rounded-xs"
								onClick={(e) => {
									e.stopPropagation()
									setExpanded(!expanded)
								}}
								variant="text">
								<div className="flex flex-col gap-1 w-full text-xs">
									<div className="flex items-center justify-between w-full">
										<div className="flex items-center gap-1 flex-wrap w-full">
											<div className="flex justify-between items-center w-full gap-1 text-xs">
												<span className="font-medium text-description">Tokens:</span>
												<div className="flex items-center gap-1 text-description text-xs">
													<span className="flex items-center gap-1 text-description">
														<ArrowUpIcon className="text-description !size-1" />
														{formatLargeNumber(item.tokensIn || 0)}
													</span>
													<span className="flex items-center gap-1 text-description">
														<ArrowDownIcon className="text-description !size-1" />
														{formatLargeNumber(item.tokensOut || 0)}
													</span>
													{item.cacheWrites
														? item.cacheWrites > 0 && (
																<span className="flex items-center gap-1 text-description">
																	<ArrowRightIcon className="text-description !size-1" />
																	{formatLargeNumber(item.cacheWrites)}
																</span>
															)
														: null}
													{item.cacheReads
														? item.cacheReads > 0 && (
																<span className="flex items-center gap-1 text-description">
																	<ArrowLeftIcon className="text-description !size-1" />
																	{formatLargeNumber(item.cacheReads)}
																</span>
															)
														: null}
												</div>
											</div>

											{item.modelId && (
												<div className="flex justify-between items-center w-full gap-1 text-xs">
													<span className="font-medium text-description">Model:</span>
													<span className="text-description">{item.modelId}</span>
												</div>
											)}

											<div className="flex justify-between items-center w-full gap-1 text-xs">
												<span className="font-medium text-description">Size:</span>
												<span className="items-center gap-2 flex text-description">
													{formatSize(item.size)}
													<Button
														aria-label="Export"
														className="m-0 p-0"
														onClick={(e) => {
															e.stopPropagation()
															TaskServiceClient.exportTaskWithId(
																StringRequest.create({ value: item.id }),
															).catch((err) => console.error("Failed to export task:", err))
														}}
														variant="ghost">
														<DownloadIcon />
													</Button>
												</span>
											</div>
										</div>
									</div>
								</div>
							</Button>
						)}
					</div>
				</TooltipTrigger>
				{/* Above the row, never beside it. This panel is a sidebar -- a row
				    spans nearly its whole width, so `side="left"` leaves no room on
				    either side, and Radix cannot flip away from a collision it has
				    nowhere to flip to: the card hung off the left edge with only its
				    right sliver visible. Vertically it has the full panel width, and
				    a row near the top flips to `bottom` on its own. */}
				{item.settings && item.settings.length > 0 && (
					<TooltipContent align="start" side="top" sideOffset={4}>
						<HistorySettingsTooltip settings={item.settings} />
					</TooltipContent>
				)}
			</Tooltip>
		</div>
	)
}

export default memo(HistoryViewItem)
