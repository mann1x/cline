import * as PopoverPrimitive from "@radix-ui/react-popover"
import { StringRequest } from "@shared/proto/cline/common"
import type { TaskSizeOnDisk } from "@shared/proto/cline/task"
import { CopyIcon, HardDriveIcon, TrashIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { writeToClipboard } from "@/utils/clipboard"
import { formatSize } from "@/utils/format"

type SizeState =
	| { kind: "idle" }
	| { kind: "measuring" }
	| { kind: "measured"; size: TaskSizeOnDisk }
	| { kind: "unavailable"; reason: string }

export type HistoryItemContextMenuProps = {
	/** Where the right-click landed, relative to the row. */
	at: { x: number; y: number } | undefined
	onClose: () => void
	taskId: string
	firstPrompt: string
	/** A favourite cannot be deleted from the list; the menu says so rather than hiding it. */
	canDelete: boolean
	onDelete: () => void
}

/**
 * The right-click menu on a conversation in history.
 *
 * Copy and Delete are also on the row; "Size on disk" lives only here, because
 * it measures on demand -- walking a session with a swarm's overlays is not
 * something to do for every row the list renders.
 */
export const HistoryItemContextMenu = ({
	at,
	onClose,
	taskId,
	firstPrompt,
	canDelete,
	onDelete,
}: HistoryItemContextMenuProps) => {
	const [size, setSize] = useState<SizeState>({ kind: "idle" })

	// A fresh menu measures afresh: the last answer may be minutes old.
	useEffect(() => {
		if (at) {
			setSize({ kind: "idle" })
		}
	}, [at])

	const measure = () => {
		setSize({ kind: "measuring" })
		TaskServiceClient.getTaskSizeOnDisk(StringRequest.create({ value: taskId }))
			.then((result) =>
				setSize(
					result.measured
						? { kind: "measured", size: result }
						: { kind: "unavailable", reason: "This conversation has no session data on disk to measure." },
				),
			)
			.catch((error) => setSize({ kind: "unavailable", reason: `Could not measure it: ${String(error)}` }))
	}

	const item =
		"flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-sm hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent"

	return (
		<Popover onOpenChange={(open) => !open && onClose()} open={at !== undefined}>
			<PopoverPrimitive.Anchor asChild>
				<span aria-hidden className="pointer-events-none absolute size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
			</PopoverPrimitive.Anchor>
			<PopoverContent
				align="start"
				className="w-64 p-1"
				onClick={(e) => e.stopPropagation()}
				onContextMenu={(e) => e.preventDefault()}
				side="bottom"
				sideOffset={2}>
				<div aria-label="Conversation actions" className="flex flex-col" role="menu">
					<button
						className={item}
						onClick={() => {
							void writeToClipboard(firstPrompt)
							onClose()
						}}
						role="menuitem"
						type="button">
						<CopyIcon className="size-3.5 stroke-1" />
						Copy first prompt
					</button>
					<button className={item} disabled={size.kind === "measuring"} onClick={measure} role="menuitem" type="button">
						<HardDriveIcon className="size-3.5 stroke-1" />
						{size.kind === "measuring" ? "Measuring…" : "Size on disk"}
					</button>
					{size.kind === "measured" && <SizeBreakdown size={size.size} />}
					{size.kind === "unavailable" && <p className="px-2 py-1 text-xs text-description">{size.reason}</p>}
					<div className="my-1 h-px bg-menu-foreground/10" role="separator" />
					<button
						className={cn(item, "text-error")}
						disabled={!canDelete}
						onClick={() => {
							onClose()
							onDelete()
						}}
						role="menuitem"
						title={canDelete ? undefined : "Remove it from favorites to delete it"}
						type="button">
						<TrashIcon className="size-3.5 stroke-1" />
						Delete
					</button>
				</div>
			</PopoverContent>
		</Popover>
	)
}

const SizeBreakdown = ({ size }: { size: TaskSizeOnDisk }) => {
	const rows: Array<[string, string]> = [["Conversation", formatSize(size.sessionBytes)]]
	if (size.agentTranscriptBytes > 0) {
		rows.push(["Agent transcripts", formatSize(size.agentTranscriptBytes)])
	}
	if (size.overlayBytes > 0) {
		rows.push(["Agent overlays", formatSize(size.overlayBytes)])
	}
	if (size.checkpointCount > 0) {
		rows.push(["Checkpoints", `${size.checkpointCount} (in the workspace's git)`])
	}
	return (
		<div className="mx-2 mb-1 rounded-xs bg-accent/10 px-2 py-1.5 text-xs" role="status">
			<div className="mb-1 flex justify-between font-medium">
				<span>Total</span>
				<span className="tabular-nums">{formatSize(size.totalBytes)}</span>
			</div>
			{rows.map(([label, value]) => (
				<div className="flex justify-between text-description" key={label}>
					<span>{label}</span>
					<span className="tabular-nums">{value}</span>
				</div>
			))}
		</div>
	)
}
