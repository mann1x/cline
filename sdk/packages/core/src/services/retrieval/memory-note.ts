/**
 * What a note is, besides its text: what kind of thing it says, whether the
 * user has settled it, where in the code it points, where it came from, and
 * what it said before.
 *
 * The model after claude-hooks' findings ledger (docs/PLAN-council-memory.md),
 * which is what stopped its critics re-ranking deliberate design as a defect
 * every run: a record that says what it is, who decided it and why, and what
 * the reader is to do with it. Here the kinds are a note's (fact, decision,
 * preference) and not a finding's.
 *
 * The model records; only the user settles. A note the model keeps is
 * `noted`. The user confirms it, or marks it outdated with a reason, in the
 * Memory panel; no tool the model has can do either. A note that changes is
 * revised in place, so its id keeps working, and what it said before is kept.
 *
 * Kept in the note's document metadata, so a store from before this reads
 * as notes of kind `fact`, status `noted`, with no places.
 */

/** What a note says: something that is so, something decided, or how the user wants it. */
export type MemoryKind = "fact" | "decision" | "preference";
export const MEMORY_KINDS: readonly MemoryKind[] = [
	"fact",
	"decision",
	"preference",
];

/**
 * Where a note stands. `noted` is how the model leaves it; `confirmed` and
 * `outdated` are the user's to set.
 */
export type MemoryStatus = "noted" | "confirmed" | "outdated";
export const MEMORY_STATUSES: readonly MemoryStatus[] = [
	"noted",
	"confirmed",
	"outdated",
];

/** A place in the code a note is about: a file, and a line when it names one. */
export interface MemoryPlace {
	path: string;
	line?: number;
	/** The line as it read when the note was kept, to tell later whether it moved. */
	text?: string;
}

/** Who kept a note. */
export interface MemoryOrigin {
	by: "model" | "user" | "import";
	/** The task it was kept in. */
	sessionId?: string;
}

/** One line of evidence for a note, appended when it was noted again. */
export interface MemoryEvidence {
	at: string;
	text: string;
}

/** What a note said before it was revised. */
export interface MemoryRevision {
	at: string;
	text: string;
}

/** The user's verdict on a note. */
export interface MemorySettlement {
	at: string;
	reason?: string;
}

/** How often and how lately a note was given to a task. */
export interface MemoryUse {
	count: number;
	last: string;
}

