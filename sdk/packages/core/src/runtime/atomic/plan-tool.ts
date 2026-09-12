/**
 * Hold the plan, so that what worked is not lost the next time the model looks.
 *
 * The protocol asks for a numbered list of changes before the first edit, and
 * `plan-text.ts` next door finds that list wherever the model wrote it. Both
 * treat the plan as *text stated once*. Measured, that is not how a small model
 * uses it.
 *
 * Session 1789139763721_ive21 on pandorum, 2026-09-11, a 9B on manic_miner:
 * eleven separate blocks headed `## TX-01 Plan` or `## TX-02 Plan`, each one
 * written from scratch against whatever the last check had just reported. Three
 * things went wrong, and they compound:
 *
 *   * **The header disagreed with the list.** Six of the eleven announced "2
 *     changes" or "4 changes" and then listed one. Nothing counted them.
 *
 *   * **Nothing was carried forward.** Message 37 says, in prose, "I've already
 *     made two edits that landed" — and then plans four more as if starting
 *     from the original file. The two that landed are named nowhere.
 *
 *   * **The same line was re-planned five times.** Line 90 at messages 7, 9 and
 *     11, then again at 144 after the transaction boundary. It was re-deriving
 *     one fix from one error, repeatedly, because the fix existed only as a
 *     side effect on disk and never as something it could read back.
 *
 * When TX-01 was discarded, the disk side effects went with it and there was
 * nothing left at all. The user's words for it: "the banked wins are lost".
 *
 * So this is a place to put them. Three things follow from the failure above
 * and are the whole design:
 *
 *   * **The tool numbers the items**, so a count can never disagree with a
 *     list — there is no count to write.
 *   * **Every call returns the whole plan**, so the current state is in front
 *     of the model at the moment it is deciding what to do next, rather than
 *     forty messages up.
 *   * **A discard does not erase the record.** The items survive with their
 *     history: an item that landed in TX-01 comes back marked `pending` (the
 *     file really was rolled back) but reads `landed in TX-01, rolled back`,
 *     which is the sentence the model needed and never had.
 *
 * There is a second failure the same session showed, and it is why this tool
 * writes the retrospective rather than only holding the plan.
 *
 * From TX-02 onward the protocol asks for four lines before the plan — WORKED,
 * DID NOT, RE-USE, DIFFERENT. The model obliged, and then **stopped writing
 * plans altogether**: every later block is headed "TX-02 Retrospective & Plan"
 * and the plan half has collapsed into the DIFFERENT line as prose ("Make ONE
 * precise editor call replacing line 89..."). The retrospective displaced the
 * thing it was meant to precede.
 *
 * It is also the half the model is worst at. WORKED and DID NOT are questions
 * about what happened, asked of a model whose recollection of what happened is
 * exactly what failed — the same session reported "I've exhausted my 71
 * restore_file attempts" when nothing had been exhausted. But this tool knows
 * what happened: it recorded it. So when a transaction rolls over it writes
 * WORKED, DID NOT and RE-USE itself, from the record, and asks the model only
 * for DIFFERENT — which is the new plan, and is the one part no record can
 * supply.
 *
 * It stores nothing about the files and changes nothing on disk. A plan is a
 * statement of intent, and this keeps the statement.
 */

import { type AgentTool, createTool } from "@cline/shared";

export const PLAN_TOOL_NAME = "plan";

/** Where an item stands in the transaction that is open now. */
export type PlanItemStatus = "pending" | "done" | "failed";

/** What happened to an item in a transaction that has since closed. */
interface PlanItemAttempt {
	readonly transaction: number;
	readonly status: Exclude<PlanItemStatus, "pending">;
	readonly note?: string;
}

export interface PlanItem {
	/** 1-based, assigned here, and stable for the life of the run. */
	readonly id: number;
	readonly where: string;
	readonly what: string;
	readonly why: string;
	status: PlanItemStatus;
	note?: string;
	/** Every closed transaction this item was touched in, oldest first. */
	readonly history: PlanItemAttempt[];
}

