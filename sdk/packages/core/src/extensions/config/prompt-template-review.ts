import {
	DEFAULT_PROMPT_TEMPLATE_NAME,
	PROMPT_TEMPLATE_DEFAULT_MARKER,
	type PromptTemplate,
	resolvePromptTemplate,
} from "@cline/shared";
import { getBuiltinPromptTemplates } from "./builtin-templates";
import { parsePromptTemplate } from "./prompt-template-parser";

/**
 * Judging a template a model wrote for itself.
 *
 * `scripts/review-prompt-templates.mts` asks a model to rewrite its own prompt
 * and then has to decide whether the answer is usable. That decision is the
 * part worth testing — a proposal that is accepted when it should not be goes
 * on to be read as a serious suggestion for what to ship — so it lives here
 * rather than in the script, the same way the builtin-template codegen does.
 *
 * The parser's own warnings cover most of it. Two failures it cannot see are
 * added: a rewrite that no longer routes to the model that wrote it, and a
 * rename. Both load, resolve and then quietly never apply.
 */

/**
 * The tools whose description has to be the model's own.
 *
 * Every one of these is a tool a model was watched getting wrong: reaching for
 * the shell instead of the file tools, sending the inner object where the outer
 * array belongs, answering a symbol question with a regex, shelling out to a
 * compiler to check one file. Those are the descriptions worth spending a
 * rewrite on, and the ones where inheriting the built-in text means the
 * template is the default wearing a hat.
 *
 * The other twenty-three are genuinely fine as `{{DEFAULT}}`: nothing about
 * how a model reads changes what `team_finalize_outcome` should say.
 */
export const DEFAULT_REQUIRED_REWRITES = [
	"read_files",
	"search_codebase",
	"editor",
	"apply_patch",
	"run_commands",
	"fetch_web_content",
	"check_file",
	"code_intel",
] as const;

