import type { AgentEvent, AgentResult } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../atomic/snapshot";
import { ESCALATE_TOOL_NAME } from "./escalate-tool";
import {
	createEscalationSession,
	type EscalationSessionOptions,
} from "./escalation-session";

function snapshotOf(files: Record<string, string>): Snapshot {
	return {
		root: "/work",
		skipped: [],
		files: new Map(
			Object.entries(files).map(([path, body]) => [
				path,
				{ hash: body, body: Buffer.from(body) },
			]),
		),
	};
}

function build(over: Partial<EscalationSessionOptions> = {}) {
	const asked: string[] = [];
	const open = vi.fn(
		async (_context: { onEvent: (event: AgentEvent) => void }) => ({
			run: async (prompt: string): Promise<AgentResult> => {
				asked.push(prompt);
				return {
					text: `expert reply ${asked.length}`,
					iterations: 1,
					usage: { inputTokens: 10, outputTokens: 5 },
				} as AgentResult;
			},
			shutdown: vi.fn(async () => {}),
		}),
	);
	const session = createEscalationSession({
		workspaceRoot: "/work",
		config: { connection: { providerId: "ollama", modelId: "big" } },
		openExpert: open,
		takeSnapshot: async () => snapshotOf({ "/work/a.js": "before" }),
		...over,
	});
	const tool = session.tools.find((entry) => entry.name === ESCALATE_TOOL_NAME);
	return {
		session,
		open,
		asked,
		call: (input: unknown) =>
			(tool?.execute(input, {} as never) as Promise<string>) ??
			Promise.reject(new Error("no escalate tool")),
	};
}

