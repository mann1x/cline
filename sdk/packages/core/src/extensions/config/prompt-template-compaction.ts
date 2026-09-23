/**
 * Compaction prompts inside a generated template: what is asked for, what is
 * checked, and what is thrown away when it fails the check.
 *
 * A tool description that reads badly costs a turn. A compaction prompt that
 * reads badly costs the session: its output replaces the transcript, and
 * nothing it drops can be recovered or checked against anything afterwards.
 * So translating them is opt-in, and the audit is stricter than it is for a
 * tool section in one respect -- a section that still fails after the repair
 * rounds is REMOVED from the file rather than kept as "the best attempt". A
 * removed section falls back to the built-in prompt, which is the safe answer;
 * a kept broken one is not.
 *
 * What survives is still only a proposal: the generated file is the user's to
 * review, edit, or strip before it is ever used.
 */
import {
	PROMPT_TEMPLATE_COMPACTION_IDS,
	type PromptTemplateCompactionId,
	type PromptTemplateCompactionPrompts,
} from "@cline/shared";
import { DEFAULT_THINKING_COMPACTION_PROMPT } from "../context/compaction-shared";
import {
	DEFAULT_COUNCIL_CRITIC_PROMPT,
	DEFAULT_COUNCIL_SYNTHESIZER_PROMPT,
	DEFAULT_COUNCIL_WRITER_PROMPT,
} from "../context/council-compaction";
import { DEFAULT_FULL_COMPACTION_PROMPT } from "../context/full-compaction";
import { DEFAULT_REPLAY_COMPACTION_PROMPT } from "../context/replay-compaction";

/** The source text for each compaction id: what is used when nothing overrides it. */
export const BUILTIN_COMPACTION_PROMPTS: Readonly<
	Record<PromptTemplateCompactionId, string>
> = {
	replay: DEFAULT_REPLAY_COMPACTION_PROMPT,
	full: DEFAULT_FULL_COMPACTION_PROMPT,
	retrospective: DEFAULT_THINKING_COMPACTION_PROMPT,
	"council-writer": DEFAULT_COUNCIL_WRITER_PROMPT,
	"council-critic": DEFAULT_COUNCIL_CRITIC_PROMPT,
	"council-synthesizer": DEFAULT_COUNCIL_SYNTHESIZER_PROMPT,
};

/** Which prompts to translate, and the text to translate from. */
export type CompactionPromptSources = Readonly<
	Partial<Record<PromptTemplateCompactionId, string>>
>;

/**
 * The sources for every compaction id: the user's own prompt where they set
 * one, the built-in one otherwise. A custom prompt is what that user's session
 * actually sends, so it is the one worth translating.
 */
export function resolveCompactionPromptSources(
	custom: CompactionPromptSources = {},
): Record<PromptTemplateCompactionId, string> {
	return Object.fromEntries(
		PROMPT_TEMPLATE_COMPACTION_IDS.map((id) => [
			id,
			custom[id]?.trim() || BUILTIN_COMPACTION_PROMPTS[id],
		]),
	) as Record<PromptTemplateCompactionId, string>;
}

/**
 * A translation shorter than this share of its source is read as a collapse.
 *
 * These prompts are long on purpose: each paragraph is a rule a summary was
 * observed to break without it. A rewrite at half the length has dropped
 * rules, however well it reads.
 */
export const MIN_COMPACTION_LENGTH_RATIO = 0.5;

const PLACEHOLDER = /\{\{[a-z_]+\}\}/g;

function placeholdersIn(text: string): string[] {
	return [...new Set(text.match(PLACEHOLDER) ?? [])];
}

function requestedIds(
	sources: CompactionPromptSources,
): PromptTemplateCompactionId[] {
	return PROMPT_TEMPLATE_COMPACTION_IDS.filter(
		(id) => (sources[id] ?? "").trim() !== "",
	);
}

/** The part of the generator's request that asks for the compaction sections. */
export function buildCompactionTranslationRequest(
	sources: CompactionPromptSources,
): string {
	const ids = requestedIds(sources);
	if (ids.length === 0) {
		return "";
	}
	const parts = [
		"--- compaction prompts ---",
		"",
		"Also rewrite the prompts below. They are what you are told when your transcript is compacted: what you write in answer to them replaces the transcript, and anything they fail to make you keep is lost for the rest of the session. Treat them as more dangerous to get wrong than any tool description.",
		"",
		"For each one, add a section after the tool sections, headed exactly `# compaction: <id>`, holding the prompt in the form you would rather receive. The same rules apply as for the tool descriptions, plus these, which are checked:",
		"",
		"- Keep every rule. Reorder, restate and sharpen, but do not drop a requirement, a prohibition, a step or a format. A rewrite much shorter than its source has lost rules and is rejected.",
		"- Keep every placeholder exactly as written, braces included: they are substituted at runtime.",
		"- Keep every literal marker exactly as written, such as `<<<HALFWAY>>>`: the harness splits on it.",
		"- Where you would not change a prompt, copy it through unchanged. That is accepted, and the copy is then left out of the file, so that prompt keeps using the built-in text and follows its future edits.",
		"- Write each section once. Do not add a `# compaction:` section for an id that is not listed.",
		"",
	];
	for (const id of ids) {
		parts.push(`=== ${id} ===`, "", (sources[id] as string).trim(), "");
	}
	return parts.join("\n");
}

