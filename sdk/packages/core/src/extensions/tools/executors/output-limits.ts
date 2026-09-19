/**
 * Shared caps for how much tool output may enter the conversation. Every
 * character returned by an executor is re-sent to the model on each
 * subsequent request, so oversized outputs cost quadratically over the
 * remaining run. Limits are measured in characters (UTF-16 code units),
 * which tracks token cost more closely than bytes and is what JS strings
 * measure exactly. Executors enforce these caps; tool descriptions
 * reference them so the model pages or narrows instead of retrying.
 *
 * Truncation notices always live in the preserved head/tail of an entry,
 * never in the elided middle. Provider-request building may re-truncate
 * long strings with its own (possibly tighter) middle-cut backstop
 * (session/services/message-builder.ts); keeping the notices at the edges
 * means the recovery guidance survives that cut too.
 */

/** Max characters of command output kept; beyond this the middle is elided. */
export const MAX_COMMAND_OUTPUT_CHARS = 48_000;

export function truncateCommandOutput(
	text: string,
	options: { maxChars?: number; totalChars?: number } = {},
): string {
	const maxChars = options.maxChars ?? MAX_COMMAND_OUTPUT_CHARS;
	const totalChars = options.totalChars ?? text.length;
	if (text.length <= maxChars && totalChars <= maxChars) {
		return text;
	}

	const headLimit = Math.ceil(maxChars / 2);
	const tailLimit = Math.max(1, maxChars - headLimit);
	return (
		`${text.slice(0, headLimit)}\n` +
		`[... output truncated: ${totalChars} chars total. ` +
		"Refine the command (grep, head, tail) to view the elided middle ...]\n" +
		text.slice(-tailLimit)
	);
}

/** Max lines returned per file read when the range is larger or absent. */
export const MAX_READ_LINES = 2_000;

/** Max characters kept per line in file reads (defangs minified files). */
export const MAX_LINE_CHARS = 2_000;

/** Max characters returned per file read window. */
export const MAX_READ_OUTPUT_CHARS = 48_000;

/**
 * The size past which a file read is refused rather than truncated.
 *
 * Truncation is the wrong answer for a read. A capped read hands back part of
 * a file with a notice the model routinely ignores, and it then reasons about
 * the file it was given as though it were the file that exists -- editing
 * against line numbers it never saw. The cost is also permanent: a tool result
 * is re-sent on every subsequent request, so one oversized read is paid for by
 * the whole rest of the run, which is how a transcript reaches the compaction
 * trigger in twenty turns.
 *
 * Refusing costs one turn and produces the read the model should have made.
 * The message names `start_line`/`end_line`, points at grep, and says how many
 * lines *would* fit, because a refusal that does not say what to do instead is
 * just a failed call — and one that does not say how much is too much makes the
 * model guess, invariably downwards.
 *
 * 24,000 chars is roughly 6,000 tokens: about 9% of a 65,536-token window, or
 * an eighth of what is left of one after the fixed price. One read that size is
 * affordable; a habit of them is what compaction is for.
 *
 * It was 2,048 in 4.100.138, which is around fifty lines of ordinary source —
 * so a whole small file was refused, and the model answered the way the message
 * invited it to: by crawling the file in tiny windows. Reported the same day as
 * "a huge amount of small reads". The size to refuse is the one that costs a
 * meaningful share of the window for the rest of the run, not the one that is
 * larger than a screenful.
 */
export const MAX_READ_REFUSAL_CHARS = 24_000;

/** Max characters returned per search query; beyond this the middle is elided. */
export const MAX_SEARCH_OUTPUT_CHARS = 48_000;
