import { StringRequest } from "@shared/proto/cline/common"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { FileServiceClient } from "@/services/grpc-client"

interface BrowserScreenshotRowProps {
	/** Data URLs of the screenshots this browser call returned. */
	images: string[]
	/** Console output and page state the tool reported alongside the shot. */
	text?: string
	/** Attach a screenshot to the message being composed. Absent = no menu entry. */
	onReference?: (image: string) => void
}

/**
 * The screenshots a `browser` call returned, under the tool row that produced them.
 *
 * The model sees these images; before this row the user did not, which is backwards
 * for the one kind of check where a person notices things the model cannot — a
 * missing menu, a layout that is off-centre, a colour that is wrong. So the picture
 * is shown small (a transcript is read by scrolling, and a full-size screenshot per
 * browser call makes that impossible), with two ways out of the thumbnail:
 *
 * - **click** opens it full size in an editor tab, which is where you actually look
 *   at a screenshot — zoomable, pannable, and it stays open while you type.
 * - **right-click → Reference in message** attaches it to the composer, so "the game
 *   should be centre aligned" arrives with the frame it is talking about instead of
 *   leaving the model to guess which screenshot is meant.
 */
const BrowserScreenshotRow = ({ images, text, onReference }: BrowserScreenshotRowProps) => {
	const [menu, setMenu] = useState<{ image: string; x: number; y: number } | undefined>(undefined)
	const menuRef = useRef<HTMLDivElement>(null)

	// A context menu that survives the next click is a stuck context menu.
	useEffect(() => {
		if (!menu) {
			return
		}
		const dismiss = (event: MouseEvent) => {
			if (menuRef.current?.contains(event.target as Node)) {
				return
			}
			setMenu(undefined)
		}
		const dismissOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMenu(undefined)
			}
		}
		window.addEventListener("mousedown", dismiss)
		window.addEventListener("keydown", dismissOnEscape)
		return () => {
			window.removeEventListener("mousedown", dismiss)
			window.removeEventListener("keydown", dismissOnEscape)
		}
	}, [menu])

	const openFullSize = useCallback((image: string) => {
		FileServiceClient.openImage(StringRequest.create({ value: image })).catch((error) =>
			console.error("Failed to open screenshot:", error),
		)
	}, [])

	if (images.length === 0) {
		return null
	}

	return (
		<div className="w-full flex flex-col gap-1.5">
			<div className="flex flex-wrap gap-1.5">
				{images.map((image, index) => (
					<img
						alt={`Browser screenshot ${index + 1}`}
						className="h-[72px] w-auto max-w-full cursor-pointer rounded border border-[var(--vscode-panel-border)] object-cover object-top"
						key={image.slice(0, 64) + index}
						onClick={() => openFullSize(image)}
						onContextMenu={(event) => {
							if (!onReference) {
								return
							}
							// Without this VS Code's own webview menu opens over ours.
							event.preventDefault()
							setMenu({ image, x: event.clientX, y: event.clientY })
						}}
						src={image}
						title="Click to open full size — right-click to reference in your message"
					/>
				))}
			</div>
			{text ? (
				<div className="text-[var(--vscode-descriptionForeground)] text-[11px] whitespace-pre-wrap break-words">
					{text}
				</div>
			) : null}
			{menu && onReference ? (
				<div
					className="fixed z-50 rounded border border-[var(--vscode-menu-border)] bg-[var(--vscode-menu-background)] py-1 shadow-lg"
					ref={menuRef}
					style={{ left: menu.x, top: menu.y }}>
					<button
						className="w-full cursor-pointer border-none bg-transparent px-3 py-1 text-left text-[13px] text-[var(--vscode-menu-foreground)] hover:bg-[var(--vscode-menu-selectionBackground)] hover:text-[var(--vscode-menu-selectionForeground)]"
						onClick={() => {
							onReference(menu.image)
							setMenu(undefined)
						}}
						type="button">
						Reference in message
					</button>
				</div>
			) : null}
		</div>
	)
}

export default memo(BrowserScreenshotRow)
