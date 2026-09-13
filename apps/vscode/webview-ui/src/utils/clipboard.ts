/**
 * Putting text on the clipboard from inside a webview, with somewhere to fall
 * back to.
 *
 * `navigator.clipboard.writeText` is not reliably available here. The webview
 * is an iframe, and writing needs both a secure context and a document that
 * the browser considers focused; a click on a button inside a panel that does
 * not have focus rejects, and so does a host that has not granted
 * `clipboard-write` to the frame. Every copy button in this UI called it and
 * handled the rejection by logging to a console nobody has open, so the button
 * still flashed "Copied" -- reported as "it comes back empty", which is
 * exactly what a paste does after a write that never happened.
 *
 * The extension host has no such restriction: `vscode.env.clipboard` always
 * works, and `FileServiceClient.copyToClipboard` has been there the whole
 * time, called from nowhere. So this tries the fast path and falls back to the
 * host, and tells the caller which of the two happened -- because a button
 * that says "Copied" when nothing was copied is worse than one that says
 * nothing at all.
 */

import { StringRequest } from "@shared/proto/cline/common"
import { FileServiceClient } from "@/services/grpc-client"

/**
 * Write `text`, returning whether it landed.
 *
 * An empty or whitespace-only string is refused rather than written. The one
 * failure this file exists to fix looks identical to a successful copy of
 * nothing, and overwriting a clipboard the user was relying on with an empty
 * string is a worse outcome than not copying.
 */
export async function writeToClipboard(text: string | undefined | null): Promise<boolean> {
	if (!text?.trim()) {
		return false
	}
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		// Expected often enough not to be worth a log line of its own: an
		// unfocused panel rejects here on every platform.
	}
	try {
		await FileServiceClient.copyToClipboard(StringRequest.create({ value: text }))
		return true
	} catch (error) {
		console.error("Copy failed in both the webview and the host", error)
		return false
	}
}
