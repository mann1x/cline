import { isPageOracle, type Oracle, type OracleVerdict } from "./oracle";
import { PLAN_TOOL_NAME } from "./plan-tool";
import { PROPOSE_CHECK_TOOL_NAME } from "./proposal";
import { RUN_CHECK_TOOL_NAME } from "./run-check-tool";

/**
 * How a transaction was judged, and by whom.
 *
 * `self-declared` is not a lesser flavour of the same thing and is never
 * presented as one. An oracle answers about the program; a model answers about
 * the edit it meant to make, and across the atomic campaign those disagreed
 * routinely — transactions that reported success and failed the oracle were
 * the normal case, because the model had fixed the error it was looking at and
 * not the one the program still had.
 *
 * `undeclared` is a third thing and the weakest of the three: nothing could
 * check the change and the model never said whether it worked. The files are
 * kept, because discarding real work over a sentence nobody wrote is the
 * failure this boundary exists to avoid -- but calling that `self-declared`
 * would report a judgement that was never made.
 */
export type TransactionVerdictSource =
	| "oracle"
	| "self-declared"
	| "undeclared";

export interface TransactionOutcome {
	/** One-based, in the order they were opened. */
	transaction: number;
	kept: boolean;
	source: TransactionVerdictSource;
	/** What the model said it would change, as it declared it. */
	plan?: string;
	/** What the model said about the change when it tried to end the turn. */
	account?: string;
	/** The oracle's output, or the model's own account when there was none. */
	evidence: string;
}

export interface ProtocolPromptInput {
	/** One-based number of the transaction about to open. */
	transaction: number;
	/** Hard limit on declared changes. Three, unless the host says otherwise. */
	maxChanges: number;
	/** Last transaction this task will get, so the model knows the budget. */
	maxTransactions: number;
	/** The check that will decide, when there is one. */
	oracle?: Oracle;
	/**
	 * Whether the model may name its own check, for a workspace with none.
	 *
	 * Only ever true where `oracle` is absent and there is a user to approve
	 * one: the alternative in that case is the model's own account of its work,
	 * which is the verdict every wrong outcome measured so far came from.
	 */
	canProposeCheck?: boolean;
	/**
	 * Whether the check this run adopted has yet to pass on any files at all.
	 *
	 * Changes what the record of earlier transactions is allowed to conclude.
	 */
	checkNeverPassed?: boolean;
	/** Whether the model may replace that check, this transaction, once. */
	canReplaceCheck?: boolean;
	/**
	 * Whether the check came from the host rather than from the model.
	 *
	 * A different situation from `checkNeverPassed`, which only ever describes
	 * a check the model proposed and may replace. This one cannot be replaced:
	 * the user named it, so a run that keeps failing it is not evidence against
	 * the check.
	 */
	hostSuppliedCheck?: boolean;
	/** What earlier transactions tried, in order. */
	history: readonly TransactionOutcome[];
}

/**
 * The rules, restated in full at the open of every transaction.
 *
 * Repeated rather than referred back to, the way the harness does it: a
 * transaction the model experiences as a continuation of a conversation still
 * has to be one it can see the rules of, and a rule that scrolled out of the
 * window is a rule that is not followed. The cost is a few hundred tokens per
 * transaction against a protocol that only works if it is understood.
 */
