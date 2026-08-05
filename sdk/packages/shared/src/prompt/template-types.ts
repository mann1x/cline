/**
 * Per-model prompt templates.
 *
 * The system prompt and every tool description used to be one text for every
 * model Cline can talk to. That text was written against frontier models, and
 * it shows: local models in the Qwen and Gemma families routinely ignore the
 * tools it describes and shell out instead, because the descriptions assume a
 * reader that infers more than they do. There is no way to say "phrase this
 * differently for Gemma" without saying it for Claude too.
 *
 * A template is a markdown file that supplies a system prompt, tool
 * descriptions, or both, plus the rule for when it applies. Input schemas are
 * deliberately NOT templatable: a description that reads badly wastes a turn,
 * but a schema that does not match the executor makes a tool uncallable, and
 * that failure would land on whoever edited the file rather than on us.
 */

/** Which sessions a template claims. Every field present must match. */
export interface PromptTemplateMatch {
	/** Provider IDs, e.g. `ollama`, `anthropic`. Wildcards allowed. */
	provider?: string[];
	/**
	 * Model families. For Ollama these are the GGUF architecture strings
	 * reported by `/api/tags` (`gemma4`, `qwen35moe`, `glm4moelite`), which is
	 * why matching is pattern-based: "Qwen" is `qwen*`, not one literal.
	 */
	family?: string[];
	/** Model IDs. Wildcards allowed, e.g. `*v7-coder*`. */
	model?: string[];
}

/** Where a template was loaded from. Later entries win ties. */
export type PromptTemplateSource = "builtin" | "global" | "workspace";

export interface PromptTemplate {
	/**
	 * Identity, and the shadowing key: a workspace template named `gemma`
	 * replaces the global one outright rather than merging with it, so a
	 * project can restate a template without inheriting half of another.
	 */
	name: string;
	source: PromptTemplateSource;
	/**
	 * The file it was read from, e.g. `gemma.md`. Kept alongside `name` because
	 * the two can differ — frontmatter `name:` wins — and the settings UI needs
	 * the file to open it, or to copy a builtin out of the bundle.
	 */
	fileName: string;
	/** Absolute path, for the settings UI to open. Absent for builtins. */
	filePath?: string;
	/** Absent means "applies to everything", i.e. the default template. */
	match?: PromptTemplateMatch;
	/** Replaces the system prompt when present. */
	system?: string;
	/** Tool name to replacement description. Tools absent here keep theirs. */
	tools: Record<string, string>;
}

/** The session a template is being resolved for. */
export interface PromptTemplateTarget {
	providerId: string;
	modelId: string;
	/** Undefined when the provider cannot report one. */
	family?: string;
}

/**
 * How specific a match is. A template that names the model beats one that
 * names the family, which beats one that names the provider, which beats the
 * default. This is the whole precedence rule.
 */
export const PROMPT_TEMPLATE_SPECIFICITY = {
	default: 0,
	provider: 1,
	family: 2,
	model: 3,
} as const;

const SOURCE_RANK: Record<PromptTemplateSource, number> = {
	builtin: 0,
	global: 1,
	workspace: 2,
};

/**
 * Case-insensitive glob with `*` as the only metacharacter.
 *
 * Deliberately not a regex: these patterns are written in a settings file by
 * hand, and `qwen*` is something you can get right on the first try in a way
 * that `^qwen.*$` is not.
 */
