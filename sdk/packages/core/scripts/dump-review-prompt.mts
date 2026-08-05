/**
 * Write out the review prompt for one target, without calling a model.
 *
 * The generator is driven by an Ollama endpoint, which is the right harness for
 * the local families and no harness at all for Claude: there is no Ollama build
 * of it to ask. This dumps the prompt a Claude session would be handed so the
 * rewrite can be produced by a Claude and then fed back through the same audit
 * the generated ones go through — same input, same checks, different transport.
 *
 *   bun scripts/dump-review-prompt.mts --template claude.md --out /tmp/p.txt
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROMPT_TEMPLATE_NAME } from "@cline/shared";
import { getBuiltinPromptTemplates } from "../src/extensions/config/builtin-templates";
import { buildPromptTemplateReviewPrompt } from "../src/extensions/config/prompt-template-review";
import { getShippedToolCallSignatures } from "../src/extensions/config/shipped-tool-signatures";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, "..", "assets", "prompt-templates");

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

const fileName = flag("--template") ?? "claude.md";
const outPath =
	flag("--out") ??
	join(
		here,
		"..",
		"..",
		"..",
		"..",
		"prompt-reviews",
		`${fileName}.prompt.txt`,
	);

const templates = getBuiltinPromptTemplates();
const defaultTemplate = readFileSync(join(TEMPLATE_DIR, "default.md"), "utf8");
const familyTemplate = readFileSync(join(TEMPLATE_DIR, fileName), "utf8");
const matched = templates.find((template) => template.fileName === fileName);
if (!matched) {
	throw new Error(`No builtin template named ${fileName}`);
}

const requiredSections = Object.keys(
	templates.find(
		(template) => template.name.toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME,
	)?.tools ?? {},
);

const prompt = buildPromptTemplateReviewPrompt(
	defaultTemplate,
	familyTemplate,
	fileName,
	undefined,
	getShippedToolCallSignatures(),
	requiredSections,
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, prompt, "utf8");
console.log(
	`${outPath} (${prompt.length} chars, ${requiredSections.length} required sections)`,
);
