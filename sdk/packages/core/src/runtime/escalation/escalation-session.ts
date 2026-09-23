/**
 * The escalation path, assembled: the tool, the budget, the brief, and what
 * happens to the workspace while a second model is editing it.
 *
 * Built the way the atomic protocol is built — decorated onto a session at
 * construction rather than registered as a default tool — for the same reason.
 * A default tool has to be declared in six places, is offered to every session
 * whether or not the feature is configured, and would answer "no expert is
 * configured" to a model that is stuck, which is the one state in which it will
 * keep calling. Here the tool exists only where an expert does.
 *
 * Three things this owns that nothing else can:
 *
 *   the budget       a stuck model with an unmetered escalate is a stuck model
 *                    with a larger bill. See `escalation-controller.ts`.
 *   the read drop    the expert moves lines the base model has already read,
 *                    and the editor's read-before-edit guard is all that stands
 *                    between a stale line number and the file on disk.
 *   the snapshot     the expert edits. With the change protocol on, the open
 *                    transaction already covers that. With it off, nothing did
 *                    until this: handing edit rights to a second model with no
 *                    way back is not a feature, it is a liability.
 */
import type { AgentEvent, AgentTool } from "@cline/shared";
import type { AgentSlotGate } from "../../extensions/tools/team/agent-slot-gate";
import type { CoreEscalationConfig } from "../../types/config";
import {
	type RestoreReport,
	restoreSnapshot as restoreSnapshotOnDisk,
	type Snapshot,
	takeSnapshot as takeSnapshotOfDisk,
} from "../atomic/snapshot";
import { textOf } from "./a2a";
import type { EscalationTransactionState } from "./brief";
import { buildEscalationBrief } from "./brief";
import {
	createEscalateTool,
	type EscalationExchangeResult,
	type EscalationRequest,
} from "./escalate-tool";
import { createEscalationController } from "./escalation-controller";
import type { ExpertMailbox } from "./expert-mailbox";
import type { ExpertNoteBatch, ExpertNotes } from "./expert-notes";
import type { ExpertRevisions } from "./expert-revisions";
import {
	createExpertSession,
	type ExpertRuntime,
	type ExpertUsage,
} from "./expert-session";
import { STAND_DOWN_NOTICE, type StandDown } from "./stand-down";
import {
	createWaitForExpertTool,
	type ExpertWatchResult,
	NOTHING_TO_WAIT_FOR,
} from "./watch-tool";

/** Escalations one task gets. */
export const DEFAULT_MAX_ESCALATIONS = 3;
/** Follow-ups within one escalation, after the first delivery. */
export const DEFAULT_MAX_FOLLOW_UPS = 20;

/**
 * What the host is told, as it happens.
 *
 * Events rather than log lines because the exchange belongs in the chat: the
 * user is paying for this model and is entitled to read what it was asked and
 * what it said, in the transcript, beside the work it produced.
 */
export type EscalationEvent =
	| { type: "escalation_started"; index: number; of: number; brief: string }
	| { type: "expert_asked"; message: string }
	| {
			type: "expert_replied";
			reply: string;
			/** Workspace-relative paths the expert changed. */
			changed: string[];
			usage: ExpertUsage;
	  }
	| {
			type: "expert_said";
			index: number;
			of: number;
			kind: "thinking" | "message";
			text: string;
	  }
	| {
			type: "expert_progress";
			index: number;
			of: number;
			toolCalls: number;
			lastTool?: string;
			usage: ExpertUsage;
	  }
	| { type: "escalation_ended"; held: boolean; usage: ExpertUsage };

/**
 * What the user said when the escalation was put to them.
 *
 * A bare boolean is still accepted because a host with only a yes/no to offer
 * should not have to wrap it, and every host did exactly that until the
 * approval moved out of a modal dialog and into the chat, where there is room
 * to say why.
 */
export type EscalationApproval =
	| boolean
	| { approved: boolean; feedback?: string };