export function buildProtocolPrompt(input: ProtocolPromptInput): string {
	const label = `TX-${String(input.transaction).padStart(2, "0")}`;
	const lines: string[] = [
		"== CHANGE PROTOCOL ==",
		"",
		`You are working in transactions. This one is ${label} of at most ${input.maxTransactions}.`,
		"",
		// Said because a model inferred the opposite and acted on it. On
		// pandorum session 1789230811792_qnyfa the model reasoned "the user gave
		// us two tasks but second explicitly overrides the first", quoting a
		// precedence rule -- "If any earlier instructions conflict with a new
		// directive or policy in this prompt, use only what is stated now" --
		// that appears nowhere in this prompt or in the codebase. It invented
		// the clause, then obeyed its own invention: "we should just follow
		// change protocol for our turn actions". It also invented a first step
		// ("before you do ANYTHING ELSE run node check.js manifest.ts") naming a
		// file the task does not contain. Three turns later it had called no
		// tool at all and the run ended with the file untouched.
		//
		// A block that arrives late, in capitals, reads as a replacement unless
		// it says otherwise. So it says otherwise.
		"This adds to your instructions; it does not replace them. Everything you were already told still applies — which tools you have, how to call them, how to verify your work. What follows governs only how changes are grouped and judged.",
		"",
		// Discovery before planning, and in that order on the page.
		//
		// The plan instruction below asks WHERE for "the exact text you will
		// match on", which is knowledge that can only come from reading the
		// file. Stated first, it asks the model to produce precision it has not
		// yet earned -- and on the session above that is exactly what came back:
		// two changes declared against code never read, with invented line
		// numbers and an invented symptom name ("unregistered-resize-window-
		// shrink"). Its own reasoning admitted it a turn later: "I don't
		// actually know WHICH file/lines these changes should go into because my
		// discovery phase never happened yet and all this declaration was pure
		// speculation."
		//
		// The oracle block further down already says to run the check before
		// editing, but it is fourteen lines later and only present when there is
		// an oracle. This reaches every host, and it comes first.
		"Start by finding out what is actually wrong. Read the files involved and run the check before you plan anything: a plan written before you have read the code is a guess, and the WHERE below asks for text you have to have actually seen. Reading and running cost nothing from the budget below, so there is no reason to economise on them.",
		"",
		`Then state your plan as a numbered list of AT MOST ${input.maxChanges} changes. For each one give three things:`,
		"  WHERE - the function, or the exact text you will match on",
		"  WHAT  - the single concrete edit you will make there",
		"  WHY   - the specific symptom it removes",
		"",
		// A change is an edit, and that had to be said. Measured on pandorum
		// session 1789122866533_br1d0: the model spent one of its numbered
		// changes on "Run check_file then node run_game.js to verify fix passes
		// /"ok":true/", which edits nothing. Nothing in the protocol ruled it
		// out -- it asked for WHERE/WHAT/WHY and the model supplied three
		// plausible-looking answers -- and the budget is small enough that
		// spending one on a step the protocol already performs for it is a real
		// loss. Named rather than implied, because the implication did not land.
		`A change is an edit to a file: after it, the file is different. Running a check, reading a file, or verifying the result is none of those, and must not take a number — you will do plenty of all three, and they cost nothing from this budget. If an item's WHAT does not name text being replaced, inserted or deleted, it is not a change and does not belong in the list.`,
		"",
		"Then make exactly those changes, in that order, and nothing else. Do not fix anything you did not declare. Do not rewrite a whole function or a whole file: edit the smallest region that removes the symptom.",
		"",
		// The sentence above is about scope -- do not fix what you did not
		// declare -- but it reads as pacing, and models act on the reading.
		// Caught in v7-coder's own reasoning on pandorum 2026-09-12, weighing the
		// two and talking itself out of the right one: "Actually, I'll do them
		// one by one? No, the instructions say 'make exactly those changes, in
		// that order, and nothing else'. I can emit multiple editor calls."
		//
		// It had a point. "Make exactly those changes, in that order" is one
		// continuous instruction to execute a list, and nothing in it says to
		// stop in between. What says so is the check line below -- fourteen
		// lines later, and only present when there is an oracle. So the
		// batching reading came first and unconditionally, and the correction
		// came second and optionally.
		//
		// Said here, without naming the check, so it still reads on a host that
		// has none. `qwen.md` carried a louder version of the same contradiction
		// and was fixed separately; this is the half that reaches every model.
		"Make them one at a time, not as a batch: after each edit, confirm it did what you intended before you start the next. Six edits that fail together leave you six things to undo and no way to tell which one was wrong. This governs edits only — reads, searches and commands change nothing and can be sent together freely, as many at a time as you find useful.",
		"",
		// Stated as well as written, because a plan in prose is a plan nobody can
		// mark. Measured on session 1789139763721_ive21: eleven plan blocks, six
		// of them announcing a count that disagreed with their own list, and two
		// edits that landed and were then re-planned because nothing recorded
		// them. `plan` numbers the list and keeps the record across a discard.
		`Put the same list into \`${PLAN_TOOL_NAME}\` as well as into your reply, and mark each item \`done\` the moment its edit applies. It numbers them for you and hands the whole list back on every call, so you never have to remember what has already landed — and it survives a discarded transaction, which your own account of it does not.`,
		"",
	];

	if (input.oracle) {
		lines.push(
			isPageOracle(input.oracle)
				? `Run \`${RUN_CHECK_TOOL_NAME}\` to ${input.oracle.label} — before you edit anything, so you see the failure in its own words, and again after each change.`
				: `Run \`${input.oracle.label}\` and read what it says — before you edit anything, so you see the failure in its own words, and again after each change. \`${RUN_CHECK_TOOL_NAME}\` runs the same check if you would rather not retype it.`,
			"",
			`That check is what decides. It is run again when your turn ends, and ${describeOracleStandard(input.oracle)} — not your account of the change, and not the fact that the edit applied. ${describeOracleChoice(input.oracle)}`,
			"",
			// Measured on a run that spent five hours and 766 turns without
			// closing a transaction: it wrote 34 helper programs, made 95% of its
			// edits to those instead of to the file named in the task, and called
			// the check 18 times in the whole run -- none in the last ninety
			// minutes. Nothing else in the protocol forbade it, because nothing
			// it did was forbidden: it wrote the helpers with `editor` and ran
			// them with `run_commands`, both allowed. Only said where a check
			// exists to be substituted for, which is why it sits in this branch.
			"A program you write yourself is not that check and cannot take its place. A small helper to locate the fault is fine; running one in place of the check is not, because a program you wrote can only tell you what you already believe. If you have written more than one helper, or you are editing a helper rather than the file this task is about, stop and run the check.",
			"",
			`If it passes, ${label} is kept and the task is finished.`,
			"",
			`If it does not, every change in ${label} is discarded. The files go back to exactly what they were when ${label} opened, and you get a new transaction with a record of what this one tried. You will never be asked to undo an edit yourself — that is done for you, mechanically, before the next transaction starts.`,
		);
	} else if (input.canProposeCheck) {
		lines.push(
			`Nothing in this workspace can be run to check the change, so as it stands you are the check — and your own account of your work is the weakest evidence there is. Name a better one: call \`${PROPOSE_CHECK_TOOL_NAME}\` with the check that would show this task is done, and the user approves it or says what they want instead.`,
			"",
			"Propose it as soon as you know what you are fixing, before you make the change. What is approved judges every attempt for the rest of the run and cannot be changed afterwards, so name the thing that would fail right now and pass once the fix lands.",
			"",
			`Once it is approved, \`${RUN_CHECK_TOOL_NAME}\` runs it against the files as they stand, as often as you want. It settles nothing and rolls nothing back. Run it before you edit and after each change: a check you only meet at the end is one that can only throw the transaction away.`,
			"",
			// Same rule as the oracle branch, and needed here for a sharper
			// reason: the approved check is already the model's own program, so
			// "write a program to decide" is the move it has just been rewarded
			// for. What is ruled out is a *second* one, run instead of the
			// approved one, which is the substitution without the approval.
			`Once a check is approved it is the only one that counts. Another program you write is not it and cannot take its place — approval is what makes a check the standard, and a program you wrote afterwards can only tell you what you already believe. A small helper to locate the fault is fine; if you have written more than one, or you are editing a helper rather than the file this task is about, stop and run \`${RUN_CHECK_TOOL_NAME}\`.`,
			"",
			`If no check is agreed, say plainly when you are done whether the change achieved what was asked and how you know. Answering "yes" because the edit applied is not knowing. If you cannot tell, say that instead — ${label} is then discarded and you get another transaction rather than a change nobody verified.`,
		);
	} else {
		lines.push(
			"Nothing in this workspace can be run to check the change, so you are the check.",
			"",
			`When you are done, say plainly whether the change achieved what was asked, and how you know. Answering "yes" because the edit applied is not knowing. If you cannot tell, say that instead — ${label} is then discarded and you get another transaction rather than a change nobody verified.`,
			"",
			`If it worked, ${label} is kept. If it did not, every change in it is discarded and the files go back to exactly what they were when it opened.`,
		);
	}

	// Offered only where the check is the model's own and has never once
	// passed. Two runs in ten died frozen to a check that could not pass --
	// one keyed on a field no correct fix produces, one whose `node -e`
	// program was not valid JavaScript -- and the second worked that out and
	// proposed the right check twice, and was refused both times.
	if (input.canReplaceCheck) {
		lines.push(
			"",
			"== THE CHECK HAS NEVER PASSED ==",
			"",
			`The check this run adopted has judged every attempt so far and has not passed once, on any files. Usually that means the change is not landing. It can also mean the check is wrong — that it asks for something no correct fix would produce, or that it never ran properly in the first place.`,
			"",
			`Decide which. Read what the check actually reports, with \`${RUN_CHECK_TOOL_NAME}\`, and look at it as a program rather than as a verdict. If it is wrong, call \`${PROPOSE_CHECK_TOOL_NAME}\` once more with a replacement — this is the only chance to change it, and the replacement is held to the same standard: it must fail on the unmodified files. If the check is right and the change simply has not worked yet, say so and carry on fixing.`,
		);
	}

	lines.push(
		"",
		`${input.maxChanges} is a hard limit and not a target. One change that removes one symptom is a better transaction than ${input.maxChanges} that might.`,
	);

	if (input.history.length > 0) {
		lines.push(
			"",
			describeHistory(input.history, input.checkNeverPassed === true),
		);
		const stuck = input.hostSuppliedCheck
			? describeStuckHostCheck(input.history)
			: undefined;
		if (stuck) {
			lines.push("", stuck);
		}
		lines.push("", describePostMortemRequest(input.history.length));
	}

	return lines.join("\n");
}

