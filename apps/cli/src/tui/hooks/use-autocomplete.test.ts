import { describe, expect, it } from "vitest";
import {
	extractAgentCommandSlot,
	extractDelegateAgentQuery,
	extractSlashQuery,
	formatMentionAutocompleteValue,
	getAgentCommandOptions,
	getFirstSelectableIndex,
	insertMention,
	takesAgentName,
} from "./use-autocomplete";

describe("TUI autocomplete slash command replacement", () => {
	it("detects a slash query immediately before the cursor", () => {
		expect(extractSlashQuery("/review")).toEqual({
			inSlashMode: true,
			query: "review",
			slashIndex: 0,
		});
		expect(extractSlashQuery("please /review")).toEqual({
			inSlashMode: true,
			query: "review",
			slashIndex: 7,
		});
	});

	it("supports replacing only the slash token at the cursor", () => {
		const text = "please /review this file";
		const cursor = "please /review".length;
		const slash = extractSlashQuery(text.slice(0, cursor));
		const replacement = "/review ";

		expect(slash.inSlashMode).toBe(true);
		if (!slash.inSlashMode) return;
		expect(
			text.slice(0, slash.slashIndex) + replacement + text.slice(cursor),
		).toBe("please /review  this file");
	});

	it("selects the first command option instead of a section header", () => {
		expect(
			getFirstSelectableIndex([
				{ display: "Skills", value: "", isHeader: true },
				{ display: "/review", value: "/review " },
			]),
		).toBe(1);
	});

	it("formats workspace mention completions as relative file mentions", () => {
		expect(formatMentionAutocompleteValue("src/main.ts")).toBe(
			"@./src/main.ts ",
		);
		expect(insertMention("open @src", 5, "src/main.ts")).toBe(
			"open @./src/main.ts ",
		);
	});

	it("preserves parser-compatible mention prefixes", () => {
		expect(formatMentionAutocompleteValue("/tmp/file.txt")).toBe(
			"@/tmp/file.txt ",
		);
		expect(formatMentionAutocompleteValue("~/file.txt")).toBe("@~/file.txt ");
		expect(formatMentionAutocompleteValue("./file.txt")).toBe("@./file.txt ");
		expect(formatMentionAutocompleteValue("../file.txt")).toBe("@../file.txt ");
	});

	it("quotes parser-compatible mention paths containing spaces", () => {
		expect(formatMentionAutocompleteValue("docs/my file.md")).toBe(
			'@"./docs/my file.md" ',
		);
		expect(insertMention("open @docs", 5, "docs/my file.md")).toBe(
			'open @"./docs/my file.md" ',
		);
	});
});

describe("TUI autocomplete of the /delegate agent", () => {
	it("is on the name from the space after the command", () => {
		expect(extractDelegateAgentQuery("/delegate ")).toEqual({
			inAgentMode: true,
			query: "",
			nameIndex: 10,
		});
		expect(extractDelegateAgentQuery("/delegate-background q")).toEqual({
			inAgentMode: true,
			query: "q",
			nameIndex: 21,
		});
	});

	it("is over once the task starts, and off for anything else", () => {
		for (const text of [
			"/delegate",
			"/delegate qa ",
			"/delegate qa run it",
			"/delegate @file",
			"please /delegate q",
			"/delegated q",
		]) {
			expect(extractDelegateAgentQuery(text).inAgentMode).toBe(false);
		}
	});

	it("knows the two commands that take an agent", () => {
		expect(takesAgentName("delegate")).toBe(true);
		expect(takesAgentName("delegate-background")).toBe(true);
		expect(takesAgentName("agents")).toBe(false);
	});
});

describe("/agent arguments", () => {
	const agents = [
		{
			name: "reviewer",
			description: "Reviews code",
			skills: ["review-website", "lint"],
		},
		{ name: "qa", description: "Runs QA" },
	];
	const skills = [
		{ name: "deploy", description: "Deploys" },
		{ name: "lint", description: "Lints" },
		{ name: "review-website", description: "Reviews a website" },
	];
	const displays = (options: { display: string }[]) =>
		options.map((option) => option.display);

	it("finds the first word, then the second, then nothing", () => {
		expect(extractAgentCommandSlot("/agent rev")).toEqual({
			position: "first",
			query: "rev",
			index: 7,
		});
		expect(extractAgentCommandSlot("/agent reviewer /li")).toEqual({
			position: "second",
			agentName: "reviewer",
			query: "/li",
			index: 16,
		});
		expect(
			extractAgentCommandSlot("/agent reviewer check the"),
		).toBeUndefined();
		expect(takesAgentName("agent")).toBe(true);
	});

	it("offers agents then skills first, and the agent's own skills second", () => {
		expect(
			displays(
				getAgentCommandOptions(
					{ position: "first", query: "rev" },
					agents,
					skills,
				),
			),
		).toEqual(["reviewer", "/review-website"]);
		expect(
			displays(
				getAgentCommandOptions(
					{ position: "second", agentName: "reviewer", query: "" },
					agents,
					skills,
				),
			),
		).toEqual(["/lint", "/review-website"]);
		expect(
			displays(
				getAgentCommandOptions(
					{ position: "second", agentName: "qa", query: "dep" },
					agents,
					skills,
				),
			),
		).toEqual(["/deploy"]);
	});

	// An empty list lets Enter send the text as the task.
	it("offers nothing for an ordinary word", () => {
		expect(
			getAgentCommandOptions(
				{ position: "first", query: "launch" },
				agents,
				skills,
			),
		).toEqual([]);
	});
});
