import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

/** A model that says the same thing every turn and never calls a tool. */
class OneNoteModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(private readonly text: string) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const text = this.text;
		return (async function* () {
			yield { type: "text-delta", text } as AgentModelEvent;
		})();
	}
}

/**
 * Says each line in turn; a line starting with `!` is a tool call instead:
 * `!!` of the tool that stops at a user's limit, `!look` of a read-only one.
 */
class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];
	private turn = 0;

	constructor(private readonly script: readonly string[]) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const index = this.turn++;
		const line = this.script[Math.min(index, this.script.length - 1)] ?? "";
		return (async function* () {
			if (line.startsWith("!")) {
				yield {
					type: "tool-call-delta",
					toolCallId: `call_${index}`,
					toolName: line.startsWith("!!")
						? "limited"
						: line === "!look"
							? "look"
							: "echo",
					inputText: '{"text":"hi"}',
				} as AgentModelEvent;
				yield { type: "finish", reason: "tool-calls" } as AgentModelEvent;
				return;
			}
			yield { type: "text-delta", text: line } as AgentModelEvent;
		})();
	}
}

/** A tool that stops at a limit only the user can change, and says so. */
const LIMITED = {
	name: "limited",
	description: "Fetch within the user's limit",
	inputSchema: { type: "object" },
	async execute(
		_input: unknown,
		context?: { reportStoppedForUser?: (reason: string) => void },
	) {
		context?.reportStoppedForUser?.("the user's file limit");
		return "NOT COMPLETE: the user's limit left 8 files out.";
	},
};

const NOT_COMPLETE_REPORT =
	"The web scraping has been saved to `zentimings_scrape`, but it is **not complete**.\n\nThe file limit left 8 files out.\n\nRaise it under Settings > Features > Web scraping and ask me to resume.";

/** The reminders the model had been sent by its last turn, each counted once. */
function asked(model: { requests: AgentModelRequest[] }): number {
	return nudges({ requests: model.requests.slice(-1) }).length;
}

const ECHO = {
	name: "echo",
	description: "Echo input text",
	inputSchema: { type: "object" },
	async execute(input: { text: string }) {
		return { echoed: input.text };
	},
};

/** Looks, changes nothing. */
const LOOK = { ...ECHO, name: "look", readOnly: true };

/** Every `[SYSTEM]` reminder the runtime fed back to the model. */
function nudges(model: { requests: AgentModelRequest[] }): string[] {
	const out: string[] = [];
	for (const request of model.requests) {
		for (const message of (request.messages ?? []) as AgentMessage[]) {
			if (message.role !== "user") {
				continue;
			}
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: (content ?? [])
							.map((part: { type?: string; text?: string }) =>
								part.type === "text" ? (part.text ?? "") : "",
							)
							.join("");
			if (text.startsWith("[SYSTEM]")) {
				out.push(text);
			}
		}
	}
	return out;
}

/**
 * The "Strong coding nudges" switch.
 *
 * On -- the default, and what every host shipped before this setting existed --
 * any turn that calls nothing is asked to continue. That is the right reading
 * inside a coding task, where a silent turn is nearly always one that should
 * have acted, and a needless nudge costs one turn against a missed one costing
 * the task.
 *
 * Off, the nudge has to be earned: unstarted work the host can name, a run that
 * has already called something, or a turn that ends on a promise. A plain
 * answer to a plain question is then allowed to end the run, which is what a
 * mostly-conversational session wants -- asked which capital belongs to which
 * country, a model answers, and being told the run "was about to end" and not
 * to describe work without doing it is simply the wrong description of what it
 * just did.
 */
