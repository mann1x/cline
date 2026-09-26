import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@cline/shared";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetAgentRounds,
	roundsFor,
} from "../../extensions/tools/team/agent-rounds";
import {
	__resetSubagentCancellations,
	registerSubagentCancellation,
} from "../../extensions/tools/team/subagent-cancellation";
import { LocalRuntimeHost } from "./local-runtime-host";
import { splitCoreSessionConfig } from "./runtime-host";

/**
 * Background rounds as the host wires them (lead-agent-control spec, A): a
 * round's report reaches the lead at its next boundary, as a background
 * delegation's does, and a user's message while the lead works beside a
 * background round goes to the lead -- the side turn is for a lead that is
 * waiting.
 */

function sessionServiceStub(dir: string): Record<string, unknown> {
	return {
		ensureSessionsDir: () => dir,
		createRootSessionWithArtifacts: (input: {
			sessionId?: string;
			prompt?: string;
		}) => {
			const sessionId = input.sessionId?.trim() || `session-${nanoid(5)}`;
			return {
				sessionId,
				manifestPath: join(dir, `${sessionId}.json`),
				messagesPath: join(dir, `${sessionId}.messages.json`),
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
	const messages: unknown[] = [];
	return {
		run: vi.fn().mockResolvedValue(result),
		continue: vi.fn().mockResolvedValue(result),
		abort: vi.fn(),
		canStartRun: vi.fn().mockReturnValue(true),
		getAgentId: vi.fn().mockReturnValue("lead-1"),
		getConversationId: vi.fn().mockReturnValue("conv-1"),
		restore: vi.fn((next: unknown[]) => {
			messages.splice(0, messages.length, ...next);
		}),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		updateConnection: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		getMessages: vi.fn(() => [...messages]),
		messages,
	};
}

describe("background rounds, as the host wires them", () => {
	let root: string;
	let agent: ReturnType<typeof stubAgent>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "rounds-host-"));
		mkdirSync(join(root, "workspace"), { recursive: true });
		setClineDir(join(root, ".cline"));
		setHomeDir(root);
		agent = stubAgent();
	});

	afterEach(() => {
		__resetAgentRounds();
		__resetSubagentCancellations();
		rmSync(root, { recursive: true, force: true });
	});

	async function start(sessionId?: string) {
		const host = new LocalRuntimeHost({
			distinctId: `test-${nanoid(5)}`,
			sessionService: sessionServiceStub(root) as never,
			createAgent: (_config: AgentConfig) => agent as never,
		});
		const started = await host.startSession({
			interactive: true,
			...splitCoreSessionConfig({
				...(sessionId ? { sessionId } : {}),
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "test-key",
				cwd: join(root, "workspace"),
				workspaceRoot: join(root, "workspace"),
				systemPrompt: "You are a test agent",
				mode: "act",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: false,
			} as never),
		});
		return { host, sessionId: started.sessionId };
	}

	function backgroundRound(sessionId: string) {
		const rounds = roundsFor(sessionId);
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: true,
			agents: [{ name: "bg", task: "t" }],
		});
		let finish: () => void = () => {};
		void handle.run(
			0,
			{ agentId: "lead", iteration: 1, sessionId } as never,
			() =>
				new Promise((resolve) => {
					finish = () =>
						resolve({ text: "the background work", finishReason: "completed" });
				}),
		);
		handle.close();
		return { rounds, finish: () => finish() };
	}

	it("puts a finished round's report in front of an idle lead", async () => {
		const { sessionId } = await start();
		const { rounds, finish } = backgroundRound(sessionId);
		finish();
		await vi.waitFor(() => expect(rounds.get("r1")?.delivered).toBe(true));
		const last = agent.messages.at(-1) as { role: string; content: string };
		expect(last.role).toBe("user");
		expect(last.content).toContain("[Round r1 finished]");
		expect(last.content).toContain("the background work");
	});

	// A round still running when the session ended -- the window reloaded, the
	// task closed -- has no agents anywhere when the session comes back. They
	// are interrupted, and the lead is told at its next turn, with the way to
	// run them again.
	it("tells the lead of a round the session's end interrupted, when the session comes back", async () => {
		const first = await start();
		const { rounds } = backgroundRound(first.sessionId);
		expect(rounds.get("r1")?.status).toBe("running");
		await first.host.stopSession(first.sessionId);

		agent = stubAgent();
		const again = await start(first.sessionId);
		expect(again.sessionId).toBe(first.sessionId);
		const round = roundsFor(again.sessionId).get("r1");
		expect(round?.agents[0]).toMatchObject({
			state: "cancelled",
			stopReason: "interrupted",
		});
		// The lead is idle at its start: the notice is in its transcript, for
		// its next turn, as a background round's report reaches an idle lead.
		const last = agent.messages.at(-1) as { role: string; content: string };
		expect(last?.role).toBe("user");
		expect(last?.content).toMatch(/^\[Round r1 interrupted\] /);
		expect(last?.content).toContain('retry_failed(round_id: "r1")');
		expect(round?.delivered).toBe(true);
	});

	it("queues it for the next boundary when the lead is mid-turn", async () => {
		const { host, sessionId } = await start();
		agent.canStartRun.mockReturnValue(false);
		const { rounds, finish } = backgroundRound(sessionId);
		finish();
		await vi.waitFor(() => expect(rounds.get("r1")?.delivered).toBe(true));
		const pending = await host.pendingPrompts.list({ sessionId });
		expect(JSON.stringify(pending)).toContain("[Round r1 finished]");
		expect(agent.messages).toHaveLength(0);
	});

	it("sends a steer to the lead, not a side turn, while it works beside a background round", async () => {
		const { host, sessionId } = await start();
		agent.canStartRun.mockReturnValue(false);
		backgroundRound(sessionId);
		registerSubagentCancellation(`${sessionId}::c#0`, undefined, "bg");
		await host.runTurn({
			sessionId,
			prompt: "also check the tests",
			delivery: "steer",
		} as never);
		const pending = await host.pendingPrompts.list({ sessionId });
		expect(JSON.stringify(pending)).toContain("also check the tests");
	});
});
