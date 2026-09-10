/**
 * What a copy out of the chat should put on the clipboard.
 *
 * Split out of ChatView's `copy` listener so the decision can be tested, and
 * so the listener can be synchronous. That second part is the whole point: the
 * listener used to `await` the HTML-to-Markdown conversion and then call
 * `preventDefault()`, cancelling the browser's own copy in favour of a
 * fire-and-forget round trip to the host that nothing checked the result of. A
 * host that failed to write left the clipboard holding whatever was there
 * before -- nothing, on a fresh session -- and said so only in a log the user
 * never sees.
 *
 * Everything here is synchronous, so the caller can hand the text straight to
 * `event.clipboardData`, which is the one writer that cannot fail silently:
 * it is the copy the browser was already about to perform.
 */

import { convertHtmlToMarkdownSync } from "./markdownUtils"

/**
 * Whether this selection should be copied verbatim rather than as Markdown.
 *
 * Code blocks and anything laid out with a `pre`-like `white-space` carry their
 * meaning in their whitespace, and running them through Markdown reflows them.
 */
export function prefersPlainText(range: Range, getComputedStyle: (element: Element) => CSSStyleDeclaration): boolean {
	const commonAncestor = range.commonAncestorContainer
	let currentElement =
		commonAncestor.nodeType === Node.ELEMENT_NODE
			? (commonAncestor as HTMLElement)
			: (commonAncestor.parentElement as HTMLElement | null)

	while (currentElement) {
		if (currentElement.tagName === "PRE" && currentElement.querySelector("code")) {
			return true
		}
		const whiteSpace = getComputedStyle(currentElement).whiteSpace
		if (whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "pre-line") {
			return true
		}
		// Stop at a message boundary: past it the styles belong to the panel,
		// not to what was selected.
		if (
			currentElement.classList.contains("chat-row-assistant-message-container") ||
			currentElement.classList.contains("chat-row-user-message-container") ||
			currentElement.tagName === "BODY"
		) {
			return false
		}
		currentElement = currentElement.parentElement
	}
	return false
}

/**
 * The text for a selection, or nothing if there is no usable one.
 *
 * Returns `null` rather than an empty string when nothing should be written:
 * an empty string is a value a caller would happily put on the clipboard,
 * which is the failure being fixed here.
 */
export function copyTextForSelection(
	selection: Selection | null,
	getComputedStyle: (element: Element) => CSSStyleDeclaration,
): string | null {
	if (!selection || selection.rangeCount === 0) {
		return null
	}
	const range = selection.getRangeAt(0)

	if (prefersPlainText(range, getComputedStyle)) {
		return selection.toString() || null
	}

	const div = document.createElement("div")
	div.appendChild(range.cloneContents())
	try {
		return convertHtmlToMarkdownSync(div.innerHTML) || null
	} catch {
		// A conversion that throws must not cost the user their copy: the
		// selection's own text is always available and is what the browser
		// would have written anyway.
		return selection.toString() || null
	}
}
