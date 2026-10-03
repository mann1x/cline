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

/** Marks a container whose copies are built row by row; see {@link compactCopyText}. */
export const COPY_COMPACT_ATTR = "data-copy-compact"
/** Marks an element that is one line of text however it is laid out. */
export const COPY_ROW_ATTR = "data-copy-row"
/** Marks a control whose label is not part of what the panel says. */
export const COPY_SKIP_ATTR = "data-copy-skip"

const BLOCK_TAGS = new Set(["DIV", "OL", "UL", "LI", "P", "PRE", "SECTION", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TR"])

function elementOf(node: Node): Element | null {
	return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

/** Whether the selection lies in a container that asked for row-by-row copies. */
export function inCompactCopyArea(range: Range): boolean {
	return !!elementOf(range.commonAncestorContainer)?.closest(`[${COPY_COMPACT_ATTR}]`)
}

/** Whitespace is the text's own in a `pre` and in anything styled like one. */
function isVerbatim(element: Element): boolean {
	return element.tagName === "PRE" || /(^|\s)whitespace-pre/.test(element.getAttribute("class") ?? "")
}

/** A row's text: its pieces on one line, a space between them. */
function rowText(node: Node): string {
	const pieces: string[] = []
	const visit = (current: Node) => {
		if (current.nodeType === Node.TEXT_NODE) {
			const text = current.textContent ?? ""
			if (text.trim()) {
				pieces.push(text.trim())
			}
			return
		}
		if (current.nodeType !== Node.ELEMENT_NODE && current.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
			return
		}
		if (current.nodeType === Node.ELEMENT_NODE && (current as Element).hasAttribute(COPY_SKIP_ATTR)) {
			return
		}
		for (const child of Array.from(current.childNodes)) {
			visit(child)
		}
	}
	visit(node)
	return pieces.join(" ")
}

/**
 * The text of a selection in a panel made of rows, one line per row.
 *
 * `Selection.toString()` follows the layout: every flex item is a block, so
 * an activity entry -- its time, its warning icon, its text, three items of
 * one flex row -- came out on three lines, with blank lines between the
 * panel's sections. Pasted into a chat box, the first of those newlines sent
 * the message (pandorum, 2026-10-03, the agents panel). So here the markup
 * says what a line is: a `data-copy-row` element is one line, a block is its
 * own line, a `pre` keeps its text as written, and no blank line is added.
 */
export function compactCopyText(range: Range): string {
	const lines: string[] = []
	let inline = ""
	const flush = () => {
		if (inline.trim()) {
			lines.push(inline.trim())
		}
		inline = ""
	}
	const visit = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			inline += (node.textContent ?? "").replace(/\s+/g, " ")
			return
		}
		if (node.nodeType !== Node.ELEMENT_NODE) {
			return
		}
		const element = node as Element
		if (element.hasAttribute(COPY_SKIP_ATTR)) {
			return
		}
		if (element.hasAttribute(COPY_ROW_ATTR)) {
			flush()
			const text = rowText(element)
			if (text) {
				lines.push(text)
			}
			return
		}
		if (isVerbatim(element)) {
			flush()
			const text = (element.textContent ?? "").replace(/^\n+|\s+$/g, "")
			if (text) {
				lines.push(text)
			}
			return
		}
		const block = BLOCK_TAGS.has(element.tagName)
		if (block) {
			flush()
		}
		for (const child of Array.from(element.childNodes)) {
			visit(child)
		}
		if (block) {
			flush()
		}
	}
	// A selection inside one row has no row element in its fragment: the row
	// is an ancestor of everything selected.
	const row = elementOf(range.commonAncestorContainer)?.closest(`[${COPY_ROW_ATTR}]`)
	const fragment = range.cloneContents()
	if (row) {
		return rowText(fragment)
	}
	for (const child of Array.from(fragment.childNodes)) {
		visit(child)
	}
	flush()
	return lines.join("\n")
}

/**
 * The text for a selection, or nothing if there is no usable one.
 *
 * Plain text by default: the Markdown markers made copied thinking hard to
 * read, and were rarely wanted (reported 2026-09-26). `formatted` keeps them,
 * for "Copy Formatted" (Ctrl+Shift+C).
 *
 * Returns `null` rather than an empty string when nothing should be written:
 * an empty string is a value a caller would happily put on the clipboard,
 * which is the failure being fixed here.
 */
export function copyTextForSelection(
	selection: Selection | null,
	getComputedStyle: (element: Element) => CSSStyleDeclaration,
	formatted = false,
): string | null {
	if (!selection || selection.rangeCount === 0) {
		return null
	}
	const range = selection.getRangeAt(0)

	if (prefersPlainText(range, getComputedStyle)) {
		return selection.toString() || null
	}
	if (inCompactCopyArea(range)) {
		return compactCopyText(range) || null
	}
	if (!formatted) {
		// The tail only, for the same reason as below: a newline pasted into
		// the chat box is submit.
		return selection.toString().replace(/\n+$/, "") || null
	}

	const div = document.createElement("div")
	div.appendChild(range.cloneContents())
	try {
		// Trailing newlines are the serializer's, not the selection's:
		// remark-stringify terminates every document with one, and it went on
		// the clipboard. Pasting into the chat box then sent the message before
		// the user had finished typing, because a newline there is submit.
		// Only the tail is touched -- newlines inside the selection are the
		// text, and the verbatim path above keeps its own ending untouched
		// because whitespace is what that path exists to preserve.
		return convertHtmlToMarkdownSync(div.innerHTML).replace(/\n+$/, "") || null
	} catch {
		// A conversion that throws must not cost the user their copy: the
		// selection's own text is always available and is what the browser
		// would have written anyway.
		return selection.toString() || null
	}
}

/** Ctrl+Shift+C (Cmd+Shift+C on a Mac): copy with the Markdown kept. */
export function isCopyFormattedKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
	return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "c"
}

/**
 * Put the formatted selection where the host's "Copy Formatted" menu command
 * finds it: VS Code hands a `webview/context` command the merged
 * `data-vscode-context` of the clicked element and its ancestors. Cleared when
 * nothing is selected, so an old selection is never what gets copied.
 */
export function stampFormattedSelection(body: HTMLElement, text: string | null): void {
	let context: Record<string, unknown> = {}
	try {
		context = JSON.parse(body.dataset.vscodeContext ?? "{}") as Record<string, unknown>
	} catch {
		context = {}
	}
	if (text === null) {
		delete context.formattedSelection
	} else {
		context.formattedSelection = text
	}
	body.dataset.vscodeContext = JSON.stringify(context)
}