/**
 * How many attempts a host check must judge and fail before it is worth saying
 * so. Three of six: two failures is an ordinary run, and firing at two would
 * spend the notice before there is a pattern to describe. Three leaves half the
 * budget to act on it.
 */
const STUCK_HOST_CHECK_AFTER = 3;

/**
 * Said when the user's own check has judged every attempt and passed none.
 *
 * `checkNeverPassed` next door cannot cover this: it reads `adopted`, which is
 * only set on the model-proposed path, so a host check that failed six times
 * out of six left the flag false and the model was told once per transaction
 * that "the previous reading of it was wrong" -- while the check had reported
 * the same string every time.
 *
 * What it does NOT say is that the check might be wrong. That is the right
 * thing to offer about a check the model proposed and can replace, and the
 * wrong thing here: the user wrote this one, it will not change, and a model
 * invited to doubt it argues with the task instead of doing it.
 *
 * Only the identical branch is emitted. Output that CHANGED between attempts
 * looks like evidence the edits are landing, and for a check that prints a
 * duration, a timestamp or a seed it would say that every single time --
 * telling a model its edits are working when nothing moved. Byte-identical
 * output cannot be wrong in that direction: if the check printed the same
 * thing twice, nothing on the path it takes changed.
 */
function describeStuckHostCheck(
	history: readonly TransactionOutcome[],
): string | undefined {
	if (history.length < STUCK_HOST_CHECK_AFTER) {
		return undefined;
	}
	if (
		!history.every((outcome) => !outcome.kept && outcome.source === "oracle")
	) {
		return undefined;
	}
	// How far back the identical output reaches. Counted from the end, because
	// what matters is the current streak, not whether it ever repeated.
	const last = history[history.length - 1].evidence.trim();
	if (!last) {
		return undefined;
	}
	let streak = 1;
	for (let i = history.length - 2; i >= 0; i--) {
		if (history[i].evidence.trim() !== last) {
			break;
		}
		streak += 1;
	}
	if (streak < 2) {
		return undefined;
	}
	const first = history[history.length - streak];
	const since = `TX-${String(first.transaction).padStart(2, "0")}`;
	return [
		`== THE CHECK HAS JUDGED ${history.length} ATTEMPTS AND PASSED NONE ==`,
		"",
		"This check is the gate to mark the task completed successfully. It was named for this task by the user and it will not change, so the question is not whether it is right. The question is what it has been telling you, which is not the same as what you have been reading it as.",
		"",
		`Its output has not changed since ${since} — the same text, byte for byte, across ${streak} attempts:`,
		"",
		last,
		"",
		"Nothing you have edited is on the path the check takes. Whatever the file looks like where you have been working, the failure it reports is raised somewhere your changes have not reached. Before editing anything else, find where that output actually comes from — read it as text, locate the thing it names, and confirm you are looking at the code that produces it.",
		"",
		"Say in one sentence where you now think it comes from. Then plan.",
	].join("\n");
}