export const PROMPT_TEMPLATE_REVIEW_INSTRUCTIONS = `You are being shown the prompt Cline gives you when it uses you as a coding agent: a system prompt and a set of tool descriptions. You are the intended reader of this text. Rewrite it into the form you would rather receive.

This is not a copy-editing task. The prompt below was written by someone reasoning about how you read, and they may have been wrong. Where a section is phrased in a way you would skim, reorder or restate it. Where a rule matters and is buried, put it where you would be when you are about to break it. Where something is repeated to no effect, cut it.

Four failures are observed in practice with models in your family, and the rewrite is judged on whether it prevents them:

1. Reaching for shell commands to do file work — 'cat' to read, 'sed -i' or 'echo >' to write, 'grep' to search — when dedicated tools exist and are always available.
2. Serialising independent work across turns: one read, wait, one read, wait, when all of them were known at the start.
3. Announcing an intention instead of acting on it, or claiming a task is finished without reading back what was written.
4. Answering a question about a symbol with a text search. Asking where something is defined, what uses it, what implements it, or what a name means, and then grepping for it and reading several files to work out which hit was the real one — when the IDE's language servers already know the answer exactly and will give it in one call. The same failure in its other form: running a compiler or a linter through the shell to find out whether one file is valid, and waiting for a whole-project build to answer a one-file question.

One thing you must get right, and which prompts written for this get wrong in both directions:

A coding agent is multi-turn, and the end of a turn is never in itself the end of the work. What is final is the completion of the assigned work — the task, the work package, the milestone, the request. An end of turn may be a milestone reached, a point where you need direction, guidance or a clarification from the user, or simply an intermediate step between two things the user asked for. So:

- Do not treat "I have stopped emitting tool calls" as "the work is done". It is not a signal about the work at all.
- Do not write a rule that makes stopping feel like failure, such as "a response without a tool call is considered complete". A rule like that buys one more unnecessary tool call on every finished task, and it teaches the wrong thing: that continuing is always correct.
- Keep your attention on the long horizon of the assigned work rather than on the current turn. Ending a turn to ask a question is correct when you need the answer. Ending it while work you were asked to do remains untouched, and saying nothing about that, is not.

Hard constraints:

- Keep every placeholder exactly as written, including the braces: {{PLATFORM_NAME}}, {{CURRENT_DATE}}, {{IDE_NAME}}, {{CWD}}, {{CLINE_RULES}}, {{CLINE_METADATA}}, {{DEFAULT}}. They are substituted at runtime; a renamed or dropped placeholder breaks the prompt.
- Keep the tool names exactly as written. They are the wire names of real tools.
- Do not invent tools, parameters, or capabilities. Describe only what is described below.
- Keep the file structure: YAML frontmatter between --- markers, then '# system', then one '# tool: <name>' section for EVERY tool listed below. Not only the ones you want to change — every one of them.
- Covering every tool is a hard requirement. A tool with no section keeps its built-in description, and that fallback exists for exactly one situation: Cline gains a new tool and the templates have not been regenerated yet. It is not a way to skip tools you have nothing to say about. A template that covers six of thirty-one tools is not using the fallback, it is relying on it, and nothing in the file shows which twenty-five were left out.
- '{{DEFAULT}}' expands to the tool's built-in description at runtime, and it is how you cover a tool cheaply. Where you would improve on the built-in wording, write your own and put '{{DEFAULT}}' on its own line where the built-in text should follow. Where you would not, the entire section body may be just '{{DEFAULT}}'. Either is a covered tool; an absent section is not.
- These eight tools must be written in your own words, and a section containing only '{{DEFAULT}}' is not acceptable for any of them: read_files, search_codebase, editor, apply_patch, run_commands, fetch_web_content, check_file, code_intel. They are the tools models in your family are observed to misuse, so they are the whole reason this template exists. For these eight, your own text — not the inherited text — has to carry the three things listed below: every value of any closed set, every argument and when to use it, and what comes back. Adding '{{DEFAULT}}' after your text is allowed and does not excuse you from any of that.
- For the other tools, a section whose body is exactly '{{DEFAULT}}' is a complete and correct answer. Do not pad them. Nothing about how you read changes what 'team_finalize_outcome' should say.
- Emit every section exactly once. Do not repeat '# system', and do not write two '# tool: <name>' headings for the same tool. Only the last copy of a repeated section survives, so a duplicate silently throws away your own work.
- Leave the 'match:' block in the frontmatter exactly as it is. It is what routes this template to you; change it and your rewrite reaches a different model, or none.

Replace a description and you inherit everything it was carrying:

If a '# tool:' section contains '{{DEFAULT}}' anywhere, the built-in description is still delivered and you are only adding emphasis on top of it. Nothing further is asked of you for that tool — unless it is one of the eight above, which are judged on your words alone.

If it does not, your text is the only thing a model will ever see about that tool, so it must not lose what the built-in description said. Specifically, and only where the built-in text below says it:

1. Closed sets. Where the built-in description lists the values an argument accepts — the operations of a language-server tool, the actions of a task tool, the statuses of a run — your replacement must list all of them too. Naming four of eight hides half the tool and a model cannot guess the rest.
2. How to address the tool. Where the built-in description names the arguments, and says which one to use when, your replacement must say the same. A tool that can be addressed three ways needs all three, and what each is for.
3. What comes back. Where the built-in description states an output, your replacement must state one: the shape, what the fields hold, and what an empty or failed result means. A model that cannot map a result back onto its request spends a turn working it out, and then stops trusting the tool.

Nothing is required of you that the built-in text did not already provide. Reproducing what is there is always enough; improving on it is better; dropping it is the one thing that is not allowed.

Do not write 'Output:' followed by nothing, or by a single word. An empty label reads as an empty result, which is worse than saying nothing at all.

For any tool outside the eight, if restating all of that is not worth it to you, do not replace its description. Write your emphasis and leave '{{DEFAULT}}' in the section, or write nothing but the marker. That is cheaper and it is always correct.

Reply with the complete template file and nothing else: no preamble, no explanation, no code fence.`;

export function buildPromptTemplateReviewPrompt(
	defaultTemplate: string,
	familyTemplate: string | undefined,
	familyTemplateName: string | undefined,
	/** What this model is, so a new template can be told how to claim itself. */
	target?: { providerId: string; modelId: string; family?: string },
	/** Real call shapes, so any example the model writes is a valid one. */
	toolSignatures?: readonly ToolCallSignature[],
	/** Every tool the reply must give a section. Checked by the audit. */
	requiredSections?: readonly string[],
): string {
	const signatureBlock = renderToolCallSignatures(toolSignatures ?? []);
	const parts = [
		PROMPT_TEMPLATE_REVIEW_INSTRUCTIONS,
		...(signatureBlock ? ["", signatureBlock] : []),
		...(requiredSections && requiredSections.length > 0
			? ["", renderRequiredSections(requiredSections)]
			: []),
		"",
		"--- default.md (the base layer, which supplies anything your template omits) ---",
		"",
		defaultTemplate,
	];
	if (familyTemplate && familyTemplateName) {
		parts.push(
			"",
			`--- ${familyTemplateName} (the template you are given today, layered over the base) ---`,
			"",
			familyTemplate,
			"",
			`Rewrite ${familyTemplateName}. It must end up with a '# tool:' section for every one of the ${requiredSections?.length ?? 0} tools listed above, not only the ones it has today.`,
		);
	} else {
		parts.push("", buildNewTemplateInstruction(target));
	}
	return parts.join("\n");
}

