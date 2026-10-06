/**
 * The `sdd` tool: the spec-driven engine, as the model sees it.
 *
 * One tool with an `action`, not twenty tools: every tool's schema is paid
 * for in every request, and these are used one at a time. Every answer ends
 * with the step that is due, so the model never has to work out its place.
 */

import { type AgentTool, createTool } from "@cline/shared";
import {
	type RequirementStatus,
	SddEngine,
	SddRuleError,
	type SliceInput,
	type TaskInput,
	type UatResult,
} from "../../services/sdd/sdd-engine";
import { isBundledSkillEnabled } from "../config/bundled-skills";

export const SDD_TOOL_NAME = "sdd";

export const SDD_ACTIONS = [
	"next",
	"status",
	"set_project",
	"add_requirement",
	"update_requirement",
	"add_decision",
	"add_knowledge",
	"capture",
	"add_milestone",
	"update_milestone",
	"approve",
	"plan_milestone",
	"add_slices",
	"remove_slice",
	"plan_slice",
	"replan_slice",
	"start_task",
	"complete_task",
	"block_task",
	"complete_slice",
	"validate_milestone",
	"complete_milestone",
	"quick",
] as const;
export type SddAction = (typeof SDD_ACTIONS)[number];

export const SDD_TOOL_DESCRIPTION = `Spec-driven development: the project's plan and where the work stands, kept in a database in the project (.sdd/). Use it for every step of a planned build; do not keep the plan in your head or in files of your own.

Call with action "next" whenever you are unsure what to do: it answers with the one step that is due and everything that step needs. Every other action ends by telling you the next step too. A step out of turn is refused with the reason.

Actions:
- next, status: where things stand. Change nothing.
- set_project {name, description, agreements}
- add_requirement {title, description}; update_requirement {id, status: active | validated | deferred | out_of_scope}
- add_decision {title, choice, why}; add_knowledge {text}; capture {text} (a thought for later)
- add_milestone {title, context}; update_milestone {title, context}
- approve {what: "requirements" | "roadmap"}: only after the user has said yes to them.
- plan_milestone {slices: [{title, goal, demo, depends: ["S01"], requirements: ["R001"]}]}
- add_slices {slices}: more slices on an approved roadmap, when the user agreed to more scope. remove_slice {slice, reason}: take off one that has no work in it.
- plan_slice {research, tasks: [{title, steps, files: [], verify, expect}]}
- replan_slice {reason, tasks}: after a blocker; done tasks are kept.
- start_task; complete_task {summary, evidence}; block_task {reason}
- complete_slice {summary, uat: [{check, result: "pass" | "fail" | "needs_human", note}]}
- validate_milestone {verdict: "pass" | "needs_remediation", findings, remediation: [slices]}
- complete_milestone {summary}
- quick {title, summary}: record a small change made outside the plan.

evidence is the real output of the task's verify command, run in the workspace. Never write it from memory.`;

const SLICE_SCHEMA = {
	type: "array",
	items: {
		type: "object",
		properties: {
			title: { type: "string" },
			goal: { type: "string" },
			demo: {
				type: "string",
				description: "What shows that the slice works.",
			},
			depends: { type: "array", items: { type: "string" } },
			requirements: { type: "array", items: { type: "string" } },
		},
		required: ["title"],
	},
} as const;

export const SDD_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		action: { type: "string", enum: [...SDD_ACTIONS] },
		name: { type: "string" },
		title: { type: "string" },
		description: { type: "string" },
		agreements: { type: "string" },
		context: { type: "string" },
		text: { type: "string" },
		id: { type: "string", description: "A requirement id, e.g. R003." },
		status: {
			type: "string",
			enum: ["active", "validated", "deferred", "out_of_scope"],
		},
		choice: { type: "string" },
		why: { type: "string" },
		what: { type: "string", enum: ["requirements", "roadmap"] },
		slice: {
			type: "string",
			description: "A slice, e.g. S02. Leave out for the one that is due.",
		},
		task: {
			type: "string",
			description: "A task, e.g. T03. Leave out for the one that is due.",
		},
		slices: SLICE_SCHEMA,
		remediation: SLICE_SCHEMA,
		research: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					steps: { type: "string" },
					files: { type: "array", items: { type: "string" } },
					verify: {
						type: "string",
						description: "The one command whose output proves the task.",
					},
					expect: { type: "string" },
				},
				required: ["title", "steps", "verify"],
			},
		},
		reason: { type: "string" },
		summary: { type: "string" },
		evidence: { type: "string" },
		uat: {
			type: "array",
			items: {
				type: "object",
				properties: {
					check: { type: "string" },
					result: { type: "string", enum: ["pass", "fail", "needs_human"] },
					note: { type: "string" },
				},
				required: ["check", "result"],
			},
		},
		verdict: { type: "string", enum: ["pass", "needs_remediation"] },
		findings: { type: "string" },
	},
	required: ["action"],
} as const;

