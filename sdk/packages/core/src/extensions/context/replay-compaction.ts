/**
 * Compaction for the strategy that keeps the last messages.
 *
 * The existing prompt asks for a hand-over note, and a note is the wrong
 * artifact here. When a recency tail is kept, the summary is **prepended to
 * messages that are still in the transcript** — the model reads it and then
 * reads its own last few turns. A note changes voice mid-stream: the model
 * goes from being told *about* a conversation, in the third person and the
 * past tense, straight into its own first-person turns. The seam is visible
 * and the model writes from the wrong side of it.
 *
 * So this prompt asks for a replay instead: the same voice as the messages it
 * will sit in front of, first person, in the order things happened. The model
 * is not reporting on a session, it is re-telling its own.
 *
 * Two things the replay must carry that a note gets away with omitting:
 *
 * - **The user's own words, verbatim.** A paraphrased instruction is the one
 *   loss that cannot be recovered from anywhere else — the files are on disk
 *   and the tool record is rebuilt by the harness, but what was asked exists
 *   only in the transcript being discarded.
 * - **Its tool calls, with what came back.** Trimmed, because a model asked to
 *   replay its work pastes whole file bodies back, which is precisely what
 *   compaction exists to remove arriving inside the thing meant to remove it.
 *   `trimReplayOverflow` is the backstop for when it does that anyway.
 *
 * The harness places the tool ledger between this replay and the retained
 * messages, so the model's own account and the measured one sit side by side
 * and any disagreement is visible rather than silent.
 */

/** The instruction, when the recency tail is kept. */
export const DEFAULT_REPLAY_COMPACTION_PROMPT = `Your transcript has grown too long and the earlier part of it is about to be discarded. Write the replay that takes its place.

Your replay will be **prepended directly to the messages that remain** — your own most recent turns, which are still there and which you will read immediately after this. Write it so that seam is invisible.

Write in the **first person**, in your own voice, in the same prose as the turns it sits in front of. You are not reporting on a session to someone else; you are re-telling your own, so that after the earlier messages are gone you still remember doing it. Past tense, in the order things happened.

Carry all of this:

- **What you were asked, verbatim.** Quote the instructions you were given word for word. Everything else here can be rebuilt from the files or from the record below your replay; what was asked exists nowhere else once these messages are gone.
- **What you did, in order**, with the tools you called and what they returned. Put each call in a fenced block tagged \`tool\`, with the invocation and its result:

\`\`\`tool
<tool name> <the arguments that mattered>
→ <what it returned>
\`\`\`

  **Trim these yourself.** Give the arguments that identify the call and the part of the result you acted on — never a whole file body, never a full command dump. If something was long, say what it was and how big: \`<412 lines>\`. The material is still on disk; repeating it here is the exact weight this replay exists to shed.
- **What came back wrong**, and what you did about it. A call that was refused or returned an error is the most important kind to keep — without it you will simply make it again.
- **What you concluded**, including anything you ruled out and why. An approach that failed, omitted here, is an approach you will try again.
- **Where you had got to** when the transcript was cut, and what you were about to do next.

Do not invent anything you are not sure of, and do not write instructions to yourself to rewrite or restore content that this replay does not itself contain — you would be reconstructing from memory something that is still on disk, and producing a worse version of it.`;

export interface ReplayBlockLimits {
	/** Longest a fenced block may be before the harness elides its middle. */
	maxBlockChars: number;
}

export const REPLAY_BLOCK_LIMITS: ReplayBlockLimits = {
	maxBlockChars: 1_200,
};

export interface TrimmedReplay {
	text: string;
	/** How many blocks the harness had to cut because the model did not. */
	trimmedBlocks: number;
}

/**
 * Cut the payloads the model was asked to trim and did not.
 *
 * Only fenced blocks are touched. A length rule that cannot tell a pasted file
 * from the prose around it would cut the summary itself, and the prose *is*
 * the artifact — a long replay of a long session is correct. So the prose is
 * never trimmed here however long it runs; the request budget is what bounds
 * that, and it bounds it by asking again rather than by silently deleting the
 * middle of a sentence.
 *
 * An unterminated fence is treated as running to the end of the text. A model
 * that exhausts its budget mid-block leaves one open, and the summary is still
 * the only record of that stretch — dropping it to punish the malformed fence
 * would discard the very thing being preserved.
 */
export function trimReplayOverflow(
	text: string,
	limits: Partial<ReplayBlockLimits> = {},
): TrimmedReplay {
	const max = limits.maxBlockChars ?? REPLAY_BLOCK_LIMITS.maxBlockChars;
	// Matches an opening fence with its optional tag, the body, and either a
	// closing fence or the end of the text.
	const fence =
		/^([ \t]*```[^\n]*\n)([\s\S]*?)(^[ \t]*```[ \t]*$|$(?![\s\S]))/gm;
	let trimmedBlocks = 0;
	const out = text.replace(
		fence,
		(whole, open: string, body: string, close: string) => {
			if (body.length <= max) {
				return whole;
			}
			trimmedBlocks += 1;
			const keep = Math.max(80, Math.floor(max / 2) - 40);
			const head = body.slice(0, keep).trimEnd();
			const tail = body.slice(-keep).trimStart();
			const dropped = body.length - head.length - tail.length;
			const middle = `\n… ${dropped} characters elided by the harness — this block was not trimmed, and the content is still on disk …\n`;
			const closing = close.trim() === "```" ? close : "\n```";
			return `${open}${head}${middle}${tail}\n${closing.replace(/^\n/, "")}`;
		},
	);
	return { text: out, trimmedBlocks };
}