/**
 * The checklist, written out.
 *
 * The tool names are all present in `default.md` further down the prompt, as
 * thirty-one headings inside eleven kilobytes of prose. Asking a model to
 * recover a list from that is asking it to do the one thing it is worst at;
 * measured, it returns six sections and believes it has finished. A flat list
 * it can count against costs a few hundred tokens and removes the excuse.
 */
function renderRequiredSections(tools: readonly string[]): string {
	return [
		`Your reply must contain a '# tool:' section for each of these ${tools.length} tools. Count them before you answer.`,
		"",
		...tools.map((tool) => `  # tool: ${tool}`),
		"",
		"A section whose body is exactly '{{DEFAULT}}' is a complete, correct section. Use it for every tool you have nothing to add to. Missing sections are the failure; short sections are not.",
	].join("\n");
}

/**
 * Tell a model writing a template from scratch exactly how to claim itself.
 *
 * Observed in practice: a model rewriting an existing template keeps its match
 * block, and a model writing a new one invents a shape — `match: [glm*]`,
 * `match.id`, a bare string — every one of which either fails to parse or
 * routes to nothing. Showing the block it should write, filled in with its own
 * identifiers, is what stops that.
 */
function buildNewTemplateInstruction(target?: {
	providerId: string;
	modelId: string;
	family?: string;
}): string {
	const lines = [
		"No template claims you today, so you are given the base layer above. Write the template that should claim you.",
		"",
		"The 'match:' block is what routes a template to a model. It is a mapping, and the only three keys it accepts are 'provider', 'family' and 'model'. Each takes a list of patterns where '*' is the only wildcard. Any other key, or a list where the mapping should be, is an error.",
	];
	if (target?.family) {
		// Family is the right key when the provider reports one: it is stable
		// across quants, tags and renames of the same model.
		const stem = target.family.replace(/[^a-zA-Z0-9]+.*$/, "") || target.family;
		lines.push(
			"",
			"Write exactly this, and change nothing in it:",
			"",
			"match:",
			`  family: [${stem}*]`,
			"",
			`Your family is '${target.family}', so that pattern claims you and every other build of the same architecture.`,
		);
	} else if (target) {
		lines.push(
			"",
			"Your provider does not report a model family, so match on the model name. Write exactly this, and change nothing in it:",
			"",
			"match:",
			`  model: ["*${target.modelId.replace(/[:@].*$/, "")}*"]`,
		);
	}
	return lines.join("\n");
}

/**
 * A one-line call signature per tool, built from the real input schema.
 *
 * This exists because of a failure seen in production logs rather than a
 * hypothetical one. `fetch_web_content` requires `{requests: [{url, prompt}]}`
 * and its description says "each request includes a URL and a prompt" — which
 * describes the inner object and never names the array that wraps it. A qwen3.6
 * session sent `{url, prompt}` four times and got
 * `Invalid input: expected array, received undefined` every time, then gave up
 * and shelled out. `read_files` has the same shape of gap: "at the provided
 * absolute paths", but the schema wants `{files: [{path}]}`.
 *
 * So a model rewriting a template must be shown the envelope, not just the
 * semantics — otherwise the confident, concrete example it writes is wrong, and
 * a wrong example is worse than none.
 */
export interface ToolCallSignature {
	name: string;
	/** Top-level argument names, in schema order. */
	parameters: string[];
	required: string[];
	/** `read_files(files: [{path, start_line?, end_line?}])` */
	signature: string;
	/**
	 * Every value of every enum in the schema, flattened.
	 *
	 * These are the closed sets a model cannot guess: `code_intel` accepts
	 * exactly eight operations and a description that names four of them has
	 * hidden half the tool. Collected here so the audit can require them
	 * without a hand-maintained list that would drift the first time an
	 * operation is added.
	 */
	enumValues: string[];
}

function describeSchemaValue(value: unknown, depth = 0): string {
	if (!value || typeof value !== "object") {
		return "";
	}
	const schema = value as {
		type?: string;
		items?: unknown;
		properties?: Record<string, unknown>;
		required?: string[];
		anyOf?: unknown[];
	};
	if (Array.isArray(schema.anyOf)) {
		// `x | null` in the schema is just an optional scalar to a reader.
		const first = schema.anyOf.find(
			(entry) => (entry as { type?: string })?.type !== "null",
		);
		return describeSchemaValue(first, depth);
	}
	if (schema.type === "array") {
		const inner = describeSchemaValue(schema.items, depth + 1);
		return `[${inner || "…"}]`;
	}
	if (schema.properties && depth > 0) {
		const required = new Set(schema.required ?? []);
		const keys = Object.keys(schema.properties).map((key) =>
			required.has(key) ? key : `${key}?`,
		);
		return `{${keys.join(", ")}}`;
	}
	return schema.type ?? "";
}

