/**
 * One artifact for two jobs: what a swarm worker reports, and what compaction
 * writes.
 *
 * These were always going to be the same thing and the reference implementation
 * says so outright -- reuse the fan-out digest schema per compacted turn-span,
 * so a fan-out digest and a compaction summary read identically to the model.
 * The reason is concrete rather than tidy: a swarm round frequently returns
 * while the lead is already over its compaction watermark, and if the two are
 * different artifacts the round's result *adds* to the pressure it was spawned
 * to relieve. Sharing the form means the commit-back can be fed straight to
 * compaction instead.
 *
 * The sections are the ones `DEFAULT_COMPACTION_PROMPT` already names, because
 * that prompt is in production and its output is what has to keep parsing.
 *
 * **Free-form JSON in a fence, read tolerantly -- not a grammar.** This is the
 * reference implementation's own resolved decision and it is the right one: a
 * worker made to satisfy a schema spends its turn satisfying the schema. So the
 * parser takes a fenced block if there is one, the markdown headings if there
 * is not, and the prose itself if there is neither. A worker that breaks the
 * contract entirely is still represented, because the reducer cannot otherwise
 * tell "nothing to report" from "lost", and a silently absent worker is exactly
 * the failure this path exists to avoid.
 */

/** One heading, and the field behind it. */
export interface WorkDigestSection {
	heading: string;
	key: keyof WorkDigest;
	/** A single paragraph, or a list of lines. */
	list: boolean;
}

export interface WorkDigest {
	/** Who wrote it. Absent on the lead's own compaction note. */
	agent?: string;
	goal?: string;
	done?: readonly string[];
	inProgress?: readonly string[];
	ruledOut?: readonly string[];
	keyFacts?: readonly string[];
	next?: readonly string[];
	/**
	 * Everything that did not fit the form.
	 *
	 * A worker that wrote prose still reported; this is where that lands, and
	 * it is why nothing is ever dropped for being off-contract.
	 */
	notes?: string;
	/** What went wrong, when something did. */
	error?: string;
	/**
	 * The reasoning tail of a turn that produced no content.
	 *
	 * A worker that spends its whole budget thinking returns
	 * `finish_reason: "length"` with an empty content channel and a full
	 * reasoning one. In that case the chain of thought *is* the requested
	 * output, and discarding the turn discards the work -- so it is carried
	 * here rather than lost with the transcript when the pool is released.
	 */
	reasoning?: string;
}

/** The sections, in the order the compaction note writes them. */
export const WORK_DIGEST_SECTIONS: readonly WorkDigestSection[] = [
	{ heading: "Goal", key: "goal", list: false },
	{ heading: "Done", key: "done", list: true },
	{ heading: "In progress", key: "inProgress", list: true },
	{ heading: "Ruled out", key: "ruledOut", list: true },
	{ heading: "Key facts", key: "keyFacts", list: true },
	{ heading: "Next", key: "next", list: true },
];

/** JSON keys a worker might reasonably use for each field. */
const JSON_ALIASES: Readonly<Record<string, keyof WorkDigest>> = {
	goal: "goal",
	done: "done",
	completed: "done",
	in_progress: "inProgress",
	inprogress: "inProgress",
	ruled_out: "ruledOut",
	ruledout: "ruledOut",
	key_facts: "keyFacts",
	keyfacts: "keyFacts",
	facts: "keyFacts",
	next: "next",
	next_steps: "next",
	notes: "notes",
	error: "error",
	reasoning: "reasoning",
	agent: "agent",
};

const FENCE = /(?:^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1(?:\n|$)/;

function asLines(value: unknown): readonly string[] | undefined {
	if (Array.isArray(value)) {
		const lines = value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter((entry) => entry !== "");
		return lines.length > 0 ? lines : undefined;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed === "" ? undefined : [trimmed];
	}
	return undefined;
}

function asText(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed === "" ? undefined : trimmed;
	}
	const lines = asLines(value);
	return lines ? lines.join("\n") : undefined;
}

function fromJson(value: Record<string, unknown>): WorkDigest {
	const digest: Record<string, unknown> = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const key = JSON_ALIASES[rawKey.trim().toLowerCase()];
		if (!key) {
			continue;
		}
		const section = WORK_DIGEST_SECTIONS.find((entry) => entry.key === key);
		const converted =
			section?.list === true ? asLines(rawValue) : asText(rawValue);
		if (converted !== undefined) {
			digest[key] = converted;
		}
	}
	return digest as WorkDigest;
}

/** Strip a leading `- `, `* ` or `1. ` from a list line. */
function stripBullet(line: string): string {
	return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
}

