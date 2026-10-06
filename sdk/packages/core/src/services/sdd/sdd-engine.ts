/**
 * The engine behind the spec-driven skills.
 *
 * The plan of a piece of software — what is wanted, the milestones, their
 * slices, each slice's tasks, and what was proved along the way — is kept in
 * one SQLite file, `.sdd/sdd.db` in the project. The database is the truth.
 * The markdown beside it is written from it, for people to read and to
 * review in a diff; nothing is read back from those files.
 *
 * Why a database and not the files: a model that keeps its place by reading
 * and ticking markdown has to get every read and every edit right, and a
 * small model does not. Here the order of the work is the engine's. It
 * refuses a step that is out of turn and says why, and `next()` answers
 * "what do I do now" with the one step that is due and everything that step
 * needs.
 *
 * The hierarchy and the order of the phases are those of Get Shit Done
 * (GSD 2, https://getshitdone.help/), which also keeps its state in a
 * database and dispatches each step itself.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";

export const SDD_DIRECTORY = ".sdd";
export const SDD_DATABASE = "sdd.db";

export type RequirementStatus =
	| "active"
	| "validated"
	| "deferred"
	| "out_of_scope";
export type MilestoneStatus = "open" | "complete";
export type SliceStatus = "pending" | "done";
export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";
export type Verdict = "pass" | "needs_remediation";
export type UatResult = "pass" | "fail" | "needs_human";

export interface SddRequirement {
	id: string;
	title: string;
	description: string;
	status: RequirementStatus;
	/** The slice that owns it, as `M001/S01`, once a roadmap names one. */
	owner?: string;
}

export interface SddMilestone {
	id: string;
	title: string;
	context: string;
	status: MilestoneStatus;
	requirementsApproved: boolean;
	roadmapApproved: boolean;
	verdict?: Verdict;
	validation?: string;
	summary?: string;
}

export interface SddSlice {
	milestone: string;
	id: string;
	title: string;
	goal: string;
	demo: string;
	depends: string[];
	status: SliceStatus;
	research?: string;
	summary?: string;
	replans: number;
	uat: { check: string; result: UatResult; note?: string }[];
}

export interface SddTask {
	milestone: string;
	slice: string;
	id: string;
	title: string;
	steps: string;
	files: string[];
	verify: string;
	expect?: string;
	status: TaskStatus;
	summary?: string;
	evidence?: string;
	blocker?: string;
}

export interface SliceInput {
	title: string;
	goal?: string;
	demo?: string;
	depends?: string[];
	requirements?: string[];
}

export interface TaskInput {
	title: string;
	steps: string;
	files?: string[];
	verify: string;
	expect?: string;
}

export type SddStep =
	| "discuss_project"
	| "discuss_milestone"
	| "approve_requirements"
	| "plan_milestone"
	| "approve_roadmap"
	| "plan_slice"
	| "execute_task"
	| "resume_task"
	| "replan_slice"
	| "close_slice"
	| "validate_milestone"
	| "complete_milestone"
	| "stuck";

export interface SddNext {
	step: SddStep;
	/** `M001`, `M001/S01` or `M001/S01/T01`: what the step is about. */
	ref?: string;
	/** Whether the step is the user's to answer, so auto mode stops here. */
	needsUser: boolean;
	/** What to do, with everything the step needs. */
	instruction: string;
}

/** A step asked for out of turn, or with something missing. The message says what to do instead. */
export class SddRuleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SddRuleError";
	}
}

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS project (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	`CREATE TABLE IF NOT EXISTS requirements (
		n INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'active', owner TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS decisions (
		n INTEGER PRIMARY KEY, title TEXT NOT NULL, choice TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
	)`,
	"CREATE TABLE IF NOT EXISTS knowledge (n INTEGER PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS captures (n INTEGER PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS quick (n INTEGER PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL)",
	`CREATE TABLE IF NOT EXISTS milestones (
		n INTEGER PRIMARY KEY, title TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'open',
		requirements_approved INTEGER NOT NULL DEFAULT 0, roadmap_approved INTEGER NOT NULL DEFAULT 0,
		verdict TEXT, validation TEXT, summary TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS slices (
		milestone INTEGER NOT NULL REFERENCES milestones(n) ON DELETE CASCADE, n INTEGER NOT NULL,
		title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', demo TEXT NOT NULL DEFAULT '',
		depends TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
		research TEXT, summary TEXT, replans INTEGER NOT NULL DEFAULT 0, uat TEXT NOT NULL DEFAULT '[]',
		PRIMARY KEY (milestone, n)
	)`,
	`CREATE TABLE IF NOT EXISTS tasks (
		milestone INTEGER NOT NULL, slice INTEGER NOT NULL, n INTEGER NOT NULL,
		title TEXT NOT NULL, steps TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]',
		verify TEXT NOT NULL, expect TEXT, status TEXT NOT NULL DEFAULT 'pending',
		summary TEXT, evidence TEXT, blocker TEXT,
		PRIMARY KEY (milestone, slice, n),
		FOREIGN KEY (milestone, slice) REFERENCES slices(milestone, n) ON DELETE CASCADE
	)`,
	`CREATE TABLE IF NOT EXISTS journal (
		n INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, ref TEXT, text TEXT NOT NULL DEFAULT ''
	)`,
];

const pad = (n: number, width: number) => String(n).padStart(width, "0");
export const milestoneId = (n: number) => `M${pad(n, 3)}`;
export const sliceId = (n: number) => `S${pad(n, 2)}`;
export const taskId = (n: number) => `T${pad(n, 2)}`;
const requirementId = (n: number) => `R${pad(n, 3)}`;
const decisionId = (n: number) => `D${pad(n, 3)}`;

function json<T>(value: unknown, fallback: T): T {
	try {
		return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
	} catch {
		return fallback;
	}
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const optional = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;
const now = () => new Date().toISOString();

function need(value: string | undefined, what: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) {
		throw new SddRuleError(`${what} is missing. Give it and call again.`);
	}
	return trimmed;
}

type Row = Record<string, unknown>;

export class SddEngine {
	private readonly db: SqliteDb;
	/** The `.sdd` folder. */
	readonly directory: string;

