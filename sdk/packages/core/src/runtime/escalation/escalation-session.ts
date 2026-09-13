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
import type { EscalationTransactionState } from "./brief";
import { buildEscalationBrief } from "./brief";
import {
	createEscalateTool,
	type EscalationExchangeResult,
	type EscalationRequest,
} from "./escalate-tool";
import { createEscalationController } from "./escalation-controller";
import {
	createExpertSession,
	type ExpertRuntime,
	type ExpertUsage,
} from "./expert-session";

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
	| { type: "escalation_ended"; held: boolean; usage: ExpertUsage };

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
	/** The harness's own reading of the code. Phase-6 seam. */
	assess?: () => Promise<string | undefined>;
	/** Retires what the base model had read about a file the expert changed. */
	forgetReads?: (absolutePath: string) => void;
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
	}) => Promise<boolean>;
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

	const controller = createEscalationController({
		maxEscalations,
		closeAfterEscalation: config?.closeAfterEscalation === true,
		createSession: () =>
			createExpertSession({
				maxFollowUps,
				open: options.openExpert,
				...(options.gate ? { gate: options.gate } : {}),
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
			const steer = options.takeSteering?.();
			const message =
				(request.message ?? request.goal ?? "") +
				(steer ? fromTheUser(steer) : "");
			let reply = { text: "", usage: open.usage, changed: [] as string[] };
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
		const assessment = await options.assess?.();
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
			const approved = await options.approve?.({
				brief,
				index,
				of: maxEscalations,
			});
			if (!approved) {
				return {
					reply:
						"The user did not approve this escalation. Nothing was spent and the expert was not called — carry on with the task yourself, and say plainly what you are blocked on if you cannot.",
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
		options.logger?.log?.(
			`[Escalation] Escalation ${index} of ${maxEscalations}: handing over to the expert`,
		);
		options.onEvent?.({
			type: "escalation_started",
			index,
			of: maxEscalations,
			brief,
		});
		const reply = await runAndObserve(async () => {
			const answer = await session.ask(opening);
			return { text: answer.text, usage: answer.usage };
		});
		options.onEvent?.({
			type: "expert_replied",
			reply: reply.text,
			changed: reply.changed,
			usage: reply.usage,
		});
		if (request.finished) {
			await controller.end();
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
			await controller.dispose();
		},
	};
}
