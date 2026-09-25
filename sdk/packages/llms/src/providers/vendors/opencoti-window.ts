/**
 * The refusal a conversation gets when opencoti cannot give it a window it can
 * use (PLANS §9c).
 *
 * Two shapes, one class:
 *
 * - **A resume** asked for exactly the window it was opened with -- its history
 *   no longer fits a smaller one -- and the server has less free. It is never
 *   retried and never negotiated down: the user is told, and chooses.
 * - **A new session** asked for its configured window, bounded below by the
 *   floor, and even the floor did not fit after the one wait it is allowed.
 *
 * It is thrown out of the provider's fetch rather than returned as a 429, so
 * that nothing between here and the user waits it out: the rate-limit
 * middleware retries every 429, and this one has already had its wait.
 *
 * **The message is the carrier.** By the time a failed turn reaches a host the
 * error object is gone and only its text is left, so the numbers ride in a
 * machine-readable tail that {@link parseOpencotiWindowUnavailable} reads back.
 * The prose avoids every phrase the overflow classifier keys on -- a refusal
 * read as "context window exceeded" would start a compaction, which cannot help
 * a server that is short of cells.
 */

export const OPENCOTI_WINDOW_UNAVAILABLE_CODE = "opencoti_window_unavailable";

export interface OpencotiWindowUnavailableDetails {
	/** The window this request asked for (`num_ctx`). */
	asked: number;
	/** The smallest window it would have accepted (`num_ctx_min`, or the ask). */
	floor: number;
	/** What the server said it could grant right now, when it said. */
	largestAdmissible?: number;
	/** A resumed conversation: it needed exactly `asked`, and never waits. */
	resume: boolean;
}

/** `262144` -> `256k`. Rounded, because the card is prose, not a ledger. */
export function formatWindowK(tokens: number): string {
	return `${Math.max(0, Math.round(tokens / 1024))}k`;
}

function describe(details: OpencotiWindowUnavailableDetails): string {
	const free =
		details.largestAdmissible !== undefined
			? `The server has ${formatWindowK(details.largestAdmissible)} free right now.`
			: "The server did not say how much it has free.";
	const lead = details.resume
		? `Can't resume this conversation. It was opened with a ${formatWindowK(details.asked)} window and needs the same to continue.`
		: `Can't open this conversation. It needs at least a ${formatWindowK(details.floor)} window (asked for ${formatWindowK(details.asked)}).`;
	const tail = [
		`asked=${details.asked}`,
		`floor=${details.floor}`,
		...(details.largestAdmissible !== undefined
			? [`largest=${details.largestAdmissible}`]
			: []),
		`resume=${details.resume}`,
	].join(" ");
	return `${lead} ${free} [${OPENCOTI_WINDOW_UNAVAILABLE_CODE} ${tail}]`;
}

export class OpencotiWindowUnavailableError extends Error {
	override readonly name = "OpencotiWindowUnavailableError";
	readonly asked: number;
	readonly floor: number;
	readonly largestAdmissible: number | undefined;
	readonly resume: boolean;

	constructor(details: OpencotiWindowUnavailableDetails) {
		super(describe(details));
		this.asked = details.asked;
		this.floor = details.floor;
		this.largestAdmissible = details.largestAdmissible;
		this.resume = details.resume;
	}

	get details(): OpencotiWindowUnavailableDetails {
		return {
			asked: this.asked,
			floor: this.floor,
			...(this.largestAdmissible !== undefined
				? { largestAdmissible: this.largestAdmissible }
				: {}),
			resume: this.resume,
		};
	}
}

const TAIL = new RegExp(`\\[${OPENCOTI_WINDOW_UNAVAILABLE_CODE}([^\\]]*)\\]`);

/**
 * Read the refusal back out of an error message, wherever it ended up.
 *
 * `undefined` for any message that is not one: a host branches on this to
 * render the card, so a false positive would put a "Can't resume" card on an
 * unrelated failure.
 */
export function parseOpencotiWindowUnavailable(
	message: string | undefined,
): OpencotiWindowUnavailableDetails | undefined {
	if (!message) {
		return undefined;
	}
	const match = TAIL.exec(message);
	if (!match) {
		return undefined;
	}
	const fields = new Map<string, string>();
	for (const pair of match[1].trim().split(/\s+/)) {
		const at = pair.indexOf("=");
		if (at > 0) {
			fields.set(pair.slice(0, at), pair.slice(at + 1));
		}
	}
	const count = (key: string): number | undefined => {
		const raw = fields.get(key);
		if (raw === undefined || !/^\d+$/.test(raw)) {
			return undefined;
		}
		return Number(raw);
	};
	const asked = count("asked");
	const floor = count("floor");
	if (asked === undefined || floor === undefined) {
		return undefined;
	}
	const largest = count("largest");
	return {
		asked,
		floor,
		...(largest !== undefined ? { largestAdmissible: largest } : {}),
		resume: fields.get("resume") === "true",
	};
}

/** Whether an error, or anything in its cause chain, is this refusal. */
export function isOpencotiWindowUnavailableError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current != null; depth++) {
		if (
			typeof current === "object" &&
			(current as { name?: unknown }).name === "OpencotiWindowUnavailableError"
		) {
			return true;
		}
		current =
			typeof current === "object"
				? (current as { cause?: unknown }).cause
				: undefined;
	}
	return false;
}
