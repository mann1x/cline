import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
 * The change protocol as the host wires it, short of the agent loop.
 *
 * The loop's half is tested in `@cline/agents` (the boundary fires on both ways
 * a run can end); this covers everything on the host side of that call — the
 * config arriving, an oracle being resolved against the workspace, the rollback
 * running, and the verdict reaching the session's event stream.
 *
 * Between them they cover the failure this feature is most exposed to: every
 * piece working while one link in the chain quietly drops the config, which
 * looks exactly like a protocol that ran and had nothing to do.
 */

/**
 * Enough session service to start a session and no more. The persistence path
 * has its own coverage next door; what this file is about is what happens at
 * the completion boundary.
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

interface TransactionNotice {
	message: string;
	metadata: Record<string, unknown>;
}

/**
 * The verdict as it leaves the host, on the session's own event stream — the
 * one channel both the CLI's line and the extension's chat row read.
 */
function findTransactionNotice(
	events: CoreSessionEvent[],
): TransactionNotice | undefined {
	for (const event of events) {
		const payload = (event as { payload?: { event?: TransactionNotice } })
			.payload?.event;
		if (payload?.metadata?.kind === "atomic_transaction") {
			return payload;
		}
	}
	return undefined;
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
		// An interactive session's second turn goes through `continue`, not
		// `run`, so a stub that only answers `run` fails on the turn this file
		// most needs to look at.
		continue: vi.fn().mockResolvedValue(result),
		abort: vi.fn(),
		canStartRun: vi.fn().mockReturnValue(true),
		getAgentId: vi.fn().mockReturnValue("agent-atomic-1"),
		getConversationId: vi.fn().mockReturnValue("conv-atomic-1"),
		restore: vi.fn(),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		updateConnection: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		getMessages: vi.fn().mockReturnValue([]),
		messages: [],
	};
}

describe("the change protocol, as the host wires it", () => {
	let root: string;
	let workspace: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-host-"));
		workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		setClineDir(join(root, ".cline"));
		setHomeDir(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function startProtocolSession(
		oracleCommand: string,
		oracleExpect?: string,
		// A non-interactive session shuts down when its turn ends, so a test that
		// sends two turns has to keep it open.
		interactive = false,
	) {
		let agentConfig: AgentConfig | undefined;
		const events: CoreSessionEvent[] = [];
		const agent = stubAgent();
		const host = new LocalRuntimeHost({
			distinctId: `test-${nanoid(5)}`,
			sessionService: sessionServiceStub() as never,
			createAgent: (config: AgentConfig) => {
				agentConfig = config;
				return agent as never;
			},
		});
		host.subscribe((event) => {
			events.push(event);
		});

		const started = await host.startSession({
			interactive,
			...splitCoreSessionConfig({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "test-key",
				cwd: workspace,
				systemPrompt: "You are a test agent",
				mode: "act",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				atomicProtocol: {
					mode: "auto",
					oracleCommand,
					...(oracleExpect ? { oracleExpect } : {}),
					maxTransactions: 2,
				},
			}),
		});

		return { agentConfig, events, host, agent, sessionId: started.sessionId };
	}

	it("puts the workspace back when the check fails, and says so on the session's stream", async () => {
		writeFileSync(join(workspace, "game.js"), "original", "utf8");
		const { agentConfig, events } = await startProtocolSession("exit 1");

		writeFileSync(join(workspace, "game.js"), "edited", "utf8");
		writeFileSync(join(workspace, "scratch.js"), "junk", "utf8");
		const message = await agentConfig?.completionPolicy?.onCompletionAttempt?.({
			text: "Fixed it.",
		});

		expect(message).toContain("TX-01 discarded");
		expect(readFileSync(join(workspace, "game.js"), "utf8")).toBe("original");
		const notice = findTransactionNotice(events);
		expect(notice?.metadata.kept).toBe(false);
		// The edited file put back and the stray one removed.
		expect(notice?.metadata.filesPutBack).toBe(2);
		expect(notice?.message).toContain("discarded");
	});

	it("lets the run end when the check passes", async () => {
		writeFileSync(join(workspace, "game.js"), "original", "utf8");
		const { agentConfig } = await startProtocolSession("exit 0");

		writeFileSync(join(workspace, "game.js"), "edited", "utf8");

		await expect(
			agentConfig?.completionPolicy?.onCompletionAttempt?.({ text: "Fixed." }),
		).resolves.toBeUndefined();
		expect(readFileSync(join(workspace, "game.js"), "utf8")).toBe("edited");
	});

	// The case the harness's own oracle is: it prints its verdict and exits 0
	// either way, so exit status alone would keep every transaction.
	it("fails a check that exits cleanly while reporting a problem", async () => {
		writeFileSync(join(workspace, "game.js"), "original", "utf8");
		const { agentConfig } = await startProtocolSession(
			`echo '{"ok":false,"error":"ReferenceError"}'`,
			'"ok":\\s*true',
		);

		writeFileSync(join(workspace, "game.js"), "edited", "utf8");
		const message = await agentConfig?.completionPolicy?.onCompletionAttempt?.(
			{},
		);

		expect(message).toContain("TX-01 discarded");
		expect(message).toContain("ReferenceError");
		expect(readFileSync(join(workspace, "game.js"), "utf8")).toBe("original");
	});

	// Answering a question about the code is a legitimate way for a run to end,
	// and running a check to confirm nobody edited anything is a cost with no
	// verdict in it.
	it("does not run the check on a task that changed nothing", async () => {
		writeFileSync(join(workspace, "game.js"), "original", "utf8");
		const { agentConfig, events } = await startProtocolSession("exit 1");

		await expect(
			agentConfig?.completionPolicy?.onCompletionAttempt?.({
				text: "That file draws the sprite.",
			}),
		).resolves.toBeUndefined();
		expect(findTransactionNotice(events)).toBeUndefined();
	});

	// The rules go where the harness this comes from puts them. Measured: from
	// the system prompt the same model made eight edits against a limit of three
	// and never wrote the plan; the harness puts the identical text in the
	// opening message and gets the plan.
	it("sends the opening rules with the user's first message, once", async () => {
		writeFileSync(join(workspace, "game.js"), "original", "utf8");
		const { agent, host, sessionId } = await startProtocolSession(
			"exit 0",
			undefined,
			true,
		);

		await host.runTurn({ sessionId, prompt: "fix manic_miner.html" });
		await host.runTurn({ sessionId, prompt: "carry on" });

		const first = String(agent.run.mock.calls[0]?.[0] ?? "");
		const second = String(agent.continue.mock.calls[0]?.[0] ?? "");
		expect(first).toContain("CHANGE PROTOCOL");
		expect(first).toContain("AT MOST 3 changes");
		// Rules first: a model that has read the request has already started
		// planning against it.
		expect(first.indexOf("CHANGE PROTOCOL")).toBeLessThan(
			first.indexOf("fix manic_miner.html"),
		);
		expect(second).not.toContain("CHANGE PROTOCOL");
	});

	it("leaves the completion boundary alone when the protocol is off", async () => {
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
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: false,
			}),
		});

		expect(agentConfig?.completionPolicy?.onCompletionAttempt).toBeUndefined();
	});
});
