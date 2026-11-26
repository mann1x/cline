import type { ViewerFocus } from "@/shared/board-viewer"

/**
 * The board viewer is an editor panel the VS Code host owns; the controller
 * is host-neutral. These two hooks connect them without the controller
 * importing `vscode`: the host registers how to open the panel (the task
 * panel's "Open board" asks for it through the board RPC), and the
 * controller says when the conversation's board changed.
 */

let opener: ((focus?: ViewerFocus) => void) | undefined
const listeners = new Set<() => void>()

export function setBoardViewerOpener(open: ((focus?: ViewerFocus) => void) | undefined): void {
	opener = open
}

/** Opens the viewer; false when this host has none. */
export function openBoardViewer(focus?: ViewerFocus): boolean {
	if (!opener) return false
	opener(focus)
	return true
}

export function onBoardChanged(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function boardChanged(): void {
	for (const listener of listeners) {
		try {
			listener()
		} catch {
			// A viewer that failed to refresh must not break the session's board.
		}
	}
}