/**
 * What to do with the wreckage of the last transaction before planning again.
 *
 * The record above says what was tried and what the check said about it. What
 * it cannot say is what the model learned, because nothing ever asked. Across
 * the JackDelta 9B session the accounts it carried forward were, verbatim: "I
 * cannot complete this task.", "Task cannot be completed — exhausted restore
 * slots (3/3)", and three more of the same. That is the record the next
 * transaction opened on, and a transaction that opens on five statements of
 * defeat re-derives defeat.
 *
 * So the retrospective is asked for rather than hoped for, and it is asked as
 * four specific questions. Not "reflect on the failure": a model given that
 * writes another apology. Each question has an answer that changes the next
 * plan, and the last one is the one nobody asks -- whether the check's own
 * output was read correctly, which is a different question from whether the
 * fix was right and the only one that can catch a diagnosis that was wrong
 * about what it was even looking at.
 */
function describePostMortemRequest(attempts: number): string {
	const those = attempts === 1 ? "that attempt" : "those attempts";
	return [
		"== BEFORE YOU PLAN, LOOK BACK ==",
		"",
		`Call \`${PLAN_TOOL_NAME}\` first. It answers WORKED, DID NOT and RE-USE for you, from what was actually recorded rather than from what you remember, and the plan you stated last time is still in it.`,
		"",
		`Then open this transaction with a short retrospective on ${those} — four lines, before the plan, in your reply where the user can see it:`,
		"",
		"  WORKED     - what you established that is still true. A symptom you located, a line you confirmed is fine, a reading of the file that held up. This survives the rollback even though the edits did not.",
		"  DID NOT    - which edit failed to move the check, and what the check said instead of what you expected.",
		"  RE-USE     - what you will carry into this attempt unchanged, so you do not spend the transaction rediscovering it.",
		'  DIFFERENT  - what you will do differently, named concretely. Not "be more careful".',
		"",
		// The retrospective displaced the plan rather than preceding it: from
		// TX-02 on, that session wrote "Retrospective & Plan" headings whose plan
		// half was one prose sentence inside DIFFERENT. Saying that DIFFERENT is
		// the plan, and that the plan is a tool call, is what closes the gap.
		`DIFFERENT is this transaction's plan. A retrospective on its own is not one — state the new list through \`${PLAN_TOOL_NAME}\` before your first edit, the way you did for the first transaction.`,
		"",
		"Then read the check's last output again as text rather than as a verdict. Does it name the thing you were fixing? If it names something else, the plan that follows should be about what it names, not about what you were working on when it said so.",
		"",
		"The files are back to their starting state, but what you learned is not. That is the only thing this transaction begins with that the last one did not.",
	].join("\n");
}