/**
 * Every string enum anywhere in a schema, at any depth.
 *
 * Walks rather than reading the top level, because the values that matter are
 * not always top level: `team_task`'s actions sit under a property, and a
 * nested one would be missed by anything shallower.
 */
function collectEnumValues(schema: unknown): string[] {
	const found = new Set<string>();
	const visit = (node: unknown, depth: number): void => {
		if (!node || typeof node !== "object" || depth > 6) {
			return;
		}
		const record = node as Record<string, unknown>;
		if (Array.isArray(record.enum)) {
			for (const value of record.enum) {
				if (typeof value === "string" && value !== "") {
					found.add(value);
				}
			}
		}
		for (const value of Object.values(record)) {
			if (Array.isArray(value)) {
				for (const entry of value) {
					visit(entry, depth + 1);
				}
			} else {
				visit(value, depth + 1);
			}
		}
	};
	visit(schema, 0);
	return [...found];
}

export function summarizeToolCallSignatures(
	tools: readonly { name: string; inputSchema?: unknown }[],
): ToolCallSignature[] {
	const signatures: ToolCallSignature[] = [];
	for (const tool of tools) {
		const schema = tool.inputSchema as
			| { properties?: Record<string, unknown>; required?: string[] }
			| undefined;
		const properties = schema?.properties ?? {};
		const required = schema?.required ?? [];
		const parameters = Object.keys(properties);
		const rendered = parameters.map((key) => {
			const described = describeSchemaValue(properties[key], 1);
			const optional = required.includes(key) ? "" : "?";
			return described
				? `${key}${optional}: ${described}`
				: `${key}${optional}`;
		});
		signatures.push({
			name: tool.name,
			parameters,
			required: [...required],
			signature: `${tool.name}(${rendered.join(", ")})`,
			enumValues: collectEnumValues(schema),
		});
	}
	return signatures;
}

/**
 * Shortest `Output:` sentence that is actually saying something.
 *
 * "Output: ." and "Output: text." are not descriptions, they are the shape of
 * one. The threshold is deliberately low — it is there to catch a model that
 * emitted the label and nothing behind it, not to judge prose.
 */
const MIN_OUTPUT_DESCRIPTION_CHARS = 24;

/**
 * Hold a rewritten tool section to what the built-in one already told the model.
 *
 * A section that keeps `{{DEFAULT}}` inherits the whole built-in description
 * and needs nothing from this: the model is adding emphasis on top of a
 * complete text. A section that drops the marker has replaced that text, and
 * replacing it is where information goes missing — measured across five models
 * rewriting `code_intel`, the replacements ranged from complete to two lines
 * naming none of the eight operations, none of the three ways to address a
 * symbol, and no output at all. Both parsed. Both resolved. Both applied.
 *
 * So the rule is: replace it and you own it — do not lose what it was saying.
 * Judged against the built-in text rather than against the schema, because the
 * two are not the same thing and the difference is not academic. The built-in
 * `team_send_message` description names neither `subject` nor `body`; a rule
 * that demanded them would be asking a model to add what it was never shown,
 * and one did exactly that for four attempts without converging, because there
 * was nothing in front of it to converge on. Requiring only what the source
 * carried is both fair and reachable: reproduce the built-in text and you pass.
 */