export function matchesPromptPattern(value: string, pattern: string): boolean {
	const normalizedValue = value.trim().toLowerCase();
	const normalizedPattern = pattern.trim().toLowerCase();
	if (normalizedPattern === "") {
		return false;
	}
	if (!normalizedPattern.includes("*")) {
		return normalizedValue === normalizedPattern;
	}
	const escaped = normalizedPattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`).test(normalizedValue);
}

function matchesAny(
	value: string | undefined,
	patterns: string[] | undefined,
): boolean | undefined {
	if (!patterns || patterns.length === 0) {
		return undefined; // dimension not constrained
	}
	if (value === undefined || value === "") {
		return false; // constrained, but we have nothing to test
	}
	return patterns.some((pattern) => matchesPromptPattern(value, pattern));
}

/**
 * Score a template against a session, or `undefined` when it does not apply.
 *
 * Every dimension the template names must match — a template that asks for
 * provider `ollama` AND family `gemma4` does not apply to Gemma on another
 * provider. The score is the most specific dimension it named.
 */
export function scorePromptTemplate(
	template: PromptTemplate,
	target: PromptTemplateTarget,
): number | undefined {
	const match = template.match;
	if (!match) {
		return PROMPT_TEMPLATE_SPECIFICITY.default;
	}
	const checks: Array<[boolean | undefined, number]> = [
		[
			matchesAny(target.providerId, match.provider),
			PROMPT_TEMPLATE_SPECIFICITY.provider,
		],
		[
			matchesAny(target.family, match.family),
			PROMPT_TEMPLATE_SPECIFICITY.family,
		],
		[
			matchesAny(target.modelId, match.model),
			PROMPT_TEMPLATE_SPECIFICITY.model,
		],
	];

	let score: number = PROMPT_TEMPLATE_SPECIFICITY.default;
	let constrained = false;
	for (const [result, weight] of checks) {
		if (result === undefined) {
			continue;
		}
		if (result === false) {
			return undefined;
		}
		constrained = true;
		score = Math.max(score, weight);
	}
	// `match: {}` names nothing, so it is the default rather than a mismatch.
	return constrained ? score : PROMPT_TEMPLATE_SPECIFICITY.default;
}

/**
 * Drop templates that a nearer source has redefined.
 *
 * Name is the identity: a workspace `gemma.md` replaces the global `gemma.md`
 * wholesale. Merging them would mean a project that overrides one tool
 * silently inherits a system prompt it never saw.
 */
export function shadowPromptTemplates(
	templates: readonly PromptTemplate[],
): PromptTemplate[] {
	const byName = new Map<string, PromptTemplate>();
	for (const template of templates) {
		const key = template.name.trim().toLowerCase();
		const existing = byName.get(key);
		if (
			!existing ||
			SOURCE_RANK[template.source] >= SOURCE_RANK[existing.source]
		) {
			byName.set(key, template);
		}
	}
	return [...byName.values()];
}

/**
 * Pick the template that governs a session, or `undefined` when none applies.
 *
 * Ties on specificity go to the nearer source, so a workspace template beats a
 * global one that is equally specific.
 */
export function resolvePromptTemplate(
	templates: readonly PromptTemplate[],
	target: PromptTemplateTarget,
): PromptTemplate | undefined {
	let best: PromptTemplate | undefined;
	let bestScore = -1;
	for (const template of shadowPromptTemplates(templates)) {
		const score = scorePromptTemplate(template, target);
		if (score === undefined) {
			continue;
		}
		if (
			score > bestScore ||
			(score === bestScore &&
				best !== undefined &&
				SOURCE_RANK[template.source] > SOURCE_RANK[best.source])
		) {
			best = template;
			bestScore = score;
		}
	}
	return best;
}

/** The name reserved for the base layer every other template falls back to. */
export const DEFAULT_PROMPT_TEMPLATE_NAME = "default";

/**
 * One template, fully resolved: what this session will actually send.
 *
 * The layering matters and is the whole point of the type. `default.md` holds
 * the complete prompt — the system text and a description for every tool — and
 * a family template is a *diff* on top of it. A Gemma template that rewrites
 * three tools should leave the other six reading exactly what `default.md`
 * says, not what the code happens to say, because otherwise editing
 * `default.md` would silently do nothing for any session that matched a family
 * template. That would make the one file people are most likely to read the
 * one file that is least likely to be true.
 *
 * Rendering happens once, when a session works out which template it is on.
 * Nothing downstream re-resolves, re-merges, or looks at the template list
 * again.
 */
export interface RenderedPromptTemplate {
	/** The template that won, for display and for logs. */
	name: string;
	fileName: string;
	source: PromptTemplateSource;
	filePath?: string;
	/** Whether anything beyond `default.md` contributed. */
	overlaid: boolean;
	/** Already merged: the custom system prompt, or the default's. */
	system?: string;
	/** Already merged: the default's descriptions, overlaid with the custom. */
	tools: Record<string, string>;
}

/**
 * Merge the template a session matched over the default one.
 *
 * A missing system section falls through to the default's; tools are merged
 * key by key, so a template naming one tool changes exactly one tool. Nothing
 * here expands `{{DEFAULT}}` — that needs the live tool, which is not
 * available at this point and is applied later.
 */
export function renderPromptTemplate(
	templates: readonly PromptTemplate[],
	target: PromptTemplateTarget,
): RenderedPromptTemplate | undefined {
	const shadowed = shadowPromptTemplates(templates);
	const base = shadowed.find(
		(template) =>
			template.name.trim().toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME,
	);
	const matched = resolvePromptTemplate(shadowed, target);

	// No default and no match means no templates at all — the caller keeps
	// whatever the code built, which is what a fresh install with an empty
	// template directory should do.
	if (!base && !matched) {
		return undefined;
	}
	if (!matched || matched === base) {
		const only = (matched ?? base) as PromptTemplate;
		return {
			name: only.name,
			fileName: only.fileName,
			source: only.source,
			filePath: only.filePath,
			overlaid: false,
			system: only.system,
			tools: { ...only.tools },
		};
	}

	return {
		name: matched.name,
		fileName: matched.fileName,
		source: matched.source,
		filePath: matched.filePath,
		overlaid: base !== undefined,
		system: matched.system ?? base?.system,
		tools: { ...base?.tools, ...matched.tools },
	};
}

/**
 * Expands to the description the tool was built with.
 *
 * Not every description is a fixed string. `run_commands` is written against
 * the shell that was actually detected — PowerShell and cmd.exe get different
 * sequencing advice — and `skills` appends the list of skills currently
 * installed. A template that replaced either outright would be freezing one
 * machine's answer into every machine's prompt, and the loss would be silent.
 *
 * So a template can wrap instead of replace:
 *
 * ```markdown
 * # tool: run_commands
 * Use this for commands only. To write a file, use `editor`.
 *
 * {{DEFAULT}}
 * ```
 */
export const PROMPT_TEMPLATE_DEFAULT_MARKER = "{{DEFAULT}}";

/**
 * Apply a template's tool descriptions to the tools a request is about to
 * carry, leaving every other field — name, schema, executor — untouched.
 *
 * Tools the template does not name keep the description they were built with,
 * so a template can rewrite one tool without having to restate the rest.
 */
export function applyPromptTemplateToTools<
	T extends { name: string; description?: string },
>(
	tools: readonly T[],
	template: Pick<PromptTemplate, "tools"> | undefined,
): T[] {
	if (!template || Object.keys(template.tools).length === 0) {
		return [...tools];
	}
	return tools.map((tool) => {
		const replacement = template.tools[tool.name];
		if (replacement === undefined) {
			return tool;
		}
		// An empty section blanks the description, which is strictly worse than
		// every other outcome: the model is handed a tool it has no information
		// about at all, and nothing at any layer reports it. Whatever the author
		// meant by an empty heading, they did not mean that — so it falls back
		// to the built-in text, the same as a tool the template never names.
		if (replacement.trim() === "") {
			return tool;
		}
		if (!replacement.includes(PROMPT_TEMPLATE_DEFAULT_MARKER)) {
			return { ...tool, description: replacement };
		}
		// The marker on its own is the common way to cover a tool without
		// changing it, and `"".split(marker).join(original)` already yields the
		// original — but only because the split leaves two empty halves. Being
		// explicit costs nothing and survives a refactor of the line below.
		if (replacement.trim() === PROMPT_TEMPLATE_DEFAULT_MARKER) {
			return tool;
		}
		// Read `description` once: on `skills` it is a getter that walks the
		// installed skills, and it is about to be read for every tool on every
		// request.
		const original = tool.description ?? "";
		return {
			...tool,
			description: replacement
				.split(PROMPT_TEMPLATE_DEFAULT_MARKER)
				.join(original)
				.trim(),
		};
	});
}
