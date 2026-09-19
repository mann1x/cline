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
 * will sit in front of, first person, **in the present tense**. The model is
 * not reporting on a session, it is re-telling its own.
 *
 * The tense is load-bearing and was wrong. A replay written in the past tense
 * reads as history -- "The user asked me to fix the collision", "the editor
 * then warned me the line numbers had shifted" -- and a model reading that in
 * front of its own live turns treats the facts as old and possibly stale. It
 * re-reads files it already knows, re-derives conclusions it already has, and
 * discounts a warning that is still in force. Reported from a 29-minute
 * pandorum run where the model kept working but stopped being efficient.
 *
 * Present tense makes the same sentences current: "The user is asking me",
 * "Let me start by", "the editor is warning me this change shifted the line
 * numbers by +11". Nothing about the content changes; only whether the model
 * reads it as the state of play or as a story about one.
 *
 * Asking was not enough on its own, and the two reasons it was not are both
 * in this file's history. The instruction was carried by a two-column table
 * whose left half printed the phrasings it forbade, and a pandorum summary
 * came back with that column nearly verbatim -- "I started by running the
 * diagnostic" against a row reading "I started by reading the file". A
 * negative exemplar is still an exemplar. And the prompt labelled five of its
 * own sections in the past tense -- "What you were asked", "What you did",
 * "Where you had got to" -- while demanding the present in its second
 * paragraph. What came back was a present-tense opening and closing around a
 * wholly past-tense body, which is the shape of a prompt disagreeing with
 * itself. Only the column that shows what to write is left, and the labels
 * are in the tense they ask for.
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

Write in the **first person, present tense**, in your own voice, in the same prose as the turns it sits in front of. You are not reporting on a session to someone else and you are not recounting something finished: you are picking the work back up, and everything in the replay is the situation as it stands right now.

Write **every step** as the step itself, then what came back. The opening of a
step is what you are about to do; the outcome is its own short sentence after
it. These are the shapes — reuse them:

- "The user is asking me to fix the collision."
- "Let me start by reading the file."
- "Let me read a large chunk of the file." — then what it showed.
- "Let me try reconstructing the script section. It failed: \`check_file\` reports an unterminated regular expression at line 274."
- "Now the editor is warning me this change shifted the line numbers by +11."
- "The file parses now, so what is left is the collision check."

This holds for the middle of the replay and not only its first and last
sentences. A step that opens by reporting itself has changed voice, and the
seam this replay exists to remove is back.

Written in the past tense the replay reads as history, and history is something you are entitled to doubt: you will re-read files you already know, re-derive what you have already settled, and treat a warning that is still in force as something that merely once happened. Written in the present it is the state of play, which is what it actually is. Every sentence, not only the first and the last.

Carry all of this:

- **What you are asked to do, verbatim.** Quote the instructions you have been given word for word. Everything else here can be rebuilt from the files or from the record below your replay; what was asked exists nowhere else once these messages are gone.
- **What you have done, in order**, with the tools you called and what they returned. Put each call in a fenced block tagged \`tool\`, with the invocation and its result:

\`\`\`tool
<tool name> <the arguments that mattered>
→ <what it returned>
\`\`\`

  **Trim these yourself.** Give the arguments that identify the call and the part of the result you acted on — never a whole file body, never a full command dump. If something was long, say what it was and how big: \`<412 lines>\`. The material is still on disk; repeating it here is the exact weight this replay exists to shed.
- **What is coming back wrong**, and what you are doing about it. A call that was refused or returned an error is the most important kind to keep — without it you will simply make it again.
- **What you have concluded**, including anything you have ruled out and why. An approach that failed, omitted here, is an approach you will try again.
- **Where you are now**, and what you are about to do next.

Do not invent anything you are not sure of. In particular, do not report a result you cannot see: a call whose output is not in front of you is a call whose outcome you do not know, and writing that it succeeded is the one error here that the next turn cannot recover from.

Do not write instructions to yourself to rewrite or restore content that this replay does not itself contain — you would be reconstructing from memory something that is still on disk, and producing a worse version of it.

Write the replay and stop. Do not continue the transcript that follows these instructions, and do not copy any part of it back: it is what you are replacing.`;

/**
 * Cut the transcript a summary copied back out of its own request.
 *
 * `buildSummaryRequest` ends with the literal line `Conversation:` followed by
 * the serialized transcript, and a model that has finished what it had to say
 * does not always stop -- it keeps the document going. Measured on pandorum
 * session 1789848400942_m8u3a: 8,925 of the stored summary's 13,846 characters
 * were the transcript copied straight back, and the copy was still running
 * when the output cap cut it off mid-string. Every guard missed it. The
 * overrun retry never fired because the whole thing was still under its token
 * budget; `trimReplayOverflow` only touches fenced blocks and the echo is not
 * fenced; and `ensureFilesSection` found the echoed `## Files` heading and so
 * left the harness's own file list off.
 *
 * The cut is keyed on `serializeMessage`'s own markers rather than on anything
 * about the prose, because those are strings the harness writes and a replay
 * has no reason to produce: the prompt asks for fenced `tool` blocks, not for
 * `[Bot tool calls]:` lines. Only `[Bot tool calls]:` and `[Tool result]:`
 * count -- `[User]:` and `[Bot]:` are plausible enough in ordinary prose that
 * cutting on them would risk discarding a good summary -- and a marker inside
 * a fenced block is left alone, since a faithful replay of a refused call may
 * legitimately quote the harness back.
 */
const ECHOED_TRANSCRIPT_MARKER =
	/^(?:Conversation:|Previous summary:|\[Bot tool calls\]:|\[Tool result\]:)/;

export interface CutTranscript {
	text: string;
	/** How much of the summary was the request, copied back. */
	cutChars: number;
}

export function cutEchoedTranscript(text: string): CutTranscript {
	const lines = text.split("\n");
	let inFence = false;
	let offset = 0;
	for (const line of lines) {
		if (/^[ \t]*```/.test(line)) {
			inFence = !inFence;
		} else if (!inFence && ECHOED_TRANSCRIPT_MARKER.test(line)) {
			const kept = text.slice(0, offset).trimEnd();
			return { text: kept, cutChars: text.length - kept.length };
		}
		offset += line.length + 1;
	}
	return { text, cutChars: 0 };
}

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