export interface EscalationSessionOptions {
	workspaceRoot: string;
	config: CoreEscalationConfig | undefined;
	/** Builds the expert's runtime on the escalation connection. */
	openExpert: (context: {
		onEvent: (event: AgentEvent) => void;
	}) => Promise<ExpertRuntime>;
	/** The open transaction, read at hand-over. Absent means the protocol is off. */
	readTransaction?: () => EscalationTransactionState | undefined;
	/** The task as the user stated it. */
	readTask?: () => string | undefined;
	/**
	 * The harness's own reading of the run, and of the code in play.
	 *
	 * Given the files the model named so the reading can cover them, and the
	 * model's goal and reason so a scorer can read what is being handed over.
	 * What comes back is opaque text for the brief and the approval dialog.
	 */
	assess?: (context: {
		files?: readonly string[];
		goal?: string;
		reason?: string;
	}) => Promise<string | undefined>;
	/** Retires what the base model had read about a file the expert changed. */
	forgetReads?: (absolutePath: string) => void;
	/**
	 * Where the expert's writes are recorded, when the host wired one up.
	 *
	 * Opened on the first ask of an escalation and purged when that escalation
	 * ends. The session owns the lifecycle because it is the only thing that
	 * knows both -- the host builds the log and decorates the expert's tools
	 * with it, but it never sees an escalation begin or finish.
	 */
	revisions?: ExpertRevisions;
	/**
	 * The base model's stand-down, and with it the non-blocking hand-over.
	 *
	 * Its presence is the switch. Given one, `escalate` returns as soon as the
	 * expert has been handed the work and the base model stays live, watching
	 * through `wait_for_expert` and barred from writing. Left out, the tool
	 * blocks until the expert delivers, which is what it did before any of this
	 * existed and what the "alternate usage" setting asks for: one model in
	 * memory at a time, and no supervision to pay for.
	 */
	standDown?: StandDown;
	/** Where the expert's activity is collected for the base model. */
	notes?: ExpertNotes;
	/**
	 * The guards watching the expert's own channels, for their reset.
	 *
	 * The session owns the reset for the same reason it owns the revision
	 * log's: it is the only thing that knows an escalation has ended, and
	 * evidence carried from one escalation into the next would have the base
	 * model told the expert is looping before it has done anything.
	 */
	guards?: { reset(): void };
	/**
	 * Where a message for a still-working expert waits for its next turn.
	 *
	 * Without one, `escalate` with a `message` during a hand-over can only say
	 * "it is still working" -- which is true and useless, because the two
	 * things the base model is watching for are exactly the two that cannot
	 * wait for the delivery: a question the expert asked, and an expert going
	 * round in circles that should stop now rather than in forty turns.
	 */
	mailbox?: ExpertMailbox;
	/** How long `wait_for_expert` sleeps between looks. Tests override it. */
	watchTickMs?: number;
	/** Overridable for tests; the real one is a timer. */
	wait?: (ms: number) => Promise<void>;
	/**
	 * Takes whatever the user has typed since it was last asked, if anything.
	 *
	 * The same queue the turn boundary drains, drained here because that
	 * boundary will not come round: while the expert is working the base model
	 * is blocked inside a tool call, so a steering message would otherwise wait
	 * out the entire exchange it was written about.
	 */
	takeSteering?: () => string | undefined;
	/**
	 * Puts the escalation to the user before it happens.
	 *
	 * Only consulted where the host set `requireApproval`. A refusal spends
	 * nothing: the budget rations the model, and a person saying no is not the
	 * model overspending.
	 */
	approve?: (request: {
		brief: string;
		index: number;
		of: number;
	}) => Promise<EscalationApproval>;
	/** The escalation endpoint's slot gate, when the host resolved one. */
	gate?: Pick<AgentSlotGate, "run" | "active">;
	onEvent?: (event: EscalationEvent) => void;
	logger?: { log?: (message: string) => void };
	/** Overridable for tests; the real ones read and write the workspace. */
	takeSnapshot?: (root: string) => Promise<Snapshot>;
	restoreSnapshot?: (snapshot: Snapshot) => Promise<RestoreReport>;
}