	constructor(projectRoot: string) {
		this.directory = join(projectRoot, SDD_DIRECTORY);
		mkdirSync(this.directory, { recursive: true });
		this.db = loadSqliteDb(join(this.directory, SDD_DATABASE));
		// One file, with no -wal beside it: the plan is kept in the project and
		// travels with it, in version control if the project is in it.
		this.db.exec("PRAGMA journal_mode = DELETE;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		for (const statement of SCHEMA) this.db.exec(statement);
	}

	close(): void {
		this.db.close?.();
	}

	// ---- reading -----------------------------------------------------------

	private all(sql: string, ...args: unknown[]): Row[] {
		return this.db.prepare(sql).all(...args) as Row[];
	}

	private one(sql: string, ...args: unknown[]): Row | undefined {
		return this.db.prepare(sql).get(...args) as Row | undefined;
	}

	private run(sql: string, ...args: unknown[]) {
		return this.db.prepare(sql).run(...args);
	}

	private change<T>(
		action: string,
		ref: string | undefined,
		note: string,
		run: () => T,
	): T {
		let result: T;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			result = run();
			this.run(
				"INSERT INTO journal(at, action, ref, text) VALUES (?, ?, ?, ?)",
				now(),
				action,
				ref ?? null,
				note,
			);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		// The change stands whether or not the files could be written.
		try {
			this.render();
		} catch {
			// Rendered again after the next change.
		}
		return result;
	}

	project():
		| { name: string; description: string; agreements: string }
		| undefined {
		const rows = this.all("SELECT key, value FROM project");
		if (rows.length === 0) return undefined;
		const values = new Map(rows.map((row) => [text(row.key), text(row.value)]));
		return {
			name: values.get("name") ?? "",
			description: values.get("description") ?? "",
			agreements: values.get("agreements") ?? "",
		};
	}

	requirements(): SddRequirement[] {
		return this.all("SELECT * FROM requirements ORDER BY n").map((row) => ({
			id: requirementId(Number(row.n)),
			title: text(row.title),
			description: text(row.description),
			status: text(row.status) as RequirementStatus,
			owner: optional(row.owner),
		}));
	}

	decisions(): { id: string; title: string; choice: string; why: string }[] {
		return this.all("SELECT * FROM decisions ORDER BY n").map((row) => ({
			id: decisionId(Number(row.n)),
			title: text(row.title),
			choice: text(row.choice),
			why: text(row.why),
		}));
	}

	knowledge(): string[] {
		return this.all("SELECT text FROM knowledge ORDER BY n").map((row) =>
			text(row.text),
		);
	}

	captures(): string[] {
		return this.all("SELECT text FROM captures ORDER BY n").map((row) =>
			text(row.text),
		);
	}

	private toMilestone(row: Row): SddMilestone {
		return {
			id: milestoneId(Number(row.n)),
			title: text(row.title),
			context: text(row.context),
			status: text(row.status) as MilestoneStatus,
			requirementsApproved: Number(row.requirements_approved) === 1,
			roadmapApproved: Number(row.roadmap_approved) === 1,
			verdict: optional(row.verdict) as Verdict | undefined,
			validation: optional(row.validation),
			summary: optional(row.summary),
		};
	}

	milestones(): SddMilestone[] {
		return this.all("SELECT * FROM milestones ORDER BY n").map((row) =>
			this.toMilestone(row),
		);
	}

	/** The milestone being worked on: the first that is not complete. */
	activeMilestone(): SddMilestone | undefined {
		return this.milestones().find(
			(milestone) => milestone.status !== "complete",
		);
	}

	private toSlice(row: Row): SddSlice {
		return {
			milestone: milestoneId(Number(row.milestone)),
			id: sliceId(Number(row.n)),
			title: text(row.title),
			goal: text(row.goal),
			demo: text(row.demo),
			depends: json<string[]>(row.depends, []),
			status: text(row.status) as SliceStatus,
			research: optional(row.research),
			summary: optional(row.summary),
			replans: Number(row.replans),
			uat: json<SddSlice["uat"]>(row.uat, []),
		};
	}

	slices(milestone: string): SddSlice[] {
		return this.all(
			"SELECT * FROM slices WHERE milestone = ? ORDER BY n",
			number(milestone),
		).map((row) => this.toSlice(row));
	}

	private toTask(row: Row): SddTask {
		return {
			milestone: milestoneId(Number(row.milestone)),
			slice: sliceId(Number(row.slice)),
			id: taskId(Number(row.n)),
			title: text(row.title),
			steps: text(row.steps),
			files: json<string[]>(row.files, []),
			verify: text(row.verify),
			expect: optional(row.expect),
			status: text(row.status) as TaskStatus,
			summary: optional(row.summary),
			evidence: optional(row.evidence),
			blocker: optional(row.blocker),
		};
	}

	tasks(milestone: string, slice: string): SddTask[] {
		return this.all(
			"SELECT * FROM tasks WHERE milestone = ? AND slice = ? ORDER BY n",
			number(milestone),
			number(slice),
		).map((row) => this.toTask(row));
	}

	journal(
		limit = 20,
	): { at: string; action: string; ref?: string; text: string }[] {
		return this.all("SELECT * FROM journal ORDER BY n DESC LIMIT ?", limit).map(
			(row) => ({
				at: text(row.at),
				action: text(row.action),
				ref: optional(row.ref),
				text: text(row.text),
			}),
		);
	}

	// ---- references --------------------------------------------------------

	private milestoneOf(ref?: string): SddMilestone {
		const wanted = ref?.match(/M0*(\d+)/i)?.[1];
		const milestone = wanted
			? this.milestones().find((entry) => number(entry.id) === Number(wanted))
			: this.activeMilestone();
		if (!milestone) {
			throw new SddRuleError(
				wanted
					? `There is no milestone M${pad(Number(wanted), 3)}. Milestones: ${
							this.milestones()
								.map((entry) => entry.id)
								.join(", ") || "none"
						}.`
					: "There is no open milestone. Add one with add_milestone.",
			);
		}
		return milestone;
	}

	/** `S02`, `M001/S02` or nothing (the slice that is due). */
	private sliceOf(ref?: string): SddSlice {
		const milestone = this.milestoneOf(ref);
		const all = this.slices(milestone.id);
		const wanted = ref?.match(/S0*(\d+)/i)?.[1];
		const slice = wanted
			? all.find((entry) => number(entry.id) === Number(wanted))
			: this.dueSlice(milestone.id);
		if (!slice) {
			throw new SddRuleError(
				wanted
					? `There is no slice S${pad(Number(wanted), 2)} in ${milestone.id}. Its slices: ${all.map((entry) => entry.id).join(", ") || "none"}.`
					: `No slice of ${milestone.id} is due. Call next.`,
			);
		}
		return slice;
	}

	private taskOf(ref?: string): SddTask {
		const slice = this.sliceOf(ref);
		const all = this.tasks(slice.milestone, slice.id);
		const wanted = ref?.match(/T0*(\d+)/i)?.[1];
		const task = wanted
			? all.find((entry) => number(entry.id) === Number(wanted))
			: (all.find((entry) => entry.status === "in_progress") ??
				all.find((entry) => entry.status === "pending"));
		if (!task) {
			throw new SddRuleError(
				wanted
					? `There is no task T${pad(Number(wanted), 2)} in ${slice.milestone}/${slice.id}. Its tasks: ${all.map((entry) => entry.id).join(", ") || "none"}.`
					: `${slice.milestone}/${slice.id} has no task waiting. Call next.`,
			);
		}
		return task;
	}

	/** The first slice not done whose dependencies are all done. */
	private dueSlice(milestone: string): SddSlice | undefined {
		const all = this.slices(milestone);
		const done = new Set(
			all.filter((slice) => slice.status === "done").map((slice) => slice.id),
		);
		return all.find(
			(slice) =>
				slice.status !== "done" && slice.depends.every((id) => done.has(id)),
		);
	}

	// ---- the specification -------------------------------------------------

	setProject(input: {
		name?: string;
		description?: string;
		agreements?: string;
	}): void {
		const existing = this.project();
		const name = input.name?.trim() || existing?.name;
		const description = input.description?.trim() || existing?.description;
		need(name, "The project's name");
		need(
			description,
			"A description of the project (what it is and who it is for)",
		);
		this.change("set_project", undefined, name ?? "", () => {
			for (const [key, value] of Object.entries({
				name,
				description,
				agreements: input.agreements?.trim() ?? existing?.agreements ?? "",
			})) {
				this.run(
					"INSERT INTO project(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					key,
					value ?? "",
				);
			}
		});
	}

	addRequirement(input: {
		title: string;
		description?: string;
		status?: RequirementStatus;
	}): string {
		const title = need(input.title, "The requirement's title");
		const milestone = this.activeMilestone();
		return this.change("add_requirement", undefined, title, () => {
			const result = this.run(
				"INSERT INTO requirements(title, description, status) VALUES (?, ?, ?)",
				title,
				input.description?.trim() ?? "",
				input.status ?? "active",
			);
			// What is wanted changed, so what was agreed to no longer covers it.
			if (milestone && (input.status ?? "active") === "active") {
				this.run(
					"UPDATE milestones SET requirements_approved = 0 WHERE n = ?",
					number(milestone.id),
				);
			}
			return requirementId(Number(result.lastInsertRowid));
		});
	}

	updateRequirement(
		id: string,
		patch: { status?: RequirementStatus; title?: string; description?: string },
	): void {
		const n = number(id);
		const existing = this.one("SELECT * FROM requirements WHERE n = ?", n);
		if (!existing) {
			throw new SddRuleError(
				`There is no requirement ${id}. Requirements: ${
					this.requirements()
						.map((entry) => entry.id)
						.join(", ") || "none"
				}.`,
			);
		}
		this.change("update_requirement", id, patch.status ?? "edited", () => {
			this.run(
				"UPDATE requirements SET status = ?, title = ?, description = ? WHERE n = ?",
				patch.status ?? text(existing.status),
				patch.title?.trim() || text(existing.title),
				patch.description?.trim() ?? text(existing.description),
				n,
			);
		});
	}

	addDecision(input: { title: string; choice: string; why?: string }): string {
		const title = need(input.title, "The decision's title");
		const choice = need(input.choice, "What was chosen");
		return this.change("add_decision", undefined, title, () =>
			decisionId(
				Number(
					this.run(
						"INSERT INTO decisions(title, choice, why, at) VALUES (?, ?, ?, ?)",
						title,
						choice,
						input.why?.trim() ?? "",
						now(),
					).lastInsertRowid,
				),
			),
		);
	}

	addKnowledge(note: string): void {
		const value = need(note, "The note");
		this.change("add_knowledge", undefined, value, () => {
			this.run("INSERT INTO knowledge(text, at) VALUES (?, ?)", value, now());
		});
	}

	/** A thought that is not for now, kept so it is not lost. */
	capture(note: string): void {
		const value = need(note, "The thought to keep");
		this.change("capture", undefined, value, () => {
			this.run("INSERT INTO captures(text, at) VALUES (?, ?)", value, now());
		});
	}

	quick(input: { title: string; summary: string }): string {
		const title = need(input.title, "What the quick change was");
		const summary = need(
			input.summary,
			"What was changed and how it was verified",
		);
		return this.change(
			"quick",
			undefined,
			title,
			() =>
				`Q${pad(Number(this.run("INSERT INTO quick(title, summary, at) VALUES (?, ?, ?)", title, summary, now()).lastInsertRowid), 3)}`,
		);
	}

	// ---- milestones --------------------------------------------------------

	addMilestone(input: { title: string; context: string }): string {
		if (!this.project()) {
			throw new SddRuleError(
				"The project is not described yet. Call set_project first.",
			);
		}
		const open = this.activeMilestone();
		if (open) {
			throw new SddRuleError(
				`${open.id} "${open.title}" is still open. Finish it first, or keep this idea with capture.`,
			);
		}
		const title = need(input.title, "The milestone's title");
		const context = need(
			input.context,
			"The milestone's context (the agreed scope and goals)",
		);
		return this.change("add_milestone", undefined, title, () =>
			milestoneId(
				Number(
					this.run(
						"INSERT INTO milestones(title, context) VALUES (?, ?)",
						title,
						context,
					).lastInsertRowid,
				),
			),
		);
	}

	/** Change the open milestone's title or context, when the user changes course. */
	updateMilestone(input: { title?: string; context?: string }): void {
		const milestone = this.milestoneOf();
		if (!input.title?.trim() && !input.context?.trim()) {
			throw new SddRuleError("Give the new title or the new context.");
		}
		this.change(
			"update_milestone",
			milestone.id,
			input.title?.trim() ?? "context",
			() => {
				this.run(
					"UPDATE milestones SET title = ?, context = ? WHERE n = ?",
					input.title?.trim() || milestone.title,
					input.context?.trim() || milestone.context,
					number(milestone.id),
				);
			},
		);
	}

	/** Record that the user approved the requirements or the roadmap. */
	approve(what: "requirements" | "roadmap"): void {
		const milestone = this.milestoneOf();
		if (what === "requirements") {
			if (!this.requirements().some((entry) => entry.status === "active")) {
				throw new SddRuleError(
					"There are no active requirements to approve. Add them with add_requirement.",
				);
			}
			this.change("approve", milestone.id, "requirements", () => {
				this.run(
					"UPDATE milestones SET requirements_approved = 1 WHERE n = ?",
					number(milestone.id),
				);
			});
			return;
		}
		if (!milestone.requirementsApproved) {
			throw new SddRuleError(
				"The requirements are not approved yet. That comes before the roadmap.",
			);
		}
		if (this.slices(milestone.id).length === 0) {
			throw new SddRuleError(
				`${milestone.id} has no roadmap to approve. Call plan_milestone first.`,
			);
		}
		this.change("approve", milestone.id, "roadmap", () => {
			this.run(
				"UPDATE milestones SET roadmap_approved = 1 WHERE n = ?",
				number(milestone.id),
			);
		});
	}

	private insertSlices(
		milestone: SddMilestone,
		slices: readonly SliceInput[],
	): string[] {
		const existing = this.slices(milestone.id);
		let n = existing.reduce((max, slice) => Math.max(max, number(slice.id)), 0);
		const known = new Set(existing.map((slice) => slice.id));
		const requirementIds = new Set(
			this.requirements().map((entry) => entry.id),
		);
		const ids: string[] = [];
		for (const input of slices) {
			const title = need(input.title, "A slice's title");
			n++;
			const id = sliceId(n);
			const depends = (input.depends ?? []).map((ref) => {
				const match = ref.match(/S0*(\d+)/i);
				const dependency = match ? sliceId(Number(match[1])) : ref;
				if (!known.has(dependency)) {
					throw new SddRuleError(
						`Slice "${title}" depends on ${ref}, which is not an earlier slice of ${milestone.id}. A slice can only depend on slices listed before it.`,
					);
				}
				return dependency;
			});
			this.run(
				"INSERT INTO slices(milestone, n, title, goal, demo, depends) VALUES (?, ?, ?, ?, ?, ?)",
				number(milestone.id),
				n,
				title,
				input.goal?.trim() ?? "",
				input.demo?.trim() ?? "",
				JSON.stringify(depends),
			);
			for (const ref of input.requirements ?? []) {
				const match = ref.match(/R0*(\d+)/i);
				const requirement = match ? requirementId(Number(match[1])) : ref;
				if (!requirementIds.has(requirement)) {
					throw new SddRuleError(
						`Slice "${title}" names requirement ${ref}, which does not exist.`,
					);
				}
				this.run(
					"UPDATE requirements SET owner = ? WHERE n = ?",
					`${milestone.id}/${id}`,
					number(requirement),
				);
			}
			known.add(id);
			ids.push(id);
		}
		return ids;
	}

	/** The roadmap: the milestone cut into slices. Replaces an unapproved roadmap. */
	planMilestone(slices: readonly SliceInput[], ref?: string): string[] {
		const milestone = this.milestoneOf(ref);
		if (!milestone.requirementsApproved) {
			throw new SddRuleError(
				'The requirements are not approved. Show them to the user, and call approve with what: "requirements" once they agree.',
			);
		}
		if (milestone.roadmapApproved) {
			throw new SddRuleError(
				`The roadmap of ${milestone.id} is approved. It is not replaced; a change to what is left goes through the user, then add_slices.`,
			);
		}
		if (slices.length === 0) {
			throw new SddRuleError("A roadmap needs at least one slice.");
		}
		return this.change(
			"plan_milestone",
			milestone.id,
			`${slices.length} slices`,
			() => {
				this.run("DELETE FROM tasks WHERE milestone = ?", number(milestone.id));
				this.run(
					"DELETE FROM slices WHERE milestone = ?",
					number(milestone.id),
				);
				this.run(
					"UPDATE requirements SET owner = NULL WHERE owner LIKE ?",
					`${milestone.id}/%`,
				);
				const ids = this.insertSlices(milestone, slices);
				const unowned = this.requirements().filter(
					(entry) => entry.status === "active" && !entry.owner,
				);
				if (unowned.length > 0) {
					throw new SddRuleError(
						`No slice owns ${unowned.map((entry) => `${entry.id} "${entry.title}"`).join(", ")}. Every active requirement belongs to a slice: name it in a slice's requirements, or defer it with update_requirement.`,
					);
				}
				return ids;
			},
		);
	}

	/** Slices added to an approved roadmap: remediation, or new scope the user agreed to. */
	addSlices(slices: readonly SliceInput[], ref?: string): string[] {
		const milestone = this.milestoneOf(ref);
		if (slices.length === 0) throw new SddRuleError("Give at least one slice.");
		return this.change(
			"add_slices",
			milestone.id,
			`${slices.length} slices`,
			() => {
				const ids = this.insertSlices(milestone, slices);
				// The audit judged a milestone that has since grown.
				this.run(
					"UPDATE milestones SET verdict = NULL WHERE n = ?",
					number(milestone.id),
				);
				return ids;
			},
		);
	}

	/** Take a slice that has not produced anything off the roadmap. */
	removeSlice(input: { slice: string; reason: string }): void {
		if (!/S0*\d+/i.test(input.slice ?? "")) {
			throw new SddRuleError("Name the slice to remove, e.g. S03.");
		}
		const slice = this.sliceOf(input.slice);
		const reason = need(input.reason, "The reason the slice is removed");
		const ref = `${slice.milestone}/${slice.id}`;
		if (
			slice.status === "done" ||
			this.tasks(slice.milestone, slice.id).some(
				(task) => task.status !== "pending",
			)
		) {
			throw new SddRuleError(
				`${slice.id} has work in it and stays on the record. What it built can be changed by a new slice.`,
			);
		}
		const dependant = this.slices(slice.milestone).find((other) =>
			other.depends.includes(slice.id),
		);
		if (dependant) {
			throw new SddRuleError(
				`${dependant.id} "${dependant.title}" depends on ${slice.id}. Remove that one first.`,
			);
		}
		const owned = this.requirements().filter(
			(entry) => entry.owner === ref && entry.status === "active",
		);
		if (owned.length > 0) {
			throw new SddRuleError(
				`${slice.id} owns ${owned.map((entry) => entry.id).join(", ")}. Defer them or put them out of scope with update_requirement first, so nothing wanted is left without a slice.`,
			);
		}
		this.change("remove_slice", ref, reason, () => {
			this.run(
				"DELETE FROM tasks WHERE milestone = ? AND slice = ?",
				number(slice.milestone),
				number(slice.id),
			);
			this.run(
				"DELETE FROM slices WHERE milestone = ? AND n = ?",
				number(slice.milestone),
				number(slice.id),
			);
			this.run("UPDATE requirements SET owner = NULL WHERE owner = ?", ref);
		});
	}

	// ---- slices ------------------------------------------------------------

	private insertTasks(
		slice: SddSlice,
		tasks: readonly TaskInput[],
		from: number,
	): string[] {
		let n = from;
		return tasks.map((input) => {
			const title = need(input.title, "A task's title");
			const steps = need(input.steps, `The steps of task "${title}"`);
			const verify = need(
				input.verify,
				`The command that proves task "${title}" (verify)`,
			);
			n++;
			this.run(
				"INSERT INTO tasks(milestone, slice, n, title, steps, files, verify, expect) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				number(slice.milestone),
				number(slice.id),
				n,
				title,
				steps,
				JSON.stringify(input.files ?? []),
				verify,
				input.expect?.trim() || null,
			);
			return taskId(n);
		});
	}

	planSlice(input: {
		slice?: string;
		research?: string;
		tasks: readonly TaskInput[];
	}): string[] {
		const slice = this.sliceOf(input.slice);
		const milestone = this.milestoneOf(slice.milestone);
		if (!milestone.roadmapApproved) {
			throw new SddRuleError(
				'The roadmap is not approved. Show it to the user, and call approve with what: "roadmap" once they agree.',
			);
		}
		if (slice.status === "done") {
			throw new SddRuleError(
				`${slice.id} is done. Completed slices are not replanned; new work is a new slice.`,
			);
		}
		const due = this.dueSlice(slice.milestone);
		if (due?.id !== slice.id) {
			throw new SddRuleError(
				`${slice.id} is not the slice that is due${due ? `; ${due.id} "${due.title}" is` : ""}. Slices are planned one at a time, when their turn comes, so the plan is made with what the earlier ones taught.`,
			);
		}
		const existing = this.tasks(slice.milestone, slice.id);
		if (existing.some((task) => task.status !== "pending")) {
			throw new SddRuleError(
				`${slice.id} is already being executed. To change its remaining tasks, call replan_slice with the reason.`,
			);
		}
		if (input.tasks.length === 0)
			throw new SddRuleError("A slice plan needs at least one task.");
		return this.change(
			"plan_slice",
			`${slice.milestone}/${slice.id}`,
			`${input.tasks.length} tasks`,
			() => {
				this.run(
					"DELETE FROM tasks WHERE milestone = ? AND slice = ?",
					number(slice.milestone),
					number(slice.id),
				);
				if (input.research?.trim()) {
					this.run(
						"UPDATE slices SET research = ? WHERE milestone = ? AND n = ?",
						input.research.trim(),
						number(slice.milestone),
						number(slice.id),
					);
				}
				return this.insertTasks(slice, input.tasks, 0);
			},
		);
	}

	/** Replace the tasks that are not done, after a blocker or a plan that proved wrong. */
	replanSlice(input: {
		slice?: string;
		reason: string;
		tasks: readonly TaskInput[];
	}): string[] {
		const slice = this.sliceOf(input.slice);
		const reason = need(input.reason, "The reason for the replan");
		if (slice.status === "done")
			throw new SddRuleError(`${slice.id} is done and is not replanned.`);
		if (input.tasks.length === 0)
			throw new SddRuleError("A replan needs at least one task.");
		const done = this.tasks(slice.milestone, slice.id).filter(
			(task) => task.status === "done",
		);
		return this.change(
			"replan_slice",
			`${slice.milestone}/${slice.id}`,
			reason,
			() => {
				this.run(
					"DELETE FROM tasks WHERE milestone = ? AND slice = ? AND status != 'done'",
					number(slice.milestone),
					number(slice.id),
				);
				this.run(
					"UPDATE slices SET replans = replans + 1 WHERE milestone = ? AND n = ?",
					number(slice.milestone),
					number(slice.id),
				);
				return this.insertTasks(
					slice,
					input.tasks,
					done.reduce((max, task) => Math.max(max, number(task.id)), 0),
				);
			},
		);
	}

	// ---- tasks -------------------------------------------------------------

	private setTask(task: SddTask, fields: Record<string, unknown>): void {
		const keys = Object.keys(fields);
		this.run(
			`UPDATE tasks SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE milestone = ? AND slice = ? AND n = ?`,
			...keys.map((key) => fields[key]),
			number(task.milestone),
			number(task.slice),
			number(task.id),
		);
	}

	startTask(ref?: string): SddTask {
		const task = this.taskOf(ref);
		const all = this.tasks(task.milestone, task.slice);
		const due = this.dueSlice(task.milestone);
		if (due?.id !== task.slice) {
			throw new SddRuleError(
				`${task.slice} is not the slice that is due${due ? `; ${due.id} is` : ""}.`,
			);
		}
		if (task.status === "done")
			throw new SddRuleError(`${task.id} is already done.`);
		const running = all.find(
			(entry) => entry.status === "in_progress" && entry.id !== task.id,
		);
		if (running) {
			throw new SddRuleError(
				`${running.id} "${running.title}" is in progress. Finish it with complete_task, or report what stops it with block_task, before starting another.`,
			);
		}
		const earlier = all.find(
			(entry) => number(entry.id) < number(task.id) && entry.status !== "done",
		);
		if (earlier) {
			throw new SddRuleError(
				`${earlier.id} "${earlier.title}" comes first and is not done.`,
			);
		}
		this.change(
			"start_task",
			`${task.milestone}/${task.slice}/${task.id}`,
			task.title,
			() => {
				this.setTask(task, { status: "in_progress", blocker: null });
			},
		);
		return { ...task, status: "in_progress" };
	}

	completeTask(input: {
		task?: string;
		summary: string;
		evidence: string;
	}): void {
		const task = this.taskOf(input.task);
		// A task that is due and was done without being announced is still done
		// in its turn: starting it here keeps the order and spares a round trip.
		if (task.status === "pending") {
			this.startTask(`${task.milestone}/${task.slice}/${task.id}`);
		} else if (task.status !== "in_progress") {
			throw new SddRuleError(`${task.id} is ${task.status}.`);
		}
		const summary = need(input.summary, "A summary of what was changed");
		const evidence = need(
			input.evidence,
			`The evidence: the output of \`${task.verify}\` as it ran in the workspace`,
		);
		this.change(
			"complete_task",
			`${task.milestone}/${task.slice}/${task.id}`,
			summary,
			() => {
				this.setTask(task, { status: "done", summary, evidence });
			},
		);
	}

	blockTask(input: { task?: string; reason: string }): void {
		const task = this.taskOf(input.task);
		const reason = need(input.reason, "What blocks the task");
		if (task.status === "done") throw new SddRuleError(`${task.id} is done.`);
		this.change(
			"block_task",
			`${task.milestone}/${task.slice}/${task.id}`,
			reason,
			() => {
				this.setTask(task, { status: "blocked", blocker: reason });
			},
		);
	}

	/** Close a slice: its summary and how its acceptance checks went. */
	completeSlice(input: {
		slice?: string;
		summary: string;
		uat: readonly { check: string; result: UatResult; note?: string }[];
	}): void {
		const slice = this.sliceOf(input.slice);
		if (slice.status === "done")
			throw new SddRuleError(`${slice.id} is already done.`);
		const tasks = this.tasks(slice.milestone, slice.id);
		const open = tasks.filter((task) => task.status !== "done");
		if (tasks.length === 0 || open.length > 0) {
			throw new SddRuleError(
				tasks.length === 0
					? `${slice.id} has no tasks. Plan it first.`
					: `${slice.id} still has ${open.map((task) => `${task.id} (${task.status})`).join(", ")}. A slice closes when every task is done.`,
			);
		}
		const summary = need(input.summary, "The slice's summary");
		if (input.uat.length === 0) {
			throw new SddRuleError(
				"A slice closes with its acceptance checks: give uat, one entry per check with how it went (pass, fail or needs_human).",
			);
		}
		const failed = input.uat.filter((entry) => entry.result === "fail");
		if (failed.length > 0) {
			throw new SddRuleError(
				`${failed.length} acceptance check(s) failed: ${failed.map((entry) => entry.check).join("; ")}. The slice is not done. Fix it with replan_slice (new tasks), then close it again.`,
			);
		}
		this.change(
			"complete_slice",
			`${slice.milestone}/${slice.id}`,
			summary,
			() => {
				this.run(
					"UPDATE slices SET status = 'done', summary = ?, uat = ? WHERE milestone = ? AND n = ?",
					summary,
					JSON.stringify(input.uat),
					number(slice.milestone),
					number(slice.id),
				);
				this.run(
					"UPDATE requirements SET status = 'validated' WHERE owner = ? AND status = 'active'",
					`${slice.milestone}/${slice.id}`,
				);
			},
		);
	}

	validateMilestone(input: {
		verdict: Verdict;
		findings: string;
		remediation?: readonly SliceInput[];
	}): string[] {
		const milestone = this.milestoneOf();
		const open = this.slices(milestone.id).filter(
			(slice) => slice.status !== "done",
		);
		if (this.slices(milestone.id).length === 0 || open.length > 0) {
			throw new SddRuleError(
				`${milestone.id} is audited when every slice is done; ${open.map((slice) => slice.id).join(", ") || "it has none yet"}.`,
			);
		}
		const findings = need(input.findings, "The findings of the audit");
		if (input.verdict === "needs_remediation" && !input.remediation?.length) {
			throw new SddRuleError(
				"needs_remediation comes with the slices that fix what was found: give them in remediation.",
			);
		}
		return this.change(
			"validate_milestone",
			milestone.id,
			input.verdict,
			() => {
				const ids =
					input.verdict === "needs_remediation"
						? this.insertSlices(milestone, input.remediation ?? [])
						: [];
				this.run(
					"UPDATE milestones SET verdict = ?, validation = ? WHERE n = ?",
					input.verdict,
					findings,
					number(milestone.id),
				);
				return ids;
			},
		);
	}

	completeMilestone(summary: string): void {
		const milestone = this.milestoneOf();
		if (
			milestone.verdict !== "pass" ||
			this.slices(milestone.id).some((slice) => slice.status !== "done")
		) {
			throw new SddRuleError(
				`${milestone.id} is completed after its audit passes. Call next.`,
			);
		}
		const value = need(summary, "The milestone's summary");
		this.change("complete_milestone", milestone.id, value, () => {
			this.run(
				"UPDATE milestones SET status = 'complete', summary = ? WHERE n = ?",
				value,
				number(milestone.id),
			);
		});
	}

	// ---- what is next ------------------------------------------------------

	next(): SddNext {
		const project = this.project();
		if (!project) {
			return {
				step: "discuss_project",
				needsUser: true,
				instruction:
					"Nothing is recorded yet. Find out from the user what is to be built, for whom, and what is out of scope; read the code that is already there. Then record it: set_project (name, description, agreements), one add_requirement per thing the result must do, and add_milestone (title, context) for the first deliverable.",
			};
		}
		const milestone = this.activeMilestone();
		if (!milestone) {
			return {
				step: "discuss_milestone",
				needsUser: true,
				instruction: `Every milestone of "${project.name}" is complete. Ask the user what comes next; add its requirements with add_requirement, then add_milestone (title, context).`,
			};
		}
		const slices = this.slices(milestone.id);
		for (const slice of slices) {
			const blocked = this.tasks(milestone.id, slice.id).find(
				(task) => task.status === "blocked",
			);
			if (blocked) {
				const ref = `${milestone.id}/${slice.id}`;
				return {
					step: "replan_slice",
					ref,
					needsUser: slice.replans >= 1,
					instruction: `${blocked.id} "${blocked.title}" of ${ref} is blocked: ${blocked.blocker}\n${slice.replans >= 1 ? `This slice was already replanned ${slice.replans} time(s). Stop and put the blocker to the user before planning again.` : "Work out what has to change, then call replan_slice with the reason and the new tasks. Tasks already done are kept."}`,
				};
			}
		}
		if (!milestone.requirementsApproved) {
			const active = this.requirements().filter(
				(entry) => entry.status === "active",
			);
			if (active.length === 0) {
				return {
					step: "approve_requirements",
					ref: milestone.id,
					needsUser: true,
					instruction: `${milestone.id} "${milestone.title}" has no requirements. Agree with the user what the result must do and add each with add_requirement.`,
				};
			}
			return {
				step: "approve_requirements",
				ref: milestone.id,
				needsUser: true,
				instruction: `Show the user these requirements for ${milestone.id} "${milestone.title}" and ask whether they are right and complete:\n${active.map((entry) => `- ${entry.id} ${entry.title}${entry.description ? `: ${entry.description}` : ""}`).join("\n")}\nChange them as the user says (add_requirement, update_requirement). When the user agrees, call approve with what: "requirements". Do not approve for them.`,
			};
		}
		if (slices.length === 0) {
			return {
				step: "plan_milestone",
				ref: milestone.id,
				needsUser: false,
				instruction: `Cut ${milestone.id} "${milestone.title}" into slices: each one a vertical piece that can be demonstrated on its own, riskiest first, each naming the requirements it delivers. Context: ${milestone.context}\nActive requirements: ${this.requirements()
					.filter((entry) => entry.status === "active")
					.map((entry) => `${entry.id} ${entry.title}`)
					.join(
						"; ",
					)}\nCall plan_milestone with slices: [{title, goal, demo, depends, requirements}]. Every active requirement must belong to a slice.`,
			};
		}
		if (!milestone.roadmapApproved) {
			return {
				step: "approve_roadmap",
				ref: milestone.id,
				needsUser: true,
				instruction: `Show the user the roadmap of ${milestone.id} and ask whether to build it this way:\n${slices.map((slice) => `- ${slice.id} ${slice.title}${slice.depends.length ? ` (after ${slice.depends.join(", ")})` : ""}${slice.demo ? `: ${slice.demo}` : ""}`).join("\n")}\nTo change it, call plan_milestone again. When the user agrees, call approve with what: "roadmap". No code is written before that.`,
			};
		}
		const due = this.dueSlice(milestone.id);
		if (due) {
			const ref = `${milestone.id}/${due.id}`;
			const tasks = this.tasks(milestone.id, due.id);
			if (tasks.length === 0) {
				const earlier = slices
					.filter((slice) => slice.status === "done" && slice.summary)
					.map((slice) => `- ${slice.id} ${slice.title}: ${slice.summary}`);
				return {
					step: "plan_slice",
					ref,
					needsUser: false,
					instruction: `Plan ${ref} "${due.title}". Goal: ${due.goal || "(none given)"}. It is demonstrated by: ${due.demo || "(none given)"}.\n${earlier.length ? `Done so far:\n${earlier.join("\n")}\n` : ""}Read the code it touches first. Then call plan_slice with tasks: [{title, steps, files, verify, expect}] — small tasks, in order, each with the files it changes, the steps, and the one command (verify) whose output proves it, with what that output should show (expect).`,
				};
			}
			const running = tasks.find((task) => task.status === "in_progress");
			const task = running ?? tasks.find((entry) => entry.status === "pending");
			if (task) {
				const taskRef = `${ref}/${task.id}`;
				const detail = `${taskRef} "${task.title}"\nSteps: ${task.steps}\nFiles: ${task.files.join(", ") || "(not named)"}\nVerify: ${task.verify}${task.expect ? `\nExpect: ${task.expect}` : ""}`;
				return running
					? {
							step: "resume_task",
							ref: taskRef,
							needsUser: false,
							instruction: `This task was started and not finished. Look at what is already changed in the workspace, then finish it.\n${detail}\nRun the verify command in the workspace. When it passes, call complete_task with summary and evidence (the command's real output). If it cannot be done as planned, call block_task with the reason.`,
						}
					: {
							step: "execute_task",
							ref: taskRef,
							needsUser: false,
							instruction: `Call start_task, then do exactly this task and nothing beyond it.\n${detail}\nRun the verify command in the workspace. When it passes, call complete_task with summary and evidence (the command's real output). If it cannot be done as planned, call block_task with the reason.`,
						};
			}
			return {
				step: "close_slice",
				ref,
				needsUser: false,
				instruction: `Every task of ${ref} "${due.title}" is done. Check the slice as a whole: run the project's tests, then do what demonstrates it (${due.demo || "its goal"}) and note how each check went. Call complete_slice with summary and uat: [{check, result: "pass" | "fail" | "needs_human", note}]. A check only a person can judge is needs_human; a failed check means new tasks through replan_slice.`,
			};
		}
		if (slices.some((slice) => slice.status !== "done")) {
			return {
				step: "stuck",
				ref: milestone.id,
				needsUser: true,
				instruction: `No slice of ${milestone.id} can start: each one left depends on a slice that is not done (${slices
					.filter((slice) => slice.status !== "done")
					.map((slice) => `${slice.id} after ${slice.depends.join(", ")}`)
					.join("; ")}). Put this to the user.`,
			};
		}
		if (milestone.verdict !== "pass") {
			return {
				step: "validate_milestone",
				ref: milestone.id,
				needsUser: false,
				instruction: `Every slice of ${milestone.id} "${milestone.title}" is done. Audit it against what was promised: for each requirement, find the evidence that it is met in the workspace as it is now.\n${this.requirements()
					.filter((entry) => entry.owner?.startsWith(milestone.id))
					.map((entry) => `- ${entry.id} ${entry.title} (${entry.owner})`)
					.join(
						"\n",
					)}\nCall validate_milestone with verdict "pass" and findings, or verdict "needs_remediation", findings, and remediation: the slices that fix what is missing.`,
			};
		}
		return {
			step: "complete_milestone",
			ref: milestone.id,
			needsUser: false,
			instruction: `The audit of ${milestone.id} passed. Call complete_milestone with a summary: what was built, what was learned, and what is left for later.`,
		};
	}

	// ---- reports -----------------------------------------------------------

	status(): string {
		const project = this.project();
		if (!project) {
			return "Spec-driven development has not been started in this project.";
		}
		const lines: string[] = [`Project: ${project.name}`];
		for (const milestone of this.milestones()) {
			const slices = this.slices(milestone.id);
			const done = slices.filter((slice) => slice.status === "done").length;
			lines.push(
				`${milestone.id} ${milestone.title}: ${milestone.status === "complete" ? "complete" : `${done} of ${slices.length} slices done`}`,
			);
			if (milestone.status === "complete") continue;
			const due = this.dueSlice(milestone.id);
			for (const slice of slices) {
				const tasks = this.tasks(milestone.id, slice.id);
				const tasksDone = tasks.filter((task) => task.status === "done").length;
				lines.push(
					`  [${slice.status === "done" ? "x" : " "}] ${slice.id} ${slice.title}${slice.status !== "done" && tasks.length ? `: ${tasksDone} of ${tasks.length} tasks done` : ""}${slice.depends.length && slice.status !== "done" ? ` (after ${slice.depends.join(", ")})` : ""}${due?.id === slice.id ? "   <- now" : ""}`,
				);
				for (const task of tasks.filter(
					(entry) => entry.status === "blocked",
				)) {
					lines.push(`      BLOCKED ${task.id} ${task.title}: ${task.blocker}`);
				}
			}
		}
		const requirements = this.requirements();
		const count = (status: RequirementStatus) =>
			requirements.filter((entry) => entry.status === status).length;
		lines.push(
			`Requirements: ${count("validated")} validated, ${count("active")} active, ${count("deferred")} deferred, ${count("out_of_scope")} out of scope`,
		);
		const human = this.milestones().flatMap((milestone) =>
			this.slices(milestone.id).flatMap((slice) =>
				slice.uat
					.filter((entry) => entry.result === "needs_human")
					.map((entry) => `${milestone.id}/${slice.id}: ${entry.check}`),
			),
		);
		if (human.length) lines.push(`Waiting on a person: ${human.join("; ")}`);
		const captures = this.captures();
		if (captures.length)
			lines.push(`Kept for later: ${captures.length} thought(s)`);
		const next = this.next();
		lines.push(
			`Next: ${next.step}${next.ref ? ` ${next.ref}` : ""}${next.needsUser ? " (needs the user)" : ""}`,
		);
		return lines.join("\n");
	}

	// ---- the files ---------------------------------------------------------

	/**
	 * Write the markdown from the database. Called after every change. The
	 * files are for reading and for review; nothing reads them back.
	 */
	render(): void {
		const header =
			"<!-- Written from .sdd/sdd.db by the sdd tool. Edits here are overwritten: change the plan through the tool. -->\n\n";
		const write = (name: string, body: string) => {
			const path = join(this.directory, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${header}${body.trimEnd()}\n`);
		};
		const project = this.project();
		if (!project) return;
		const captures = this.captures();
		write(
			"PROJECT.md",
			`# ${project.name}\n\n${project.description}\n\n## Working agreements\n\n${project.agreements || "None recorded."}\n${captures.length ? `\n## Later\n\n${captures.map((entry) => `- ${entry}`).join("\n")}\n` : ""}`,
		);
		const requirements = this.requirements();
		const group = (status: RequirementStatus, title: string) => {
			const entries = requirements.filter((entry) => entry.status === status);
			return entries.length
				? `## ${title}\n\n${entries.map((entry) => `- **${entry.id}** ${entry.title}${entry.owner ? ` (${entry.owner})` : ""}${entry.description ? `\n  ${entry.description}` : ""}`).join("\n")}\n\n`
				: "";
		};
		write(
			"REQUIREMENTS.md",
			`# Requirements\n\n${group("active", "Active")}${group("validated", "Validated")}${group("deferred", "Deferred")}${group("out_of_scope", "Out of scope")}`,
		);
		write(
			"DECISIONS.md",
			`# Decisions\n\n${
				this.decisions()
					.map(
						(entry) =>
							`## ${entry.id} ${entry.title}\n\n${entry.choice}${entry.why ? `\n\nWhy: ${entry.why}` : ""}`,
					)
					.join("\n\n") || "None yet."
			}`,
		);
		write(
			"KNOWLEDGE.md",
			`# Knowledge\n\n${
				this.knowledge()
					.map((entry) => `- ${entry}`)
					.join("\n") || "Nothing yet."
			}`,
		);
		write(
			"STATE.md",
			`# State\n\n\`\`\`\n${this.status()}\n\`\`\`\n\n## Next\n\n${this.next().instruction}`,
		);
		// The milestone folders are rebuilt whole, so a replaced plan leaves nothing behind.
		rmSync(join(this.directory, "milestones"), {
			recursive: true,
			force: true,
		});
		for (const milestone of this.milestones()) {
			const base = `milestones/${milestone.id}`;
			const slices = this.slices(milestone.id);
			write(
				`${base}/${milestone.id}-CONTEXT.md`,
				`# ${milestone.id} ${milestone.title}\n\n${milestone.context}`,
			);
			if (slices.length) {
				write(
					`${base}/${milestone.id}-ROADMAP.md`,
					`# ${milestone.id} roadmap${milestone.roadmapApproved ? "" : " (not approved yet)"}\n\n${slices.map((slice) => `- [${slice.status === "done" ? "x" : " "}] **${slice.id}** ${slice.title}${slice.depends.length ? ` (after ${slice.depends.join(", ")})` : ""}${slice.goal ? `\n  Goal: ${slice.goal}` : ""}${slice.demo ? `\n  Demo: ${slice.demo}` : ""}`).join("\n")}`,
				);
			}
			if (milestone.validation) {
				write(
					`${base}/${milestone.id}-VALIDATION.md`,
					`# ${milestone.id} validation: ${milestone.verdict ?? "superseded by added slices"}\n\n${milestone.validation}`,
				);
			}
			if (milestone.summary) {
				write(
					`${base}/${milestone.id}-SUMMARY.md`,
					`# ${milestone.id} ${milestone.title}\n\n${milestone.summary}`,
				);
			}
			for (const slice of slices) {
				const sliceBase = `${base}/slices/${slice.id}`;
				const tasks = this.tasks(milestone.id, slice.id);
				if (slice.research)
					write(
						`${sliceBase}/${slice.id}-RESEARCH.md`,
						`# ${slice.id} research\n\n${slice.research}`,
					);
				if (tasks.length) {
					write(
						`${sliceBase}/${slice.id}-PLAN.md`,
						`# ${slice.id} ${slice.title}${slice.replans ? ` (replanned ${slice.replans}x)` : ""}\n\n${tasks.map((task) => `- [${task.status === "done" ? "x" : " "}] **${task.id}** ${task.title}${task.status === "blocked" ? ` — BLOCKED: ${task.blocker}` : task.status === "in_progress" ? " — in progress" : ""}`).join("\n")}`,
					);
				}
				for (const task of tasks) {
					write(
						`${sliceBase}/tasks/${task.id}-PLAN.md`,
						`# ${task.id} ${task.title}\n\n## Steps\n\n${task.steps}\n\n## Files\n\n${task.files.map((file) => `- ${file}`).join("\n") || "Not named."}\n\n## Verify\n\n\`${task.verify}\`${task.expect ? `\n\nExpect: ${task.expect}` : ""}`,
					);
					if (task.summary) {
						write(
							`${sliceBase}/tasks/${task.id}-SUMMARY.md`,
							`# ${task.id} ${task.title}\n\n${task.summary}\n\n## Evidence\n\n\`\`\`\n${task.evidence ?? ""}\n\`\`\``,
						);
					}
				}
				if (slice.summary) {
					write(
						`${sliceBase}/${slice.id}-SUMMARY.md`,
						`# ${slice.id} ${slice.title}\n\n${slice.summary}`,
					);
					write(
						`${sliceBase}/${slice.id}-UAT-RESULT.md`,
						`# ${slice.id} acceptance\n\n${slice.uat.map((entry) => `- ${entry.result === "pass" ? "PASS" : entry.result === "fail" ? "FAIL" : "NEEDS-HUMAN"} ${entry.check}${entry.note ? ` — ${entry.note}` : ""}`).join("\n")}`,
					);
				}
			}
		}
		const quick = this.all("SELECT * FROM quick ORDER BY n");
		for (const row of quick) {
			write(
				`quick/Q${pad(Number(row.n), 3)}-SUMMARY.md`,
				`# ${text(row.title)}\n\n${text(row.summary)}`,
			);
		}
	}
}

/** `M001`, `S02`, `T03`, `R004` → the number. */
function number(id: string): number {
	return Number(id.match(/(\d+)\s*$/)?.[1] ?? Number.NaN);
}
