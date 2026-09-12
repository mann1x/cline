import type { AgentTool, AgentToolDefinition } from "@cline/shared";
import type { CoreAtomicProtocolConfig } from "../../types/config";
import { withBaseRevisionReads } from "./base-revision-reads";
import { withCheckFirstEdits } from "./check-first-edits";
import { discoverOracle, type Oracle } from "./oracle";
import { withPlanCapture } from "./plan-capture";
import { readPlan } from "./plan-text";
import { createPlanTool } from "./plan-tool";
import type { CheckApprover } from "./proposal";
import { DEFAULT_CHECK_RECONSIDERED_AFTER } from "./proposal";
import { createProposeCheckTool } from "./propose-check-tool";
import { buildEmptyAttemptPrompt, describeEmptyAttempt } from "./protocol";
import { createRestoreFileTool } from "./restore-file-tool";
import { createRunCheckTool } from "./run-check-tool";
import {
	createStalledChecks,
	describeStalledChecks,
	withChangeSignal,
} from "./stalled-checks";
import {
	type SelfReport,
	TransactionController,
	type TransactionEvent,
} from "./transaction-controller";

/**
 * Changes a transaction may declare, unless the user says otherwise.
 *
 * Six. It was three, from the harness campaign that produced this protocol,
 * where the models under test were large enough that three declared changes
 * was a comfortable budget and the limit did what it was for -- stopping a
 * shotgun rewrite. On a 9B it does something else. Measured on a JackDelta 9B
 * session: the model made 56 editor calls in TX-01 against a ceiling of three
 * declared changes, so the ceiling was not restraining the work, it was only
 * making the declaration a fiction the model abandoned. A small model that
 * needs four small edits to remove one symptom has to either under-declare or
 * ignore the number, and it ignored it.
 *
 * Six leaves the limit meaning what it says while giving a model that works in
 * smaller steps room to describe what it is actually going to do. It is still
 * a ceiling and the prompt still says so.
 */
export const DEFAULT_MAX_CHANGES = 6;

/**
 * Attempts a task gets. Six, as the harness this comes from runs it: measured
 * across that campaign the fix landed in the first three transactions or not at
 * all, and the later ones bought re-readings of the same symptom.
 */
export const DEFAULT_MAX_TRANSACTIONS = 6;

/**
 * Empty submissions a transaction absorbs before it is spent.
 *
 * One, and bounded for the same reason the runtime bounds its no-tool-call
 * nudge: asking a model that has stopped working to carry on is worth a turn,
 * and asking a third time is a spin with a wall clock on it.
 *
 * Measured on the harness this protocol comes from. A run whose first
 * transaction was discarded closed the remaining five in about nine minutes
 * without a single edit between them — one iteration each, no tool calls, and
 * the work file byte-identical to the seeded source at the end. It read as six
 * failed attempts and it was one.
 *
 * What happens after the budget is spent is not the run ending. The transaction
 * is settled like any other, which closes it, writes the retrospective and
 * opens the next with the rules in full — so a model that keeps submitting
 * nothing is stopped by running out of transactions rather than by a second
 * rule nobody counted.
 */
export const DEFAULT_MAX_EMPTY_ATTEMPTS = 1;