describe("createEscalationSession", () => {
	// No expert configured is every previous build: the tool is not offered at
	// all. An `escalate` that always answers "no expert is configured" is worse
	// than no tool -- a stuck model will call it anyway, and repeatedly.
	it("offers no tool when no expert is configured", () => {
		const session = createEscalationSession({
			workspaceRoot: "/work",
			config: undefined,
			openExpert: async () => {
				throw new Error("must not open");
			},
		});

		expect(session.tools).toHaveLength(0);
	});

	it("offers no tool when the escalation scope has no connection", () => {
		const session = createEscalationSession({
			workspaceRoot: "/work",
			config: { maxEscalations: 3 },
			openExpert: async () => {
				throw new Error("must not open");
			},
		});

		expect(session.tools).toHaveLength(0);
	});

	it("offers escalate when an expert is configured", () => {
		const { session } = build();

		expect(session.tools.map((tool) => tool.name)).toEqual([
			ESCALATE_TOOL_NAME,
		]);
	});

	// The brief is what the expert is given, and the goal is the part of it the
	// base model wrote. Checked here rather than trusting `brief.ts`: this is
	// the seam where the two halves are wired together.
	it("hands the brief to the expert on the first call", async () => {
		const { call, asked } = build({
			readTask: () => "The game freezes on level two.",
		});

		const result = await call({
			goal: "explain why step() throws on frame 2",
			expectation: "run_game.js prints ok:true",
		});

		expect(asked[0]).toContain("explain why step() throws on frame 2");
		expect(asked[0]).toContain("The game freezes on level two.");
		expect(result).toContain("expert reply 1");
	});

	// One conversation, not one per message: the expert still has the exchange
	// in its context, and on a hosted provider its prompt cache is still warm.
	it("continues the same conversation on a follow-up", async () => {
		const { call, asked, open } = build();

		await call({ goal: "fix it" });
		await call({ message: "that did not run — it throws on line 40" });

		expect(open).toHaveBeenCalledTimes(1);
		expect(asked).toHaveLength(2);
		expect(asked[1]).toContain("it throws on line 40");
		// The follow-up is the model's own words, not another brief.
		expect(asked[1]).not.toContain("== ESCALATION ==");
	});

	// With the change protocol off there is nothing behind the expert's edits,
	// and it has edit rights. The snapshot is what makes handing control to a
	// second model recoverable.
	it("takes its own snapshot when there is no open transaction", async () => {
		const takeSnapshot = vi.fn(async () =>
			snapshotOf({ "/work/a.js": "before" }),
		);
		const { call, asked } = build({ takeSnapshot });

		await call({ goal: "fix it" });

		expect(takeSnapshot).toHaveBeenCalled();
		expect(asked[0]).toMatch(/snapshot/i);
	});

	// With the protocol on, the open transaction's snapshot already covers the
	// expert -- its edits are inside the transaction and a discard puts them
	// back with everything else. The brief says that instead.
	it("puts the open transaction in the brief rather than a snapshot of its own", async () => {
		const { call, asked } = build({
			readTransaction: () => ({
				transaction: 2,
				maxTransactions: 6,
				maxChanges: 6,
				history: [],
			}),
		});

		await call({ goal: "fix it" });

		expect(asked[0]).toContain("TX-02");
		expect(asked[0]).toMatch(/rolled back/i);
	});

	// The expert moves lines the base model has already read, and the editor's
	// read-before-edit guard is the only thing between a stale line number and
	// the file on disk. Same reasoning as `restore_file`, same seam.
	it("retires the base model's reads of files the expert changed, and names them", async () => {
		const forgetReads = vi.fn();
		const states = [
			snapshotOf({ "/work/a.js": "before", "/work/b.js": "same" }),
			snapshotOf({ "/work/a.js": "after", "/work/b.js": "same" }),
		];
		let taken = 0;
		const { call } = build({
			forgetReads,
			takeSnapshot: async () => states[Math.min(taken++, states.length - 1)],
		});

		const result = await call({ goal: "fix it" });

		expect(forgetReads).toHaveBeenCalledWith("/work/a.js");
		expect(forgetReads).not.toHaveBeenCalledWith("/work/b.js");
		expect(result).toContain("a.js");
	});

	// Ending it is a decision, and the host's setting decides what ending means.
	// Closed here, so the slot goes back.
	it("releases the expert when the model says it is finished and the host says close", async () => {
		const shutdown = vi.fn(async () => {});
		const { call } = build({
			config: {
				connection: { providerId: "ollama", modelId: "big" },
				closeAfterEscalation: true,
			},
			openExpert: async () => ({
				run: async () =>
					({
						text: "ok",
						iterations: 1,
						usage: { inputTokens: 1, outputTokens: 1 },
					}) as AgentResult,
				shutdown,
			}),
		});

		await call({ goal: "fix it" });
		const result = await call({ message: "thanks", finished: true });

		expect(shutdown).toHaveBeenCalled();
		expect(result).toMatch(/closed|released/i);
	});

	// Held is the default, so nothing is released until the task ends -- and
	// then it must be, or a local server's slot stays booked by a conversation
	// nothing can reach.
	it("holds the expert by default and releases it on teardown", async () => {
		const shutdown = vi.fn(async () => {});
		const { call, session } = build({
			openExpert: async () => ({
				run: async () =>
					({
						text: "ok",
						iterations: 1,
						usage: { inputTokens: 1, outputTokens: 1 },
					}) as AgentResult,
				shutdown,
			}),
		});

		await call({ goal: "fix it" });
		await call({ message: "done", finished: true });
		expect(shutdown).not.toHaveBeenCalled();

		await session.dispose();
		expect(shutdown).toHaveBeenCalled();
	});

	// The budget is the thing that stops a stuck model spending a metered
	// account. Past it the tool still answers -- it says what happened and what
	// to do instead -- and no expert is opened.
	it("refuses past the escalation budget without opening an expert", async () => {
		const { call, open } = build({
			config: {
				connection: { providerId: "ollama", modelId: "big" },
				maxEscalations: 1,
				closeAfterEscalation: true,
			},
		});

		await call({ goal: "first" });
		await call({ finished: true });
		const result = await call({ goal: "second" });

		expect(result).toMatch(/limit/i);
		expect(open).toHaveBeenCalledTimes(1);
	});

	// What the task spent on the expert, separable from its own. The header row
	// is built from this.
	it("reports what the expert has spent", async () => {
		const { call, session } = build();

		await call({ goal: "fix it" });

		expect(session.usage.requests).toBe(1);
		expect(session.usage.inputTokens).toBe(10);
		expect(session.usage.outputTokens).toBe(5);
	});

	// The exchange belongs in the chat, and the host renders it. Emitted rather
	// than logged: a log line cannot be a message in the transcript, and the
	// user paying for the expert is entitled to read what it was asked.
	it("announces the hand-over and the delivery to the host", async () => {
		const events: string[] = [];
		const { call } = build({
			onEvent: (event) => events.push(event.type),
		});

		await call({ goal: "fix it" });

		expect(events).toEqual(["escalation_started", "expert_replied"]);
	});

	// A snapshot nobody can go back to is theatre. This is the other half of
	// taking one: the workspace as the first escalation of the task found it,
	// which is the only undo there is when the change protocol is off.
	it("restores the workspace as the first escalation found it", async () => {
		const restoreSnapshot = vi.fn(async () => ({
			restored: ["/work/a.js"],
			removed: [],
			recreated: [],
			uncovered: [],
		}));
		const first = snapshotOf({ "/work/a.js": "before" });
		const { call, session } = build({
			restoreSnapshot,
			takeSnapshot: async () => first,
		});

		expect(await session.restore()).toBeUndefined();
		await call({ goal: "fix it" });
		const report = await session.restore();

		expect(restoreSnapshot).toHaveBeenCalledWith(first);
		expect(report?.restored).toEqual(["/work/a.js"]);
	});

	// While the expert is working the base model is blocked inside a tool call,
	// so the turn boundary that ordinarily delivers a steering message will not
	// come round until the escalation is over. The user's words would otherwise
	// wait out the whole exchange they were written about.
	it("carries a steering message into the brief", async () => {
		const { call, asked } = build({
			takeSteering: () => "not that file — the bug is in board.js",
		});

		await call({ goal: "fix the crash" });

		expect(asked[0]).toContain("not that file — the bug is in board.js");
		expect(asked[0]).toMatch(/user/i);
	});

	// And one that arrives while the expert is running reaches the base model on
	// the way back, because by then the brief has already gone.
	it("hands back steering that arrived while the expert was working", async () => {
		let asks = 0;
		const { call } = build({
			// Nothing at hand-over; a message typed during the run.
			takeSteering: () =>
				asks++ === 0 ? undefined : "stop, I fixed it myself",
		});

		const result = await call({ goal: "fix the crash" });

		expect(result).toContain("stop, I fixed it myself");
	});

	// Nothing typed is the ordinary case, and it must add nothing at all: a
	// heading with no message under it teaches the expert that the user said
	// something and it was lost.
	it("says nothing about the user when nothing was typed", async () => {
		const { call, asked } = build({ takeSteering: () => undefined });

		const result = await call({ goal: "fix the crash" });

		expect(asked[0]).not.toMatch(/FROM THE USER/i);
		expect(result).not.toMatch(/FROM THE USER/i);
	});

	// The user's own veto, when the host asks for one. A refused escalation
	// spends nothing: the budget is what the model is rationed by, and being
	// told "no" by a person is not the model overspending.
	it("spends nothing when the user refuses the escalation", async () => {
		const { call, open, session } = build({
			config: {
				connection: { providerId: "ollama", modelId: "big" },
				requireApproval: true,
			},
			approve: async () => false,
		});

		const result = await call({ goal: "fix it" });

		expect(open).not.toHaveBeenCalled();
		expect(session.used).toBe(0);
		expect(result).toMatch(/did not|refus|declin/i);
	});

	// Run slhu9, 2026-09-13: the expert's ollama answered "ollama cloud is
	// disabled: remote model is unavailable" 31ms after the hand-over. The base
	// model was told that this was the delivery, and the task was charged an
	// escalation for a model that was never asked anything.
	it("says the escalation did not happen when the expert's run failed", async () => {
		const harness = build({
			openExpert: async () => ({
				run: async (): Promise<AgentResult> =>
					({
						text: "ollama cloud is disabled: remote model is unavailable",
						iterations: 1,
						finishReason: "error",
						usage: { inputTokens: 0, outputTokens: 0 },
					}) as AgentResult,
				shutdown: vi.fn(async () => {}),
			}),
		});

		const result = await harness.call({ goal: "fix line 90" });

		expect(result).toContain("The escalation did not happen");
		expect(result).toContain("ollama cloud is disabled");
		expect(result).not.toContain("THIS IS A DELIVERY");
	});

	it("gives the escalation back when the expert's run failed", async () => {
		let fail = true;
		const prompts: string[] = [];
		const harness = build({
			config: {
				connection: { providerId: "ollama", modelId: "big" },
				maxEscalations: 1,
			},
			openExpert: async () => ({
				run: async (prompt: string): Promise<AgentResult> => {
					prompts.push(prompt);
					if (fail) {
						fail = false;
						return {
							text: "upstream is down",
							iterations: 1,
							finishReason: "error",
							usage: { inputTokens: 0, outputTokens: 0 },
						} as AgentResult;
					}
					return {
						text: "fixed line 90",
						iterations: 1,
						usage: { inputTokens: 10, outputTokens: 5 },
					} as AgentResult;
				},
				shutdown: vi.fn(async () => {}),
			}),
		});

		await harness.call({ goal: "fix line 90" });
		// The only escalation this task has. A charge for the failed attempt
		// would make this second call the one that is refused.
		const second = await harness.call({ goal: "fix line 90" });

		expect(second).toContain("fixed line 90");
		expect(second).not.toContain("did not happen");
		// And it is a hand-over, not a follow-up into the conversation the
		// failure left behind: the expert gets the brief, not the raw goal.
		expect(second).toContain("THIS IS A DELIVERY");
		expect(prompts.at(-1)).toContain("== ESCALATION ==");
	});

	// A hand-over is one tool call from the base model's side, so the chat had
	// nothing to say between the brief and the delivery. On 2026-09-13 that was
	// twenty minutes of one collapsed grey line while the expert made twelve
	// tool calls and spent 40k tokens nobody could see.
	it("reports the expert's progress while the turn is still running", async () => {
		const events: Array<{ type: string; [key: string]: unknown }> = [];
		const harness = build({
			onEvent: (event) => events.push(event),
			openExpert: async ({ onEvent }) => ({
				run: async (): Promise<AgentResult> => {
					onEvent({
						type: "content_end",
						contentType: "tool",
						toolName: "read_files",
					} as AgentEvent);
					onEvent({
						type: "usage",
						inputTokens: 31_054,
						outputTokens: 2_100,
					} as AgentEvent);
					onEvent({
						type: "content_end",
						contentType: "tool",
						toolName: "grep",
					} as AgentEvent);
					return {
						text: "fixed line 90",
						iterations: 3,
						usage: { inputTokens: 31_054, outputTokens: 2_100 },
					} as AgentResult;
				},
				shutdown: vi.fn(async () => {}),
			}),
		});

		await harness.call({ goal: "fix line 90" });

		const progress = events.filter((event) => event.type === "expert_progress");
		expect(progress).toHaveLength(3);
		expect(progress[0]).toMatchObject({
			index: 1,
			of: 3,
			toolCalls: 1,
			lastTool: "read_files",
		});
		expect(progress[2]).toMatchObject({ toolCalls: 2, lastTool: "grep" });
		// The spend has to be live, not the zeroes a turn carries until it ends.
		expect((progress[2].usage as { inputTokens: number }).inputTokens).toBe(
			31_054,
		);
	});

	// The approval moved out of a modal dialog and into the chat, where there
	// is room to say why. A refusal that carries a reason tells the model what
	// to do instead; one that does not only tells it to stop asking.
	it("passes on what the user said when they declined", async () => {
		const harness = build({
			config: {
				connection: { providerId: "ollama", modelId: "big" },
				requireApproval: true,
			},
			approve: async () => ({
				approved: false,
				feedback: "don't escalate for syntax errors, run node --check first",
			}),
		});

		const result = await harness.call({ goal: "fix line 90" });

		expect(result).toContain("did not approve");
		expect(result).toContain("They said: don't escalate for syntax errors");
		// A refusal spends nothing, so the expert is never opened.
		expect(harness.open).not.toHaveBeenCalled();
	});

	it("still takes a bare boolean from a host with only a yes and a no", async () => {
		const harness = build({
			config: {
				connection: { providerId: "ollama", modelId: "big" },
				requireApproval: true,
			},
			approve: async () => true,
		});

		const result = await harness.call({ goal: "fix line 90" });

		expect(result).toContain("expert reply 1");
		expect(harness.open).toHaveBeenCalled();
	});

	// A host with nobody to ask can only refuse. Escalating anyway would make
	// `requireApproval` do the opposite of what it says.
	it("refuses when the host configured no way to ask", async () => {
		const harness = build({
			config: {
				connection: { providerId: "ollama", modelId: "big" },
				requireApproval: true,
			},
		});

		const result = await harness.call({ goal: "fix line 90" });

		expect(result).toContain("did not approve");
		expect(harness.open).not.toHaveBeenCalled();
	});
});
