/**
 * What a delegated agent reports, and how the lead reads it.
 *
 * A round's reports went to the lead whole, as one tool result, and the
 * transcript sends at most 32,000 characters of any tool result, cut from the
 * middle. On pandorum 2026-09-24 a round of 75 returned 209,219 characters,
 * and the lead was shown the first 11 and the last 15 reports: "the harness
 * truncated the middle of the 75-report output".
 *
 * So each agent now hands back a short summary it writes itself once it is
 * done, and its full report is kept here. The lead gets the summaries -- every
 * agent represented -- and reads a full report when it wants one, a page at a
 * time, the way it reads a large file.
 */
import type { AgentResult, AgentTool } from "@cline/shared";

/** The longest summary the lead is handed per agent. */
export const AGENT_SUMMARY_MAX_CHARS = 1_000;
/** A page of a report, at most, as `read_files` pages a file. */
export const AGENT_REPORT_PAGE_LINES = 200;
export const AGENT_REPORT_PAGE_CHARS = 12_000;

export const READ_AGENT_REPORT_TOOL_NAME = "read_agent_report";

export const AGENT_SUMMARY_PROMPT = [
	"You are done. Write a summary of your work for the agent that started you, in at most 1,000 characters.",
	"Say what you found or changed, where (file and line), and what is left undone or uncertain. No preamble, no tool calls.",
	"Your full report stays available to it; this summary is what it reads first.",
].join(" ");

const REPORTS = new Map<string, Map<string, string>>();

/**
 * Keep an agent's full report under its name, for the lead's session.
 *
 * Returns the name it is filed under: a name already used in this session gets
 * a suffix, so an agent of the next round does not replace one the lead may
 * still want to read.
 */
export function recordAgentReport(
	sessionId: string | undefined,
	name: string,
	text: string,
): string {
	const key = sessionId ?? "";
	let reports = REPORTS.get(key);
	if (!reports) {
		reports = new Map();
		REPORTS.set(key, reports);
	}
	const base = name.trim() || "agent";
	let filed = base;
	for (let n = 2; reports.has(filed); n += 1) {
		filed = `${base}#${n}`;
	}
	reports.set(filed, text);
	return filed;
}

/** Forget a session's reports, with the session. */
export function clearAgentReports(sessionId: string | undefined): void {
	REPORTS.delete(sessionId ?? "");
}

/** A page of a report, numbered, with where to read on from. */
export function readAgentReport(
	sessionId: string | undefined,
	name: string,
	startLine = 1,
): string {
	const reports = REPORTS.get(sessionId ?? "");
	const text = reports?.get(name.trim());
	if (text === undefined) {
		const known = [...(reports?.keys() ?? [])];
		return known.length > 0
			? `No report named "${name}". Reports in this session: ${known.join(", ")}.`
			: `No report named "${name}": no agent has reported in this session yet.`;
	}
	const lines = text.split("\n");
	const first = Math.max(1, Math.min(Math.floor(startLine), lines.length));
	const page: string[] = [];
	let chars = 0;
	let last = first - 1;
	for (let index = first - 1; index < lines.length; index += 1) {
		const line = `${String(index + 1).padStart(4)} | ${lines[index]}`;
		if (
			page.length >= AGENT_REPORT_PAGE_LINES ||
			(page.length > 0 && chars + line.length > AGENT_REPORT_PAGE_CHARS)
		) {
			break;
		}
		page.push(line);
		chars += line.length + 1;
		last = index + 1;
	}
	const more =
		last < lines.length
			? `Lines ${first}-${last} of ${lines.length}. Read on with start_line ${last + 1}.`
			: `Lines ${first}-${last} of ${lines.length}: the end of the report.`;
	return `${page.join("\n")}\n\n${more}`;
}

/** The lead's way into a full report. */
export function createReadAgentReportTool(): AgentTool {
	return {
		name: READ_AGENT_REPORT_TOOL_NAME,
		description:
			"Read the full report of an agent you delegated to, by the name its summary gives. " +
			`Each call returns up to ${AGENT_REPORT_PAGE_LINES} lines; a longer report says where to read on, so read it in pages with start_line. ` +
			"Read one when its summary is not enough to act on; the summaries alone are usually enough to decide what to read.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "The agent's name, as its summary gives it.",
				},
				start_line: {
					type: "integer",
					minimum: 1,
					description: "The line to start from. Defaults to 1.",
				},
			},
			required: ["name"],
		},
		execute: async (input: unknown, context) => {
			const { name, start_line } = (input ?? {}) as {
				name?: string;
				start_line?: number;
			};
			if (!name?.trim()) {
				return "Give `name`: the agent's name, as its summary gives it.";
			}
			return readAgentReport(context.sessionId, name, start_line ?? 1);
		},
	} as AgentTool;
}

/**
 * The agent's result as the lead is to receive it: a summary the agent wrote,
 * and where its full report is filed. A report already under the limit is its
 * own summary, and costs no extra turn.
 *
 * `summarize` asks the agent itself -- one more turn on the conversation that
 * produced the report, which is the only party that knows what mattered in it.
 * A failed or empty summary falls back to the report's opening.
 */
export async function summarizeForLead(input: {
	sessionId: string | undefined;
	name: string;
	result: AgentResult;
	summarize: (prompt: string) => Promise<{ text: string }>;
}): Promise<AgentResult> {
	const full = input.result.text ?? "";
	if (
		input.result.finishReason !== "completed" ||
		full.length <= AGENT_SUMMARY_MAX_CHARS
	) {
		return input.result;
	}
	let summary = "";
	try {
		summary = (await input.summarize(AGENT_SUMMARY_PROMPT)).text.trim();
	} catch {
		summary = "";
	}
	if (!summary) {
		summary = full.slice(0, AGENT_SUMMARY_MAX_CHARS);
	}
	if (summary.length > AGENT_SUMMARY_MAX_CHARS) {
		summary = `${summary.slice(0, AGENT_SUMMARY_MAX_CHARS - 1)}…`;
	}
	const filed = recordAgentReport(input.sessionId, input.name, full);
	const lines = full.split("\n").length;
	return {
		...input.result,
		text: `${summary}\n\n[Full report: ${full.length.toLocaleString("en-US")} characters, ${lines} lines. Read it with ${READ_AGENT_REPORT_TOOL_NAME}(name: "${filed}").]`,
	};
}