/**
 * What the command has to do for the transaction to be kept.
 *
 * Said explicitly when a pattern is set, because the two standards lead to
 * different work: a model told only "make it exit zero" against a check that
 * always exits zero has been told nothing at all.
 */
function describeOracleStandard(oracle: Oracle): string {
	// A check the harness runs itself has one standard and states it plainly:
	// the page loads, runs, and throws nothing. There is no exit code to
	// explain and no pattern to match.
	if (isPageOracle(oracle)) {
		return "the verdict is that the page loads, runs its frames and throws nothing";
	}
	return oracle.expect
		? `the verdict is that it finishes cleanly AND its output matches /${oracle.expect}/`
		: "its exit status is the verdict";
}

function describeOracleChoice(oracle: Oracle): string {
	return oracle.reason === "named for this task"
		? "It was named for this task, so it is the standard the change is held to."
		: `It was chosen because ${oracle.reason}.`;
}

/**
 * What the earlier transactions tried, carried into this one.
 *
 * The record is the only thing that makes a second attempt different from a
 * first. Without it a rolled-back transaction is indistinguishable from never
 * having happened, and the model re-derives the same plan from the same
 * starting file — measured on the harness before the record was added.
 */
function describeHistory(
	history: readonly TransactionOutcome[],
	checkNeverPassed: boolean,
): string {
	const lines = ["== WHAT EARLIER TRANSACTIONS TRIED =="];
	for (const outcome of history) {
		const label = `TX-${String(outcome.transaction).padStart(2, "0")}`;
		lines.push(
			"",
			`${label} — ${outcome.kept ? "kept" : "discarded"}${
				outcome.source === "self-declared"
					? " (no check available)"
					: outcome.source === "undeclared"
						? " (no check available, and you never said whether it worked)"
						: ""
			}`,
		);
		if (outcome.plan?.trim()) {
			lines.push("plan:", outcome.plan.trim());
		}
		if (outcome.account?.trim()) {
			lines.push("you said:", outcome.account.trim());
		}
		if (outcome.evidence.trim()) {
			lines.push("result:", outcome.evidence.trim());
		}
	}
	// "The previous reading was wrong" is the right thing to say about a check
	// that has ever passed, and the wrong thing about one that has not: it told
	// two runs, six times each, that the fault was their diagnosis when the
	// fault was the check they were frozen to.
	lines.push(
		"",
		checkNeverPassed
			? "Those changes are gone: the files are as they were before that transaction. Do not repeat a plan that has already been discarded. The check has not passed once across any of them, so either the same reading of the symptom keeps coming back wrong, or the check itself is not asking for what a fix would produce — the second is worth considering by now."
			: "Those changes are gone: the files are as they were before that transaction. Do not repeat a plan that has already been discarded — if the same symptom is still there, the previous reading of it was wrong.",
	);
	return lines.join("\n");
}

