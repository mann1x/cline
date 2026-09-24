import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_SUMMARY_MAX_CHARS,
	clearAgentReports,
	createReadAgentReportTool,
	readAgentReport,
	recordAgentReport,
	summarizeForLead,
} from "./agent-reports";

afterEach(() => clearAgentReports("lead"));

const completed = (text: string) =>
	({
		text,
		finishReason: "completed",
		iterations: 3,
		usage: { inputTokens: 1, outputTokens: 1 },
	}) as never;

describe("a delegated agent's report", () => {
	// pandorum 2026-09-24: 75 reports, 209,219 characters, sent whole and cut
	// from the middle; the lead saw 26 of them.
	it("reaches the lead as the agent's own summary, the full text filed", async () => {
		const full = Array.from({ length: 400 }, (_, i) => `finding ${i + 1}`).join(
			"\n",
		);
		const summarize = vi.fn(async () => ({
			text: "Found 400 things; the worst is at line 82.",
		}));
		const result = (await summarizeForLead({
			sessionId: "lead",
			name: "verifier-7",
			result: completed(full),
			summarize,
		})) as { text: string };

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(result.text).toContain("Found 400 things; the worst is at line 82.");
		expect(result.text).toContain('read_agent_report(name: "verifier-7")');
		expect(readAgentReport("lead", "verifier-7")).toContain(
			"finding 400".slice(0, 0),
		);
	});

	it("costs no extra turn when the report is already short", async () => {
		const summarize = vi.fn();
		const result = (await summarizeForLead({
			sessionId: "lead",
			name: "a",
			result: completed("All good."),
			summarize,
		})) as { text: string };
		expect(summarize).not.toHaveBeenCalled();
		expect(result.text).toBe("All good.");
	});

	it("holds a summary that runs long to the limit, and falls back when there is none", async () => {
		const long = await summarizeForLead({
			sessionId: "lead",
			name: "b",
			result: completed("x".repeat(5_000)),
			summarize: async () => ({ text: "y".repeat(3_000) }),
		});
		expect((long as { text: string }).text.split("\n\n")[0]?.length).toBe(
			AGENT_SUMMARY_MAX_CHARS,
		);
		const none = await summarizeForLead({
			sessionId: "lead",
			name: "c",
			result: completed("z".repeat(5_000)),
			summarize: async () => {
				throw new Error("model gone");
			},
		});
		expect((none as { text: string }).text.startsWith("z".repeat(100))).toBe(
			true,
		);
	});

	it("is read in pages, and says where to read on", () => {
		recordAgentReport(
			"lead",
			"big",
			Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n"),
		);
		const first = readAgentReport("lead", "big");
		expect(first).toContain("   1 | line 1");
		expect(first).toContain("Lines 1-200 of 450. Read on with start_line 201.");
		expect(readAgentReport("lead", "big", 401)).toContain(
			"Lines 401-450 of 450: the end of the report.",
		);
	});

	it("files a second agent of the same name beside the first", () => {
		expect(recordAgentReport("lead", "fixer", "one")).toBe("fixer");
		expect(recordAgentReport("lead", "fixer", "two")).toBe("fixer#2");
		expect(readAgentReport("lead", "fixer#2")).toContain("two");
	});

	it("names what there is when asked for a report that is not", async () => {
		recordAgentReport("lead", "known", "text");
		const output = await createReadAgentReportTool().execute(
			{ name: "unknown" },
			{ sessionId: "lead" } as never,
		);
		expect(output).toContain("Reports in this session: known.");
	});
});
