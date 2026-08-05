import type { PromptTemplate } from "@cline/shared";
import { BUILTIN_PROMPT_TEMPLATE_FILES } from "./builtin-templates.generated";
import { parsePromptTemplate } from "./prompt-template-parser";

/**
 * The templates Cline ships with, parsed.
 *
 * These are the base layer: `default.md` supplies a system prompt and a
 * description for every tool, and the family templates layer over it. They are
 * inlined rather than read from disk so that a bundled extension, a bundled
 * CLI and a test all get the same answer without any of them having to guess
 * where the package's assets ended up.
 *
 * A builtin that fails to parse is a build error rather than a user problem,
 * so it is dropped silently here and caught by the test that parses all of
 * them.
 */
let cached: PromptTemplate[] | undefined;

export function getBuiltinPromptTemplates(): PromptTemplate[] {
	if (cached) {
		return cached;
	}
	const templates: PromptTemplate[] = [];
	for (const file of BUILTIN_PROMPT_TEMPLATE_FILES) {
		const result = parsePromptTemplate({
			raw: file.raw,
			source: "builtin",
			fileName: file.fileName,
		});
		if (result.template) {
			templates.push(result.template);
		}
	}
	cached = templates;
	return templates;
}

/**
 * The markdown behind a builtin, by file name.
 *
 * A builtin has no path on disk, so "edit this template" has to write a copy
 * somewhere first. This is what gets copied — the file verbatim, comments and
 * all, so the copy reads like the original and diffs against it cleanly.
 */
export function getBuiltinPromptTemplateSource(
	fileName: string,
): string | undefined {
	return BUILTIN_PROMPT_TEMPLATE_FILES.find(
		(file) => file.fileName === fileName,
	)?.raw;
}