/**
 * Longest any one field may be.
 *
 * A WHERE that runs to a page is a paste of the file, and the plan stops being
 * readable at exactly the point it stops being short.
 */
const MAX_FIELD_CHARS = 400;

/** Declarations allowed per transaction, so re-planning is bounded. */
export const MAX_DECLARATIONS_PER_TRANSACTION = 3;

export const PLAN_TOOL_DESCRIPTION = `Keep the plan for this task: what you intend to change, and which of those changes have landed.

Call it three ways.

To state the plan, send \`changes\`: a list, each entry naming WHERE (the function, or the exact text you will match on), WHAT (the single concrete edit) and WHY (the symptom it removes). Numbering is done for you — send the list, not a count.

To record that an item landed, send \`done\` with its number, and optionally \`note\`. Do this the moment the edit applies, not at the end. An item you do not mark is an item you will plan again.

To record that an item did not work, send \`failed\` with its number and a \`note\` saying what happened.

Every call returns the whole plan with its current state, so you never have to remember it or scroll back for it. Read what comes back before deciding what to do next.

The plan survives a discarded transaction. An item that landed and was then rolled back comes back as work still to do, but it is still on the record as something that once worked — which is the fastest route back to a working file.`;

export const PLAN_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		changes: {
			type: "array",
			description:
				"The plan, as a list. Each entry names where, what and why. Replaces any plan already stated.",
			items: {
				type: "object",
				properties: {
					where: {
						type: "string",
						description: "The function, or the exact text you will match on.",
					},
					what: {
						type: "string",
						description: "The single concrete edit you will make there.",
					},
					why: {
						type: "string",
						description: "The specific symptom it removes.",
					},
				},
				required: ["where", "what", "why"],
			},
		},
		done: {
			type: "number",
			description: "The number of an item whose edit has just landed.",
		},
		failed: {
			type: "number",
			description: "The number of an item that did not work.",
		},
		note: {
			type: "string",
			description: "What happened, for the item named by `done` or `failed`.",
		},
	},
	required: [],
} as const;

/**
 * The part of the controller this tool reads.
 *
 * Only the transaction number. The change budget arrives as an option instead
 * of being read off the controller, because the controller does not publish it
 * and widening its surface for one number is the wrong trade.
 */
export interface PlanTransactionSource {
	/** Which transaction is open. A change here means the last one closed. */
	readonly transaction: number;
}

export interface PlanToolOptions {
	controller: PlanTransactionSource;
	/** The protocol's change budget, which bounds the list. */
	maxChanges: number;
	/** Called when the plan changes, so a host can show it. */
	onPlan?: (items: readonly PlanItem[]) => void;
}

function trimField(value: unknown): string {
	return typeof value === "string"
		? value.trim().slice(0, MAX_FIELD_CHARS)
		: "";
}

/** One line per attempt, so the history reads as a sentence rather than a table. */
function describeHistory(item: PlanItem): string {
	if (item.history.length === 0) {
		return "";
	}
	const parts = item.history.map((attempt) => {
		const verb = attempt.status === "done" ? "landed" : "failed";
		const note = attempt.note ? ` (${attempt.note})` : "";
		return `${verb} in TX-${String(attempt.transaction).padStart(2, "0")}${note}`;
	});
	// A landed item that is back to pending was rolled back, and saying so is
	// the point of keeping the history at all.
	const rolledBack =
		item.status === "pending" &&
		item.history.some((attempt) => attempt.status === "done");
	return `  — ${parts.join("; ")}${rolledBack ? ", rolled back" : ""}`;
}

const STATUS_MARK: Record<PlanItemStatus, string> = {
	pending: "[ ]",
	done: "[x]",
	failed: "[!]",
};

/**
 * What the closed transaction actually did, in the protocol's own four heads.
 *
 * Written from the record rather than from recollection. WORKED is what landed
 * before the rollback, DID NOT is what was tried and refused, RE-USE is both of
 * those together — they are the findings that survive a rollback even though
 * the edits do not. DIFFERENT is left blank on purpose: it is the new plan, and
 * asking for it is the point.
 */