function fromMarkdown(text: string): WorkDigest {
	const digest: Record<string, unknown> = {};
	// Split on any level of heading, so a worker writing `# Goal` or `### Goal`
	// is read the same as the `## Goal` the prompt asks for.
	const parts = text.split(/\n(?=#{1,6}\s)/);
	for (const part of parts) {
		const match = part.match(/^#{1,6}\s+(.+?)\s*\n([\s\S]*)$/);
		if (!match) {
			continue;
		}
		const heading = (match[1] ?? "").trim().toLowerCase();
		const section = WORK_DIGEST_SECTIONS.find(
			(entry) => entry.heading.toLowerCase() === heading,
		);
		if (!section) {
			continue;
		}
		const body = (match[2] ?? "").trim();
		if (body === "") {
			continue;
		}
		if (section.list) {
			const lines = body
				.split("\n")
				.map(stripBullet)
				.filter((line) => line !== "");
			if (lines.length > 0) {
				digest[section.key] = lines;
			}
		} else {
			digest[section.key] = body;
		}
	}
	return digest as WorkDigest;
}

function isEmptyDigest(digest: WorkDigest): boolean {
	return Object.values(digest).every(
		(value) =>
			value === undefined || (Array.isArray(value) && value.length === 0),
	);
}

/**
 * Read whatever a worker wrote into a digest.
 *
 * Three readings in order -- a fenced block, the markdown headings, then the
 * prose -- and the last one never fails, which is the point: an off-contract
 * worker is reported as itself rather than as an absence.
 */
export function parseWorkDigest(
	text: string | undefined,
): WorkDigest | undefined {
	const trimmed = text?.trim();
	if (!trimmed) {
		return undefined;
	}
	const fence = FENCE.exec(`\n${trimmed}`);
	if (fence?.[2]) {
		try {
			const parsed: unknown = JSON.parse(fence[2]);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const digest = fromJson(parsed as Record<string, unknown>);
				if (!isEmptyDigest(digest)) {
					return digest;
				}
			}
		} catch {
			// Not JSON. The prose fallback below still reports the worker.
		}
	}
	const markdown = fromMarkdown(trimmed);
	if (!isEmptyDigest(markdown)) {
		return markdown;
	}
	return { notes: trimmed };
}

function renderList(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

/**
 * Write a digest in the form the compaction note uses.
 *
 * Empty sections are omitted rather than written blank: a heading with nothing
 * under it reads to the model as "this was considered and there is nothing",
 * which is a claim, and one the worker did not make.
 */
export function renderWorkDigest(digest: WorkDigest): string {
	const parts: string[] = [];
	if (digest.agent) {
		parts.push(`## Agent\n${digest.agent}`);
	}
	if (digest.error) {
		parts.push(`## Error\n${digest.error}`);
	}
	for (const section of WORK_DIGEST_SECTIONS) {
		const value = digest[section.key];
		if (value === undefined) {
			continue;
		}
		if (section.list) {
			const lines = value as readonly string[];
			if (lines.length === 0) {
				continue;
			}
			parts.push(`## ${section.heading}\n${renderList(lines)}`);
		} else {
			parts.push(`## ${section.heading}\n${String(value)}`);
		}
	}
	if (digest.notes) {
		parts.push(`## Notes\n${digest.notes}`);
	}
	if (digest.reasoning) {
		// Named for what it is. A reader that mistook a reasoning tail for a
		// finished report would act on a conclusion the worker never reached.
		parts.push(
			`## Reasoning (recovered; this worker produced no answer)\n${digest.reasoning}`,
		);
	}
	return parts.join("\n\n");
}

/** `w1, w2: line` -- who said it, kept, because it is often the point. */
function attribute(agents: readonly string[], line: string): string {
	const named = agents.filter((agent) => agent !== "");
	return named.length > 0 ? `${named.join(", ")}: ${line}` : line;
}

/**
 * Fold several workers' digests into one.
 *
 * This is what the reducer does without a model, and what it falls back to when
 * the model call fails. A single digest passes through untouched: with one
 * worker there is nothing to reduce, and a model call there spends a round trip
 * rewriting the answer it was given.
 *
 * Two workers on one prefix reach the same conclusion often, so an identical
 * line is said once with both names on it -- repeating it makes the round look
 * like twice the work it was.
 */
export function mergeWorkDigests(digests: readonly WorkDigest[]): WorkDigest {
	if (digests.length === 0) {
		return {};
	}
	if (digests.length === 1) {
		return digests[0] as WorkDigest;
	}
	const merged: Record<string, unknown> = {};
	for (const section of WORK_DIGEST_SECTIONS) {
		if (!section.list) {
			const first = digests.find((digest) => digest[section.key] !== undefined);
			if (first) {
				merged[section.key] = first[section.key];
			}
			continue;
		}
		// Insertion-ordered, so the output reads in the order the workers were
		// spawned rather than in whatever order they happened to finish.
		const byLine = new Map<string, string[]>();
		for (const digest of digests) {
			const lines = (digest[section.key] as readonly string[]) ?? [];
			for (const line of lines) {
				const agents = byLine.get(line) ?? [];
				agents.push(digest.agent ?? "");
				byLine.set(line, agents);
			}
		}
		if (byLine.size > 0) {
			merged[section.key] = [...byLine].map(([line, agents]) =>
				attribute(agents, line),
			);
		}
	}
	// A worker that reported nothing usable is named here rather than dropped.
	// The lead cannot tell an empty round from a lost one otherwise.
	const notes: string[] = [];
	for (const digest of digests) {
		const who = digest.agent ?? "an agent";
		if (digest.error) {
			notes.push(`${who}: ${digest.error}`);
		}
		if (digest.notes) {
			notes.push(`${who}: ${digest.notes}`);
		}
		if (digest.reasoning) {
			notes.push(
				`${who} produced no answer; its reasoning said: ${digest.reasoning}`,
			);
		}
	}
	if (notes.length > 0) {
		merged.notes = notes.join("\n");
	}
	return merged as WorkDigest;
}
