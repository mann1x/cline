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

/** A pattern written `!qwen*moe*` excludes instead of including. */
export const PROMPT_TEMPLATE_EXCLUDE_PREFIX = "!";

/**
 * Whether a dimension's pattern list claims this value.
 *
 * WHY EXCLUSIONS EXIST. They predate pattern specificity (see
 * `patternSpecificity`) and were the only way to break a tie within a
 * dimension: `qwen*` and `qwen*moe*` both score `family`, the tie fell to
 * `SOURCE_RANK`, and between two builtins that is a draw -- leaving the winner
 * to be whichever the array happened to list first. Measured: with
 * `[qwen, qwen-moe]` a `qwen35moe` session resolved to `qwen`, and with the
 * same two reversed it resolved to `qwen-moe`.
 *
 * A family could then say out loud which architectures are not its own:
 *
 * ```yaml
 * match:
 *   family: [qwen*, "!*moe*"]
 * ```
 *
 * An exclusion beats every inclusion in its list, so the order of the list
 * does not matter either. A list of nothing but exclusions matches everything
 * it does not name.
 *
 * STILL USEFUL, AND STILL DIFFERENT. Specificity picks a winner among templates
 * that all claim a value; an exclusion says a value is not claimed at all. Use
 * an exclusion when a family must fall through to the base layer rather than to
 * a sibling -- and note that it is the one thing specificity cannot express,
 * because the most specific pattern still claims what it matches.
 */
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
	const included: string[] = [];
	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (trimmed.startsWith(PROMPT_TEMPLATE_EXCLUDE_PREFIX)) {
			if (matchesPromptPattern(value, trimmed.slice(1))) {
				return false;
			}
			continue;
		}
		included.push(trimmed);
	}
	if (included.length === 0) {
		return true;
	}
	return included.some((pattern) => matchesPromptPattern(value, pattern));
}

/**
 * How specific the most specific pattern that claims `value` is.
 *
 * The tie-break within a dimension, and what lets a generational template sit
 * under a generic one. `kimi-k3*` and `kimi*` both score `family`, and without
 * this the winner between two builtins is array order. Measuring the literal
 * (non-wildcard) characters of the matched pattern makes `kimi-k3*` (7) beat
 * `kimi*` (4), so a family can keep a generic template as its fallback and add
 * a narrower one per generation:
 *
 * ```yaml
 * # kimi.md      -> claims every kimi, including generations not yet released
 * match: { family: [kimi*] }
 * # kimi-k3.md   -> claims kimi-k3 specifically, and outranks the above
 * match: { family: [kimi-k3*] }
 * ```
 *
 * A future `kimi-k4` then lands on `kimi.md` rather than falling silently to
 * the base layer, which is the failure that hit `glm5*` and `deepseek4*`.
 *
 * An exact pattern outranks a wildcard one of the same literal length, which is
 * why the bonus exists: `kimi-k3` is a stronger claim than `kimi-k3*`.
 *
 * Exclusions are skipped. They do not claim a value -- they veto it, in
 * `matchesAny`, before scoring is reached.
 *
 * This CANNOT re-route any template shipped today: no two shipped `match:`
 * blocks claim the same value (verified in the tests). It changes an outcome
 * only where two patterns already overlapped, and there the old outcome was
 * array order, i.e. luck.
 */
export function patternSpecificity(
	value: string | undefined,
	patterns: string[] | undefined,
): number {
	if (!patterns || value === undefined || value === "") {
		return 0;
	}
	let best = 0;
	for (const pattern of patterns) {
		const trimmed = pattern.trim();
		if (
			trimmed === "" ||
			trimmed.startsWith(PROMPT_TEMPLATE_EXCLUDE_PREFIX) ||
			!matchesPromptPattern(value, trimmed)
		) {
			continue;
		}
		const literal = trimmed.replace(/\*/g, "").length;
		best = Math.max(best, trimmed.includes("*") ? literal : literal + 1);
	}
	return best;
}

/** A template's claim on a session: the dimension first, then how narrow. */
export interface PromptTemplateScore {
	/** The most specific dimension the template named. */
	dimension: number;
	/** How narrow the winning dimension's matching pattern is. */
	specificity: number;
}

/**
 * Score a template against a session, or `undefined` when it does not apply.
 *
 * Every dimension the template names must match — a template that asks for
 * provider `ollama` AND family `gemma4` does not apply to Gemma on another
 * provider. The score is the most specific dimension it named.
 */
