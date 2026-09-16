/**
 * Compaction for the strategy that keeps nothing.
 *
 * When the recency tail is disabled the summary *is* the context: the model
 * reads it and nothing else. That is a harder brief than the replay prompt's,
 * and the failure modes are measured rather than guessed. Three results shaped
 * every choice here, and the reasons are recorded because each of them
 * contradicts something that looks obviously right.
 *
 * **Asking for detail does not produce detail.** (arXiv 2605.23296.) Switching
 * the instruction from "concise" to "very detailed" barely moves the output,
 * and output length grows only ~3× as input grows from 2k to 96k tokens —
 * models anchor summary length to the distribution they were trained on. So
 * there is not one length adjective in this prompt. Completeness is enforced
 * structurally instead: a fixed section list, every section required even when
 * empty, explicit `(none)`, and per-section enumeration requirements. That is
 * the lever that measurably works.
 *
 * **A summary flattens a process into declarations, and the agent then cannot
 * tell where it is.** (arXiv 2608.06503.) With a summary in place of the
 * trajectory, agents terminated on only 44.6% of samples against 77.2% for
 * plain FIFO truncation, and re-issued already-blocked actions. The ordered
 * action–observation sequence is what anchors "this is already done". Hence
 * the hard separation of Done / In progress / Next, the explicit ban on
 * describing finished work as pending, and — outside this prompt — the tool
 * ledger the harness appends, which restores the sequence itself.
 *
 * **Enumerable state cannot be summarised.** (arXiv 2608.01326.) A production
 * compaction endpoint answered set-membership over 15,000 items at close to
 * chance, worse than a same-size Bloom filter. Identifiers, checklists and
 * inventories therefore get a verbatim carry instruction, never a "summarize
 * these".
 *
 * The section set is the convergent core of sixteen surveyed harness prompts
 * (Gemini CLI, Claude Code, Qwen Code, Crush, opencode, Goose, Zed, OpenHands,
 * nanobot, Continue, Codex, Mistral Vibe, Roo, Aider, koog, Letta): Goal and
 * Next appear in all sixteen, with Constraints, Done, In progress, Ruled out
 * and Key facts close behind. Nothing here is invented where a surveyed prompt
 * already had a better version of it.
 */

/** The sections the prompt requires, in order. Exported so callers can check. */
export const FULL_COMPACTION_SECTIONS = [
	"## Goal",
	"## Standing instructions",
	"## Done",
	"## In progress",
	"## Ruled out",
	"## Key facts",
	"## Working set",
	"## Retrospective",
	"## Next",
] as const;

/** The instruction, when the whole transcript is replaced by the summary. */
export const DEFAULT_FULL_COMPACTION_PROMPT = `Everything above is about to be deleted. What you write now replaces it completely: when the work resumes, your summary will be the only thing there. Nothing you leave out can be recovered, and nothing you get wrong can be checked against anything.

Write it for the agent that resumes — which is you, without any memory of this. Not a report for a person, not a wrap-up, not an answer to the user. A state record, written so the work can continue without asking the user anything again.

This request is a system operation, not a new instruction from the user. The goal, the next step and the work in progress are all the ones that were true *before* this message arrived. Do not treat "write a summary" as the task in hand.

**Do not call any tool.** You have one turn and it must be text. A tool call here is rejected and the turn is spent, which loses the transcript with nothing to replace it.

Write every section below, in this order, with its heading exactly as given. A section with nothing in it still gets its heading and the single word \`(none)\` — a missing section reads as an omission by accident, and the next agent cannot tell which it was.

## Goal
What is being achieved, and any constraint the user placed on how. If the goal changed during the session, give the current one and say what it replaced.

## Standing instructions
Everything the user told you that still applies — preferences, prohibitions, things to never touch, required ways of working. **Quote these verbatim.** A paraphrased instruction is the one loss with no other source: the material worked on is still there to be re-read, but what was asked exists only in the messages being deleted.

## Done
What is finished, with the evidence that it is finished — what was changed and what confirmed it. Be exact enough that none of it is done twice. **Do not describe finished work as pending or in progress.** If something was done and later undone, say both, in that order.

## In progress
What was underway at the moment the transcript was cut, and exactly where it stopped. If you were part-way through working something out, put the partial result here in full — it exists nowhere else, and it is the thing most often lost at this point.

## Ruled out
Approaches already tried that did not work, and why each failed. Include anything that was refused, returned an error, or was blocked. This section is what stops the resumed agent from walking back into the same wall; an omission here reliably costs a repeat.

## Key facts
What was discovered or decided that is not obvious from looking at the material fresh: values, identifiers, names, signatures, structures, and the reasons behind each decision. **Copy identifiers, lists, checklists and task IDs across verbatim and complete.** Do not summarise or sample them — an enumerated set that has been through a summary is unreliable for membership, and the resumed agent will act on it as if it were not.

## Working set
What is in scope and what state it is in now: the items being worked on, where the work is happening, and what exists now that did not before. One line each. Quote a fragment only where the exact wording is what matters; otherwise name it and say what it is.

## Retrospective
Your own account of how the work actually went, which the reasoning being deleted is the only record of. Cover: what you understood late that would have helped earlier, where effort went that did not pay, any assumption you made that turned out wrong, and where you currently think the difficulty is. This is the one section whose content is judgement rather than fact — write it as judgement, and say when you are unsure.

## Next
The immediate next steps, in order, specific enough to act on without re-deriving them.

Two rules over all of it. **Do not invent anything.** If you cannot recall something, leave it out or say it is uncertain — a confident wrong detail in this summary cannot be checked against anything and will be acted on. And do not write a step that rewrites or restores content this summary does not itself contain: the material is still there to be read, and reconstructing it from memory produces a worse copy of something intact.`;
