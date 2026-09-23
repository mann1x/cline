/**
 * Regenerate individual `# tool:` sections instead of a whole template.
 *
 * Adding one tool used to mean a full-file rewrite of all ten shipped
 * templates: ten model calls, ten files where every section could drift, and a
 * diff in which the one section anyone wanted to read was buried. The cost is
 * not the model time — it is that a full rewrite puts every *other* section at
 * risk to add one, so a routine addition becomes a review of thirty sections
 * per file.
 *
 * So the unit of work here is the section. The model is asked for the named
 * sections and nothing else, and the result is spliced into the file it came
 * from: every byte outside those sections is carried through unchanged, which
 * a diff then proves.
 *
 * The audit is deliberately NOT relaxed to match. A delta is spliced first and
 * audited second, as a complete file — so "every tool has a section" and every
 * other whole-file guarantee still has to hold at the end. A partial answer is
 * a smaller thing to ask for, not a smaller thing to check.
 */

/** The heading grammar, identical to the parser's. Kept in step by a test. */
const SECTION_HEADING =
	/^#[ \t]+(system|tool:[ \t]*([A-Za-z0-9_.-]+)|compaction:[ \t]*[A-Za-z0-9_-]+)[ \t]*$/;

export interface TemplateSection {
	/** The heading line verbatim, or "" for the frontmatter and preamble. */
	heading: string;
	/** The tool this section is for, when the heading names one. */
	name?: string;
	/** Everything under the heading, trailing whitespace trimmed. */
	body: string;
	/**
	 * Newlines between the end of this section's text and the next heading.
	 *
	 * Not always 2. `kimi-k3.md` runs `{{DEFAULT}}` straight into the next
	 * `# tool:` heading with no blank line between them, in two places. Writing
	 * a uniform blank line back would edit two lines of a file nobody asked to
	 * touch — which is exactly the churn a section rewrite exists to avoid, so
	 * the separator is carried through rather than assumed.
	 */
	gapAfter?: number;
}

/**
 * Split a template into its sections, preserving order and everything else.
 *
 * The template parser gives back the sections' *text* but not the order they
 * were written in, nor the frontmatter, nor a heading it does not recognise.
 * All three have to survive a splice, so this walks the lines instead. The
 * preamble — frontmatter plus any note above the first heading — comes back as
 * a single leading section with an empty heading.
 */
export function splitTemplateSections(raw: string): TemplateSection[] {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const sections: TemplateSection[] = [];
	const preamble: string[] = [];
	let heading = "";
	let name: string | undefined;
	let body: string[] = [];
	let started = false;

	const flush = () => {
		if (!started) {
			return;
		}
		const joined = body.join("\n");
		const trimmed = joined.replace(/\s+$/, "");
		// The newline that ended the last body line was consumed as the split
		// separator, so it is not in the tail and has to be added back.
		const tail = joined.slice(trimmed.length);
		sections.push({
			heading,
			...(name === undefined ? {} : { name }),
			body: trimmed,
			gapAfter: (tail.match(/\n/g)?.length ?? 0) + 1,
		});
	};

	for (const line of lines) {
		const match = line.match(SECTION_HEADING);
		if (match) {
			flush();
			started = true;
			heading = line;
			name = match[2];
			body = [];
			continue;
		}
		if (!started) {
			preamble.push(line);
			continue;
		}
		body.push(line);
	}
	flush();

	if (preamble.length > 0) {
		const joined = preamble.join("\n");
		const trimmed = joined.replace(/\s+$/, "");
		const tail = joined.slice(trimmed.length);
		sections.unshift({
			heading: "",
			body: trimmed,
			gapAfter: (tail.match(/\n/g)?.length ?? 0) + 1,
		});
	}
	return sections;
}

/** Reassemble what {@link splitTemplateSections} produced. */
export function joinTemplateSections(
	sections: readonly TemplateSection[],
): string {
	let out = "";
	sections.forEach((section, index) => {
		out +=
			section.heading === ""
				? section.body
				: `${section.heading}\n${section.body}`;
		if (index < sections.length - 1) {
			// Two newlines — one blank line — is the convention everywhere except
			// the handful of places noted on `gapAfter`.
			out += "\n".repeat(Math.max(1, section.gapAfter ?? 2));
		}
	});
	return `${out.replace(/\s+$/, "")}\n`;
}

export interface SpliceToolSectionsResult {
	/** The whole file, with only the named sections changed. */
	template: string;
	/** Sections that existed and were rewritten. */
	replaced: string[];
	/** Sections that did not exist and were appended. */
	added: string[];
	/** Names asked for that the reply never supplied. */
	missing: string[];
}

/**
 * Put a supplied body under its heading the way the file already does it.
 *
 * Every shipped template writes `# tool: x`, a blank line, then the text. A
 * model's reply has no such blank line, so splicing it raw produced one section
 * that hugged its heading while its thirty siblings did not — a cosmetic
 * difference, but one that shows up in a diff as the section having been
 * reformatted rather than rewritten. Idempotent: a body that already carries
 * the blank line is unchanged, which is what keeps the round trip byte-exact.
 */
function normalizeSectionBody(body: string): string {
	return `\n${body.replace(/^\n+/, "").replace(/\s+$/, "")}`;
}