/**
 * What the model is told when it ends a transaction it never changed.
 *
 * Not the protocol rules again. The rules are already in the window — it read
 * them when the transaction opened and followed none of them — so restating
 * them buys another few hundred tokens of the same. What is new is that the
 * submission was empty, that it cost nothing, and how much budget is left.
 *
 * IT MUST NOT OFFER AN EXIT. The first version ended with "if you have run out
 * of ideas, say so plainly in one sentence and stop... it is not counted
 * against you". Measured on pandorum session 1789114968332_v7fsq
 * (JackDeltaCoder 9B, 4.100.92): the model took that offer on its first empty
 * attempt and closed the run, reporting that "all my edits failed to match any
 * lines" — which the transcript contradicts, since one edit had applied and it
 * had used `restore_file` six times to undo its own work. A model facing a task
 * it finds hard reads a sanctioned, unpenalised exit as permission, and a small
 * one takes it immediately.
 *
 * So this says the opposite: the budget is counted out loud, an empty
 * submission is named as an attempt that has not happened rather than a failed
 * one, and the next step is concrete. Stopping is still possible — nothing
 * here prevents it — but it is no longer suggested, and no longer described as
 * worth more than trying again.
 */
export function buildEmptyAttemptPrompt(input: {
	transaction: number;
	maxChanges: number;
	maxTransactions: number;
}): string {
	const label = `TX-${String(input.transaction).padStart(2, "0")}`;
	// `transaction` is the one that came back empty and is still open, so it
	// counts as available along with everything after it.
	const left = Math.max(1, input.maxTransactions - input.transaction + 1);
	const budget =
		left === 1
			? `${label} is the last transaction you have`
			: `you have ${left} left, counting this one: ${label} of ${input.maxTransactions}`;
	return [
		"== NOTHING WAS CHANGED ==",
		"",
		`You ended ${label} without editing a single file, so there was nothing to judge. The transaction was not spent, it is still open, and ${budget}.`,
		"",
		"Keep going. An empty submission is not a failed attempt — it is an attempt that has not happened yet, and nothing has been used up.",
		"",
		`State the plan as before — AT MOST ${input.maxChanges} changes, each with WHERE, WHAT and WHY — and then make it.`,
		"",
		"If your edits are being refused, the refusal says why, and it is worth more than another read: an `old_text` that disagrees with the line range you named is the usual cause, so send one or the other, not both. If you cannot see the defect, run the linter on the file and act on the line it names rather than reading the whole file again.",
	].join("\n");
}