describe("strong coding nudges", () => {
	const ANSWER = "The capital of Italy is Rome.";
	const PROMISE = "Let me open the file and fix the import.";

	it("nudges a plain answer by default", async () => {
		const model = new OneNoteModel(ANSWER);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: { maxNoToolCallNudges: 1 },
		});

		await runtime.run("which capital belongs to Italy?");

		expect(nudges(model)).toHaveLength(1);
	});

	it("lets a plain answer end the run when switched off", async () => {
		const model = new OneNoteModel(ANSWER);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: { maxNoToolCallNudges: 1, strongNudges: false },
		});

		await runtime.run("which capital belongs to Italy?");

		expect(nudges(model)).toEqual([]);
	});

	it("still nudges a turn that ends on a promise when switched off", async () => {
		const model = new OneNoteModel(PROMISE);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: { maxNoToolCallNudges: 1, strongNudges: false },
		});

		await runtime.run("fix the import");

		const seen = nudges(model);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.join("\n")).toContain("called nothing");
	});

	it("still nudges a run that worked and then said nothing, when switched off", async () => {
		// A run that has already acted is a working run, so a silent turn in it
		// is a stop rather than an answer -- the distinction the flag draws is
		// between a conversation and a task, and one tool call settles it.
		const model = new ScriptedModel(["!work", "", "Done."]);
		const runtime = new AgentRuntime({
			model,
			tools: [ECHO],
			completionPolicy: { maxNoToolCallNudges: 1, strongNudges: false },
		});

		await runtime.run("do the thing");

		expect(nudges(model)).toHaveLength(1);
	});

	// Pandorum, 2026-10-10, session 7pfjl: one sentence saying the scrape was
	// complete was nudged, for a turn that changed nothing.
	it("takes a statement that the work is complete as the end of the run", async () => {
		for (const report of [
			"Done.",
			"The web scrape of `https://zentimings.com` is now complete, with all site assets saved in the `zentimings_scrape/` directory.",
			"All three files have been updated.\n\nThe task is complete.",
			// Session 3o4bp: the word in bold, then a summary.
			"The web scraping of `https://zentimings.com` is now **complete**.\n\n### Scrape Details:\n- **Status:** Complete\n- **Files Fetched:** 20 files\n\nYou can find the overview in:\n**`zentimings_scrape/index.md`**",
			// Session xkuuh: the same claim in the first person.
			"I have successfully completed the web scraping of `https://zentimings.com/`.\n\n### Summary of Work:\n1.  **Mapped the Site**: one main page.\n2.  **Crawled the Site**: 22 files.\n\n- **Documentation**: `index.md` lists every captured file.",
		]) {
			const model = new ScriptedModel(["!work", report]);
			const runtime = new AgentRuntime({
				model,
				tools: [ECHO],
				completionPolicy: { maxNoToolCallNudges: 1 },
			});

			await runtime.run("make a web scraping of zentimings.com");

			expect(nudges(model), report).toHaveLength(0);
			expect(model.requests, report).toHaveLength(2);
		}
	});

	// Session ndhh9: a correct "not complete" report was nudged, and the model
	// went around the user's limit to make it untrue.
	it("takes a report as the end of the run when a tool stopped at the user's limit", async () => {
		for (const script of [
			["!!crawl", NOT_COMPLETE_REPORT],
			// Session eyyof: it looked at what was saved, and tried the tool
			// again, before reporting. Neither is other work.
			["!!crawl", "!look", "!look", "!!crawl", NOT_COMPLETE_REPORT],
		]) {
			const model = new ScriptedModel(script);
			const runtime = new AgentRuntime({
				model,
				tools: [ECHO, LOOK, LIMITED],
				completionPolicy: { maxNoToolCallNudges: 1 },
			});

			await runtime.run("make a web scraping of zentimings.com");

			expect(nudges(model), script.join(" / ")).toHaveLength(0);
			expect(model.requests, script.join(" / ")).toHaveLength(script.length);
		}
	});

	// Session eyyof, second message: after a first message that was nudged.
	it("takes the completion statement of a follow-up message too", async () => {
		const model = new ScriptedModel([
			"!!crawl",
			"!look",
			NOT_COMPLETE_REPORT,
			"!!crawl",
			"!look",
			"The web scraping of [zentimings.com](https://zentimings.com) is complete. All 22 identified files have been successfully fetched and saved in the `zentimings_scrape` directory.",
			"The task is finished.",
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [ECHO, LOOK, LIMITED],
			completionPolicy: { maxNoToolCallNudges: 1 },
		});

		await runtime.run("make a web scraping of zentimings.com");
		const first = model.requests.length;
		await runtime.continue("i raised the limit resume the scraping");

		// No nudge in either: a report after the stop, then a completion.
		expect(first).toBe(3);
		expect(model.requests.length - first).toBe(3);
		expect(nudges(model)).toHaveLength(0);
	});

	it("asks about the same report when no tool said it had stopped", async () => {
		for (const script of [
			// Nothing reported a stop.
			["!work", NOT_COMPLETE_REPORT, "Done."],
			// One did, and the run has done other work since.
			["!!crawl", "!work", NOT_COMPLETE_REPORT, "Done."],
			// A status with work still to do, and no promise in it.
			["!work", "I have edited file A. File B needs the same change.", "Done."],
			// Bold does not make "not complete" a completion.
			[
				"!work",
				"The scrape is **not complete**: 8 files are missing.",
				"Done.",
			],
		]) {
			const model = new ScriptedModel(script);
			const runtime = new AgentRuntime({
				model,
				tools: [ECHO, LIMITED],
				completionPolicy: { maxNoToolCallNudges: 1 },
			});

			await runtime.run("do the thing");

			expect(nudges(model), script.join(" / ")).toHaveLength(1);
		}
	});

	// Session xkuuh: the checklist reminder and the nudge arrived together,
	// the model answered the nudge ("The task is finished.") and left the box
	// unticked, and the checklist had to ask again.
	it("leaves the question to the host's guard when it asks on the same turn", async () => {
		let asked = 0;
		const model = new ScriptedModel([
			"!work",
			"Yes, there are several questions in the scraped site.",
			"!tick",
			"The task is finished.",
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [ECHO],
			completionPolicy: {
				maxNoToolCallNudges: 1,
				completionGuard: () =>
					asked++ === 0
						? "[SYSTEM] CHECKLIST: one item is unticked"
						: undefined,
			},
		});

		await runtime.run("is there any question in the scraped website?");

		expect(
			nudges(model).filter((nudge) => nudge.includes("CHECKLIST")),
		).not.toHaveLength(0);
		expect(
			nudges(model).filter((nudge) =>
				nudge.includes("contained no tool calls"),
			),
		).toHaveLength(0);
		expect(model.requests).toHaveLength(4);
	});

	it("still asks a run that worked and then promised, asked or went quiet", async () => {
		for (const reply of [
			"",
			"I fetched the page. Next, I will download the stylesheets.",
			"The page is saved. Should I fetch the pictures too?",
			"I have finished the first page. Next, I will fetch the second.",
			"The page is fetched and I have finished reading it. Two stylesheets are still missing.",
		]) {
			const model = new ScriptedModel(["!work", reply, "Done."]);
			const runtime = new AgentRuntime({
				model,
				tools: [ECHO],
				completionPolicy: { maxNoToolCallNudges: 1 },
			});

			await runtime.run("make a web scraping of zentimings.com");

			expect(
				nudges(model).filter((nudge) =>
					nudge.includes("contained no tool calls"),
				),
				reply,
			).not.toHaveLength(0);
		}
	});

	// Session qjzln: a summary, a nudge, a check of the files, "it is complete",
	// a second nudge, another check, a third.
	it("takes one short sentence after a check as the answer to the nudge", async () => {
		const model = new ScriptedModel([
			"Here is a long summary of the page.\n\nIt has several parts.",
			"!check",
			"The web scraping of zentimings.com is complete.",
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [ECHO],
			completionPolicy: { maxNoToolCallNudges: 1 },
		});

		await runtime.run("make a web scraping of zentimings.com");

		expect(asked(model)).toBe(1);
		expect(model.requests).toHaveLength(3);
	});

	it("still asks again when what follows the check is not that sentence", async () => {
		for (const reply of [
			"Let me also write a script for it.",
			"Should I save it somewhere else?",
			"The scrape is complete.\n\nHere is everything that was found, at length.",
		]) {
			const model = new ScriptedModel([
				"Here is a summary.",
				"!check",
				reply,
				"Done.",
			]);
			const runtime = new AgentRuntime({
				model,
				tools: [ECHO],
				completionPolicy: { maxNoToolCallNudges: 1 },
			});

			await runtime.run("make a web scraping of zentimings.com");

			// A promise draws the announced-intent nudge as well.
			expect(asked(model), reply).toBeGreaterThanOrEqual(2);
		}
	});

	it("names the unstarted work even when switched off", async () => {
		const model = new OneNoteModel(ANSWER);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				strongNudges: false,
				describeUnstartedWork: () => " TX-01 is open with nothing in it.",
			},
		});

		await runtime.run("fix the import");

		const seen = nudges(model);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("TX-01 is open with nothing in it.");
	});
});