export function renderRetrospective(
	items: readonly PlanItem[],
	closed: number,
): string {
	const label = `TX-${String(closed).padStart(2, "0")}`;
	const lastOf = (item: PlanItem) =>
		item.history.filter((attempt) => attempt.transaction === closed);
	const landed = items.filter((item) =>
		lastOf(item).some((attempt) => attempt.status === "done"),
	);
	const refused = items.filter(
		(item) =>
			lastOf(item).some((attempt) => attempt.status === "failed") &&
			!lastOf(item).some((attempt) => attempt.status === "done"),
	);
	const untouched = items.filter((item) => lastOf(item).length === 0);
	const name = (item: PlanItem) => `#${item.id} ${item.what}`;
	const noted = (item: PlanItem) => {
		const attempt = lastOf(item).at(-1);
		return attempt?.note ? `${name(item)} — ${attempt.note}` : name(item);
	};
	const lines = [
		`${label} is closed and its edits are gone. What it established is not, and this is the record of it — you do not have to reconstruct it.`,
		"",
		landed.length > 0
			? `  WORKED   ${landed.map(noted).join("; ")} — these applied cleanly before the rollback, so the edit itself is known good.`
			: "  WORKED   nothing was marked as landed.",
		refused.length > 0
			? `  DID NOT  ${refused.map(noted).join("; ")}`
			: "  DID NOT  nothing was marked as failed.",
		untouched.length > 0
			? `  RE-USE   ${untouched.map(name).join("; ")} — never attempted, still open.`
			: "  RE-USE   every item was attempted.",
		"  DIFFERENT  — yours to write. State it as the plan below, not as prose.",
	];
	return lines.join("\n");
}

/** The whole plan as the model reads it back. */
export function renderPlan(
	items: readonly PlanItem[],
	transaction: number,
): string {
	if (items.length === 0) {
		return "No plan stated yet. Send `changes` with the list of edits you intend to make.";
	}
	const lines = items.map((item) => {
		const note = item.note ? `\n      note: ${item.note}` : "";
		return [
			`${STATUS_MARK[item.status]} ${item.id}. ${item.what}`,
			`      where: ${item.where}`,
			`      why:   ${item.why}${note}${describeHistory(item)}`,
		].join("\n");
	});
	const done = items.filter((item) => item.status === "done").length;
	const failed = items.filter((item) => item.status === "failed").length;
	const pending = items.length - done - failed;
	return [
		`Plan for TX-${String(transaction).padStart(2, "0")} — ${items.length} change${items.length === 1 ? "" : "s"}: ${done} landed, ${failed} failed, ${pending} still to do.`,
		"",
		...lines,
	].join("\n");
}