/** Everything about a note but its text, as kept in its metadata. */
export interface MemoryNoteFields {
	kind: MemoryKind;
	status: MemoryStatus;
	/** Why: a decision's reason. */
	reason?: string;
	places: MemoryPlace[];
	origin?: MemoryOrigin;
	evidence: MemoryEvidence[];
	history: MemoryRevision[];
	settled?: MemorySettlement;
	/** Notes folded into this one, by id: a reference to one of them reaches this note. */
	merged: string[];
	recalled?: MemoryUse;
	/** When it was last revised. */
	revisedAt?: string;
	/** When it expires; past it, it is distilled and removed. */
	expiresAt?: string;
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

function list<T>(value: unknown, read: (entry: unknown) => T | undefined): T[] {
	return Array.isArray(value)
		? value.flatMap((entry) => {
				const read_ = read(entry);
				return read_ === undefined ? [] : [read_];
			})
		: [];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function dated(entry: unknown): { at: string; text: string } | undefined {
	const held = record(entry);
	const at = text(held?.at);
	const said = text(held?.text);
	return at && said ? { at, text: said } : undefined;
}

function place(entry: unknown): MemoryPlace | undefined {
	const held = record(entry);
	const path = text(held?.path);
	if (!path) return undefined;
	const line = Number(held?.line);
	const said = typeof held?.text === "string" ? held.text : undefined;
	return {
		path,
		...(Number.isInteger(line) && line > 0 ? { line } : {}),
		...(said !== undefined ? { text: said } : {}),
	};
}

/** A note's fields from its metadata, whatever shape they were kept in. */
export function readNoteFields(
	metadata: Record<string, unknown>,
): MemoryNoteFields {
	const kind = MEMORY_KINDS.includes(metadata.kind as MemoryKind)
		? (metadata.kind as MemoryKind)
		: "fact";
	const status = MEMORY_STATUSES.includes(metadata.status as MemoryStatus)
		? (metadata.status as MemoryStatus)
		: "noted";
	const origin = record(metadata.origin);
	const by = origin?.by;
	const settled = record(metadata.settled);
	const recalled = record(metadata.recalled);
	return {
		kind,
		status,
		...(text(metadata.reason) ? { reason: text(metadata.reason) } : {}),
		places: list(metadata.places, place),
		...(by === "model" || by === "user" || by === "import"
			? {
					origin: {
						by,
						...(text(origin?.sessionId)
							? { sessionId: text(origin?.sessionId) }
							: {}),
					},
				}
			: {}),
		evidence: list(metadata.evidence, dated),
		history: list(metadata.history, dated),
		...(settled && text(settled.at)
			? {
					settled: {
						at: text(settled.at) as string,
						...(text(settled.reason) ? { reason: text(settled.reason) } : {}),
					},
				}
			: {}),
		merged: list(metadata.merged, (entry) =>
			typeof entry === "string" && /^m\d+$/.test(entry) ? entry : undefined,
		),
		...(recalled && Number(recalled.count) > 0 && text(recalled.last)
			? {
					recalled: {
						count: Math.floor(Number(recalled.count)),
						last: text(recalled.last) as string,
					},
				}
			: {}),
		...(text(metadata.revisedAt)
			? { revisedAt: text(metadata.revisedAt) }
			: {}),
		...(text(metadata.expiresAt)
			? { expiresAt: text(metadata.expiresAt) }
			: {}),
	};
}

/**
 * `src/net/backoff.ts:148`, `src/net/backoff.ts`, `backoff.ts:148-160` --
 * as a place. A range keeps its first line. Undefined for what is not a path.
 */
export function parsePlace(value: string): MemoryPlace | undefined {
	const match =
		/^\s*`?([^\s`:]+?\.[A-Za-z0-9]{1,8}|[^\s`:]*\/[^\s`:]+)(?::(\d+)(?:-\d+)?)?`?\s*$/.exec(
			value,
		);
	if (!match) return undefined;
	const line = match[2] ? Number(match[2]) : undefined;
	return {
		path: match[1].replace(/^\.\//, ""),
		...(line && line > 0 ? { line } : {}),
	};
}

/** `path:line`, or the path alone. */
export function formatPlace(place: MemoryPlace): string {
	return place.line ? `${place.path}:${place.line}` : place.path;
}

/**
 * What the reading model is to do with a note, by what it is and where it
 * stands: the line that stopped claude-hooks' critics re-ranking deliberate
 * design every run, here for notes.
 */
export function readingRule(fields: MemoryNoteFields): string {
	if (fields.status === "outdated") {
		return `The user marked it outdated${fields.settled?.reason ? `: ${fields.settled.reason}` : ""}. Do not rely on it.`;
	}
	const confirmed =
		fields.status === "confirmed"
			? ` Confirmed by the user${fields.settled?.at ? ` on ${fields.settled.at.slice(0, 10)}` : ""}${fields.settled?.reason ? `: ${fields.settled.reason}` : ""}.`
			: "";
	switch (fields.kind) {
		case "decision":
			return `A decision${fields.reason ? `, because ${fields.reason}` : ""}. Do not reopen it unless something now contradicts that reason.${confirmed}`;
		case "preference":
			return `How the user wants it. Follow it unless the user says otherwise.${confirmed}`;
		default:
			return fields.status === "confirmed"
				? `A fact.${confirmed}`
				: "A fact as noted then: check it still holds before relying on it.";
	}
}

/**
 * How much a note's past use moves it in a ranking, from claude-hooks
 * decay.py: recalled lately counts for more and fades with a half-life
 * toward a half; recalled once or twice is a note that was useful (a
 * little more), and recalled at every turn is one that comes up whatever
 * is asked (less). A note never recalled is neutral.
 */
export const RECALL_HALF_LIFE_DAYS = 14;
export const RECALL_FREQUENCY_CAP = 5;

export function useWeight(
	use: MemoryUse | undefined,
	nowMs: number = Date.now(),
): number {
	if (!use) return 1;
	const last = Date.parse(use.last);
	const days = Number.isFinite(last)
		? Math.max(0, (nowMs - last) / 86_400_000)
		: 0;
	const recency =
		0.5 + 0.5 * Math.exp((-Math.LN2 * days) / RECALL_HALF_LIFE_DAYS);
	let frequency = 1;
	if (use.count <= 0) frequency = 1;
	else if (use.count <= 2) frequency = 1.1;
	else if (use.count >= RECALL_FREQUENCY_CAP) frequency = 0.6;
	else frequency = 1.1 - (0.5 * (use.count - 2)) / (RECALL_FREQUENCY_CAP - 2);
	return recency * frequency;
}

/** What became of a note's place, as `Memory.checkPlaces` found it. */
export interface DescribedPlaceCheck {
	place: MemoryPlace;
	state: "ok" | "moved" | "changed" | "missing" | "ambiguous";
	line?: number;
}

/** A note as the model reads it: the head line, the text, what to do with it, and what became of its places. */
export function describeNote(
	item: {
		id: string;
		memory: string;
		tags: string[];
		createdAt: string;
		text: string;
		relevance?: number;
	} & Partial<MemoryNoteFields>,
	options: { checks?: readonly DescribedPlaceCheck[]; extra?: string } = {},
): string {
	const fields = readNoteFields({
		kind: item.kind,
		status: item.status,
		reason: item.reason,
		settled: item.settled,
	});
	const head = [
		`[${item.id}] ${item.createdAt.slice(0, 10)}`,
		item.memory,
		...(fields.kind !== "fact" ? [fields.kind] : []),
		...(fields.status !== "noted" ? [fields.status] : []),
		...(item.tags.length ? [`tags: ${item.tags.join(", ")}`] : []),
		...(item.places?.length
			? [`at ${item.places.slice(0, 3).map(formatPlace).join(", ")}`]
			: []),
		...(item.revisedAt ? [`revised ${item.revisedAt.slice(0, 10)}`] : []),
		...(item.relevance !== undefined
			? [`relevance ${item.relevance.toFixed(2)}`]
			: []),
		...(options.extra ? [options.extra] : []),
	].join(", ");
	const changed = (options.checks ?? []).filter(
		(check) => check.state !== "ok",
	);
	return [
		head,
		item.text,
		`(${readingRule(fields)})`,
		...(changed.length > 0
			? [
					`(Since it was noted: ${changed
						.map((check) => {
							const at = formatPlace(check.place);
							switch (check.state) {
								case "moved":
									return `${at} is now line ${check.line}`;
								case "changed":
									return `${at} changed`;
								case "missing":
									return `${check.place.path} is gone`;
								default:
									return `${check.place.path} matches more than one file`;
							}
						})
						.join("; ")}.)`,
				]
			: []),
	].join("\n");
}
