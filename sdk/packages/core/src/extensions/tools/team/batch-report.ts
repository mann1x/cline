/**
 * What an `agents` call hands back to the lead: a result that always fits and
 * names every agent.
 *
 * A tool result reaches the model capped at 32,000 characters, and a longer
 * one is cut from the MIDDLE (`message-builder.ts`). Each agent's summary is
 * up to 1,000 characters, so a round of 75 -- pandorum's 1tmrl -- was well over
 * the cap, and the agents in the middle of the list were simply not there for
 * the lead to read: not their report, not even their name.
 *
 * So the result is built to fit, in order of what the lead needs most:
 *
 * 1. `summary` -- one aggregate block: how many completed, errored or were
 *    cancelled, per agent kind and per failure class, and the round's
 *    iterations and tokens.
 * 2. `agents` -- a compact index, one entry per agent in the order they were
 *    asked for: name, status, failure class, and one line.
 * 3. `reports` -- as many agents' summaries as fit under
 *    {@link SPAWN_BATCH_RESULT_BUDGET_CHARS}, safely below the cap.
 * 4. `notShown` -- every agent whose report did not fit, BY NAME, each one
 *    readable in full with `read_agent_report`.
 *
 * Nothing is left to middle truncation: the budget is measured on the JSON the
 * model will receive.
 */
import { classifyTurnFault } from "@cline/shared";
import {
	READ_AGENT_REPORT_TOOL_NAME,
	recordAgentReport,
} from "./agent-reports";
import { isNodeUnreachable } from "./node-reachability";

/**
 * The most the whole result may take, in characters of its JSON.
 *
 * The transcript sends at most 32,000 characters of one tool result; this
 * leaves room for the wrapping the provider adds and for estimates that run
 * short.
 */
export const SPAWN_BATCH_RESULT_BUDGET_CHARS = 28_000;

/** The longest index line per agent, before the index has to shrink. */
export const SPAWN_BATCH_INDEX_LINE_CHARS = 120;

export type SpawnBatchStatus = "completed" | "errored" | "cancelled";

/**
 * Whose failure it was. `infra` is the transport, a refusal or the server --
 * nothing the agent did, and worth trying again as is. `task` is the model,
 * a tool or the iteration budget -- the job itself did not get done.
 */
export type SpawnBatchFailureClass = "infra" | "task";

/** What one agent of the round came back with, as the batch sees it. */
export interface SpawnBatchMemberResult {
	name: string;
	/** Configured agent type, when the entry named one. */
	type?: string;
	text?: string;
	finishReason?: string;
	iterations?: number;
	usage?: { inputTokens?: number; outputTokens?: number };
	/** Set when the agent could not be run or threw. */
	error?: string;
}

export interface SpawnBatchIndexEntry {
	name: string;
	status: SpawnBatchStatus;
	failureClass?: SpawnBatchFailureClass;
	/** One line: the start of its summary, or what went wrong. */
	line?: string;
	/** For an agent that did not complete: why, short. */
	error?: string;
}

export interface SpawnBatchSummary {
	total: number;
	completed: number;
	errored: number;
	cancelled: number;
	/** Per configured type, or per name with its `-<n>` copy suffix dropped. */
	byType: Record<
		string,
		{ total: number; completed: number; errored: number; cancelled: number }
	>;
	byFailureClass: { infra: number; task: number };
	totalIterations: number;
	totalTokens: { input: number; output: number };
}

export interface SpawnBatchReport {
	summary: SpawnBatchSummary;
	/**
	 * One per agent, in the order asked for. An object normally; for a round
	 * too large for that, `name|status` or `name|status|failureClass`.
	 */
	agents: Array<SpawnBatchIndexEntry | string>;
	reports: Array<{ name: string; text: string }>;
	notShown?: {
		names: string[];
		note: string;
	};
	usage: { inputTokens: number; outputTokens: number };
}

/** Messages that mean the server or the way to it failed, not the agent. */
const INFRA_PATTERNS: readonly RegExp[] = [
	/no agent node can take an agent/i,
	/\bmodel\b.*\bnot found\b/i,
	/\bbad gateway\b|\bgateway time-?out\b|\bservice unavailable\b/i,
	/could not reach|cannot reach|not answering|unreachable/i,
];

function statusOf(result: SpawnBatchMemberResult): SpawnBatchStatus {
	if (result.error !== undefined && result.finishReason === undefined) {
		// The runtime's own guard ends the run with an abort error; nobody
		// cancelled it, and showing it as cancelled reads like a stop by the
		// lead or the user (9 agents of swarm 0926).
		if (/\bloop guard\b/i.test(result.error)) {
			return "errored";
		}
		return /\babort|cancel|stopped\b/i.test(result.error)
			? "cancelled"
			: "errored";
	}
	if (result.finishReason === "completed") {
		return "completed";
	}
	if (result.finishReason === "aborted") {
		return "cancelled";
	}
	return "errored";
}

/** Whose failure an agent's was; see {@link SpawnBatchFailureClass}. */
export function failureClassOf(
	result: SpawnBatchMemberResult,
): SpawnBatchFailureClass | undefined {
	const status = statusOf(result);
	if (status !== "errored") {
		return undefined;
	}
	if (
		result.finishReason === "max_iterations" ||
		result.finishReason === "mistake_limit"
	) {
		return "task";
	}
	const text = (result.error ?? result.text ?? "").trim();
	// The first line is the failure; what follows is a sandbox footer or the
	// agent's own words.
	const first = text.split("\n")[0] ?? "";
	if (
		classifyTurnFault(first) !== undefined ||
		isNodeUnreachable({ message: first }) ||
		INFRA_PATTERNS.some((pattern) => pattern.test(first))
	) {
		return "infra";
	}
	return "task";
}

