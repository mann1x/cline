import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@cline/shared";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreSessionEvent } from "../../types/events";
import { LocalRuntimeHost } from "./local-runtime-host";
import { splitCoreSessionConfig } from "./runtime-host";

/**
 * The escalation path as the host wires it.
 *
 * The pieces have their own tests next door; what this file is about is the
 * chain between them, which is where this kind of feature is actually lost. The
 * measured version of that failure in this codebase: a provider field the store
 * wrote, nobody read back, and a panel that rendered blank — every piece
 * working, one link dropping the config, indistinguishable from a feature that
 * ran and had nothing to do.
 */

const expertCalls: Array<{
	prompt: string;
	tools: string[];
	descriptions: Record<string, string>;
	connection: { providerId: string; modelId: string; baseUrl?: string };
	asked: string[];
}> = [];

vi.mock(
	"../../extensions/tools/team/delegated-agent",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../extensions/tools/team/delegated-agent")
			>();
		return {
			...actual,
			createDelegatedAgent: (options: {
				prompt: string;
				tools: Array<{ name: string; description?: string }>;
				configProvider: {
					getConnectionConfig: () => {
						providerId: string;
						modelId: string;
						baseUrl?: string;
					};
				};
			}) => {
				const call = {
					prompt: options.prompt,
					tools: options.tools.map((tool) => tool.name),
					descriptions: Object.fromEntries(
						options.tools.map((tool) => [
							tool.name,
							(tool as { description?: string }).description ?? "",
						]),
					),
					connection: options.configProvider.getConnectionConfig(),
					asked: [] as string[],
				};
				expertCalls.push(call);
				return {
					run: async (prompt: string) => {
						call.asked.push(prompt);
						return {
							text: "I changed step() to clamp the row index and ran the check.",
							iterations: 2,
							finishReason: "completed",
							usage: { inputTokens: 4_000, outputTokens: 300 },
						};
					},
					shutdown: async () => {},
					abort: () => {},
					subscribeEvents: () => () => {},
					getAgentId: () => "expert-1",
					getConversationId: () => "expert-conv-1",
				};
			},
		};
	},
);

function sessionServiceStub(): Record<string, unknown> {
	return {
		ensureSessionsDir: () => tmpdir(),
		createRootSessionWithArtifacts: (input: {
			sessionId?: string;
			prompt?: string;
		}) => {
			const sessionId = input.sessionId?.trim() || `session-${nanoid(5)}`;
			return {
				sessionId,
				manifestPath: join(tmpdir(), `${sessionId}.json`),
				messagesPath: join(tmpdir(), `${sessionId}.messages.json`),
				manifest: {
					version: 1,
					session_id: sessionId,
					status: "running",
					prompt: input.prompt,
				},
			};
		},
		updateSessionStatus: () => ({ updated: false }),
		appendSessionMessages: () => {},
		writeSessionMessages: () => {},
		readSessionManifest: () => undefined,
		listSessions: () => [],
		persistSessionMessages: () => {},
		readSessionMessages: () => [],
		mutateSessionManifest: () => undefined,
	};
}

function stubAgent() {
	const result = {
		text: "ok",
		iterations: 1,
		finishReason: "completed",
		usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
		messages: [],
		toolCalls: [],
		durationMs: 1,
		model: { id: "mock-model", provider: "mock-provider" },
		startedAt: new Date(),
		endedAt: new Date(),
	};
	return {
		run: vi.fn().mockResolvedValue(result),
		continue: vi.fn().mockResolvedValue(result),
		abort: vi.fn(),
		canStartRun: vi.fn().mockReturnValue(true),
		getAgentId: vi.fn().mockReturnValue("agent-escalation-1"),
		getConversationId: vi.fn().mockReturnValue("conv-escalation-1"),
		restore: vi.fn(),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		updateConnection: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		getMessages: vi.fn().mockReturnValue([]),
		messages: [],
	};
}

interface Notice {
	message: string;
	metadata: Record<string, unknown>;
}

function noticesOfKind(events: CoreSessionEvent[], kind: string): Notice[] {
	const found: Notice[] = [];
	for (const event of events) {
		const payload = (event as { payload?: { event?: Notice } }).payload?.event;
		if (payload?.metadata?.kind === kind) {
			found.push(payload);
		}
	}
	return found;
}