export function scorePromptTemplateDetailed(
	template: PromptTemplate,
	target: PromptTemplateTarget,
): PromptTemplateScore | undefined {
	const match = template.match;
	if (!match) {
		return {
			dimension: PROMPT_TEMPLATE_SPECIFICITY.default,
			specificity: 0,
		};
	}
	const checks: Array<[boolean | undefined, number, number]> = [
		[
			matchesAny(target.providerId, match.provider),
			PROMPT_TEMPLATE_SPECIFICITY.provider,
			patternSpecificity(target.providerId, match.provider),
		],
		[
			matchesAny(target.family, match.family),
			PROMPT_TEMPLATE_SPECIFICITY.family,
			patternSpecificity(target.family, match.family),
		],
		[
			matchesAny(target.modelId, match.model),
			PROMPT_TEMPLATE_SPECIFICITY.model,
			patternSpecificity(target.modelId, match.model),
		],
	];

	let dimension: number = PROMPT_TEMPLATE_SPECIFICITY.default;
	let specificity = 0;
	let constrained = false;
	for (const [result, weight, narrowness] of checks) {
		if (result === undefined) {
			continue;
		}
		if (result === false) {
			return undefined;
		}
		constrained = true;
		// The tie-break belongs to the dimension that wins, not to the
		// broadest one the template happened to name: a template matching on
		// both family and model is chosen on its model pattern.
		if (weight > dimension) {
			dimension = weight;
			specificity = narrowness;
		} else if (weight === dimension) {
			specificity = Math.max(specificity, narrowness);
		}
	}
	// `match: {}` names nothing, so it is the default rather than a mismatch.
	return constrained
		? { dimension, specificity }
		: { dimension: PROMPT_TEMPLATE_SPECIFICITY.default, specificity: 0 };
}

/**
 * The dimension a template matched on, or `undefined` when it does not apply.
 *
 * The long-standing shape of this function, kept because it is what callers
 * outside resolution ask for. Resolution itself needs the tie-break as well and
 * uses `scorePromptTemplateDetailed`.
 */
export function scorePromptTemplate(
	template: PromptTemplate,
	target: PromptTemplateTarget,
): number | undefined {
	return scorePromptTemplateDetailed(template, target)?.dimension;
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
	let bestScore: PromptTemplateScore | undefined;
	for (const template of shadowPromptTemplates(templates)) {
		const score = scorePromptTemplateDetailed(template, target);
		if (score === undefined) {
			continue;
		}
		// Three keys, in order: the dimension named, then how narrowly that
		// dimension's pattern claims this session, then the source. The middle
		// one is what lets `kimi-k3*` sit under `kimi*` instead of tying with
		// it and being decided by array order.
		if (
			best === undefined ||
			bestScore === undefined ||
			score.dimension > bestScore.dimension ||
			(score.dimension === bestScore.dimension &&
				(score.specificity > bestScore.specificity ||
					(score.specificity === bestScore.specificity &&
						SOURCE_RANK[template.source] > SOURCE_RANK[best.source])))
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
 * The host, named the way the system prompt names it.
 *
 * `{{IDE_NAME}}` is substituted in the system prompt and was not substituted
 * anywhere else, so a `# tool:` section that used it shipped the braces to the
 * model verbatim. That left a template author two bad options: name one host
 * and be wrong on the other, or write "the IDE" and be wrong on every host
 * that is not one — which is what the shipped descriptions did, telling a
 * model in a terminal about an IDE it does not have and a Problems panel that
 * does not exist.
 *
 * So the same token resolves here. Nothing else does: `{{CWD}}` and the rest
 * describe the moment a request is built, and a tool description is written
 * once for the session.
 */
export const PROMPT_TEMPLATE_TOOL_PLACEHOLDERS = ["{{IDE_NAME}}"] as const;

/**
 * What the host is called, for substitution into a tool description.
 *
 * Optional, and deliberately so: a host that says nothing gets `the editor`,
 * which is wrong nowhere in particular rather than wrong somewhere specific.
 * The alternative — leaving the token unsubstituted — puts literal braces in
 * front of the model, which is the failure this exists to prevent.
 */
export interface PromptTemplateToolFacts {
	ideName?: string;
}

const UNNAMED_HOST = "the editor";

function substituteToolPlaceholders(
	description: string,
	facts: PromptTemplateToolFacts | undefined,
): string {
	if (!description.includes("{{IDE_NAME}}")) {
		return description;
	}
	return description.replaceAll(
		"{{IDE_NAME}}",
		facts?.ideName?.trim() || UNNAMED_HOST,
	);
}

/**
 * Apply a template's tool descriptions to the tools a request is about to
 * carry, leaving every other field — name, schema, executor — untouched.
 *
 * Tools the template does not name keep the description they were built with,
 * so a template can rewrite one tool without having to restate the rest.
 *
 * Every description that survives is then read once for `{{IDE_NAME}}`,
 * including the ones no template touched — a host tool can carry the token as
 * well as a template section can, and a token that resolved in one place and
 * not the other would be worse than not resolving at all. That read is the
 * reason this walks tools it has nothing to say about; on `skills` the getter
 * it costs walks the installed skills, which is why callers memoise this.
 */
export function applyPromptTemplateToTools<
	T extends { name: string; description?: string },
>(
	tools: readonly T[],
	template: Pick<PromptTemplate, "tools"> | undefined,
	facts?: PromptTemplateToolFacts,
): T[] {
	const templated = applyPromptTemplateSections(tools, template);
	return templated.map((tool) => {
		const description = tool.description ?? "";
		const substituted = substituteToolPlaceholders(description, facts);
		return substituted === description
			? tool
			: { ...tool, description: substituted };
	});
}

function applyPromptTemplateSections<
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