export function createPlanTool(options: PlanToolOptions): AgentTool {
	let items: PlanItem[] = [];
	let lastTransaction = options.controller.transaction;
	let declarationsIn = 0;
	/** The transaction that just closed, until a new plan is stated for this one. */
	let closedUnread: number | undefined;

	/**
	 * Close the open transaction's books.
	 *
	 * Everything it did is written into each item's history, and `done` goes
	 * back to `pending` because the rollback really did undo it. `failed` goes
	 * back too: the next transaction starts from the original file, so a change
	 * that failed against a half-edited one has not been tried against this one.
	 */
	function rollOver(closed: number): void {
		for (const item of items) {
			if (item.status !== "pending") {
				item.history.push({
					transaction: closed,
					status: item.status,
					note: item.note,
				});
			}
			item.status = "pending";
			item.note = undefined;
		}
		declarationsIn = 0;
		if (items.length > 0) {
			closedUnread = closed;
		}
	}

	function syncTransaction(): number {
		const transaction = options.controller.transaction;
		if (transaction !== lastTransaction) {
			rollOver(lastTransaction);
			lastTransaction = transaction;
		}
		return transaction;
	}

	function mark(
		id: unknown,
		status: Exclude<PlanItemStatus, "pending">,
		note: string,
		transaction: number,
	): string {
		if (typeof id !== "number" || !Number.isInteger(id)) {
			return `\`${status}\` needs the number of a plan item. ${renderPlan(items, transaction)}`;
		}
		const item = items.find((candidate) => candidate.id === id);
		if (!item) {
			return items.length === 0
				? "There is no plan yet, so there is no item to mark. Send `changes` first."
				: `There is no item ${id} in this plan.\n\n${renderPlan(items, transaction)}`;
		}
		item.status = status;
		item.note = note || undefined;
		options.onPlan?.(items);
		return withRetrospective(renderPlan(items, transaction), false);
	}

	/**
	 * The retrospective, if one is owed, followed by whatever the call produced.
	 *
	 * Owed exactly once per rollover: it is cleared by the plan that answers it,
	 * so a model that reads the plan twice does not get told twice.
	 */
	function withRetrospective(rest: string, clear: boolean): string {
		if (closedUnread === undefined) {
			return rest;
		}
		const head = renderRetrospective(items, closedUnread);
		if (clear) {
			closedUnread = undefined;
		}
		return `${head}\n\n${rest}`;
	}

	return createTool({
		name: PLAN_TOOL_NAME,
		description: PLAN_TOOL_DESCRIPTION,
		inputSchema: PLAN_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
		execute: async (input: unknown): Promise<string> => {
			const transaction = syncTransaction();
			const args = (input ?? {}) as {
				changes?: unknown;
				done?: unknown;
				failed?: unknown;
				note?: unknown;
			};
			const note = trimField(args.note);

			if (args.done !== undefined) {
				return mark(args.done, "done", note, transaction);
			}
			if (args.failed !== undefined) {
				return mark(args.failed, "failed", note, transaction);
			}

			if (args.changes === undefined) {
				// A bare call is a read, and a read is worth answering: it is the
				// cheapest way for the model to get the record back in front of it.
				// It does not clear an owed retrospective: reading is not answering.
				return withRetrospective(renderPlan(items, transaction), false);
			}

			if (!Array.isArray(args.changes)) {
				return "`changes` is a list of entries, each naming where, what and why.";
			}

			if (declarationsIn >= MAX_DECLARATIONS_PER_TRANSACTION) {
				return `You have stated a plan ${MAX_DECLARATIONS_PER_TRANSACTION} times in this transaction. Restating it is not progress — the plan below is the one you have. Mark items \`done\` as they land, and make the next change.\n\n${renderPlan(items, transaction)}`;
			}

			const parsed: Omit<PlanItem, "id" | "status" | "history">[] = [];
			for (const raw of args.changes) {
				const entry = (raw ?? {}) as Record<string, unknown>;
				const where = trimField(entry.where);
				const what = trimField(entry.what);
				const why = trimField(entry.why);
				if (!where || !what || !why) {
					return "Every entry needs all three of `where`, `what` and `why`. An entry missing one of them is not a change anyone can check.";
				}
				parsed.push({ where, what, why });
			}

			if (parsed.length === 0) {
				return "An empty list is not a plan. Send the changes you intend to make.";
			}

			const budget = options.maxChanges;
			if (parsed.length > budget) {
				return `That is ${parsed.length} changes and this transaction allows ${budget}. Send the ${budget} that matter most; the rest can have a transaction of their own.`;
			}

			// Replaces rather than appends. A restated plan is the model's current
			// intent, and carrying dead items alongside it is how the list stopped
			// being readable in the first place. History is preserved for an item
			// whose WHAT is unchanged, so marking one done and then restating the
			// plan does not quietly erase that it worked.
			const previous = items;
			items = parsed.map((entry, index) => {
				const match = previous.find(
					(candidate) => candidate.what === entry.what,
				);
				return {
					id: index + 1,
					...entry,
					status: match?.status ?? "pending",
					note: match?.note,
					history: match ? [...match.history] : [],
				};
			});
			declarationsIn += 1;
			options.onPlan?.(items);
			// Stating the plan is the DIFFERENT the retrospective asked for, so
			// this is the call that answers it.
			return withRetrospective(renderPlan(items, transaction), true);
		},
	});
}
