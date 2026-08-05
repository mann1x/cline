/**
 * Split a leading `---` YAML block off a markdown document.
 *
 * Pure string work with no YAML dependency, so it lives here rather than
 * beside any one of the formats that use it — cron specs, prompt templates and
 * configured agents all open the same way, and each having its own copy is how
 * they end up disagreeing about what counts as a frontmatter block.
 *
 * A document with no opening `---` or no closing one is returned whole as the
 * body: a half-written header is text, not an error, and the caller's own
 * validation is a better place to say so.
 */
export function splitFrontmatter(raw: string): {
	frontmatter: string | undefined;
	body: string;
} {
	const text = raw.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) {
		return { frontmatter: undefined, body: raw };
	}
	const afterOpen = text.slice(4);
	const closeIdx = afterOpen.indexOf("\n---");
	if (closeIdx === -1) {
		return { frontmatter: undefined, body: raw };
	}
	const frontmatter = afterOpen.slice(0, closeIdx);
	let rest = afterOpen.slice(closeIdx + 4);
	if (rest.startsWith("\n")) rest = rest.slice(1);
	return { frontmatter, body: rest };
}
