import {
	type PromptTemplate,
	type PromptTemplateMatch,
	type PromptTemplateSource,
	type PromptTemplateWarning,
	splitFrontmatter,
	validatePromptTemplate,
} from "@cline/shared";
import YAML from "yaml";

/**
 * Parser for the prompt template files under `~/.cline/templates/` and
 * `<workspace>/.clinerules/templates/`.
 *
 * The format is deliberately the same shape as the cron specs and skills next
 * to it — YAML frontmatter, markdown body — because it is edited by hand in
 * the editor, and one more bespoke syntax is one more thing to get wrong at
 * two in the morning.
 *
 * ```markdown
 * ---
 * name: gemma
 * match:
 *   family: [gemma*]
 * ---
 *
 * # system
 * You are Cline...
 *
 * # tool: editor
 * Write a file. Use this instead of shell redirection...
 * ```
 *
 * Like the cron parser, this never throws for a bad file: it returns an error
 * string so the loader can show which template is broken and carry on with the
 * others, rather than a session failing to start because of a stray colon.
 */

export interface PromptTemplateParseInput {
	raw: string;
	source: PromptTemplateSource;
	/** Used for the template name when the frontmatter omits one. */
	fileName: string;
	filePath?: string;
	/**
	 * Tool names this session has, so a section naming something else can be
	 * reported. Omitted by callers that only want to read the file.
	 */
	knownToolNames?: readonly string[];
}

export type PromptTemplateParseResult =
	| {
			template: PromptTemplate;
			error?: undefined;
			/**
			 * Non-fatal problems: a mistyped placeholder, a missing one, a
			 * section for a tool that does not exist. The template still loads —
			 * these are things a person editing it needs told, not reasons to
			 * refuse the file.
			 */
			warnings: PromptTemplateWarning[];
	  }
	| { template?: undefined; error: string; warnings?: undefined };

/** `# tool: <name>` or `# system`, at the start of a line. */
const SECTION_HEADING = /^#[ \t]+(system|tool:[ \t]*([A-Za-z0-9_.-]+))[ \t]*$/;

function normalizePatternList(
	value: unknown,
	field: string,
): string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	// A single string is the common case by hand — `family: gemma*` — and
	// rejecting it would be pedantry.
	const list = Array.isArray(value) ? value : [value];
	const patterns: string[] = [];
	for (const entry of list) {
		if (typeof entry !== "string") {
			throw new Error(`match.${field} must be a string or a list of strings`);
		}
		const trimmed = entry.trim();
		if (trimmed !== "") {
			patterns.push(trimmed);
		}
	}
	return patterns.length > 0 ? patterns : undefined;
}

function parseMatch(value: unknown): PromptTemplateMatch | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("match must be a mapping of provider / family / model");
	}
	const record = value as Record<string, unknown>;
	const known = new Set(["provider", "family", "model"]);
	for (const key of Object.keys(record)) {
		if (!known.has(key)) {
			// Silence here would look exactly like a rule that matches nothing.
			throw new Error(
				`match.${key} is not a thing to match on — use provider, family or model`,
			);
		}
	}
	return {
		provider: normalizePatternList(record.provider, "provider"),
		family: normalizePatternList(record.family, "family"),
		model: normalizePatternList(record.model, "model"),
	};
}

/**
 * Split the body into its `# system` and `# tool: <name>` sections.
 *
 * Text before the first heading is ignored rather than treated as the system
 * prompt: a file that opens with a paragraph of notes is far more likely than
 * one that means that paragraph to become the prompt.
 */
function parseSections(body: string): {
	system?: string;
	tools: Record<string, string>;
	unknownHeadings: string[];
	duplicateSections: string[];
} {
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	const tools: Record<string, string> = {};
	const unknownHeadings: string[] = [];
	// A repeated section is silently survivable — the last one simply wins —
	// which is exactly why it has to be reported. A model rewriting a template
	// emits a duplicate now and then, and the copy the author reads may not be
	// the copy that takes effect.
	const duplicateSections: string[] = [];
	let system: string | undefined;

	let current: { kind: "system" } | { kind: "tool"; name: string } | undefined;
	let buffer: string[] = [];

	const flush = () => {
		if (!current) {
			buffer = [];
			return;
		}
		const text = buffer.join("\n").trim();
		if (text !== "") {
			if (current.kind === "system") {
				if (system !== undefined) {
					duplicateSections.push("system");
				}
				system = text;
			} else {
				if (tools[current.name] !== undefined) {
					duplicateSections.push(`tool: ${current.name}`);
				}
				tools[current.name] = text;
			}
		}
		buffer = [];
	};

	for (const line of lines) {
		const heading = line.match(SECTION_HEADING);
		if (heading) {
			flush();
			current = heading[2]
				? { kind: "tool", name: heading[2] }
				: { kind: "system" };
			continue;
		}
		// Any other top-level heading ends the section and is reported, so a
		// typo like `# tools: editor` is visible instead of silently swallowed.
		if (/^#[ \t]+\S/.test(line)) {
			flush();
			current = undefined;
			unknownHeadings.push(line.trim());
			continue;
		}
		buffer.push(line);
	}
	flush();

	return { system, tools, unknownHeadings, duplicateSections };
}

export function parsePromptTemplate(
	input: PromptTemplateParseInput,
): PromptTemplateParseResult {
	const { frontmatter, body } = splitFrontmatter(input.raw);

	let meta: Record<string, unknown> = {};
	if (frontmatter !== undefined) {
		try {
			const parsed = YAML.parse(frontmatter);
			if (parsed !== null && parsed !== undefined) {
				if (typeof parsed !== "object" || Array.isArray(parsed)) {
					return { error: "frontmatter must be a mapping" };
				}
				meta = parsed as Record<string, unknown>;
			}
		} catch (error) {
			return {
				error: `frontmatter is not valid YAML: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	let match: PromptTemplateMatch | undefined;
	try {
		match = parseMatch(meta.match);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	const rawName = typeof meta.name === "string" ? meta.name.trim() : "";
	const name = rawName !== "" ? rawName : input.fileName.replace(/\.md$/i, "");
	if (name === "") {
		return {
			error: "template needs a name, in the frontmatter or the filename",
		};
	}

	const { system, tools, unknownHeadings, duplicateSections } =
		parseSections(body);
	if (system === undefined && Object.keys(tools).length === 0) {
		return {
			error:
				unknownHeadings.length > 0
					? `no '# system' or '# tool: <name>' section — found ${unknownHeadings
							.map((heading) => `'${heading}'`)
							.join(", ")}`
					: "no '# system' or '# tool: <name>' section",
		};
	}

	const template: PromptTemplate = {
		name,
		fileName: input.fileName,
		source: input.source,
		filePath: input.filePath,
		match,
		system,
		tools,
	};

	return {
		template,
		warnings: [
			...duplicateSections.map((section) => ({
				code: "duplicate-section" as const,
				section,
				message: `'${section}' appears more than once; only the last one takes effect.`,
			})),
			...validatePromptTemplate(template, {
				knownToolNames: input.knownToolNames,
			}),
		],
	};
}