export function auditToolSectionContent(
	tools: Readonly<Record<string, string>>,
	signatures: readonly ToolCallSignature[],
	/** The built-in description per tool. Nothing is required beyond these. */
	builtinDescriptions: Readonly<Record<string, string>> = {},
	/**
	 * Tools whose section must be written, not inherited.
	 *
	 * The marker is a fair way to cover a tool a model has nothing to say
	 * about, and for most of the thirty-one that is the honest answer. It is
	 * not the honest answer for the handful the model actually gets wrong: a
	 * 31B model handed the option produced twenty-four bare markers and two
	 * lines of its own on `code_intel`, which is not a template that reads
	 * differently from the default — it is the default with a preamble.
	 */
	requiredRewrites: readonly string[] = [],
): string[] {
	const problems: string[] = [];
	const byName = new Map(signatures.map((entry) => [entry.name, entry]));
	const mustRewrite = new Set(requiredRewrites);

	for (const [name, body] of Object.entries(tools)) {
		const outputProblem = auditOutputClaim(name, body);
		if (outputProblem) {
			problems.push(outputProblem);
		}
		const own = body.split(PROMPT_TEMPLATE_DEFAULT_MARKER).join("").trim();
		if (mustRewrite.has(name) && own === "") {
			problems.push(
				`The '# tool: ${name}' section is nothing but '{{DEFAULT}}'. This is one of the tools models in your family actually misuse, so it is the one place the marker is not enough — write the description in your own words, in the form you would rather receive it.`,
			);
			continue;
		}
		// A tool that has to be rewritten is judged on its own words, marker or
		// not: inheriting the contract defeats the point of demanding the
		// rewrite. Everything else is judged only when it replaced the text.
		if (
			!mustRewrite.has(name) &&
			body.includes(PROMPT_TEMPLATE_DEFAULT_MARKER)
		) {
			// Inherits the built-in text, which already says all of this.
			continue;
		}
		const signature = byName.get(name);
		const builtin = builtinDescriptions[name];
		if (!signature || builtin === undefined) {
			continue;
		}
		const judged = mustRewrite.has(name) ? own : body;
		const names = (token: string) => new RegExp(`\\b${token}\\b`).test(judged);
		const builtinNames = (token: string) =>
			new RegExp(`\\b${token}\\b`).test(builtin);

		const missingEnums = signature.enumValues.filter(
			(value) => builtinNames(value) && !names(value),
		);
		if (missingEnums.length > 0) {
			problems.push(
				`The '# tool: ${name}' section replaces the built-in description but drops ${missingEnums.length} of the values it accepts: ${missingEnums.join(", ")}. A model cannot guess a closed set. List every one of them, or keep '{{DEFAULT}}' in the section so the built-in text supplies them.`,
			);
		}

		const missingParameters = signature.parameters.filter(
			(parameter) => builtinNames(parameter) && !names(parameter),
		);
		if (missingParameters.length > 0) {
			problems.push(
				`The '# tool: ${name}' section replaces the built-in description but drops the argument(s) it named: ${missingParameters.join(", ")}. Say how to address the tool — which arguments it takes and when each is the right one — or keep '{{DEFAULT}}' in the section.`,
			);
		}

		if (/\boutput\b/i.test(builtin) && !/\boutput\b/i.test(judged)) {
			problems.push(
				`The '# tool: ${name}' section replaces the built-in description but drops what it said about the tool's output. A model that cannot map a result onto its request spends a turn working it out, or stops using the tool. State the output, or keep '{{DEFAULT}}' in the section.`,
			);
		}
	}
	return problems;
}