export interface EscalationSession {
	/** `escalate`, where an expert is configured. Empty where none is. */
	readonly tools: AgentTool[];
	/** Escalations made. */
	readonly used: number;
	/**
	 * Escalations still available.
	 *
	 * Read by the struggle detector's offer, which must not suggest a tool call
	 * the budget would refuse -- an offer the model takes and is turned down on
	 * is worse than no offer.
	 */
	readonly remaining: number;
	/** What the expert has spent in this task. */
	readonly usage: ExpertUsage;
	/**
	 * Puts the workspace back as the first escalation found it.
	 *
	 * Only meaningful where escalation took a snapshot — that is, where the
	 * change protocol was off. Undefined when there is nothing to go back to.
	 */
	restore(): Promise<RestoreReport | undefined>;
	/** Task teardown. Releases a held expert. */
	dispose(): Promise<void>;
}

/** Paths whose contents differ between two readings of the tree. */
function changedBetween(before: Snapshot, after: Snapshot): string[] {
	const changed: string[] = [];
	for (const [path, entry] of after.files) {
		const was = before.files.get(path);
		if (!was || was.hash !== entry.hash) {
			changed.push(path);
		}
	}
	for (const path of before.files.keys()) {
		if (!after.files.has(path)) {
			changed.push(path);
		}
	}
	return changed.sort();
}

function relative(root: string, absolute: string): string {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
}