describe("the escalation path, as the host wires it", () => {
	let root: string;
	let workspace: string;

	beforeEach(() => {
		expertCalls.length = 0;
		root = mkdtempSync(join(tmpdir(), "escalation-host-"));
		workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		setClineDir(join(root, ".cline"));
		setHomeDir(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function startSession(
		escalation?: Record<string, unknown>,
		atomicProtocol?: Record<string, unknown>,
		extra?: Record<string, unknown>,
	) {
		let agentConfig: AgentConfig | undefined;
		const events: CoreSessionEvent[] = [];
		const host = new LocalRuntimeHost({
			distinctId: `test-${nanoid(5)}`,
			sessionService: sessionServiceStub() as never,
			createAgent: (config: AgentConfig) => {
				agentConfig = config;
				return stubAgent() as never;
			},
		});
		host.subscribe((event) => {
			events.push(event);
		});
		const started = await host.startSession({
			interactive: true,
			...splitCoreSessionConfig({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "test-key",
				cwd: workspace,
				workspaceRoot: workspace,
				systemPrompt: "You are a test agent",
				mode: "act",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				...(escalation ? { escalation } : {}),
				...(atomicProtocol ? { atomicProtocol } : {}),
				...(extra ?? {}),
			} as never),
		});
		return { agentConfig, events, host, sessionId: started.sessionId };
	}

	function escalateVia(agentConfig: AgentConfig | undefined) {
		const tools = (agentConfig?.tools ?? []) as {
			name: string;
			execute?: unknown;
		}[];
		const tool = tools.find((entry) => entry.name === "escalate");
		if (!tool?.execute) {
			throw new Error("no escalate tool on the agent config");
		}
		return (input: unknown) =>
			(tool.execute as (a: unknown, b: unknown) => Promise<unknown>)(input, {
				iteration: 1,
			} as never).then(String);
	}

	// Every build before this one. A tool that is always there and always
	// answers "no expert is configured" is worst exactly where it is reached.
	it("offers no escalate tool when no expert is configured", async () => {
		const { agentConfig } = await startSession();

		expect((agentConfig?.tools ?? []).map((tool) => tool.name)).not.toContain(
			"escalate",
		);
	});

	it("offers escalate when the escalation scope has a connection", async () => {
		const { agentConfig } = await startSession({
			connection: {
				providerId: "ollama",
				modelId: "qwen3.6:27b",
				baseUrl: "http://192.168.178.161:11434",
			},
		});

		expect((agentConfig?.tools ?? []).map((tool) => tool.name)).toContain(
			"escalate",
		);
	});

	// The expert runs on the escalation scope's own connection, not the
	// session's. This is the link the fork has lost before: a field the settings
	// store wrote and nothing downstream read back.
	it("runs the expert on the escalation connection, with the session's tools and not its own", async () => {
		const { agentConfig } = await startSession({
			connection: {
				providerId: "ollama",
				modelId: "qwen3.6:27b",
				baseUrl: "http://192.168.178.161:11434",
			},
		});

		await escalateVia(agentConfig)({
			goal: "explain why step() throws on frame 2",
			expectation: "run_game.js prints ok:true",
		});

		expect(expertCalls).toHaveLength(1);
		expect(expertCalls[0]?.connection.providerId).toBe("ollama");
		expect(expertCalls[0]?.connection.modelId).toBe("qwen3.6:27b");
		expect(expertCalls[0]?.connection.baseUrl).toBe(
			"http://192.168.178.161:11434",
		);
		// An expert that could escalate would escalate to itself.
		expect(expertCalls[0]?.tools).not.toContain("escalate");
	});

	// The transaction is the BASE model's: its budget, its plan, its record of
	// what has been tried, and its rollback. The expert used to be handed the
	// whole decorated list, `submit_transaction` included -- the one tool in
	// the protocol that commits -- so it could close a transaction the base had
	// not finished, or put back work the base meant to keep.
	it("does not hand the expert the base model's change protocol", async () => {
		const { agentConfig } = await startSession(
			{
				connection: {
					providerId: "ollama",
					modelId: "qwen3.6:27b",
					baseUrl: "http://192.168.178.161:11434",
				},
			},
			{
				mode: "static",
				oracleCommand: "node run_game.js",
				maxTransactions: 2,
			},
		);

		// The session itself has them, or this test proves nothing.
		const sessionTools = (agentConfig?.tools ?? []).map((tool) => tool.name);
		expect(sessionTools).toContain("submit_transaction");

		await escalateVia(agentConfig)({
			goal: "explain why step() throws on frame 2",
			expectation: "run_game.js prints ok:true",
		});

		expect(expertCalls).toHaveLength(1);
		for (const protocolTool of [
			"submit_transaction",
			"restore_file",
			"run_check",
			"plan",
		]) {
			expect(expertCalls[0]?.tools).not.toContain(protocolTool);
		}
	});

	// Lead-agent-control spec: "Escalation gets the status tool only." The
	// expert may look at the lead's agents; acting on them stays the lead's.
	it("hands the expert agents_status and none of the lead's agent controls", async () => {
		const { agentConfig } = await startSession(
			{
				connection: {
					providerId: "ollama",
					modelId: "qwen3.6:27b",
					baseUrl: "http://192.168.178.161:11434",
				},
			},
			undefined,
			{ enableSpawnAgent: true, maxConcurrentAgents: 4 },
		);
		const sessionTools = (agentConfig?.tools ?? []).map((tool) => tool.name);
		expect(sessionTools).toEqual(
			expect.arrayContaining(["agents_status", "requeue_agent", "stop_agents"]),
		);

		await escalateVia(agentConfig)({
			goal: "explain why step() throws on frame 2",
			expectation: "run_game.js prints ok:true",
		});

		expect(expertCalls[0]?.tools).toContain("agents_status");
		for (const control of [
			"requeue_agent",
			"restart_agent",
			"resume_agent",
			"retry_failed",
			"message_agents",
			"stop_agents",
		]) {
			expect(expertCalls[0]?.tools).not.toContain(control);
		}
	});

	// The expert is a different model from the session's, usually a different
	// family, and it used to get neither its family's system text nor its tool
	// descriptions -- it read upstream Cline's prompt, written for frontier
	// models, which is the reason family templates exist at all.
	it("gives the expert its own family template, after the role preamble", async () => {
		const { agentConfig } = await startSession({
			connection: {
				providerId: "ollama",
				modelId: "qwen3.6:27b",
				baseUrl: "http://192.168.178.161:11434",
			},
			promptTemplate: {
				name: "qwen",
				fileName: "qwen.md",
				source: "builtin",
				overlaid: true,
				system: "THE QWEN SYSTEM TEXT",
				tools: { read_files: "THE QWEN READ_FILES TEXT" },
			},
		});

		await escalateVia(agentConfig)({
			goal: "explain why step() throws on frame 2",
			expectation: "run_game.js prints ok:true",
		});

		const prompt = expertCalls[0]?.prompt ?? "";
		expect(prompt).toContain("You are the expert on an escalation.");
		expect(prompt).toContain("THE QWEN SYSTEM TEXT");
		// Order is the point. The preamble says the caller is a model and that a
		// suggested patch is the one useless answer; a family prompt read first
		// gets answered as if a user had asked.
		expect(prompt.indexOf("You are the expert on an escalation.")).toBeLessThan(
			prompt.indexOf("THE QWEN SYSTEM TEXT"),
		);
	});

	it("rewrites the expert's tool descriptions from its own template", async () => {
		const { agentConfig } = await startSession({
			connection: {
				providerId: "ollama",
				modelId: "qwen3.6:27b",
				baseUrl: "http://192.168.178.161:11434",
			},
			promptTemplate: {
				name: "qwen",
				fileName: "qwen.md",
				source: "builtin",
				overlaid: true,
				tools: { check_file: "THE QWEN CHECK_FILE TEXT" },
			},
		});

		await escalateVia(agentConfig)({
			goal: "explain why step() throws on frame 2",
			expectation: "run_game.js prints ok:true",
		});

		expect(expertCalls[0]?.descriptions?.check_file).toBe(
			"THE QWEN CHECK_FILE TEXT",
		);
	});

	it("hands the expert a brief carrying the goal and the task", async () => {
		const { agentConfig, host, sessionId } = await startSession({
			connection: { providerId: "ollama", modelId: "qwen3.6:27b" },
		});
		await host.runTurn({ sessionId, prompt: "The game freezes on level two." });

		const result = await escalateVia(agentConfig)({
			goal: "explain why step() throws on frame 2",
		});

		expect(expertCalls[0]?.asked[0]).toContain(
			"explain why step() throws on frame 2",
		);
		expect(expertCalls[0]?.asked[0]).toContain(
			"The game freezes on level two.",
		);
		expect(result).toContain("clamp the row index");
	});

	// The user is paying for the expert and is entitled to read what it was
	// asked and what it answered, in the transcript, beside the work.
	it("puts the hand-over and the delivery on the session's event stream", async () => {
		const { agentConfig, events, host, sessionId } = await startSession({
			connection: { providerId: "ollama", modelId: "qwen3.6:27b" },
		});
		await host.runTurn({ sessionId, prompt: "Fix the crash" });

		await escalateVia(agentConfig)({ goal: "fix the crash" });

		expect(noticesOfKind(events, "escalation_started")).toHaveLength(1);
		const delivered = noticesOfKind(events, "expert_reply");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message).toContain("clamp the row index");
		// What the expert spent, carried on the message: the task header's
		// expert row is built from this, and it is the only figure that answers
		// what a metered account was actually charged for.
		expect(
			(delivered[0]?.metadata.usage as { inputTokens: number }).inputTokens,
		).toBe(4_000);
	});

	it("puts a struggle verdict on the event stream, not only in the model's tool result", async () => {
		// The offer rides the next tool result, which is what the model needs
		// and is invisible to everyone else: across 326 finished runs the
		// corpus could say how often compaction fired and nothing at all about
		// how often the detector did. Thresholds with no evidence behind them
		// are the ones that never get tuned.
		const { agentConfig, events } = await startSession({
			connection: { providerId: "anthropic", modelId: "claude-opus-4-5" },
			maxEscalations: 2,
			struggleThresholds: { editStreak: 2, minIteration: 0, window: 10 },
		});

		// `onEvent` on the agent config is the seam the detector sits behind —
		// the stub never runs a model, so the stream has to be played by hand.
		const onEvent = (agentConfig as { onEvent?: (event: unknown) => void })
			?.onEvent;
		if (!onEvent) {
			throw new Error("the host installed no onEvent on the agent config");
		}
		const play = (event: unknown) => onEvent(event);
		play({ type: "iteration_start", iteration: 1 });
		for (const path of ["a.ts", "b.ts"]) {
			play({
				type: "content_start",
				contentType: "tool",
				toolName: "editor",
				input: { path },
			});
			play({
				type: "content_end",
				contentType: "tool",
				toolName: "editor",
				error: "the edit was refused",
			});
		}
		play({ type: "iteration_end", iteration: 1 });

		// The nudge arm reads the files in play before it holds, so the notice
		// lands a tick or two after the verdict — deliberately, since a nudge is
		// not worth making the turn boundary wait on a disk.
		//
		// Polled rather than slept. This was a flat 50ms, which is a bet that a
		// disk read finishes inside 50ms — true on an idle machine and false
		// under a full 295-file run, where it failed as `expected 0 to be
		// greater than 0` roughly one run in three while passing every time in
		// isolation. Waiting on the condition is both faster when it is fast and
		// correct when the machine is busy.
		// `vi.waitFor` rather than the flat 50ms this used to sleep. 50ms is a
		// bet that a disk read finishes in 50ms -- true on an idle machine, and
		// false under a full 295-file run, where it failed as `expected 0 to be
		// greater than 0` while passing every time in isolation. Waiting on the
		// condition is faster when it is fast and correct when it is not.
		const struggle = await vi.waitFor(() => {
			const found = noticesOfKind(events, "struggle");
			expect(found.length).toBeGreaterThan(0);
			return found;
		});
		expect(struggle.length).toBeGreaterThan(0);
		expect(["nudge", "offer"]).toContain(struggle[0]?.metadata.phase);
	});
});
