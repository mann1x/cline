import { describe, expect, it } from "vitest"
import { copyTextForSelection, prefersPlainText } from "./copySelection"

/** A selection over the whole of `html`, as the browser would hand it over. */
function selectionOver(html: string): { selection: Selection; getComputedStyle: (el: Element) => CSSStyleDeclaration } {
	const host = document.createElement("div")
	host.innerHTML = html
	document.body.appendChild(host)
	const range = document.createRange()
	range.selectNodeContents(host)
	const selection = {
		rangeCount: 1,
		getRangeAt: () => range,
		toString: () => host.textContent ?? "",
	} as unknown as Selection
	return { selection, getComputedStyle: (el: Element) => window.getComputedStyle(el) }
}

describe("copyTextForSelection", () => {
	// The whole point of the rewrite: this has to produce the text inside the
	// listener, with no await anywhere, or `clipboardData` cannot be written.
	it("returns markdown synchronously", () => {
		const { selection, getComputedStyle } = selectionOver("<p>Hello <strong>world</strong></p>")

		const text = copyTextForSelection(selection, getComputedStyle)

		expect(text).toContain("Hello")
		expect(text).toContain("world")
		expect(text).not.toBeInstanceOf(Promise)
	})

	// Selecting *inside* a code block takes the verbatim path, indentation and
	// all: running it through Markdown would reflow it.
	it("keeps a selection inside a code block verbatim", () => {
		const host = document.createElement("div")
		host.innerHTML = "<pre><code>const a = 1;\n  indented\n</code></pre>"
		document.body.appendChild(host)
		const code = host.querySelector("code") as HTMLElement
		const range = document.createRange()
		range.selectNodeContents(code)
		const selection = {
			rangeCount: 1,
			getRangeAt: () => range,
			toString: () => code.textContent ?? "",
		} as unknown as Selection

		expect(copyTextForSelection(selection, (el) => window.getComputedStyle(el))).toBe("const a = 1;\n  indented\n")
	})

	// Selecting a whole message that *contains* a code block is the other path,
	// and it must keep the code as code rather than flattening it into prose.
	it("fences a code block that a wider selection swept up", () => {
		const { selection, getComputedStyle } = selectionOver("<p>look:</p><pre><code>const a = 1;\n</code></pre>")

		const text = copyTextForSelection(selection, getComputedStyle) ?? ""

		expect(text).toContain("look:")
		expect(text).toContain("```")
		expect(text).toContain("const a = 1;")
	})

	// `null` and not `""`: an empty string is a value the caller would happily
	// put on the clipboard, which is how a copy comes back empty.
	it("says nothing rather than nothing-as-a-string", () => {
		expect(copyTextForSelection(null, () => ({}) as CSSStyleDeclaration)).toBeNull()
		expect(copyTextForSelection({ rangeCount: 0 } as unknown as Selection, () => ({}) as CSSStyleDeclaration)).toBeNull()

		const { selection, getComputedStyle } = selectionOver("")
		expect(copyTextForSelection(selection, getComputedStyle)).toBeNull()
	})
})

describe("prefersPlainText", () => {
	const styleOf =
		(whiteSpace: string) =>
		(_el: Element): CSSStyleDeclaration =>
			({ whiteSpace }) as CSSStyleDeclaration

	function rangeOver(html: string): Range {
		const host = document.createElement("div")
		host.innerHTML = html
		document.body.appendChild(host)
		const range = document.createRange()
		range.selectNodeContents(host.firstElementChild ?? host)
		return range
	}

	it("is true inside a code block", () => {
		expect(prefersPlainText(rangeOver("<pre><code>x</code></pre>"), styleOf("normal"))).toBe(true)
	})

	it("is true for pre-like white-space", () => {
		for (const whiteSpace of ["pre", "pre-wrap", "pre-line"]) {
			expect(prefersPlainText(rangeOver("<div>x</div>"), styleOf(whiteSpace))).toBe(true)
		}
	})

	it("is false for ordinary prose", () => {
		expect(prefersPlainText(rangeOver("<div>x</div>"), styleOf("normal"))).toBe(false)
	})
})