export function createEscalationSession(
	options: EscalationSessionOptions,
): EscalationSession {
	const config = options.config;
	const maxEscalations = config?.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
	const maxFollowUps = config?.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
	const takeSnapshot =
		options.takeSnapshot ?? ((root) => takeSnapshotOfDisk(root));
	const restore =
		options.restoreSnapshot ?? ((snapshot) => restoreSnapshotOnDisk(snapshot));

	/**
	 * Which hand-over the open conversation belongs to.
	 *
	 * The conversation is built once and reused across escalations, so the
	 * progress it reports has to be stamped with the escalation that is live
	 * now rather than the one it was created for.
	 */
	let liveIndex = 0;

	const controller = createEscalationController({
		maxEscalations,
		closeAfterEscalation: config?.closeAfterEscalation === true,
		createSession: () =>
			createExpertSession({
				maxFollowUps,
				open: options.openExpert,
				...(options.gate ? { gate: options.gate } : {}),
				...(options.onEvent
					? {
							onUtterance: (utterance) =>
								options.onEvent?.({
									type: "expert_said",
									index: liveIndex,
									of: maxEscalations,
									kind: utterance.kind,
									text: utterance.text,
								}),
							onProgress: (progress) =>
								options.onEvent?.({
									type: "expert_progress",
									index: liveIndex,
									of: maxEscalations,
									toolCalls: progress.toolCalls,
									...(progress.lastTool ? { lastTool: progress.lastTool } : {}),
									usage: progress.usage,
								}),
						}
					: {}),
			}),
	});

	/** The state of the workspace when the first escalation of this task began. */
	let restorePoint: Snapshot | undefined;

	/**
	 * Runs the expert and works out what it did to the workspace.
	 *
	 * The diff is how the read receipts get retired. Watching the expert's own
	 * tool calls would be narrower and would miss everything it changed by a
	 * route this code does not know about — a shell command, a formatter, a
	 * build step — and the guard those receipts feed refuses edits rather than
	 * corrupting files, so missing one is a run that grinds to a halt.
	 */
	const runAndObserve = async (
		ask: () => Promise<{ text: string; usage: ExpertUsage }>,
	): Promise<{ text: string; usage: ExpertUsage; changed: string[] }> => {
		const before = await takeSnapshot(options.workspaceRoot);
		if (!restorePoint) {
			restorePoint = before;
		}
		// Revision #1 is the file as THIS escalation opened, so the log starts
		// at the first ask of each one and not at the first ask of the task. A
		// base model told "the expert changed a.html, read #1 to see what it
		// was" against a #1 two escalations old would be reading a state
		// nobody is claiming anything about.
		if (options.revisions && options.revisions.source.pending === undefined) {
			options.revisions.open(before, controller.used || 1);
		}
		const reply = await ask();
		const after = await takeSnapshot(options.workspaceRoot);
		const changed = changedBetween(before, after);
		for (const path of changed) {
			options.forgetReads?.(path);
		}
		return { ...reply, changed };
	};

	/**
	 * The user's words, labelled as theirs.
	 *
	 * Labelled rather than merged, in both directions. To the expert, because a
	 * correction from the person who owns the task carries a different weight
	 * from the model's own account of it; to the base model, because a line that
	 * arrives inside a tool result and reads as the expert's would be attributed
	 * to the expert for the rest of the run.
	 */
	const fromTheUser = (message: string): string =>
		`\n\n== FROM THE USER, JUST NOW ==\n\n${message.trim()}`;

	const describeChanged = (changed: string[]): string =>
		changed.length === 0
			? ""
			: `\n\nThe expert changed ${changed.length} file${changed.length === 1 ? "" : "s"}: ${changed
					.map((path) => relative(options.workspaceRoot, path))
					.join(
						", ",
					)}. Read ${changed.length === 1 ? "it" : "them"} before you edit ${changed.length === 1 ? "it" : "them"} — what you had read is no longer what is there.`;

	/** What one ask of the expert produced. */
	type Delivery = { text: string; usage: ExpertUsage; changed: string[] };

	/**
	 * The expert's ask, while it is still running.
	 *
	 * Held rather than awaited. This is the whole of the non-blocking
	 * hand-over: `escalate` starts it and returns, `wait_for_expert` is what
	 * eventually reads it, and in between the base model has a turn it can
	 * spend watching instead of a tool call it is stuck inside.
	 */
	let inFlight: Promise<Delivery> | undefined;
	/** A finished ask nobody has collected yet. */
	let delivered: Delivery | undefined;
	/** A failed ask nobody has collected yet. Re-thrown on collection. */
	let failed: unknown;

	const standDown = options.standDown;
	const notes = options.notes;
	const tickMs = options.watchTickMs ?? 250;
	const wait =
		options.wait ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	const detach = (ask: () => Promise<{ text: string; usage: ExpertUsage }>) => {
		notes?.setState("working");
		standDown?.engage();
		const run = runAndObserve(ask).then(
			(reply) => {
				delivered = reply;
				notes?.setState("completed");
				return reply;
			},
			(error) => {
				failed = error;
				notes?.setState("failed");
				throw error;
			},
		);
		// Nothing awaits this until `collect` does, and an unobserved rejection
		// in between would take the whole process down rather than reaching the
		// model as a tool result.
		run.catch(() => undefined);
		inFlight = run;
	};

	const handOver = (index: number): string =>
		[
			`The expert has the work. This is escalation ${index} of ${maxEscalations}, and it is running now — you were not made to wait for it.`,
			STAND_DOWN_NOTICE,
			"Call `wait_for_expert` now. It returns when the expert has done enough to be worth looking at, or when it delivers.",
		].join("\n\n");

	const describeBatch = (batch: ExpertNoteBatch): string => {
		const body = textOf(batch.parts);
		if (batch.final) {
			return `== THE EXPERT HAS FINISHED. What it did since you last looked ==\n\n${body}`;
		}
		return `== WHAT THE EXPERT HAS DONE SINCE YOU LAST LOOKED ==\n\n${body}\n\nSpot-check what matters — \`read_files\` with the revision a note names shows you exactly what was written — then call \`wait_for_expert\` again. If it is going round in circles, \`escalate\` with \`message\` and say so.`;
	};

	/**
	 * Block until there is something to tell the base model.
	 *
	 * The loop is a poll rather than a subscription because what it is waiting
	 * for is two different things -- a batch becoming due, which is a clock,
	 * and the expert finishing, which is a promise -- and racing a timer
	 * against a promise every tick is the same loop with more parts.
	 */
	const collect = async (): Promise<ExpertWatchResult> => {
		if (!inFlight && delivered === undefined && failed === undefined) {
			return { kind: "none", text: NOTHING_TO_WAIT_FOR };
		}
		while (delivered === undefined && failed === undefined) {
			const batch = notes?.take();
			if (batch) {
				return { kind: "batch", text: describeBatch(batch) };
			}
			await wait(tickMs);
		}
		inFlight = undefined;
		standDown?.release();
		if (failed !== undefined) {
			const error = failed;
			failed = undefined;
			// The hand-over is charged at `begin`, before the expert has been
			// asked anything. A detached ask that failed outright reaches this
			// point instead of the blocking path's catch, so the refund has to
			// happen here or the escalation is billed for a conversation that
			// never started.
			if (controller.session?.deliveries === 0) {
				await controller.refund();
			}
			throw error;
		}
		const reply = delivered as Delivery;
		delivered = undefined;
		options.onEvent?.({
			type: "expert_replied",
			reply: reply.text,
			changed: reply.changed,
			usage: reply.usage,
		});
		// Whatever is still waiting goes out with the delivery rather than
		// costing the base another turn to come back for.
		const tail = notes?.take();
		const arrived = options.takeSteering?.();
		const open = controller.session;
		const followUpsLeft = open ? Math.max(0, maxFollowUps - open.followUps) : 0;
		return {
			kind: "delivered",
			text: [
				tail ? describeBatch(tail) : "",
				"== THE EXPERT HAS DELIVERED. THIS IS A DELIVERY, NOT A VERDICT ==",
				reply.text.trim() || "(the expert returned nothing)",
				describeChanged(reply.changed).trim(),
				"You have the pen back. Check what it did before you build on it: run the check yourself, read the files it says it changed, and satisfy yourself that what it did is a fix and not a way around the symptom. You are still the one accountable for this task.",
				followUpsLeft > 0
					? `If it does not hold up, call \`escalate\` again with \`message\` and say exactly what you found — ${followUpsLeft} follow-up${followUpsLeft === 1 ? "" : "s"} left in this exchange, and they are much cheaper than another escalation. When you are satisfied, call it with \`finished: true\` to release the expert.`
					: "This exchange is out of follow-ups. Act on what you have, and call `escalate` with `finished: true` to release the expert.",
				arrived ? fromTheUser(arrived).trim() : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		};
	};

	const consult = async (
		request: EscalationRequest,
	): Promise<EscalationExchangeResult> => {
		const open = controller.session;
		const live = open && !open.closed && controller.used > 0;

		// Nothing open and nothing to say: the model is closing an exchange that
		// has already ended. Not an error, and not worth a turn.
		if (!live && request.finished && !request.goal) {
			return {
				reply: "",
				opened: false,
				closed: true,
				followUpsLeft: 0,
				escalationsLeft: controller.remaining,
			};
		}

		if (live) {
			liveIndex = controller.used;
			if (standDown && inFlight && request.finished) {
				// Calling it off mid-turn. The base model is authorised to do
				// this -- it is the one watching for the expert going in
				// circles -- and the detached ask is already catching its own
				// rejection, so ending under it is safe.
				inFlight = undefined;
				await controller.end();
				options.revisions?.purge();
				options.guards?.reset();
				options.mailbox?.clear();
				standDown.release();
				options.onEvent?.({
					type: "escalation_ended",
					held: config?.closeAfterEscalation !== true,
					usage: controller.usage,
				});
				return {
					reply:
						"You called the expert off and the exchange is closed. You have the pen back, and whatever it had already changed is still on disk — read the files before you edit them.",
					opened: false,
					closed: true,
					followUpsLeft: 0,
					escalationsLeft: controller.remaining,
				};
			}
			if (standDown && inFlight) {
				const said = request.message ?? request.goal;
				const mailbox = options.mailbox;
				if (said && mailbox) {
					mailbox.send(said);
					options.onEvent?.({ type: "expert_asked", message: said });
					return {
						reply:
							"Your message is waiting for the expert and it will read it on its next turn — it does not interrupt the turn it is in the middle of. Call `wait_for_expert` to see what it does about it.",
						opened: false,
						handedOver: true,
						followUpsLeft: Math.max(0, maxFollowUps - open.followUps),
						escalationsLeft: controller.remaining,
					};
				}
				return {
					reply:
						"The expert is still working — it has not delivered yet, so there is nothing to push back on. Call `wait_for_expert` to be told what it has been doing.",
					opened: false,
					handedOver: true,
					followUpsLeft: Math.max(0, maxFollowUps - open.followUps),
					escalationsLeft: controller.remaining,
				};
			}
			const steer = options.takeSteering?.();
			const message =
				(request.message ?? request.goal ?? "") +
				(steer ? fromTheUser(steer) : "");
			let reply = { text: "", usage: open.usage, changed: [] as string[] };
			if (message.trim() && standDown) {
				options.onEvent?.({ type: "expert_asked", message });
				detach(async () => {
					const answer = await open.ask(message);
					return { text: answer.text, usage: answer.usage };
				});
				return {
					reply: [
						"Your reply is with the expert and it is working on it.",
						"You are still standing down: no edits until it delivers. Call `wait_for_expert` to follow it.",
					].join("\n\n"),
					opened: false,
					handedOver: true,
					followUpsLeft: Math.max(0, maxFollowUps - open.followUps),
					escalationsLeft: controller.remaining,
				};
			}
			if (message.trim()) {
				options.onEvent?.({ type: "expert_asked", message });
				reply = await runAndObserve(async () => {
					const answer = await open.ask(message);
					return { text: answer.text, usage: answer.usage };
				});
				options.onEvent?.({
					type: "expert_replied",
					reply: reply.text,
					changed: reply.changed,
					usage: reply.usage,
				});
			}
			if (request.finished) {
				const held = config?.closeAfterEscalation !== true;
				await controller.end();
				// The delivery is made and the base has had its say, so there
				// is no claim left for a revision to settle.
				options.revisions?.purge();
				options.guards?.reset();
				options.mailbox?.clear();
				standDown?.release();
				options.onEvent?.({
					type: "escalation_ended",
					held,
					usage: controller.usage,
				});
				return {
					reply: reply.text + describeChanged(reply.changed),
					opened: false,
					closed: true,
					followUpsLeft: 0,
					escalationsLeft: controller.remaining,
				};
			}
			const arrived = options.takeSteering?.();
			return {
				reply:
					reply.text +
					describeChanged(reply.changed) +
					(arrived ? fromTheUser(arrived) : ""),
				opened: false,
				followUpsLeft: Math.max(0, maxFollowUps - open.followUps),
				escalationsLeft: controller.remaining,
			};
		}

		// Opening one. Everything below this line can throw -- the budget, the
		// user's refusal -- and the tool turns that into a result the model can
		// act on rather than a failed call.
		const transaction = options.readTransaction?.();
		const assessment = await options.assess?.({
			...(request.files?.length ? { files: request.files } : {}),
			...(request.goal ? { goal: request.goal } : {}),
			...(request.message ? { reason: request.message } : {}),
		});
		const index = controller.used + 1;
		const brief = buildEscalationBrief({
			goal: request.goal ?? "",
			...(request.expectation ? { expectation: request.expectation } : {}),
			...(options.readTask?.() ? { task: options.readTask?.() } : {}),
			workspaceRoot: options.workspaceRoot,
			...(request.files?.length ? { filesInPlay: request.files } : {}),
			...(transaction ? { transaction } : {}),
			...(assessment ? { assessment } : {}),
			escalation: { index, of: maxEscalations },
			followUpsAllowed: maxFollowUps,
			// Only where nothing else covers the expert's edits. With a
			// transaction open, a second snapshot would be a copy of a copy and
			// the brief would promise a rollback the model cannot reach.
			snapshotTaken: !transaction,
		});

		if (config?.requireApproval) {
			const answer = await options.approve?.({
				brief,
				index,
				of: maxEscalations,
			});
			// No asker configured is a refusal, not an approval: an approval
			// nobody can give is not one, and escalating anyway would make the
			// setting do the opposite of what it says.
			const decision =
				answer === undefined
					? { approved: false }
					: typeof answer === "boolean"
						? { approved: answer }
						: answer;
			if (!decision.approved) {
				// What they said when they said no, if they said anything. A
				// refusal on its own tells the model only that it may not have
				// help; a refusal with a reason tells it what to do instead,
				// and that is the difference between a model that stops and one
				// that carries on usefully.
				const said = decision.feedback?.trim();
				return {
					reply:
						"The user did not approve this escalation. Nothing was spent and the expert was not called — carry on with the task yourself, and say plainly what you are blocked on if you cannot." +
						(said ? `\n\nThey said: ${said}` : ""),
					opened: false,
					closed: true,
					followUpsLeft: 0,
					escalationsLeft: controller.remaining,
				};
			}
		}

		const steer = options.takeSteering?.();
		const opening = steer ? brief + fromTheUser(steer) : brief;
		const session = controller.begin();
		liveIndex = index;
		options.logger?.log?.(
			`[Escalation] Escalation ${index} of ${maxEscalations}: handing over to the expert`,
		);
		options.onEvent?.({
			type: "escalation_started",
			index,
			of: maxEscalations,
			brief,
		});
		if (standDown) {
			detach(async () => {
				const answer = await session.ask(opening);
				return { text: answer.text, usage: answer.usage };
			});
			return {
				reply: handOver(index),
				opened: true,
				handedOver: true,
				followUpsLeft: maxFollowUps,
				escalationsLeft: controller.remaining,
			};
		}
		let reply: { text: string; usage: ExpertUsage; changed: string[] };
		try {
			reply = await runAndObserve(async () => {
				const answer = await session.ask(opening);
				return { text: answer.text, usage: answer.usage };
			});
		} catch (error) {
			// The hand-over is charged at `begin`, before the expert has been
			// asked anything, because that is the only place that can refuse
			// one. When the ask then fails outright there is nothing to charge
			// for -- and the conversation it opened has to go with the charge,
			// or the next `escalate` arrives as a follow-up into a context the
			// expert never saw.
			if (session.deliveries === 0) {
				await controller.refund();
			}
			throw error;
		}
		options.onEvent?.({
			type: "expert_replied",
			reply: reply.text,
			changed: reply.changed,
			usage: reply.usage,
		});
		if (request.finished) {
			await controller.end();
			options.revisions?.purge();
			options.guards?.reset();
			options.mailbox?.clear();
			options.onEvent?.({
				type: "escalation_ended",
				held: config?.closeAfterEscalation !== true,
				usage: controller.usage,
			});
		}
		const arrived = options.takeSteering?.();
		return {
			reply:
				reply.text +
				describeChanged(reply.changed) +
				(arrived ? fromTheUser(arrived) : ""),
			opened: true,
			...(request.finished ? { closed: true } : {}),
			followUpsLeft: maxFollowUps,
			escalationsLeft: controller.remaining,
		};
	};

	const tools = config?.connection
		? [
				createEscalateTool({
					consult,
					onError: (message, error) =>
						options.logger?.log?.(`${message}: ${String(error)}`),
				}),
				// Only where the hand-over is non-blocking. Without a stand-down
				// there is never a moment when the base model is live and the
				// expert is working, so the tool could only ever answer "nothing
				// to wait for" -- and a tool that only refuses teaches the model
				// the feature does not exist.
				...(standDown
					? [
							createWaitForExpertTool({
								collect,
								onError: (message, error) =>
									options.logger?.log?.(`${message}: ${String(error)}`),
							}),
						]
					: []),
			]
		: [];

	return {
		tools,
		get used() {
			return controller.used;
		},
		get remaining() {
			return tools.length === 0
				? 0
				: Math.max(0, maxEscalations - controller.used);
		},
		get usage() {
			return controller.usage;
		},
		async restore(): Promise<RestoreReport | undefined> {
			return restorePoint ? await restore(restorePoint) : undefined;
		},
		async dispose(): Promise<void> {
			// A task that ends mid-escalation never reaches `finished`, so the
			// history would otherwise outlive the session that made it -- and
			// the base model would be left barred from writing by an expert
			// that is no longer there.
			options.revisions?.purge();
			options.guards?.reset();
			options.mailbox?.clear();
			standDown?.release();
			inFlight = undefined;
			await controller.dispose();
		},
	};
}
