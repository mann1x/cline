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

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

const path = argv.find((arg) => arg.endsWith(".md"));
if (!path) {
	throw new Error(
		"usage: audit-prompt-template.mts <file.md> [--provider id] [--model id] [--family name]",
	);
}

/**
 * One of the audit's checks is that the template still claims the session it
 * was written for, so it needs a session to check against. Without one the
 * check fires on every file that is not for the default target, which reads as
 * a defect in the template rather than a missing argument.
 */
const providerId = flag("--provider") ?? "ollama";
const modelId = flag("--model") ?? "unknown";
const family = flag("--family");

const templates = getBuiltinPromptTemplates();
const base = templates.find(
	(template) => template.name.toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME,
);
const knownToolNames = Object.keys(base?.tools ?? {});

const audit = auditPromptTemplateProposal({
	raw: readFileSync(path, "utf8"),
	fileName: path.split("/").pop() ?? path,
	providerId,
	modelId,
	family,
	knownToolNames,
	expectedName: flag("--name"),
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
