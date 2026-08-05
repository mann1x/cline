/**
 * Run a template file through the generator's audit, without a model.
 *
 * The repair loop only ever sees what a model produced. A template written or
 * edited by hand gets no such check, and the failures the audit catches — a
 * dropped placeholder, a duplicated heading, an example call whose shape the
 * schema rejects, an `Output:` followed by nothing — are exactly the ones that
 * are invisible in a diff and expensive in a session.
 *
 *   bun scripts/audit-prompt-template.mts prompt-reviews/claude.md
 */
import { readFileSync } from "node:fs";
import { DEFAULT_PROMPT_TEMPLATE_NAME } from "@cline/shared";
import { getBuiltinPromptTemplates } from "../src/extensions/config/builtin-templates";
import {
	auditPromptTemplateProposal,
	DEFAULT_REQUIRED_REWRITES,
} from "../src/extensions/config/prompt-template-review";
import { getShippedToolCallSignatures } from "../src/extensions/config/shipped-tool-signatures";

const path = process.argv[2];
if (!path) {
	throw new Error("usage: audit-prompt-template.mts <file.md> [expectedName]");
}
const expectedName = process.argv[3];

const templates = getBuiltinPromptTemplates();
const base = templates.find(
	(template) => template.name.toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME,
);
const knownToolNames = Object.keys(base?.tools ?? {});

const audit = auditPromptTemplateProposal({
	raw: readFileSync(path, "utf8"),
	fileName: path.split("/").pop() ?? path,
	providerId: "anthropic",
	modelId: "claude-opus-5",
	family: undefined,
	knownToolNames,
	expectedName,
	requiredSections: knownToolNames,
	requiredRewrites: DEFAULT_REQUIRED_REWRITES,
	toolSignatures: getShippedToolCallSignatures(),
});

const sections = Object.keys(audit.template?.tools ?? {});
console.log(
	`${path}: system=${audit.template?.system ? "yes" : "no"} sections=${sections.length}/${knownToolNames.length}`,
);
for (const problem of audit.problems) {
	console.error(`  ${problem}`);
}
process.exit(audit.problems.length === 0 ? 0 : 1);