export interface CompactionSectionAudit {
	problems: string[];
	/** Ids whose section must not be kept as written. */
	failing: Set<string>;
	/**
	 * Ids whose section is the source copied through. Not a failure -- the
	 * request allows it -- but not kept either: a copy is a snapshot, and the
	 * next edit to the built-in prompt would reach every model except this one.
	 * Leaving the section out is what "use the built-in" means.
	 */
	unchanged: Set<string>;
}

function normalizeForComparison(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Check the compaction sections a proposal carries against what was asked for.
 *
 * Every failing id is reported by name, so the repair round can fix it and
 * the final strip can remove exactly those.
 */
export function auditCompactionSections(
	compaction: PromptTemplateCompactionPrompts | undefined,
	sources: CompactionPromptSources,
): CompactionSectionAudit {
	const problems: string[] = [];
	const failing = new Set<string>();
	const unchanged = new Set<string>();
	const got = compaction ?? {};
	const wanted = new Set<string>(requestedIds(sources));

	for (const id of Object.keys(got)) {
		if (!wanted.has(id)) {
			failing.add(id);
			problems.push(
				`The '# compaction: ${id}' section was not asked for. Remove it: only the compaction prompts listed were to be rewritten.`,
			);
		}
	}

	for (const id of wanted) {
		const source = (sources[id as PromptTemplateCompactionId] ?? "").trim();
		const body = (got[id as PromptTemplateCompactionId] ?? "").trim();
		if (body === "") {
			failing.add(id);
			problems.push(
				`There is no '# compaction: ${id}' section. Add it after the tool sections, holding your rewrite of the '${id}' prompt, or the source copied through unchanged.`,
			);
			continue;
		}
		if (normalizeForComparison(body) === normalizeForComparison(source)) {
			unchanged.add(id);
			continue;
		}
		// Literal markers such as `<<<HALFWAY>>>` are checked by the template
		// validator, which runs on every parse; its warning names the section,
		// and `compactionIdsWithWarnings` turns that into a failing id.
		const lost = placeholdersIn(source).filter(
			(token) => !body.includes(token),
		);
		if (lost.length > 0) {
			failing.add(id);
			problems.push(
				`The '# compaction: ${id}' section dropped ${lost
					.map((token) => `\`${token}\``)
					.join(
						", ",
					)}. The harness substitutes ${lost.length === 1 ? "it" : "them"} at runtime; put ${lost.length === 1 ? "it" : "each"} back exactly as written.`,
			);
		}
		if (body.length < source.length * MIN_COMPACTION_LENGTH_RATIO) {
			failing.add(id);
			problems.push(
				`The '# compaction: ${id}' section is ${body.length} characters against ${source.length} in the prompt it rewrites. A rewrite under half the length has dropped rules. Restore every requirement the source states; restate them, do not remove them.`,
			);
		}
	}
	return { problems, failing, unchanged };
}

/**
 * The compaction ids a list of audit problems names, from the parser's
 * validation warnings (`In 'compaction: <id>': ...`).
 */
export function compactionIdsWithWarnings(
	problems: readonly string[],
): string[] {
	return problems.flatMap((problem) => {
		const id = problem.match(/^In 'compaction: ([A-Za-z0-9_-]+)'/)?.[1];
		return id ? [id] : [];
	});
}

const COMPACTION_HEADING = /^#[ \t]+compaction:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/;
const ANY_HEADING = /^#[ \t]+(?:system|tool:|compaction:)/;

/**
 * Remove the named `# compaction:` sections from a template file.
 *
 * Line-based on the same headings the parser reads, so a section's body runs
 * to the next section heading and nothing else in the file moves.
 */
export function stripCompactionSections(
	raw: string,
	ids: ReadonlySet<string>,
): string {
	if (ids.size === 0) {
		return raw;
	}
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const kept: string[] = [];
	let skipping = false;
	for (const line of lines) {
		if (ANY_HEADING.test(line)) {
			const id = line.match(COMPACTION_HEADING)?.[1];
			const removed = id !== undefined && ids.has(id);
			if (removed && !skipping) {
				// The blank lines that separated the removed section from the one
				// before it; the next kept heading puts one back.
				while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
					kept.pop();
				}
			} else if (!removed && skipping && kept.length > 0) {
				kept.push("");
			}
			skipping = removed;
		}
		if (!skipping) {
			kept.push(line);
		}
	}
	return kept.join("\n").replace(/\s+$/, "");
}
