/**
 * Utility functions for handling markdown conversions and cleanup
 */

import rehypeParse from "rehype-parse"
import rehypeRemark from "rehype-remark"
import remarkStringify from "remark-stringify"
import { unified } from "unified"

/**
 * Clean up markdown escape characters
 */
function cleanupMarkdownEscapes(markdown: string): string {
	return (
		markdown
			// Handle underscores and asterisks (single or multiple)
			.replace(/\\([_*]+)/g, "$1")

			// Handle angle brackets (for generics and XML)
			.replace(/\\([<>])/g, "$1")

			// Handle backticks (for code)
			.replace(/\\(`)/g, "$1")

			// Handle other common markdown special characters
			.replace(/\\([[\]()#.!])/g, "$1")

			// Fix multiple consecutive backslashes
			.replace(/\\{2,}([_*`<>[\]()#.!])/g, "$1")
	)
}

/**
 * The pipeline, built once per call because `unified()` processors are not
 * reusable across concurrent processing.
 */
function markdownProcessor() {
	return unified()
		.use(rehypeParse as any, { fragment: true }) // Parse HTML fragments
		.use(rehypeRemark as any) // Convert HTML to Markdown AST
		.use(remarkStringify as any, {
			// Convert Markdown AST to text
			bullet: "-", // Use - for unordered lists
			emphasis: "*", // Use * for emphasis
			strong: "_", // Use _ for strong
			listItemIndent: "one", // Use one space for list indentation
			rule: "-", // Use - for horizontal rules
			ruleSpaces: false, // No spaces in horizontal rules
			fences: true,
			escape: false,
			entities: false,
		})
}

/**
 * Convert HTML to Markdown, synchronously.
 *
 * Synchronous because the one caller is a `copy` event listener, and a listener
 * that awaits has already let the event finish dispatching: `preventDefault()`
 * after that point is a no-op, and the text has to reach `clipboardData` while
 * the event is still live. Every plugin in the pipeline is synchronous, so
 * `processSync` is available; it throws if that ever stops being true, which is
 * the right way to find out.
 */
export function convertHtmlToMarkdownSync(html: string): string {
	return cleanupMarkdownEscapes(String(markdownProcessor().processSync(html)))
}

/** The same conversion, for callers that are not on an event's clock. */
export async function convertHtmlToMarkdown(html: string): Promise<string> {
	return cleanupMarkdownEscapes(String(await markdownProcessor().process(html)))
}
