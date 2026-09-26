import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@cline/shared";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compactionConfigs: Array<Record<string, unknown>> = [];
vi.mock("../../extensions/context/compaction", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createContextCompactionPrepareTurn: (config: Record<string, unknown>) => {
		compactionConfigs.push(config);
		return undefined;
	},
}));

import { LocalRuntimeHost } from "./local-runtime-host";
import { splitCoreSessionConfig } from "./runtime-host";

/**
 * What the Checkpoints switch turns off.
 *
 * Reported by the tester: "I have disabled checkpoints in features but the
 * model can still use restore_file and rollback, I was expecting the machinery
 * to be completely disabled ... only change protocol at that point should keep
 * the restore_file available when engaged."
 *
 * The session-scoped revision log was deliberately decoupled from the change
 * protocol so that a run with `--atomic off` still recorded a history worth
 * having. Nothing was ever wired to the switch the user was reaching for, so
 * `restore_file` was offered on every session there has been.
 */
function sessionServiceStub(): Record<string, unknown> {
	return {
		ensureSessionsDir: () => tmpdir(),
		createRootSessionWithArtifacts: (input: { sessionId?: string }) => {
			const sessionId = input.sessionId?.trim() || `session-${nanoid(5)}`;
			return {
				sessionId,
				manifestPath: join(tmpdir(), `${sessionId}.json`),
				messagesPath: join(tmpdir(), `${sessionId}.messages.json`),
				manifest: { version: 1, session_id: sessionId, status: "running" },
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
		getAgentId: vi.fn().mockReturnValue("agent-rev-1"),
		getConversationId: vi.fn().mockReturnValue("conv-rev-1"),
		restore: vi.fn(),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		updateConnection: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		getMessages: vi.fn().mockReturnValue([]),
		messages: [],
	};
}

describe("what the checkpoints switch turns off", () => {
	let root: string;
	let workspace: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "revisions-host-"));
		workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		setClineDir(join(root, ".cline"));
		setHomeDir(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function toolNames(
		checkpoint: { enabled?: boolean } | undefined,
		atomic?: boolean,
		spawn = false,
	): Promise<string[]> {
		let agentConfig: AgentConfig | undefined;
		const host = new LocalRuntimeHost({
			distinctId: `test-${nanoid(5)}`,
			sessionService: sessionServiceStub() as never,
			createAgent: (config: AgentConfig) => {
				agentConfig = config;
				return stubAgent() as never;
			},
		});
		await host.startSession({
			interactive: false,
			...splitCoreSessionConfig({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "test-key",
				cwd: workspace,
				systemPrompt: "You are a test agent",
				mode: "act",
				enableTools: true,
				enableSpawnAgent: spawn,
				enableAgentTeams: false,
				...(checkpoint ? { checkpoint } : {}),
				...(atomic
					? {
							atomicProtocol: {
								mode: "static" as const,
								// An oracle, because without one the protocol is not
								// built at all and the test would be asserting the
								// fallback it means to rule out.
								oracleCommand: "node --version",
								maxTransactions: 2,
							},
						}
					: {}),
			}),
		});
		return ((agentConfig?.tools ?? []) as { name: string }[]).map(
			(tool) => tool.name,
		);
	}

	it("offers restore_file while checkpoints are on", async () => {
		expect(await toolNames({ enabled: true })).toContain("restore_file");
	});

	it("withholds restore_file once checkpoints are off", async () => {
		expect(await toolNames({ enabled: false })).not.toContain("restore_file");
	});

	// A delegated agent's changes come back only as revisions: with no way to
	// read or adopt one, the agent's work was unreachable. Its own writes are
	// still not recorded, so what it can reach is the agents' work alone.
	it("still offers reading and adopting revisions when the session can delegate", async () => {
		const names = await toolNames({ enabled: false }, false, true);
		expect(names).toContain("spawn_agent");
		expect(names).toContain("restore_file");
	});

	// The one exception the tester named. The protocol brings its own
	// `restore_file` and its own transaction to roll back to, and that rollback
	// is the protocol working rather than the checkpoint machinery leaking.
	it("keeps restore_file when the change protocol is engaged", async () => {
		expect(await toolNames({ enabled: false }, true)).toContain("restore_file");
	});

	// An SDK or CLI caller that never mentions checkpoints is not a user who
	// turned them off, and silently stripping the tool from every headless run
	// would be a different change from the one that was asked for.
	it("leaves a caller that says nothing alone", async () => {
		expect(await toolNames(undefined)).toContain("restore_file");
	});
});

describe("what the checkpoints switch does not turn off", () => {
	let root: string;
	let workspace: string;

	beforeEach(() => {
		compactionConfigs.length = 0;
		root = mkdtempSync(join(tmpdir(), "ledger-host-"));
		workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		setClineDir(join(root, ".cline"));
		setHomeDir(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function compactionConfig(checkpoint: {
		enabled?: boolean;
	}): Promise<Record<string, unknown>> {
		const host = new LocalRuntimeHost({
			distinctId: `test-${nanoid(5)}`,
			sessionService: sessionServiceStub() as never,
			createAgent: () => stubAgent() as never,
		});
		await host.startSession({
			interactive: false,
			...splitCoreSessionConfig({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "test-key",
				cwd: workspace,
				systemPrompt: "You are a test agent",
				mode: "act",
				enableTools: true,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				checkpoint,
				compaction: { enabled: true, strategy: "agentic" },
			}),
		});
		return (compactionConfigs.at(-1)?.compaction ?? {}) as Record<
			string,
			unknown
		>;
	}

	// The ledger is the only place a refused call survives compaction, and it
	// was wired to the checkpoints switch -- so a tester who had turned the
	// change protocol off had never seen one. Measured on pandorum session
	// 1789852877349_7bbnd: generation 4 carried a retrospective and a summary
	// and no ledger, and the model went on not knowing it had a checker to
	// run. Core's own comment argues against exactly this coupling.
	it("keeps the tool ledger when checkpoints are off", async () => {
		const config = await compactionConfig({ enabled: false });
		expect(config.toolLedgerEnabled).not.toBe(false);
		// What the switch does still take: the revision addresses, because a
		// ledger naming revisions no tool can reach reads as an offer.
		expect(config.revisions).toBeUndefined();
	});

	it("keeps the revision addresses when checkpoints are on", async () => {
		const config = await compactionConfig({ enabled: true });
		expect(config.toolLedgerEnabled).not.toBe(false);
		expect(config.revisions).toBeDefined();
	});
});
