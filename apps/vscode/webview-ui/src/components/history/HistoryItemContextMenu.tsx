import * as PopoverPrimitive from "@radix-ui/react-popover"
import { MAX_TAG_LENGTH, MAX_TAGS_PER_CONVERSATION, normalizeTag } from "@shared/conversation-tags"
import { StringRequest } from "@shared/proto/cline/common"
import type { TaskSizeOnDisk } from "@shared/proto/cline/task"
import { CopyIcon, HardDriveIcon, TagIcon, TrashIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { writeToClipboard } from "@/utils/clipboard"
import { formatSize } from "@/utils/format"
import { TagChip } from "./TagChip"

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
	/** The conversation's tags now. */
	tags: readonly string[]
	/** Tags used lately, offered as one-click choices. */
	recentTags: readonly string[]
	onAddTag: (tag: string) => void
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
	tags,
	recentTags,
	onAddTag,
}: HistoryItemContextMenuProps) => {
	const [size, setSize] = useState<SizeState>({ kind: "idle" })
	const [addingTag, setAddingTag] = useState(false)
	const [draftTag, setDraftTag] = useState("")

	// A fresh menu measures afresh (the last answer may be minutes old) and
	// starts with the tag field closed.
	useEffect(() => {
		if (at) {
			setSize({ kind: "idle" })
			setAddingTag(false)
			setDraftTag("")
		}
	}, [at])

	const has = new Set(tags.map((tag) => tag.toLowerCase()))
	const suggestions = recentTags.filter((tag) => !has.has(tag.toLowerCase())).slice(0, 8)
	const full = tags.length >= MAX_TAGS_PER_CONVERSATION

	const addTag = (raw: string) => {
		const tag = normalizeTag(raw)
		if (tag && !has.has(tag.toLowerCase()) && !full) {
			onAddTag(tag)
		}
		setDraftTag("")
	}

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
					<button
						className={item}
						disabled={full}
						onClick={() => setAddingTag(true)}
						role="menuitem"
						title={full ? `A conversation holds at most ${MAX_TAGS_PER_CONVERSATION} tags` : undefined}
						type="button">
						<TagIcon className="size-3.5 stroke-1" />
						Add tag
					</button>
					{addingTag && !full && (
						<div className="mx-2 mb-1 flex flex-col gap-1.5">
							<Input
								aria-label="New tag"
								autoFocus
								className="px-1.5 py-0.5"
								maxLength={MAX_TAG_LENGTH}
								onChange={(e) => setDraftTag(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault()
										addTag(draftTag)
									}
								}}
								placeholder="Tag name, then Enter"
								value={draftTag}
							/>
							{suggestions.length > 0 && (
								<div aria-label="Recent tags" className="flex flex-wrap gap-1">
									{suggestions.map((tag) => (
										<TagChip key={tag} onSelect={() => addTag(tag)} tag={tag} />
									))}
								</div>
							)}
						</div>
					)}
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