/**
 * The line an empty submission ends on, for the user and for the log.
 *
 * Worth a line of its own precisely because it is not a verdict: no check ran,
 * nothing was put back, and a run where this happened reads — from the
 * transcript alone — like a transaction that quietly went missing.
 *
 * `continued` says which of the two things is about to happen: the transaction
 * is held open for another attempt, or it has come back empty often enough
 * that it is spent and closed like any other. Neither of them ends the run.
 */
export function describeEmptyAttempt(
	transaction: number,
	continued: boolean,
): string {
	const label = `TX-${String(transaction).padStart(2, "0")}`;
	return continued
		? `${label} was submitted with nothing changed, so it was not spent and is still open.`
		: `${label} was submitted with nothing changed again, so it is being spent and closed rather than held open, and the run carries on with whatever transactions are left.`;
}

/**
 * The line a transaction ends on, for the user and for the log.
 *
 * Says which of the two things happened to their files, because "discarded" is
 * the word that matters and it has to be unmissable.
 */
export function describeVerdict(
	transaction: number,
	kept: boolean,
	source: TransactionVerdictSource,
	verdict?: OracleVerdict,
	forced = false,
): string {
	const label = `TX-${String(transaction).padStart(2, "0")}`;
	if (kept) {
		if (source === "oracle") {
			return `${label} kept — the check passed.`;
		}
		if (source === "self-declared") {
			return `${label} kept — self-declared, nothing here could check it.`;
		}
		// Nothing judged this. Saying so is the whole point: a line reading
		// "self-declared" over a change the model never spoke about sends the
		// user looking through the transcript for a claim that is not there.
		return forced
			? `${label} kept but UNVERIFIED — the run was cut short before you said whether the change worked, and nothing here could check it. The changes are on disk; check them before relying on them.`
			: `${label} kept but UNVERIFIED — nothing here could check the change and it was never stated to work. The changes are on disk; check them before relying on them.`;
	}
	if (source === "self-declared" || source === "undeclared") {
		return `${label} discarded — the change was not verified. Your files are back as they were.`;
	}
	if (verdict?.timedOut) {
		return `${label} discarded — the check did not finish. Your files are back as they were.`;
	}
	// Named apart from a crash: "it ran and reported a problem" reads nothing
	// like "it fell over", and the model's next move differs between the two.
	if (verdict?.unmatched) {
		return `${label} discarded — the check ran, and what it reported is not what this task counts as working. Your files are back as they were.`;
	}
	// A check that can say what went wrong says it. "The check failed (exit 1)"
	// is the least informative true thing available about a page that threw a
	// ReferenceError on frame 2.
	if (verdict?.summary) {
		return `${label} discarded — ${verdict.summary} Your files are back as they were.`;
	}
	if (verdict?.exitCode == null) {
		return `${label} discarded — the check could not be run at all, so nothing was verified. Your files are back as they were.`;
	}
	return `${label} discarded — the check failed (exit ${verdict.exitCode}). Your files are back as they were.`;
}