export interface SddToolOptions {
	/** The project the plan belongs to. */
	cwd: string;
	onError?: (message: string, error: unknown) => void;
}

const str = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

/** Arrays arrive as arrays, or from a small model as a JSON string of one. */
function list<T>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (typeof value === "string" && value.trim().startsWith("[")) {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed as T[];
		} catch {
			// Not a list.
		}
	}
	return [];
}

function slices(value: unknown): SliceInput[] {
	return list<Record<string, unknown>>(value).map((entry) => ({
		title: str(entry.title) ?? "",
		goal: str(entry.goal),
		demo: str(entry.demo),
		depends: list<string>(entry.depends),
		requirements: list<string>(entry.requirements),
	}));
}

function tasks(value: unknown): TaskInput[] {
	return list<Record<string, unknown>>(value).map((entry) => ({
		title: str(entry.title) ?? "",
		steps: Array.isArray(entry.steps)
			? entry.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
			: (str(entry.steps) ?? ""),
		files: list<string>(entry.files),
		verify: str(entry.verify) ?? "",
		expect: str(entry.expect),
	}));
}

/** Run one action. Returns what happened, without the next step. */
export function runSddAction(
	engine: SddEngine,
	input: Record<string, unknown>,
): string {
	const action = str(input.action) as SddAction | undefined;
	switch (action) {
		case "next":
			return "";
		case "status":
			return engine.status();
		case "set_project":
			engine.setProject({
				name: str(input.name) ?? str(input.title),
				description: str(input.description),
				agreements: str(input.agreements),
			});
			return "The project is recorded.";
		case "add_requirement":
			return `Added ${engine.addRequirement({
				title: str(input.title) ?? "",
				description: str(input.description),
				status: str(input.status) as RequirementStatus | undefined,
			})}.`;
		case "update_requirement":
			engine.updateRequirement(str(input.id) ?? "", {
				status: str(input.status) as RequirementStatus | undefined,
				title: str(input.title),
				description: str(input.description),
			});
			return `Updated ${str(input.id)}.`;
		case "add_decision":
			return `Recorded ${engine.addDecision({
				title: str(input.title) ?? "",
				choice: str(input.choice) ?? "",
				why: str(input.why),
			})}.`;
		case "add_knowledge":
			engine.addKnowledge(str(input.text) ?? "");
			return "Noted.";
		case "capture":
			engine.capture(str(input.text) ?? "");
			return "Kept for later. It does not change the plan.";
		case "add_milestone":
			return `Added ${engine.addMilestone({
				title: str(input.title) ?? "",
				context: str(input.context) ?? str(input.description) ?? "",
			})}.`;
		case "update_milestone":
			engine.updateMilestone({
				title: str(input.title),
				context: str(input.context),
			});
			return "The milestone is updated.";
		case "remove_slice":
			engine.removeSlice({
				slice: str(input.slice) ?? "",
				reason: str(input.reason) ?? "",
			});
			return `Removed ${str(input.slice)}.`;
		case "approve": {
			const what = str(input.what);
			if (what !== "requirements" && what !== "roadmap") {
				throw new SddRuleError(
					'approve needs what: "requirements" or "roadmap".',
				);
			}
			engine.approve(what);
			return `The ${what} ${what === "roadmap" ? "is" : "are"} approved.`;
		}
		case "plan_milestone":
			return `The roadmap has ${engine.planMilestone(slices(input.slices)).join(", ")}.`;
		case "add_slices":
			return `Added ${engine.addSlices(slices(input.slices)).join(", ")}.`;
		case "plan_slice":
			return `Planned ${engine
				.planSlice({
					slice: str(input.slice),
					research: str(input.research),
					tasks: tasks(input.tasks),
				})
				.join(", ")}.`;
		case "replan_slice":
			return `Replanned; the new tasks are ${engine
				.replanSlice({
					slice: str(input.slice),
					reason: str(input.reason) ?? "",
					tasks: tasks(input.tasks),
				})
				.join(", ")}.`;
		case "start_task": {
			const task = engine.startTask(str(input.task));
			return `Started ${task.id} "${task.title}". Do exactly this task and nothing beyond it.\nSteps: ${task.steps}\nFiles: ${task.files.join(", ") || "(not named)"}\nVerify: ${task.verify}${task.expect ? `\nExpect: ${task.expect}` : ""}\nRun the verify command in the workspace. When it passes, call complete_task with summary and evidence (the command's real output). If the task cannot be done as planned, call block_task with the reason.`;
		}
		case "complete_task":
			engine.completeTask({
				task: str(input.task),
				summary: str(input.summary) ?? "",
				evidence: str(input.evidence) ?? "",
			});
			return "The task is done.";
		case "block_task":
			engine.blockTask({
				task: str(input.task),
				reason: str(input.reason) ?? "",
			});
			return "The task is marked blocked.";
		case "complete_slice":
			engine.completeSlice({
				slice: str(input.slice),
				summary: str(input.summary) ?? "",
				uat: list<Record<string, unknown>>(input.uat).map((entry) => ({
					check: str(entry.check) ?? "",
					result: (str(entry.result) ?? "fail") as UatResult,
					note: str(entry.note),
				})),
			});
			return "The slice is closed, and the requirements it owns are validated.";
		case "validate_milestone": {
			const verdict = str(input.verdict);
			if (verdict !== "pass" && verdict !== "needs_remediation") {
				throw new SddRuleError(
					'validate_milestone needs verdict: "pass" or "needs_remediation".',
				);
			}
			const added = engine.validateMilestone({
				verdict,
				findings: str(input.findings) ?? "",
				remediation: slices(input.remediation),
			});
			return verdict === "pass"
				? "The audit passed."
				: `The audit found gaps; ${added.join(", ")} were added to fix them.`;
		}
		case "complete_milestone":
			engine.completeMilestone(str(input.summary) ?? "");
			return "The milestone is complete.";
		case "quick":
			return `Recorded as ${engine.quick({
				title: str(input.title) ?? "",
				summary: str(input.summary) ?? "",
			})}. The plan is unchanged.`;
		default:
			throw new SddRuleError(
				`Unknown action ${JSON.stringify(input.action)}. Actions: ${SDD_ACTIONS.join(", ")}.`,
			);
	}
}

