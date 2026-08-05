import type { PromptTemplate } from "./template-types";
import { PROMPT_TEMPLATE_DEFAULT_MARKER } from "./template-types";

/**
 * Sanity checks for a hand-edited prompt template.
 *
 * Every mistake this catches is currently silent. A template is markdown with
 * `{{PLACEHOLDER}}` tokens in it, and nothing downstream distinguishes a token
 * it knows from one it does not: `{{CWD}}` is substituted, `{{cwd}}` is sent to
 * the model verbatim, and the only symptom is a model that does not know where
 * it is. Worse, dropping `{{CLINE_RULES}}` removes the plan-mode contract, so
 * the model stops being told it is in plan mode and starts editing files.
 *
 * These are warnings rather than errors on purpose. A template with an odd
 * placeholder is still a usable template, and refusing to load it would be a
 * worse outcome than using it and saying so. The one genuinely dangerous case
 * — a missing rules slot — is repaired in `buildClineSystemPrompt` as well as
 * reported here.
 */

/** Tokens `buildClineSystemPrompt` substitutes in a system prompt. */
export const PROMPT_TEMPLATE_SYSTEM_PLACEHOLDERS = [
	"{{PLATFORM_NAME}}",
	"{{CWD}}",
	"{{CURRENT_DATE}}",
	"{{IDE_NAME}}",
	"{{CLINE_METADATA}}",
	"{{CLINE_RULES}}",
] as const;

/**
 * Placeholders whose absence changes behaviour rather than wording.
 *
 * `{{CLINE_RULES}}` carries the mode-tag explanation and the plan-mode
 * contract. `{{CWD}}` is how the model learns which directory it is working
 * in; without it, relative paths become guesswork.
 */
export const PROMPT_TEMPLATE_REQUIRED_PLACEHOLDERS = [
	"{{CLINE_RULES}}",
	"{{CWD}}",
] as const;

export type PromptTemplateWarningCode =
	| "missing-required-placeholder"
	| "missing-optional-placeholder"
	| "unknown-placeholder"
	| "default-marker-in-system"
	| "unknown-tool"
	| "duplicate-section"
	| "empty-section";

export interface PromptTemplateWarning {
	code: PromptTemplateWarningCode;
	/** `system`, or `tool: <name>`. */
	section: string;
	message: string;
}

const PLACEHOLDER_PATTERN = /\{\{[^{}]*\}\}/g;

function collectPlaceholders(text: string): string[] {
	return text.match(PLACEHOLDER_PATTERN) ?? [];
}

/**
 * Suggest the placeholder someone meant.
 *
 * Only case and surrounding space are considered, because those are the
 * mistakes that actually happen — `{{cwd}}`, `{{ CWD }}`, `{{Cline_Rules}}`.
 * Guessing at spelling would produce confident nonsense for a token that was
 * never a placeholder at all.
 */
function suggestPlaceholder(
	token: string,
	known: readonly string[],
): string | undefined {
	const normalized = token.replace(/[{}\s_]/g, "").toLowerCase();
	return known.find(
		(candidate) =>
			candidate.replace(/[{}\s_]/g, "").toLowerCase() === normalized,
	);
}

export interface ValidatePromptTemplateOptions {
	/**
	 * Tool names this session actually has. A section naming something else is
	 * dead text — usually a rename, sometimes a tool that is simply disabled —
	 * so it is only reported when the caller can say what exists.
	 */
	knownToolNames?: readonly string[];
}

export function validatePromptTemplate(
	template: PromptTemplate,
	options: ValidatePromptTemplateOptions = {},
): PromptTemplateWarning[] {
	const warnings: PromptTemplateWarning[] = [];
	const known = PROMPT_TEMPLATE_SYSTEM_PLACEHOLDERS;

	if (template.system !== undefined) {
		const system = template.system;

		for (const placeholder of known) {
			if (system.includes(placeholder)) {
				continue;
			}
			const required = (
				PROMPT_TEMPLATE_REQUIRED_PLACEHOLDERS as readonly string[]
			).includes(placeholder);
			warnings.push({
				code: required
					? "missing-required-placeholder"
					: "missing-optional-placeholder",
				section: "system",
				message: required
					? placeholder === "{{CLINE_RULES}}"
						? `${placeholder} is missing — the plan-mode contract and mode-tag explanation are inserted there. It will be appended for you, but add it where you want it.`
						: `${placeholder} is missing — the model will not be told its working directory.`
					: `${placeholder} is missing — the model will not be told this part of its environment.`,
			});
		}

		for (const token of collectPlaceholders(system)) {
			if ((known as readonly string[]).includes(token)) {
				continue;
			}
			if (token === PROMPT_TEMPLATE_DEFAULT_MARKER) {
				warnings.push({
					code: "default-marker-in-system",
					section: "system",
					message: `${PROMPT_TEMPLATE_DEFAULT_MARKER} only means something in a '# tool:' section; here it is sent to the model as written.`,
				});
				continue;
			}
			const suggestion = suggestPlaceholder(token, known);
			warnings.push({
				code: "unknown-placeholder",
				section: "system",
				message: suggestion
					? `${token} is not a placeholder — did you mean ${suggestion}? As written it is sent to the model literally.`
					: `${token} is not a placeholder and is sent to the model literally.`,
			});
		}
	}

	for (const [toolName, description] of Object.entries(template.tools)) {
		const section = `tool: ${toolName}`;
		if (description.trim() === "") {
			warnings.push({
				code: "empty-section",
				section,
				message:
					"This section is empty, so the tool is left with no description.",
			});
		}
		for (const token of collectPlaceholders(description)) {
			if (token === PROMPT_TEMPLATE_DEFAULT_MARKER) {
				continue;
			}
			const suggestion = suggestPlaceholder(token, [
				PROMPT_TEMPLATE_DEFAULT_MARKER,
			]);
			warnings.push({
				code: "unknown-placeholder",
				section,
				message: suggestion
					? `${token} is not a placeholder — did you mean ${suggestion}? As written it is sent to the model literally.`
					: `${token} is not substituted in a tool description and is sent to the model literally.`,
			});
		}
		if (options.knownToolNames && !options.knownToolNames.includes(toolName)) {
			warnings.push({
				code: "unknown-tool",
				section,
				message: `There is no tool called '${toolName}', so this section has no effect.`,
			});
		}
	}

	return warnings;
}