/**
 * Put `sections` into `base`, changing nothing else.
 *
 * A tool the file already covers is rewritten in place, so its position in the
 * file — which is editorial, and which a reader relies on — does not move. A
 * tool it does not cover is appended, because there is no defensible place to
 * guess and the end is at least predictable.
 */
export function spliceToolSections(
	base: string,
	sections: ReadonlyMap<string, string>,
): SpliceToolSectionsResult {
	const parsed = splitTemplateSections(base);
	const replaced: string[] = [];
	const seen = new Set<string>();

	const next = parsed.map((section) => {
		if (section.name === undefined) {
			return section;
		}
		const body = sections.get(section.name);
		if (body === undefined) {
			return section;
		}
		seen.add(section.name);
		replaced.push(section.name);
		return { ...section, body: normalizeSectionBody(body) };
	});

	const added: string[] = [];
	for (const [name, body] of sections) {
		if (seen.has(name)) {
			continue;
		}
		added.push(name);
		next.push({
			heading: `# tool: ${name}`,
			name,
			body: normalizeSectionBody(body),
		});
	}

	return {
		template: joinTemplateSections(next),
		replaced,
		added,
		missing: [],
	};
}

/**
 * Pull `# tool:` sections out of a reply that is not a whole template.
 *
 * A delta reply has no frontmatter and no `# system`, so it cannot go through
 * the template parser — that would reject it for the very thing that makes it
 * a delta. Anything the model wrote above the first heading is dropped, which
 * is where a model puts "Here are the sections you asked for".
 *
 * `known` is the guard against a model inventing a tool: a section naming
 * something that is not a real tool is reported rather than spliced, because
 * splicing it would put a tool that does not exist into a shipped template.
 */
export function parseToolSectionsFromReply(
	reply: string,
	known: readonly string[],
): { sections: Map<string, string>; unknown: string[] } {
	const allowed = new Set(known);
	const sections = new Map<string, string>();
	const unknown: string[] = [];

	for (const section of splitTemplateSections(reply)) {
		if (section.name === undefined || section.body.trim() === "") {
			continue;
		}
		if (!allowed.has(section.name)) {
			unknown.push(section.name);
			continue;
		}
		sections.set(section.name, section.body);
	}
	return { sections, unknown };
}

export interface ToolSectionDeltaPromptArgs {
	/** The file being amended, shown so the rewrite matches its voice. */
	familyTemplate: string;
	/** `default.md`'s section for each tool: the text being rewritten. */
	defaultSections: ReadonlyMap<string, string>;
	/** The tools to write sections for. */
	tools: readonly string[];
	/** Real call shapes for those tools, rendered into the prompt. */
	signatureText?: string;
	modelId: string;
	family?: string;
}

/**
 * Ask for only the named sections.
 *
 * The instruction is blunt about the output shape because the failure that
 * matters is a model helpfully returning the whole template: that is not a
 * delta, and splicing it would silently revert every hand-made change in the
 * file. Asking twice — once in the rules, once in the closing line — is cheap
 * next to that.
 */
export function buildToolSectionDeltaPrompt(
	args: ToolSectionDeltaPromptArgs,
): string {
	const wanted = args.tools
		.map((name) => {
			const current = args.defaultSections.get(name);
			return current
				? `# tool: ${name}\n${current}`
				: `# tool: ${name}\n(no built-in description — write one from the tool's name and the call shape below.)`;
		})
		.join("\n\n");

	const list = args.tools.map((name) => `\`${name}\``).join(", ");
	const plural = args.tools.length === 1 ? "section" : "sections";

	return [
		"You are being shown the prompt Cline gives you when it uses you as a coding agent.",
		`You are ${args.modelId}${args.family ? ` (family ${args.family})` : ""}, and you are the intended reader of this text.`,
		"",
		`This template already exists and is in use. ${args.tools.length === 1 ? "One tool is" : `${args.tools.length} tools are`} being added to it or rewritten in it: ${list}.`,
		"",
		"== WHAT TO RETURN ==",
		"",
		`Return ONLY the ${plural} listed above, each under its own \`# tool: <name>\` heading, in the order given.`,
		"Do not return the frontmatter. Do not return the `# system` section. Do not return any other tool's section.",
		"Everything you leave out is kept exactly as it is, so leaving it out is how you protect it — returning the whole file would overwrite work that is not yours to change.",
		"",
		"== THE TEMPLATE YOU ARE AMENDING ==",
		"",
		"Match its voice, its level of detail, and the way it writes examples. A section that reads like it came from somewhere else is a worse section, even if it is accurate.",
		"",
		"```markdown",
		args.familyTemplate.trim(),
		"```",
		"",
		"== THE BUILT-IN TEXT FOR THE SECTIONS YOU ARE WRITING ==",
		"",
		"This is what the model is given today. Rewrite it into the form you would rather receive: keep every fact, drop nothing the tool can do, and say what its output means.",
		"",
		"```markdown",
		wanted,
		"```",
		...(args.signatureText
			? [
					"",
					"== THE REAL CALL SHAPES ==",
					"",
					"Every example you write is checked against these. An example the schema rejects is worse than no example.",
					"",
					args.signatureText,
				]
			: []),
		"",
		`Now write the ${plural}. Start your reply with \`# tool: ${args.tools[0]}\` and include nothing before it.`,
	].join("\n");
}
