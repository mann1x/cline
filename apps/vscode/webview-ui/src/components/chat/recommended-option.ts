/**
 * The recommendation a model may attach to one of its `ask_question` options.
 *
 * Asked for after a run offered four options and no view: "when the model asks
 * the user and present options ... it should always have a recommended option.
 * can we nudge the model think about the recommended option and provide one if
 * pertinent?" A question that enumerates without deciding hands the work back.
 *
 * It travels as a suffix rather than a field because the options are a
 * `string[]` from the schema (`AskQuestionInputSchema`) through the executor and
 * the host to the button, and a new field would have to be added to each of
 * those and to the message payload — the shape of change this repo has measured
 * failing silently in three of eight places. A suffix also works on a model that
 * ignores a field it has never seen, and a model that marks nothing gets exactly
 * today's behaviour.
 *
 * **Exactly one, or none.** Marking every option is not a recommendation, so a
 * reply that marks more than one is read as marking nothing rather than as
 * recommending the first. That is the failure mode a lenient parse would invent.
 *
 * The reason for the pick belongs in the question text, where there is room for
 * a sentence; the button has room for a word.
 */

/** Written by the model, tolerant of case and a trailing period. */
const RECOMMENDED_SUFFIX = /\s*\((?:recommended|recommendation)\)\s*\.?\s*$/i

export interface OptionItem {
	/** Exactly as the model sent it, so it stays a stable React key. */
	readonly raw: string
	/** What the button shows, and what is sent back when it is clicked. */
	readonly label: string
	readonly recommended: boolean
}

/**
 * Splits the marker off the options.
 *
 * The label is what goes back to the model: the marker is presentation, and
 * echoing "(recommended)" into the answer would put a word in the user's mouth
 * that they did not choose.
 */
export function readOptionItems(options: readonly string[] | undefined): OptionItem[] {
	const parsed = (options ?? []).map((raw) => {
		const label = raw.replace(RECOMMENDED_SUFFIX, "").trim()
		// A bare "(recommended)" is a marker with nothing to mark. Left alone, it
		// would render as an empty button.
		const marked = label !== "" && label !== raw
		return { raw, label: label === "" ? raw : label, marked }
	})
	const markedCount = parsed.filter((item) => item.marked).length
	return parsed.map(({ raw, label, marked }) => ({
		raw,
		label,
		recommended: markedCount === 1 && marked,
	}))
}