/** The agent's kind: its configured type, or its name without `-<n>`. */
function kindOf(result: SpawnBatchMemberResult): string {
	if (result.type?.trim()) {
		return result.type.trim();
	}
	return result.name.replace(/-\d+$/, "") || result.name;
}

function oneLine(text: string | undefined, max: number): string | undefined {
	if (max <= 0) {
		return undefined;
	}
	const flat = (text ?? "")
		.replace(/\[Full report:[^\]]*\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!flat) {
		return undefined;
	}
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function indexEntry(
	result: SpawnBatchMemberResult,
	lineChars: number,
): SpawnBatchIndexEntry {
	const status = statusOf(result);
	const failureClass = failureClassOf(result);
	const why =
		status === "completed" || lineChars === 0
			? undefined
			: oneLine(result.error ?? result.text, Math.max(lineChars, 60));
	const line =
		status === "completed" ? oneLine(result.text, lineChars) : undefined;
	return {
		name: result.name,
		status,
		...(failureClass ? { failureClass } : {}),
		...(line ? { line } : {}),
		...(why ? { error: why } : {}),
	};
}

/** The index entry at its smallest: `name|status[|failureClass]`. */
function compactIndexEntry(result: SpawnBatchMemberResult): string {
	const failureClass = failureClassOf(result);
	return [
		result.name,
		statusOf(result),
		...(failureClass ? [failureClass] : []),
	].join("|");
}

/** Where a report the lead is not shown can be read in full. */
function filedName(
	sessionId: string | undefined,
	result: SpawnBatchMemberResult,
): string {
	const text = result.text ?? result.error ?? "";
	const already = /read_agent_report\(name: "([^"]+)"\)/.exec(text);
	if (already?.[1]) {
		return already[1];
	}
	return recordAgentReport(sessionId, result.name, text);
}

function jsonLength(value: unknown): number {
	return JSON.stringify(value).length;
}

/**
 * Build the round's result within {@link SPAWN_BATCH_RESULT_BUDGET_CHARS}.
 *
 * `sessionId` is the lead's: a report left out is filed there, so
 * `read_agent_report` finds it by the name the result gives.
 */
export function buildSpawnBatchReport(
	results: readonly SpawnBatchMemberResult[],
	sessionId: string | undefined,
	budget = SPAWN_BATCH_RESULT_BUDGET_CHARS,
): SpawnBatchReport {
	const summary: SpawnBatchSummary = {
		total: results.length,
		completed: 0,
		errored: 0,
		cancelled: 0,
		byType: {},
		byFailureClass: { infra: 0, task: 0 },
		totalIterations: 0,
		totalTokens: { input: 0, output: 0 },
	};
	for (const result of results) {
		const status = statusOf(result);
		summary[status] += 1;
		const kind = kindOf(result);
		summary.byType[kind] ??= {
			total: 0,
			completed: 0,
			errored: 0,
			cancelled: 0,
		};
		const byKind = summary.byType[kind];
		byKind.total += 1;
		byKind[status] += 1;
		const failureClass = failureClassOf(result);
		if (failureClass) {
			summary.byFailureClass[failureClass] += 1;
		}
		summary.totalIterations += result.iterations ?? 0;
		summary.totalTokens.input += result.usage?.inputTokens ?? 0;
		summary.totalTokens.output += result.usage?.outputTokens ?? 0;
	}
	const usage = {
		inputTokens: summary.totalTokens.input,
		outputTokens: summary.totalTokens.output,
	};

	const notShownNote = `Not shown to keep this result whole; read each with ${READ_AGENT_REPORT_TOOL_NAME}(name).`;
	// Room for the `notShown` block at its largest: every name in it, each
	// with a filing suffix. Set aside first, so it can never be what does
	// not fit.
	const reserve =
		jsonLength({
			notShown: {
				names: results.map((result) => `${result.name}#99`),
				note: notShownNote,
			},
		}) + 16;
	// The index is everyone, always. Its lines shrink, and at the last its
	// entries become `name|status|class` strings, before it would not fit.
	let agents: Array<SpawnBatchIndexEntry | string> = [];
	for (const tier of [SPAWN_BATCH_INDEX_LINE_CHARS, 60, 0, -1]) {
		agents = results.map((result) =>
			tier < 0 ? compactIndexEntry(result) : indexEntry(result, tier),
		);
		if (jsonLength({ summary, agents }) + reserve <= budget) {
			break;
		}
	}

	const report: SpawnBatchReport = {
		summary,
		agents,
		reports: [],
		usage,
	};
	const omitted: SpawnBatchMemberResult[] = [];
	let used = jsonLength(report);
	for (const result of results) {
		const text = (result.text ?? result.error ?? "").trim();
		if (!text) {
			continue;
		}
		const entry = { name: result.name, text };
		const cost = jsonLength(entry) + 1;
		if (used + cost + reserve <= budget) {
			report.reports.push(entry);
			used += cost;
		} else {
			omitted.push(result);
		}
	}
	if (omitted.length > 0) {
		report.notShown = {
			names: omitted.map((result) => filedName(sessionId, result)),
			note: notShownNote,
		};
	}
	return report;
}