export interface AtomicProtocolSessionOptions {
	workspaceRoot: string;
	config: CoreAtomicProtocolConfig | undefined;
	onEvent?: (event: TransactionEvent) => void;
	/**
	 * `log`, not `debug`. Which check a change will be judged by — and whether
	 * there is one at all — is operational rather than diagnostic, and on the
	 * CLI a debug line is below the default level: the first live check of this
	 * feature read as "the config never arrived" for exactly that reason.
	 */
	logger?: { log?: (message: string) => void };
	/**
	 * Said to the user, not to the log: whether the protocol engaged, and why.
	 *
	 * A log line is the wrong place for this. Measured on the first live use:
	 * the mode was set to auto, the workspace held one HTML file and nothing
	 * that could be run, so the protocol stood down exactly as designed — and
	 * from the chat that is indistinguishable from a feature that is broken, or
	 * from one that is running and has had nothing to judge yet. The user's
	 * report was "I don't see any engagement of the atomic transaction even if
	 * it's enabled", which is the only thing they could have concluded.
	 */
	onStatus?: (status: { armed: boolean; message: string }) => void;
	/**
	 * Asks the user to approve a check the model proposed.
	 *
	 * Its presence is what makes a workspace with nothing to run worth arming
	 * in `auto`: the alternative there is the model judging its own work, and
	 * a host with nobody to ask -- cron, automation, a CLI with no terminal --
	 * leaves this out and gets the old behaviour.
	 */
	approveCheck?: CheckApprover;
	/**
	 * Whether the model may propose its own check where nothing can be run.
	 *
	 * Defaults on. Off restores the verdict that preceded it -- the model's own
	 * account of its work -- which is weaker evidence and measurably faster:
	 * across one workspace the proposed-check runs took four to six times the
	 * model time of the self-declared ones and closed nothing. This is here so
	 * the two can be compared on the same task rather than across releases.
	 */
	proposeCheck?: boolean;
	/** Proposals put to the user before the run gives up on having a check. */
	maxCheckProposals?: number;
	/**
	 * Discarded attempts before a check that has never passed may be replaced.
	 *
	 * Zero is off, and off is the freeze exactly as it was. See
	 * `TransactionController.checkIsUnderReconsideration`.
	 */
	checkReconsideredAfter?: number;
	/**
	 * Retires what the model had read about a file the protocol put back.
	 *
	 * Supplied by hosts that own the read receipts. `restore_file` moves every
	 * line in the file it restores, so a read taken before it no longer
	 * describes the file — and the editor's read-before-edit guard is the only
	 * thing between a stale line number and the file on disk. A host that
	 * leaves this out still gets the restore; what it loses is the guard
	 * noticing.
	 */
	forgetReads?: (absolutePath: string) => void;
}

export interface AtomicProtocolSession {
	readonly controller: TransactionController;
	/**
	 * The check this task is judged by, or nothing when it has none.
	 *
	 * Read through the controller rather than captured, because a check the
	 * user approves mid-run arrives after this session was built.
	 */
	readonly oracle: Oracle | undefined;
	/**
	 * Tools this protocol adds to the session, if any.
	 *
	 * Only `propose_check`, and only where there is nothing to run and someone
	 * to ask. A tool the model cannot usefully call is a tool that gets called.
	 */
	readonly tools: AgentTool[];
	/**
	 * The session's other tools, with what the protocol adds to them.
	 *
	 * Only `read_files`, which gains a `revision` for reading the file as this
	 * transaction found it. A decoration rather than a tool of its own, and
	 * applied here rather than at the tool's definition, so that a host running
	 * without the protocol keeps byte-for-byte the schema it had: there is no
	 * base revision without an open transaction, and advertising one anyway
	 * teaches a call that can only be refused.
	 */
	decorateTools<T extends AgentToolDefinition>(tools: readonly T[]): T[];
	/**
	 * The first transaction's rules, to go out with the task itself, once.
	 *
	 * In the user's message rather than the system prompt, which is where this
	 * started. The harness this protocol comes from puts the identical text in
	 * the opening message, and this matches the arm the campaign was measured
	 * on; it is not a demonstrated improvement, and nothing here should be read
	 * as one.
	 *
	 * A warning for anyone measuring this, learned by getting it wrong: count
	 * applied edits, not editor calls. Two system-prompt runs looked like eight
	 * and twenty-six changes against a limit of three, which reads as a limit
	 * nobody honours. Read against the tool results, they applied seven and
	 * three: the twenty-six was twenty-three failed calls -- no-match, read
	 * before edit, wrong insert mode -- around three changes that landed, which
	 * is the limit exactly.
	 *
	 * Returns the text once and nothing after. Every later transaction's rules
	 * arrive the same way, on the message that reopens it.
	 */
	takeOpeningRules(): string | undefined;
	/**
	 * A clause for the no-tool-call nudge naming a transaction nothing has
	 * landed in, or undefined when there is nothing to say.
	 *
	 * The runtime's nudge tells a silent turn that it called nothing. That is
	 * the whole message, and with the protocol engaged it omits the state the
	 * model is actually in. Measured on pandorum session 1789230811792_qnyfa:
	 * TX-01 open, three turns of prose describing edits, two nudges, neither
	 * naming the transaction, and the run ended with the file untouched and no
	 * tool ever called. The transaction machinery could not intervene because
	 * every one of its entry points is a tool call.
	 */
	describeUnstartedWork(): Promise<string | undefined>;
	/** The boundary. Judges the open transaction and keeps it or puts it back. */
	onCompletionAttempt(context: {
		text?: string;
		forced?: boolean;
	}): Promise<string | undefined>;
}