function describeNext(engine: SddEngine): string {
	const next = engine.next();
	return `Next step: ${next.step}${next.ref ? ` (${next.ref})` : ""}${next.needsUser ? " — this one needs the user; stop and ask them" : ""}\n${next.instruction}`;
}

export function createSddTool(options: SddToolOptions): AgentTool {
	return createTool({
		name: SDD_TOOL_NAME,
		description: SDD_TOOL_DESCRIPTION,
		inputSchema: SDD_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown): Promise<string> => {
			let engine: SddEngine | undefined;
			try {
				engine = new SddEngine(options.cwd);
				const request = (input ?? {}) as Record<string, unknown>;
				let done: string;
				try {
					done = runSddAction(engine, request);
				} catch (error) {
					if (!(error instanceof SddRuleError)) throw error;
					// A refusal is an answer: say why, and what is due instead.
					return `Not done: ${error.message}\n\n${describeNext(engine)}`;
				}
				// A task just started is the next step; "resume" would misname it.
				if (request.action === "start_task") return done;
				return [done, describeNext(engine)].filter(Boolean).join("\n\n");
			} catch (error) {
				options.onError?.("[sdd] the plan could not be read or written", error);
				return `The plan could not be read or written: ${error instanceof Error ? error.message : String(error)}`;
			} finally {
				engine?.close();
			}
		},
	});
}

/** The spec-driven skills, any one of which brings the tool with it. */
export const SDD_SKILL_NAMES = [
	"sdd-wizard",
	"sdd-discuss",
	"sdd-plan",
	"sdd-execute",
	"sdd-verify",
	"sdd-quick",
	"sdd-status",
] as const;

/** Whether the user has any of the spec-driven skills turned on. */
export function isSddEnabled(): boolean {
	return SDD_SKILL_NAMES.some((name) => isBundledSkillEnabled(name, false));
}

/**
 * The tool, when a spec-driven skill is on. The skills are what tell the
 * model how to work this way; without one the tool would be a cost in every
 * request and no use.
 */
export function createSddTools(
	options: SddToolOptions & { log?: (message: string) => void },
): AgentTool[] {
	if (!isSddEnabled()) {
		options.log?.("sdd omitted: no spec-driven skill is turned on");
		return [];
	}
	options.log?.("sdd offered: a spec-driven skill is turned on");
	return [createSddTool(options)];
}