/** An `Output:` label with nothing behind it is worse than none. */
function auditOutputClaim(name: string, body: string): string | undefined {
	const match = /\boutput\b\s*:(.*)$/im.exec(body);
	if (!match) {
		return undefined;
	}
	const claim = (match[1] ?? "").trim();
	if (claim.replace(/[.\s]/g, "").length === 0) {
		return `The '# tool: ${name}' section says 'Output:' and then nothing. Either describe what comes back or remove the label — an empty one tells a model the answer is empty.`;
	}
	// A shape says more in seventeen characters than a sentence usually does:
	// `{agentId, status}` is the whole answer for half the team tools, and a
	// length rule that rejected it would be pushing models towards padding.
	if (/[{[]/.test(claim)) {
		return undefined;
	}
	if (claim.length < MIN_OUTPUT_DESCRIPTION_CHARS) {
		return `The '# tool: ${name}' section describes its output as '${claim}', which does not say what a caller will receive. Give the shape, or say what the text contains.`;
	}
	return undefined;
}

/** The block handed to a model so its examples use the real argument shapes. */
export function renderToolCallSignatures(
	signatures: readonly ToolCallSignature[],
): string {
	if (signatures.length === 0) {
		return "";
	}
	return [
		"These are the exact call shapes of the tools, taken from their schemas. Every example call you write must use these argument names and this nesting — a confidently written example with the wrong shape is worse than no example, because the model will copy it and the call will be rejected.",
		"",
		...signatures.map((entry) => `  ${entry.signature}`),
		"",
		"Note the wrappers in particular. Several tools take a single array argument whose elements are objects; passing the inner object directly, or passing a bare list of strings, is rejected.",
	].join("\n");
}

export interface PromptTemplateProposalAudit {
	template?: PromptTemplate;
	/** Empty means usable. Each entry is phrased to be handed back to a model. */
	problems: string[];
}

export interface AuditPromptTemplateProposalArgs {
	raw: string;
	fileName: string;
	/** The provider the template is being generated for. */
	providerId: string;
	/** The model this was written by and for, e.g. `gemma4:31b-cloud`. */
	modelId: string;
	/**
	 * The model family, when the provider can report one. Only Ollama does; for
	 * every other provider this is undefined and the template matches on the
	 * provider or the model id instead.
	 */
	family: string | undefined;
	knownToolNames: readonly string[];
	/** The name it must keep, or undefined when writing a brand-new template. */
	expectedName?: string;
	/**
	 * Tools the rewrite has to say something about, anywhere in the file.
	 *
	 * Omitting a tool section is legal — it falls back to the default template
	 * — so a proposal that simply forgets a tool passes every structural check
	 * while quietly failing to do the thing it was asked to do. Observed once
	 * in six runs, which is exactly often enough to matter and rarely enough to
	 * miss by eye.
	 */
	requiredMentions?: readonly string[];
	/**
	 * Tools that must each have a `# tool:` section of their own.
	 *
	 * Stricter than `requiredMentions`, which only asks that the name appear
	 * somewhere. This asks for the section, because a tool with no section is
	 * a tool whose description this template does not govern.
	 */
	requiredSections?: readonly string[];
	/**
	 * Tools whose section must be the model's own words rather than the marker.
	 * These are the tools whose description actually changes behaviour.
	 */
	requiredRewrites?: readonly string[];
	/**
	 * Real call shapes, so example calls in the proposal can be checked.
	 * Without these the audit cannot tell `read_files(["a.ts"])` — which is
	 * rejected at runtime — from a correct one.
	 */
	toolSignatures?: readonly ToolCallSignature[];
	/** Injection point for tests; defaults to the shipped templates. */
	baseTemplates?: readonly PromptTemplate[];
}

export function auditPromptTemplateProposal(
	args: AuditPromptTemplateProposalArgs,
): PromptTemplateProposalAudit {
	const parsed = parsePromptTemplate({
		raw: args.raw,
		source: "global",
		fileName: args.fileName,
		knownToolNames: args.knownToolNames,
	});
	if (!parsed.template) {
		return { problems: [`The file does not parse: ${parsed.error}`] };
	}

	const problems = parsed.warnings.map(
		(warning) => `In '${warning.section}': ${warning.message}`,
	);

	if (args.expectedName && parsed.template.name !== args.expectedName) {
		problems.push(
			`The template is named '${parsed.template.name}'. It must stay '${args.expectedName}', which is the name it is known by.`,
		);
	}

	// Routing is the whole point. A rewrite that no longer claims this model is
	// a file that will never be used, and nothing downstream would say so.
	const base = (args.baseTemplates ?? getBuiltinPromptTemplates()).filter(
		(template) =>
			template.name.trim().toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME,
	);
	const winner = resolvePromptTemplate([...base, parsed.template], {
		providerId: args.providerId,
		modelId: args.modelId,
		family: args.family,
	});
	if (winner !== parsed.template) {
		problems.push(
			`The 'match:' block no longer selects this model (provider '${
				args.providerId
			}', family '${args.family ?? "unknown"}', id '${
				args.modelId
			}'), so the template would never be applied. Restore the original match block.`,
		);
	}

	problems.push(...auditExampleCalls(args.raw, args.toolSignatures ?? []));
	problems.push(
		...auditToolSectionContent(
			parsed.template.tools,
			args.toolSignatures ?? [],
			base[0]?.tools ?? {},
			args.requiredRewrites ?? DEFAULT_REQUIRED_REWRITES,
		),
	);

	// Every tool needs a section of its own.
	//
	// A missing section is not an error — the tool keeps its built-in
	// description — which is exactly why this has to be checked here. The
	// fallback exists for one situation: Cline gains a tool and the templates
	// have not been regenerated yet. A template that silently covers six of
	// thirty-one tools is not using the fallback, it is relying on it, and the
	// gap is invisible from the file. Nothing downstream would ever report it.
	if (args.requiredSections && args.requiredSections.length > 0) {
		const covered = new Set(Object.keys(parsed.template.tools));
		const uncovered = args.requiredSections.filter(
			(tool) => !covered.has(tool),
		);
		if (uncovered.length > 0) {
			problems.push(
				`${uncovered.length} tool(s) have no '# tool:' section: ${uncovered.join(", ")}. ` +
					"Every tool must have one. Where you have nothing to add to the built-in wording, the section body can be exactly `{{DEFAULT}}`, or your own framing with `{{DEFAULT}}` on its own line where the built-in text should be inserted. Do not omit the section.",
			);
		}
	}

	for (const tool of args.requiredMentions ?? []) {
		if (!args.raw.includes(tool)) {
			problems.push(
				`The rewrite never mentions '${tool}'. One of the listed failures is the one that tool solves, so the template has to tell the model to reach for it — in the system prompt, in a '# tool: ${tool}' section, or wherever you think it will be read.`,
			);
		}
	}

	return { template: parsed.template, problems };
}

/**
 * Hand a model its own file back with the list of what is wrong with it.
 *
 * Asking for a fix works far better than asking for another draft: a fresh
 * draft reintroduces the same mistakes at the same rate, because the thing that
 * produced them has not changed.
 */
export function buildPromptTemplateRepairPrompt(
	previous: string,
	problems: readonly string[],
): string {
	return [
		"The file you produced has problems. Fix exactly these and change nothing else.",
		"",
		"--- problems ---",
		...problems.map((problem, index) => `${index + 1}. ${problem}`),
		"",
		"--- your file ---",
		"",
		previous,
		"",
		"Reply with the complete corrected file and nothing else: no preamble, no explanation, no code fence.",
	].join("\n");
}

/**
 * Pull the template out of a reply.
 *
 * The instructions ask for no code fence. Models add one anyway, and a fenced
 * reply that is otherwise perfect should not cost a repair round.
 */
export function extractTemplateFromReply(reply: string): string {
	const fenced = reply.match(/```(?:markdown|md)?\n([\s\S]*?)```/);
	return (fenced ? fenced[1] : reply).trim();
}

/**
 * Ask a model for a template it would rather receive, and keep asking until the
 * answer is usable.
 *
 * The model call is injected because the two callers reach a model by entirely
 * different routes: the review script talks to Ollama over HTTP, and the
 * extension goes through whichever provider the user has configured. What must
 * not differ is everything around the call — the instructions, the audit, and
 * the decision to try again — because a template generated from the settings
 * panel and one generated from the script should be the same artefact.
 */
export interface GeneratePromptTemplateArgs {
	/** `default.md`, the base layer the proposal is layered over. */
	defaultTemplate: string;
	/** The template this model is given today, if any. */
	familyTemplate?: string;
	familyFileName?: string;
	providerId: string;
	modelId: string;
	family?: string;
	knownToolNames: readonly string[];
	requiredMentions?: readonly string[];
	/**
	 * Tools the proposal must give a `# tool:` section each. Defaults to
	 * `knownToolNames`: every tool that exists is a tool the template governs.
	 */
	requiredSections?: readonly string[];
	/** Tools that must be rewritten rather than inherited via the marker. */
	requiredRewrites?: readonly string[];
	/** Real call shapes: put into the prompt and used to check the result. */
	toolSignatures?: readonly ToolCallSignature[];
	expectedName?: string;
	/**
	 * The name the file will be written under. A template with no `name:` in
	 * its frontmatter takes its name from here, so auditing under a different
	 * one would judge a name the file will never have.
	 */
	fileName?: string;
	/** Tries, including the first. Each retry hands back the problem list. */
	attempts?: number;
	/** One completion. Returns the reply text; throws to abort. */
	complete: (
		messages: readonly { role: "user" | "assistant"; content: string }[],
	) => Promise<string>;
	/** Progress, for a UI that has somewhere to put it. */
	onAttempt?: (attempt: number, problems: readonly string[]) => void;
}

export interface GeneratePromptTemplateResult {
	/** The best proposal produced, which is not always a clean one. */
	raw: string;
	audit: PromptTemplateProposalAudit;
	/** How many model calls it took. */
	attempts: number;
}

export async function generatePromptTemplate(
	args: GeneratePromptTemplateArgs,
): Promise<GeneratePromptTemplateResult> {
	const attemptLimit = Math.max(1, args.attempts ?? 3);
	const fileName = args.fileName ?? `${args.expectedName ?? "generated"}.md`;
	const messages: { role: "user" | "assistant"; content: string }[] = [
		{
			role: "user",
			content: buildPromptTemplateReviewPrompt(
				args.defaultTemplate,
				args.familyTemplate,
				args.familyFileName,
				{
					providerId: args.providerId,
					modelId: args.modelId,
					family: args.family,
				},
				args.toolSignatures,
				args.requiredSections ?? args.knownToolNames,
			),
		},
	];

	let best: GeneratePromptTemplateResult | undefined;

	for (let attempt = 1; attempt <= attemptLimit; attempt++) {
		const reply = await args.complete(messages);
		if (reply.trim() === "") {
			throw new Error("The model returned an empty response.");
		}

		const raw = extractTemplateFromReply(reply);
		const audit = auditPromptTemplateProposal({
			raw,
			fileName,
			providerId: args.providerId,
			modelId: args.modelId,
			family: args.family,
			knownToolNames: args.knownToolNames,
			requiredMentions: args.requiredMentions,
			requiredSections: args.requiredSections ?? args.knownToolNames,
			requiredRewrites: args.requiredRewrites ?? DEFAULT_REQUIRED_REWRITES,
			toolSignatures: args.toolSignatures,
			expectedName: args.expectedName,
		});
		args.onAttempt?.(attempt, audit.problems);

		// Keep the cleanest attempt, so a run that never reaches zero problems
		// still yields the best version rather than the last one.
		if (
			!best ||
			(audit.template && !best.audit.template) ||
			audit.problems.length < best.audit.problems.length
		) {
			best = { raw, audit, attempts: attempt };
		}
		if (audit.problems.length === 0) {
			return { raw, audit, attempts: attempt };
		}
		if (attempt < attemptLimit) {
			messages.push({ role: "assistant", content: raw });
			messages.push({
				role: "user",
				content: buildPromptTemplateRepairPrompt(raw, audit.problems),
			});
		}
	}

	// Unreachable with attemptLimit >= 1, but the type does not know that.
	if (!best) {
		throw new Error("No proposal was produced.");
	}
	return best;
}

/**
 * Check the example calls a template writes against the real schemas.
 *
 * The shipped `qwen.md` contained `Right: read_files(["src/app.ts"])`, which is
 * rejected — the schema is `{files: [{path}]}`. A template that teaches an
 * invalid call is worse than one that teaches nothing, because the model
 * follows it, fails, and falls back to the shell. That is the observed
 * behaviour this check exists to stop being reintroduced.
 */
/**
 * Words that turn an example into a counter-example.
 *
 * Read from the start of the line up to the call itself, so "Wrong:" and
 * "Never write" disqualify it while a mention further down the paragraph does
 * not. Deliberately generous: a false negative here costs one unchecked
 * counter-example, a false positive costs a correct template a failed run.
 */
const NEGATIVE_EXAMPLE_MARKER =
	/\b(wrong|incorrect|invalid|bad|never|avoid|don't|do not|rejected|not this|instead of|fails?)\b/i;

function isNegativeExample(raw: string, index: number): boolean {
	const lineStart = raw.lastIndexOf("\n", index) + 1;
	return NEGATIVE_EXAMPLE_MARKER.test(raw.slice(lineStart, index));
}

export function auditExampleCalls(
	raw: string,
	signatures: readonly ToolCallSignature[],
): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();

	for (const entry of signatures) {
		// `tool(` followed by anything up to the matching-ish close. Good enough:
		// these are prose examples on one line, not code to parse.
		const pattern = new RegExp(`\\b${entry.name}\\s*\\(([^)\n]*)\\)`, "g");
		for (const match of raw.matchAll(pattern)) {
			const args = match[1].trim();
			if (args === "") {
				continue;
			}
			// A malformed call shown as a warning is the template doing its job.
			// Qwen writes "Correct: …" beside "Wrong: read_files([{path}])" and
			// an audit that cannot tell them apart fails the one model that took
			// the trouble to show both — and, worse, teaches the repair loop to
			// delete the warning.
			if (isNegativeExample(raw, match.index ?? 0)) {
				continue;
			}
			const named = [...args.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]/g)].map(
				(m) => m[1],
			);
			const example =
				match[0].length > 90 ? `${match[0].slice(0, 90)}…` : match[0];
			if (seen.has(example)) {
				continue;
			}
			seen.add(example);

			if (named.length === 0) {
				problems.push(
					`The example \`${example}\` passes its argument positionally. Every tool takes a named-argument object; write it as \`${entry.signature}\`.`,
				);
				continue;
			}
			const unknown = named.filter((name) => !entry.parameters.includes(name));
			// A nested key is fine — `files: [{path: "x"}]` names `path` too — so
			// only complain when nothing in the example matches the real top-level
			// arguments at all.
			if (
				unknown.length > 0 &&
				!named.some((name) => entry.parameters.includes(name))
			) {
				problems.push(
					`The example \`${example}\` uses ${unknown
						.map((name) => `'${name}'`)
						.join(", ")}, which ${
						unknown.length === 1 ? "is not an argument" : "are not arguments"
					} of ${entry.name}. Its shape is \`${entry.signature}\`.`,
				);
			}
		}
	}
	return problems;
}