/**
 * Arm the protocol for a session, or decline and say why.
 *
 * `auto` engages only where a change can actually be judged — an oracle the
 * user named, or something in the workspace that can be run. Without one the
 * verdict would come from the model's own account of its work, and the whole
 * reason the protocol exists is that this account and the program disagree.
 * `always` engages anyway, and is honest in the prompt about what is judging.
 */
export async function createAtomicProtocolSession(
	options: AtomicProtocolSessionOptions,
): Promise<AtomicProtocolSession | undefined> {
	const mode = options.config?.mode ?? "off";
	if (mode === "off") {
		return undefined;
	}

	const oracle = await discoverOracle(options.workspaceRoot, {
		manual: options.config?.oracleCommand,
		expect: options.config?.oracleExpect,
	});
	// Nothing to run, but someone to ask: the model names a check and the user
	// approves it, which is a real verdict where the alternative was the
	// model's own account of its work.
	const approveCheck = options.approveCheck ?? options.config?.approveCheck;
	// The switch exists to be turned off. Model-proposed checks were measured
	// making runs four to six times longer than the self-declared verdict they
	// replaced, and a comparison needs both arms on the same workspace rather
	// than an argument about which release was better.
	const proposeCheckAllowed =
		(options.proposeCheck ?? options.config?.proposeCheck) !== false;
	const canProposeCheck =
		!oracle && approveCheck !== undefined && proposeCheckAllowed;
	if (!oracle && !canProposeCheck && mode === "auto") {
		// Said out loud, and to the user rather than to a log file. A feature
		// that silently does nothing looks exactly like one that is working and
		// has nothing to do, and there is no other line to tell them apart.
		const message =
			"Change protocol stood down: nothing in this workspace can be run to judge a change, and the mode is Auto. Name your own check in Settings → Features → Change Protocol, or set the mode to Always to have the model judge its own work.";
		options.logger?.log?.(`[Atomic] ${message}`);
		options.onStatus?.({ armed: false, message });
		return undefined;
	}
	const armedMessage = oracle
		? `Change protocol armed: each attempt is judged by \`${oracle.label}\` (${oracle.reason}), and an attempt that fails it is put back.`
		: canProposeCheck
			? "Change protocol armed with nothing to run: the model will propose a check and ask you to approve it. Until one is approved it judges its own work, which is labelled as such on every attempt."
			: "Change protocol armed with no check to run: the model judges its own work, which is the weaker of the two and is labelled as such on every attempt.";
	options.logger?.log?.(`[Atomic] ${armedMessage}`);
	options.onStatus?.({ armed: true, message: armedMessage });

	const controller = new TransactionController({
		workspaceRoot: options.workspaceRoot,
		maxChanges: options.config?.maxChanges ?? DEFAULT_MAX_CHANGES,
		maxTransactions:
			options.config?.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS,
		oracle,
		allowCheckProposal: canProposeCheck,
		checkReconsideredAfter:
			options.checkReconsideredAfter ??
			options.config?.checkReconsideredAfter ??
			DEFAULT_CHECK_RECONSIDERED_AFTER,
		oracleTimeoutMs: options.config?.oracleTimeoutMs,
		onEvent: options.onEvent,
	});

	// The transaction already holds what every file said when it opened, and
	// until now only the rollback could reach it. A model that has damaged a
	// file can undo exactly that file and keep the rest of its work, instead of
	// retyping the original from memory — measured, that reconstruction is
	// where a run's hours go, and on a minified line it rarely converges.
	const tools: AgentTool[] = [
		createRestoreFileTool({
			controller,
			forgetReads: options.forgetReads ?? options.config?.forgetReads,
			onRestored: ({ path: restored, deleted }) =>
				options.logger?.log?.(
					`[Atomic] ${restored} ${deleted ? "deleted" : "put back"} at the model's request.`,
				),
			onError: (message, error) =>
				options.logger?.log?.(`${message}: ${String(error)}`),
		}),
	];
	// Offered whenever the protocol is armed, including before a check exists:
	// the model has to be able to ask, and the answer "there is none" is a
	// better one than silence. It is also the only way to reach a `page` check,
	// which runs inside Cline and cannot be typed into a shell.
	// The plan, held rather than restated. Measured on a 9B: eleven plan blocks
	// in one session, each written from scratch, six of them announcing a count
	// that disagreed with their own list, and nothing carried across the
	// discard. This holds the items, numbers them, and writes the retrospective
	// from the record instead of asking the model to remember it.
	tools.push(
		createPlanTool({
			controller,
			maxChanges: options.config?.maxChanges ?? DEFAULT_MAX_CHANGES,
			onPlan: (items) =>
				options.logger?.log?.(
					`[Atomic] plan: ${items.length} change(s), ${items.filter((item) => item.status === "done").length} landed.`,
				),
		}),
	);
	// Counts checks run over files nothing has changed in between. A model that
	// never yields its turn never reaches `onCompletionAttempt`, which is the
	// only caller of `settle`, so without this a run can spend its whole clock
	// with every transaction still open. See `stalled-checks.ts` for why the
	// trigger counts unchanged files rather than failures.
	const stalled = createStalledChecks({
		get transaction() {
			return controller.transaction;
		},
	});
	tools.push(
		createRunCheckTool({
			controller,
			canProposeCheck,
			onRun: async (verdict, ran) => {
				options.logger?.log?.(
					`[Atomic] ${ran.label} run on request: ${verdict.passed ? "passed" : "failed"}.`,
				);
				if (!stalled.checked(verdict.passed) || finished) {
					return undefined;
				}
				const notice = describeStalledChecks(stalled.streak, ran.label);
				options.logger?.log?.(`[Atomic] ${notice}`);
				const closed = await settleTransaction({
					...(planned?.transaction === controller.transaction
						? { plan: planned.plan }
						: {}),
					account: notice,
					forced: true,
					notice,
				});
				if (closed.message) {
					return closed.message;
				}
				// Nothing left to open. Which of the two it is matters to the
				// model: one is the task done, the other is the budget gone.
				return closed.kept
					? `${notice}\n\nJudged at that point the check passed, so the task is settled and this run is done.`
					: `${notice}\n\nThat was the last transaction, so there is no next one. Say plainly what you tried and what the check still says.`;
			},
			onError: (message, error) =>
				options.logger?.log?.(`${message}: ${String(error)}`),
		}),
	);
	if (canProposeCheck && approveCheck) {
		tools.push(
			createProposeCheckTool({
				workspaceRoot: options.workspaceRoot,
				controller,
				approve: approveCheck,
				maxProposals:
					options.maxCheckProposals ?? options.config?.maxCheckProposals,
				onAdopted: (adopted) => {
					const message = `Change protocol: you approved \`${adopted.label}\`, and every attempt from here is judged by it.`;
					options.logger?.log?.(`[Atomic] ${message}`);
					options.onStatus?.({ armed: true, message });
				},
				onError: (message, error) =>
					options.logger?.log?.(`${message}: ${String(error)}`),
			}),
		);
	}

	let rules: string | undefined = await controller.open();
	let finished = false;
	let emptyAttempts = 0;
	// The plan for the open transaction, as the model wrote it, kept here
	// because it is stated at the start and needed at the end: `settle` records
	// it so the next transaction can be told what this one intended, and by
	// then the reply that carried it is long gone.
	let planned: { transaction: number; plan: string } | undefined;

	/**
	 * Close the open transaction and work out what the model has to be told.
	 *
	 * Shared by the two things that can end one: the completion attempt, and a
	 * check run three times over files nobody changed in between. Both need the
	 * same answer -- the verdict, what the check said, and the whole of the next
	 * transaction's rules -- and both have to set `finished` in this closure,
	 * which is why this lives here rather than on the controller.
	 */
	const settleTransaction = async (report: {
		plan?: string;
		account?: string;
		selfReport?: SelfReport;
		forced?: boolean;
		notice?: string;
	}): Promise<{ finished: boolean; kept: boolean; message?: string }> => {
		// Each transaction gets its own budget: a model that submitted nothing,
		// was asked again and then made a real change has recovered, and the next
		// transaction should not start one strike down. A transaction spent on
		// emptiness resets it for the same reason.
		emptyAttempts = 0;
		planned = undefined;

		const settlement = await controller.settle({
			...(report.plan ? { plan: report.plan } : {}),
			account: report.account,
			selfReport: report.selfReport,
			forced: report.forced,
		});
		if (settlement.kept || !settlement.nextPrompt) {
			finished = true;
			return { finished: true, kept: settlement.kept };
		}
		// The whole of the next transaction's rules, not a pointer to them. This
		// message is the only thing that opens TX-02, exactly as a fresh
		// session's opening prompt is in the harness this comes from: the rules,
		// the limit and the record of what was already tried, restated in full
		// rather than referred back to.
		return {
			finished: false,
			kept: false,
			message: [
				report.notice,
				settlement.message,
				settlement.verdict?.output
					? `The check said:\n${settlement.verdict.output}`
					: undefined,
				settlement.nextPrompt,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n\n"),
		};
	};

	return {
		controller,
		get oracle() {
			return controller.oracle;
		},
		tools,
		decorateTools: (given) => {
			const withReads = withBaseRevisionReads(given, controller);
			// Outermost, so it sees every call including the ones the gate
			// refuses: the turn that answers the gate is exactly the turn that
			// states the plan, and its edit never reaches the executor.
			const withPlans = withPlanCapture(withReads, {
				get transaction() {
					return controller.transaction;
				},
				onPlan: (plan, from) => {
					planned = { transaction: controller.transaction, plan };
					options.onEvent?.({
						type: "plan",
						transaction: controller.transaction,
						plan,
						from,
					});
				},
			});
			// Inside the check-first gate below, so an edit that gate refuses --
			// which never reaches the file -- cannot clear the stalled-check
			// count and hold a dead transaction open.
			const withChanges = withChangeSignal(withPlans, () => {
				stalled.changed();
			});
			// Only where there is a check to run first. With none, the sentence
			// the gate enforces was never in the prompt either.
			const check = controller.oracle;
			return check
				? withCheckFirstEdits(withChanges, {
						get transaction() {
							return controller.transaction;
						},
						checkLabel: check.label,
					})
				: withChanges;
		},
		takeOpeningRules: () => {
			const opening = rules;
			rules = undefined;
			return opening;
		},
		async describeUnstartedWork() {
			// Spent transactions have nothing left to start.
			if (finished) {
				return undefined;
			}
			// `isUntouched` is the same question the boundary asks, and the same
			// answer: nothing in this transaction has changed a file yet. A model
			// mid-transaction with an edit already landed does not need telling
			// to begin, and saying so would be wrong as well as noisy.
			if (!(await controller.isUntouched())) {
				return undefined;
			}
			const label = `TX-${String(controller.transaction).padStart(2, "0")}`;
			return (
				` The change protocol is engaged and ${label} is open with nothing in it:` +
				" no file has been changed yet. It does not replace your other instructions," +
				" and it cannot advance on prose — reading a file, running the check and" +
				" editing are all tool calls, and one of them is the next thing to do." +
				" Start by reading what you are about to change."
			);
		},
		async onCompletionAttempt({ text, forced }) {
			// Once the transactions are spent there is nothing left to judge with,
			// and asking again would settle a transaction that was never opened.
			if (finished) {
				return undefined;
			}

			const untouched = await controller.isUntouched();

			// A task that changed nothing is not a transaction. Answering a
			// question about the code is a legitimate way for a run to end, and
			// running a typecheck to confirm that nobody edited anything is a cost
			// with no verdict in it.
			if (controller.outcomes.length === 0 && untouched) {
				finished = true;
				return undefined;
			}

			// Once a transaction has been judged, an empty submission means
			// something else: the model has given up. The first one does not spend
			// a transaction — it stays open, the model is told what it just did,
			// and it gets to try again.
			//
			// The second one does spend it. Not because the transaction earned a
			// verdict, but because the alternative is worse: holding it open
			// forever needs some other rule to end the run, and the rule this used
			// to have ended it on the spot, with transactions still unspent and
			// nothing said about what had been tried. Settling instead closes this
			// transaction like any other, writes the retrospective, and opens the
			// next one with the rules in full. A model that submits nothing every
			// time runs out of transactions, which is the budget it was given.
			let emptyNotice: string | undefined;
			if (untouched) {
				emptyAttempts += 1;
				const continued = emptyAttempts <= DEFAULT_MAX_EMPTY_ATTEMPTS;
				const notice = describeEmptyAttempt(controller.transaction, continued);
				options.logger?.log?.(`[Atomic] ${notice}`);
				options.onEvent?.({
					type: "empty",
					transaction: controller.transaction,
					message: notice,
					continued,
				});
				if (continued) {
					return [
						notice,
						buildEmptyAttemptPrompt({
							transaction: controller.transaction,
							maxChanges: options.config?.maxChanges ?? DEFAULT_MAX_CHANGES,
							maxTransactions:
								options.config?.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS,
						}),
					].join("\n\n");
				}
				// Falls through to the settle below, which spends this transaction
				// and opens the next. The notice rides along so the model is told
				// why this one closed without a change in it.
				emptyNotice = notice;
			}

			// The reply first, then whatever was captured during the transaction.
			// Both can be absent, and that is still a fact worth recording as
			// itself rather than as an empty string.
			const plan =
				readPlan(text) ??
				(planned?.transaction === controller.transaction
					? planned.plan
					: undefined);
			const closed = await settleTransaction({
				...(plan ? { plan } : {}),
				account: text,
				selfReport: oracle ? undefined : readSelfReport(text),
				forced,
				...(emptyNotice ? { notice: emptyNotice } : {}),
			});
			return closed.message;
		},
	};
}

/**
 * What a model's closing message says about whether its change worked.
 *
 * A heuristic, and only reached where there is no oracle. It looks for doubt
 * rather than for confidence: a model that ends a run is already asserting that
 * it is done, so the thing worth finding is the sentence where it says it is
 * not sure, and returning `undefined` means "it did not say otherwise" rather
 * than "it said yes".
 */
export function readSelfReport(
	text: string | undefined,
): SelfReport | undefined {
	if (!text) return undefined;
	const lowered = text.toLowerCase();
	const doubted = [
		"could not verify",
		"couldn't verify",
		"unable to verify",
		"cannot verify",
		"can't verify",
		"could not test",
		"unable to test",
		"not able to test",
		"i cannot tell",
		"i can't tell",
		"unverified",
		"not verified",
	].some((phrase) => lowered.includes(phrase));
	if (doubted) return "unsure";
	const failed = [
		"still fails",
		"still failing",
		"still broken",
		"did not work",
		"didn't work",
		"does not work",
		"doesn't work",
		"was not able to fix",
		"could not fix",
		"couldn't fix",
	].some((phrase) => lowered.includes(phrase));
	return failed ? "failure" : undefined;
}
