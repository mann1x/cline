import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamRuntimeState } from "@cline/shared";
import { resolveTeamDataDir } from "@cline/shared/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTeamStore } from "../../../services/storage/file-team-store";
import { SqliteTeamStore } from "../../../services/storage/sqlite-team-store";
import { reviveTeamStateDates as reviveSessionTeamStateDates } from "../../../session/models/session-row";
import { readAgentReport } from "./agent-reports";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";
import { AgentTeamsRuntime } from "./multi-agent";
import {
	bootstrapAgentTeams,
	createAgentTeamsTools,
	reviveTeamStateDates,
} from "./team-tools";

type EnvSnapshot = {
	CLINE_DATA_DIR: string | undefined;
	CLINE_TEAM_DATA_DIR: string | undefined;
};

function captureEnv(): EnvSnapshot {
	return {
		CLINE_DATA_DIR: process.env.CLINE_DATA_DIR,
		CLINE_TEAM_DATA_DIR: process.env.CLINE_TEAM_DATA_DIR,
	};
}

function restoreEnv(snapshot: EnvSnapshot): void {
	process.env.CLINE_DATA_DIR = snapshot.CLINE_DATA_DIR;
	process.env.CLINE_TEAM_DATA_DIR = snapshot.CLINE_TEAM_DATA_DIR;
}

function makeTeammateConfigProvider(
	overrides?: Partial<Parameters<typeof createDelegatedAgentConfigProvider>[0]>,
) {
	return createDelegatedAgentConfigProvider({
		providerId: "anthropic",
		modelId: "claude-sonnet-4-5-20250929",
		...overrides,
	});
}

describe("resolveTeamDataDir", () => {
	let snapshot: EnvSnapshot = captureEnv();

	afterEach(() => {
		restoreEnv(snapshot);
	});

	it("uses CLINE_TEAM_DATA_DIR when set", () => {
		snapshot = captureEnv();
		process.env.CLINE_TEAM_DATA_DIR = "/tmp/team-dir";
		process.env.CLINE_DATA_DIR = "/tmp/cline-data";
		expect(resolveTeamDataDir()).toBe("/tmp/team-dir");
	});

	it("falls back to CLINE_DATA_DIR/teams", () => {
		snapshot = captureEnv();
		delete process.env.CLINE_TEAM_DATA_DIR;
		process.env.CLINE_DATA_DIR = "/tmp/cline-data";
		expect(resolveTeamDataDir()).toBe(join("/tmp/cline-data", "teams"));
	});
});

describe("createAgentTeamsTools schema surface", () => {
	it("exposes a compact task action tool plus strict schemas elsewhere", () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});

		const spawn = tools.find((tool) => tool.name === "team_spawn_teammate");
		const teamTask = tools.find((tool) => tool.name === "team_task");
		const send = tools.find((tool) => tool.name === "team_send_message");
		const createOutcome = tools.find(
			(tool) => tool.name === "team_create_outcome",
		);
		const teamAwaitRuns = tools.find((tool) => tool.name === "team_await_runs");
		const teamLogUpdate = tools.find(
			(tool) => tool.name === "team_mission_log",
		);

		expect(spawn?.inputSchema.type).toBe("object");
		const teamTaskSchema = teamTask?.inputSchema as
			| {
					type?: string;
					properties?: Record<string, unknown>;
					required?: unknown[];
			  }
			| undefined;
		expect(teamTaskSchema?.type).toBe("object");
		expect(teamTaskSchema?.properties).toHaveProperty("action");
		expect(teamTaskSchema?.required).toEqual(["action"]);
		expect(send?.inputSchema.type).toBe("object");
		expect(createOutcome?.inputSchema.type).toBe("object");
		expect(teamAwaitRuns?.inputSchema.type).toBe("object");
		const schema = teamLogUpdate?.inputSchema as
			| { properties: Record<string, unknown>; required: unknown[] }
			| undefined;
		expect(schema?.properties.kind).toEqual({
			type: "string",
			enum: ["progress", "handoff", "blocked", "decision", "done", "error"],
		});
		expect(schema?.required).toEqual(["kind", "summary"]);
	});

	it("rejects extra fields for strict spawn schema", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const spawn = tools.find((tool) => tool.name === "team_spawn_teammate");
		expect(spawn).toBeDefined();

		await expect(
			spawn?.execute(
				{
					agentId: "python-poet",
					rolePrompt: "Write concise Python-focused haiku",
					action: "spawn",
				},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).rejects.toThrow("Unrecognized key");
	});

	it("can expose only the spawn tool until the first teammate is created", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const onLeadToolsUnlocked = vi.fn();
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
			includeSpawnTool: true,
			includeManagementTools: false,
			onLeadToolsUnlocked,
		});

		expect(tools.map((tool) => tool.name)).toEqual(["team_spawn_teammate"]);

		const spawn = tools[0];
		await expect(
			spawn?.execute(
				{
					agentId: "writer",
					rolePrompt: "Write concise summaries",
				},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toEqual({
			agentId: "writer",
			status: "spawned",
		});

		expect(onLeadToolsUnlocked).toHaveBeenCalledTimes(1);
		const unlockedTools = onLeadToolsUnlocked.mock.calls[0]?.[0] as
			| Array<{ name: string }>
			| undefined;
		expect(unlockedTools?.some((tool) => tool.name === "team_task")).toBe(true);
		expect(
			unlockedTools?.some((tool) => tool.name === "team_spawn_teammate"),
		).toBe(false);
	});

	it("rejects non-object payloads for task tools", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const teamTask = tools.find((tool) => tool.name === "team_task");
		expect(teamTask).toBeDefined();

		await expect(
			teamTask?.execute(["create", "task"], {
				agentId: "lead",
				conversationId: "conv-1",
				iteration: 1,
			}),
		).rejects.toThrow("expected object");
	});

	it("normalizes null placeholders for required fields into missing-field errors", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const teamTask = tools.find((tool) => tool.name === "team_task");
		expect(teamTask).toBeDefined();

		await expect(
			teamTask?.execute(
				{
					action: "complete",
					taskId: "task_0001",
					summary: null,
				},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).rejects.toThrow('Field "summary" is required when action=complete');
	});

	it("accepts null placeholders for optional fields", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const teamTask = tools.find((tool) => tool.name === "team_task");
		expect(teamTask).toBeDefined();
		if (!teamTask) {
			throw new Error("Expected team_task tool to be defined");
		}

		await expect(
			teamTask.execute(
				{
					action: "create",
					title: "Investigate llms boundaries",
					description: "Deep dive models and providers",
					dependsOn: null,
				},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toMatchObject({
			action: "create",
			status: "pending",
			taskId: expect.stringMatching(/^task_/),
		});
	});

	it("ignores non-create fields for action=create and reports them back", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const teamTask = tools.find((tool) => tool.name === "team_task");
		expect(teamTask).toBeDefined();
		if (!teamTask) {
			throw new Error("Expected team_task tool to be defined");
		}

		await expect(
			teamTask.execute(
				{
					action: "create",
					title: "Draft TypeScript haiku",
					description: "Write a concise haiku",
					status: "pending",
					summary: "not used",
				},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toMatchObject({
			action: "create",
			status: "pending",
			taskId: expect.stringMatching(/^task_/),
			ignoredFields: ["status", "summary"],
			note: "Ignored fields for action=create: status, summary",
		});
	});

	it("defaults requiredSections for team_create_outcome", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const createOutcome = tools.find(
			(tool) => tool.name === "team_create_outcome",
		);
		expect(createOutcome).toBeDefined();

		await expect(
			createOutcome?.execute(
				{
					title: "LLMS boundary redesign",
				},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toMatchObject({
			outcomeId: expect.stringMatching(/^out_/),
			status: "draft",
		});

		const outcomes = runtime.listOutcomes();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.requiredSections).toEqual([
			"current_state",
			"boundary_analysis",
			"interface_proposal",
		]);
	});

	it("can list outcomes via dedicated list tool", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const createOutcome = tools.find(
			(tool) => tool.name === "team_create_outcome",
		);
		const listOutcomes = tools.find(
			(tool) => tool.name === "team_list_outcomes",
		);
		expect(createOutcome).toBeDefined();
		expect(listOutcomes).toBeDefined();

		await createOutcome?.execute(
			{ title: "LLMS redesign" },
			{
				agentId: "lead",
				conversationId: "conv-1",
				iteration: 1,
			},
		);

		await expect(
			listOutcomes?.execute(
				{},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: expect.any(String),
					createdAt: expect.any(String),
				}),
			]),
		);
	});

	it("serializes mailbox timestamps through team_read_mailbox", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		runtime.sendMessage("lead", "lead", "Status", "Please review");
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const readMailbox = tools.find((tool) => tool.name === "team_read_mailbox");

		await expect(
			readMailbox?.execute(
				{ unreadOnly: true },
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toEqual([
			expect.objectContaining({
				subject: "Status",
				sentAt: expect.any(String),
				readAt: expect.any(String),
			}),
		]);
	});

	it("accepts null sourceRunId for team_attach_outcome_fragment", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const createOutcome = tools.find(
			(tool) => tool.name === "team_create_outcome",
		);
		const attachFragment = tools.find(
			(tool) => tool.name === "team_attach_outcome_fragment",
		);
		expect(createOutcome).toBeDefined();
		expect(attachFragment).toBeDefined();
		if (!createOutcome || !attachFragment) {
			throw new Error("Expected outcome tools to be defined");
		}

		const createdResult = await createOutcome.execute(
			{ title: "Providers report" },
			{
				agentId: "lead",
				conversationId: "conv-1",
				iteration: 1,
			},
		);
		expect(createdResult).toMatchObject({
			outcomeId: expect.stringMatching(/^out_/),
			status: "draft",
		});
		const isCreatedOutcome = (
			value: unknown,
		): value is { outcomeId: string; status: string } => {
			if (typeof value !== "object" || value === null) {
				return false;
			}
			const record = value as Record<string, unknown>;
			return (
				typeof record.outcomeId === "string" &&
				typeof record.status === "string"
			);
		};
		if (!isCreatedOutcome(createdResult)) {
			throw new Error(
				"Expected createOutcome result to include outcomeId and status",
			);
		}
		const created = createdResult;

		await expect(
			attachFragment.execute(
				{
					outcomeId: created.outcomeId,
					section: "current_state",
					sourceRunId: null,
					content: "Current findings.",
				},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toMatchObject({
			fragmentId: expect.stringMatching(/^frag_/),
			status: "draft",
		});

		const [fragment] = runtime.listOutcomeFragments(created.outcomeId);
		expect(fragment?.sourceRunId).toBeUndefined();
	});
});

describe("createAgentTeamsTools runtime behavior", () => {
	it("forwards teammateRuntime headers when spawning teammates", async () => {
		const spawnTeammate = vi.fn();
		const runtime = {
			getMemberRole: vi.fn(() => "lead"),
			isTeammateActive: vi.fn(() => false),
			assertCanSpawnTeammate: vi.fn(),
			spawnTeammate,
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				headers: { Authorization: "Bearer token" },
			}),
			createBaseTools: () => [],
			includeManagementTools: false,
		});
		const spawnTool = tools.find((tool) => tool.name === "team_spawn_teammate");
		expect(spawnTool).toBeDefined();

		await spawnTool?.execute(
			{
				agentId: "investigator",
				rolePrompt: "Investigate code boundaries",
			},
			{
				agentId: "lead",
				conversationId: "conv-1",
				iteration: 1,
			},
		);

		expect(spawnTeammate).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					headers: { Authorization: "Bearer token" },
				}),
			}),
		);
	});

	it("injects workspace metadata into cline teammate system prompt", async () => {
		const spawnTeammate = vi.fn();
		const runtime = {
			getMemberRole: vi.fn(() => "lead"),
			isTeammateActive: vi.fn(() => false),
			assertCanSpawnTeammate: vi.fn(),
			spawnTeammate,
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/app",
			}),
		});
		const spawnTool = tools.find((tool) => tool.name === "team_spawn_teammate");
		expect(spawnTool).toBeDefined();

		await spawnTool?.execute(
			{
				agentId: "researcher",
				rolePrompt: "Investigate runtime boundary regressions.",
			},
			{
				agentId: "lead",
				conversationId: "conv-1",
				iteration: 1,
			},
		);

		expect(spawnTeammate).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					systemPrompt: expect.stringContaining("# Workspace Configuration"),
				}),
			}),
		);
		expect(spawnTeammate).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					systemPrompt: expect.stringContaining('"/repo/app"'),
				}),
			}),
		);
		expect(spawnTeammate).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					systemPrompt: expect.stringContaining('"hint": "app"'),
				}),
			}),
		);
		expect(spawnTeammate).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({
					systemPrompt: expect.stringContaining(
						"# Team Teammate Role\nInvestigate runtime boundary regressions.",
					),
				}),
			}),
		);
	});

	it("throws from team_await_runs when a requested async delegated run fails", async () => {
		const runtime = {
			awaitRun: vi.fn(async () => ({
				id: "run_0001",
				status: "failed",
				error: "Authentication failed",
			})),
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const awaitRuns = tools.find((tool) => tool.name === "team_await_runs");
		expect(awaitRuns).toBeDefined();

		await expect(
			awaitRuns?.execute(
				{ runId: "run_0001" },
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).rejects.toThrow('Run "run_0001" failed: Authentication failed');
	});

	it("throws from team_await_runs when any delegated run is not successful in all-runs mode", async () => {
		const runtime = {
			awaitAllRuns: vi.fn(async () => [
				{ id: "run_ok", status: "completed" },
				{ id: "run_bad", status: "failed", error: "Auth expired" },
			]),
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const awaitRuns = tools.find((tool) => tool.name === "team_await_runs");
		expect(awaitRuns).toBeDefined();

		await expect(
			awaitRuns?.execute(
				{},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).rejects.toThrow(
			"One or more runs did not complete successfully: run_bad:failed(Auth expired)",
		);
	});

	it("returns compact summaries from team_await_runs without full teammate transcripts", async () => {
		const runtime = {
			awaitRun: vi.fn(async () => ({
				id: "run_0001",
				agentId: "models-investigator",
				status: "completed",
				message:
					"Investigate the models directory and summarize the boundaries",
				priority: 0,
				retryCount: 0,
				maxRetries: 0,
				startedAt: new Date("2026-03-24T09:00:00.000Z"),
				endedAt: new Date("2026-03-24T09:01:00.000Z"),
				lastProgressAt: new Date("2026-03-24T09:00:59.000Z"),
				lastProgressMessage: "completed",
				currentActivity: "completed",
				result: {
					text: "Models are the public catalog and provider files are provider-specific defaults.",
					usage: {
						inputTokens: 1200,
						outputTokens: 300,
						cacheReadTokens: 900,
						cacheWriteTokens: 120,
						totalCost: 0.12,
					},
					messages: [{ role: "user", content: "huge transcript omitted" }],
					toolCalls: [{ name: "read_file", input: {}, output: "omitted" }],
					iterations: 3,
					finishReason: "completed",
					model: { id: "claude-sonnet-4-5-20250929", provider: "anthropic" },
					startedAt: new Date("2026-03-24T09:00:00.000Z"),
					endedAt: new Date("2026-03-24T09:01:00.000Z"),
					durationMs: 60_000,
				},
			})),
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const awaitRuns = tools.find((tool) => tool.name === "team_await_runs");

		await expect(
			awaitRuns?.execute(
				{ runId: "run_0001" },
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toEqual({
			id: "run_0001",
			agentId: "models-investigator",
			status: "completed",
			messagePreview:
				"Investigate the models directory and summarize the boundaries",
			priority: 0,
			retryCount: 0,
			maxRetries: 0,
			startedAt: "2026-03-24T09:00:00.000Z",
			endedAt: "2026-03-24T09:01:00.000Z",
			lastProgressAt: "2026-03-24T09:00:59.000Z",
			lastProgressMessage: "completed",
			currentActivity: "completed",
			resultSummary: {
				textPreview:
					"Models are the public catalog and provider files are provider-specific defaults.",
				text: "Models are the public catalog and provider files are provider-specific defaults.",
				iterations: 3,
				finishReason: "completed",
				durationMs: 60_000,
				usage: {
					inputTokens: 1200,
					outputTokens: 300,
					cacheReadTokens: 900,
					cacheWriteTokens: 120,
					totalCost: 0.12,
				},
			},
		});
	});

	it("returns compact summaries from team_list_runs", async () => {
		const runtime = {
			listRuns: vi.fn(() => [
				{
					id: "run_0001",
					agentId: "providers-investigator",
					status: "running",
					message: "Investigate providers directory in detail",
					priority: 0,
					retryCount: 0,
					maxRetries: 0,
					startedAt: new Date("2026-03-24T09:00:00.000Z"),
					lastProgressAt: new Date("2026-03-24T09:00:30.000Z"),
					lastProgressMessage: "reading files",
					currentActivity: "reading_files",
				},
			]),
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const listRuns = tools.find((tool) => tool.name === "team_list_runs");

		await expect(
			listRuns?.execute(
				{},
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toEqual([
			{
				id: "run_0001",
				agentId: "providers-investigator",
				status: "running",
				messagePreview: "Investigate providers directory in detail",
				priority: 0,
				retryCount: 0,
				maxRetries: 0,
				startedAt: "2026-03-24T09:00:00.000Z",
				lastProgressAt: "2026-03-24T09:00:30.000Z",
				lastProgressMessage: "reading files",
				currentActivity: "reading_files",
				resultSummary: undefined,
			},
		]);
	});

	// The tool told the model it "uses a long timeout", and the docs said the
	// wait times out after 1 h. Nothing reads a tool's `timeoutMs`: the wait
	// has no clock, and agents get no wall-clock bound by design.
	it("claims no timeout it does not have", () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const awaitRuns = tools.find((tool) => tool.name === "team_await_runs");
		expect(awaitRuns?.description).not.toMatch(/timeout/i);
	});

	// A teammate is given team_await_runs too. Called with no runId it waited
	// for every active run -- its own included, which cannot end while it
	// waits: a deadlock only the lead's Stop broke.
	it("does not make a teammate wait for its own run", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		let finish!: () => void;
		(
			runtime as unknown as {
				members: Map<string, Record<string, unknown>>;
			}
		).members.set("w", {
			agentId: "w",
			role: "teammate",
			status: "idle",
			runningCount: 0,
			lastMissionStep: 0,
			lastMissionAt: Date.now(),
			agent: {
				canStartRun: () => true,
				run: () =>
					new Promise((resolve) => {
						finish = () =>
							resolve({
								text: "done",
								finishReason: "completed",
								iterations: 1,
								durationMs: 1,
								usage: { inputTokens: 1, outputTokens: 1 },
								messages: [],
								toolCalls: [],
							});
					}),
				getMessages: () => [],
				abort: () => {},
			},
		});
		const own = runtime.startTeammateRun("w", "task");
		const teammateTools = createAgentTeamsTools({
			runtime,
			requesterId: "w",
			teammateConfigProvider: makeTeammateConfigProvider(),
			includeSpawnTool: false,
		});
		const awaitRuns = teammateTools.find(
			(tool) => tool.name === "team_await_runs",
		);
		const ctx = { agentId: "w", conversationId: "conv-w", iteration: 1 };
		const stillWaiting = Symbol("still waiting");
		const within = <T>(promise: Promise<T>) =>
			Promise.race([
				promise,
				new Promise<typeof stillWaiting>((resolve) =>
					setTimeout(() => resolve(stillWaiting), 1_000),
				),
			]);
		try {
			await expect(
				within(Promise.resolve(awaitRuns?.execute({}, ctx))),
			).resolves.toEqual([]);
			await expect(
				within(Promise.resolve(awaitRuns?.execute({ runId: own.id }, ctx))),
			).rejects.toThrow("your own run");
		} finally {
			finish();
			await runtime.awaitRun(own.id, 1);
		}
	});

	it("collapses concurrent sync team_run_task calls to the same agent", async () => {
		let resolveRoute!: (value: { text: string; iterations: number }) => void;
		const routePromise = new Promise<{ text: string; iterations: number }>(
			(resolve) => {
				resolveRoute = resolve;
			},
		);
		const routeToTeammate = vi.fn(() => routePromise);
		const runtime = {
			routeToTeammate,
			getMemberRole: vi.fn(() => "lead"),
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const runTask = tools.find((tool) => tool.name === "team_run_task");
		expect(runTask).toBeDefined();
		if (!runTask) {
			throw new Error("Expected team_run_task tool to be defined");
		}

		const ctx = { agentId: "lead", conversationId: "conv-1", iteration: 1 };
		const input = {
			agentId: "educator",
			task: "Explain probability",
			runMode: "sync",
		};

		// Fire two concurrent sync calls to the same agent
		const call1 = runTask.execute(input, ctx);
		const call2 = runTask.execute(input, ctx);

		// Only one routeToTeammate call should be made.
		expect(routeToTeammate).toHaveBeenCalledTimes(1);

		// Both callers should receive the same result from the shared in-flight run.
		resolveRoute({ text: "Probability explained", iterations: 3 });
		const result1 = (await call1) as { text?: string; iterations?: number };
		const result2 = (await call2) as {
			text?: string;
			iterations?: number;
			status?: string;
			deduped?: boolean;
			message?: string;
		};
		expect(result1.text).toBe("Probability explained");
		expect(result1.iterations).toBe(3);
		expect(result2.text).toBe("Probability explained");
		expect(result2.iterations).toBe(3);
		expect(result2.status).toBe("joined");
		expect(result2.deduped).toBe(true);
		expect(result2.message).toContain("already dispatched");
	});

	// The dedupe was keyed by teammate alone: a second, DIFFERENT task in the
	// same batch was answered with the first one's result, marked joined, and
	// never ran -- the lead was told it had completed.
	it("runs a different sync task for the same teammate after the first, not as a duplicate", async () => {
		const resolvers: Array<
			(value: { text: string; iterations: number }) => void
		> = [];
		const routeToTeammate = vi.fn(
			() =>
				new Promise<{ text: string; iterations: number }>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const runtime = {
			routeToTeammate,
			getMemberRole: vi.fn(() => "lead"),
		} as unknown as AgentTeamsRuntime;
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const runTask = tools.find((tool) => tool.name === "team_run_task");
		if (!runTask) {
			throw new Error("Expected team_run_task tool to be defined");
		}
		const ctx = { agentId: "lead", conversationId: "conv-1", iteration: 1 };

		const call1 = runTask.execute(
			{ agentId: "w", task: "task-AAAAAA", runMode: "sync" },
			ctx,
		);
		const call2 = runTask.execute(
			{ agentId: "w", task: "task-BBBBBB", runMode: "sync" },
			ctx,
		);
		// The second waits for the teammate: one task at a time.
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(routeToTeammate).toHaveBeenCalledTimes(1);
		resolvers[0]?.({ text: "did: AAAAAA", iterations: 1 });
		const result1 = (await call1) as { text?: string };
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(routeToTeammate).toHaveBeenCalledTimes(2);
		expect(routeToTeammate.mock.calls[1]).toEqual([
			"w",
			"task-BBBBBB",
			expect.anything(),
		]);
		resolvers[1]?.({ text: "did: BBBBBB", iterations: 1 });
		const result2 = (await call2) as {
			text?: string;
			status?: string;
			deduped?: boolean;
		};
		expect(result1.text).toBe("did: AAAAAA");
		expect(result2.text).toBe("did: BBBBBB");
		expect(result2.deduped).toBeUndefined();
		expect(result2.status).not.toBe("joined");
	});

	it("returns explicit dispatch state for async team_run_task calls", async () => {
		const runtime = {
			startTeammateRun: vi.fn(() => ({ id: "run_00001" })),
			getMemberRole: vi.fn(() => "lead"),
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const runTask = tools.find((tool) => tool.name === "team_run_task");
		expect(runTask).toBeDefined();
		if (!runTask) {
			throw new Error("Expected team_run_task tool to be defined");
		}

		const ctx = { agentId: "lead", conversationId: "conv-1", iteration: 1 };
		const result = (await runTask.execute(
			{ agentId: "educator", task: "Explain probability", runMode: "async" },
			ctx,
		)) as {
			runId?: string;
			status?: string;
			dispatched?: boolean;
			message?: string;
		};

		expect(result.runId).toBe("run_00001");
		expect(result.status).toBe("queued");
		expect(result.dispatched).toBe(true);
		expect(result.message).toContain("queued as run_00001");
	});

	// A teammate is durable: at its cap its conversation stays, so going on is
	// another task with continueConversation. The lead is told exactly that.
	it("runs a task under the lead's cap, and says how to go on when the cap stops it", async () => {
		const routeToTeammate = vi.fn(async () => ({
			text: "got halfway",
			iterations: 6,
			finishReason: "max_iterations",
		}));
		const runtime = {
			routeToTeammate,
			getMemberRole: vi.fn(() => "lead"),
		} as unknown as AgentTeamsRuntime;
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const runTask = tools.find((tool) => tool.name === "team_run_task");
		if (!runTask) {
			throw new Error("Expected team_run_task tool to be defined");
		}
		const result = (await runTask.execute(
			{
				agentId: "fixer",
				task: "fix it",
				runMode: "sync",
				max_iterations: "6",
			},
			{ agentId: "lead", conversationId: "conv-1", iteration: 1 },
		)) as Record<string, unknown>;
		expect(routeToTeammate).toHaveBeenCalledWith(
			"fixer",
			"fix it",
			expect.objectContaining({ maxIterations: 6 }),
		);
		expect(result).toMatchObject({
			text: "got halfway",
			iterations: 6,
			maxIterations: 6,
			finishReason: "max_iterations",
			stopReason: "iteration_cap",
		});
		expect(String(result.message)).toContain("continueConversation");
	});

	it("passes the lead's cap to an async run", async () => {
		const startTeammateRun = vi.fn(() => ({ id: "run_1" }));
		const runtime = {
			startTeammateRun,
			getMemberRole: vi.fn(() => "lead"),
		} as unknown as AgentTeamsRuntime;
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const runTask = tools.find((tool) => tool.name === "team_run_task");
		await runTask?.execute(
			{ agentId: "fixer", task: "fix it", runMode: "async", max_iterations: 9 },
			{ agentId: "lead", conversationId: "conv-1", iteration: 1 },
		);
		expect(startTeammateRun).toHaveBeenCalledWith(
			"fixer",
			"fix it",
			expect.objectContaining({ maxIterations: 9 }),
		);
	});

	it("allows concurrent sync team_run_task calls to different agents", async () => {
		let resolveRoute1!: (value: { text: string; iterations: number }) => void;
		let resolveRoute2!: (value: { text: string; iterations: number }) => void;
		const routeToTeammate = vi.fn((agentId: string) => {
			if (agentId === "educator") {
				return new Promise<{ text: string; iterations: number }>((resolve) => {
					resolveRoute1 = resolve;
				});
			}
			return new Promise<{ text: string; iterations: number }>((resolve) => {
				resolveRoute2 = resolve;
			});
		});
		const runtime = {
			routeToTeammate,
			getMemberRole: vi.fn(() => "lead"),
		} as unknown as AgentTeamsRuntime;

		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const runTask = tools.find((tool) => tool.name === "team_run_task");
		expect(runTask).toBeDefined();
		if (!runTask) {
			throw new Error("Expected team_run_task tool to be defined");
		}

		const ctx = { agentId: "lead", conversationId: "conv-1", iteration: 1 };

		// Fire sync calls to two different agents - both should proceed
		const call1 = runTask.execute(
			{ agentId: "educator", task: "Explain probability", runMode: "sync" },
			ctx,
		);
		const call2 = runTask.execute(
			{ agentId: "assessor", task: "Evaluate answer", runMode: "sync" },
			ctx,
		);

		// Both should have called routeToTeammate
		expect(routeToTeammate).toHaveBeenCalledTimes(2);

		// Resolve both
		resolveRoute1({ text: "Explained", iterations: 2 });
		resolveRoute2({ text: "Evaluated", iterations: 1 });

		const result1 = (await call1) as { text?: string };
		const result2 = (await call2) as { text?: string };
		expect(result1.text).toBe("Explained");
		expect(result2.text).toBe("Evaluated");
	});

	it("lists team tasks through team_task list action", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const teamTask = tools.find((tool) => tool.name === "team_task");
		expect(teamTask).toBeDefined();

		const first = (await teamTask?.execute(
			{
				action: "create",
				title: "Ready task",
				description: "Claim immediately",
			},
			{
				agentId: "lead",
				conversationId: "conv-1",
				iteration: 1,
			},
		)) as { taskId: string };
		await teamTask?.execute(
			{
				action: "create",
				title: "Blocked task",
				description: "Wait on dependency",
				dependsOn: [first.taskId],
			},
			{
				agentId: "lead",
				conversationId: "conv-1",
				iteration: 1,
			},
		);

		await expect(
			teamTask?.execute(
				{ action: "list" },
				{
					agentId: "lead",
					conversationId: "conv-1",
					iteration: 1,
				},
			),
		).resolves.toEqual({
			action: "list",
			tasks: [
				expect.objectContaining({
					id: first.taskId,
					createdAt: expect.any(String),
					updatedAt: expect.any(String),
					isReady: true,
					blockedBy: [],
				}),
				expect.objectContaining({
					title: "Blocked task",
					isReady: false,
					blockedBy: [first.taskId],
				}),
			],
		});
	});
});

/**
 * The output sentence is generated from each tool's own result schema, so what
 * is worth pinning is not the wording but that it stays true: every team tool
 * says what it answers with, and the shape it names is the shape the tool
 * really returns. A schema change that silently stops being described is
 * exactly the drift this whole change exists to remove.
 */
describe("team tool output descriptions", () => {
	const tools = createAgentTeamsTools({
		runtime: new AgentTeamsRuntime({ teamName: "test-team" }),
		requesterId: "lead",
		teammateConfigProvider: makeTeammateConfigProvider(),
	});

	it("describes an output for every tool", () => {
		const undescribed = tools
			.filter((tool) => !tool.description?.includes("Output: "))
			.map((tool) => tool.name);
		expect(undescribed).toEqual([]);
	});

	it("names the fields a caller has to read", () => {
		const describedBy = (name: string) =>
			tools.find((tool) => tool.name === name)?.description ?? "";

		expect(describedBy("team_spawn_teammate")).toContain(
			"Output: {agentId, status}.",
		);
		expect(describedBy("team_create_outcome")).toContain(
			"Output: {outcomeId, status, requiredSections: [...]}.",
		);
		// A list tool has to look like a list, or its result reads as one item.
		expect(describedBy("team_list_outcomes")).toContain("Output: [{");
	});

	// The other half of the swarm's description. A teammate is durable and
	// takes task after task; spawning a roster of them is not how a broad job
	// gets fanned out to as many workers as the machine will take.
	it("says a teammate is durable and that a one-round fan-out is not a team", () => {
		const description =
			tools.find((tool) => tool.name === "team_spawn_teammate")?.description ??
			"";

		expect(description).toMatch(/stays|durable|persists/i);
		expect(description).toMatch(/swarm/i);
	});

	it("keeps the discriminator of a branching result", () => {
		// `team_task` answers with a different shape per action. Repeating the
		// bare word `action` five times would say nothing; the literal is what
		// tells a model which branch it is about to get.
		const description =
			tools.find((tool) => tool.name === "team_task")?.description ?? "";
		expect(description).toContain('action: "create"');
		expect(description).toContain('action: "list", tasks:');
	});
});

describe("a teammate's temperature and seed", () => {
	const lead = { agentId: "lead", conversationId: "conv-1", iteration: 1 };

	it("are applied to the teammate and carried on its spawn event", async () => {
		const events: Array<{ type: string; teammate?: unknown }> = [];
		const runtime = new AgentTeamsRuntime({
			teamName: "test-team",
			onTeamEvent: (event) => events.push(event as never),
		});
		const spawnSpy = vi.spyOn(runtime, "spawnTeammate");
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider({ temperature: 0.9 }),
		});
		const spawn = tools.find((tool) => tool.name === "team_spawn_teammate");
		await spawn?.execute(
			{ agentId: "w", rolePrompt: "Write", temperature: 0.2, seed: 8 },
			lead,
		);
		const options = spawnSpy.mock.calls[0]?.[0];
		expect(options?.config.temperature).toBe(0.2);
		expect(
			(options?.config.providerConfig as { sampling?: unknown } | undefined)
				?.sampling,
		).toEqual({ temperature: 0.2, seed: 8 });
		const spawned = events.find((event) => event.type === "teammate_spawned");
		expect(spawned?.teammate).toMatchObject({ temperature: 0.2, seed: 8 });
	});

	it("leave the connection's sampler alone when the spawn names neither", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const spawnSpy = vi.spyOn(runtime, "spawnTeammate");
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider({ temperature: 0.9 }),
		});
		const spawn = tools.find((tool) => tool.name === "team_spawn_teammate");
		await spawn?.execute({ agentId: "w", rolePrompt: "Write" }, lead);
		const options = spawnSpy.mock.calls[0]?.[0];
		expect(options?.config.temperature).toBe(0.9);
		expect(options?.config.providerConfig).toBeUndefined();
		expect(options?.sampling).toBeUndefined();
	});

	it("are drawn when random and persisted as drawn on the spawn event", async () => {
		const events: Array<{ type: string; teammate?: unknown }> = [];
		const runtime = new AgentTeamsRuntime({
			teamName: "test-team",
			onTeamEvent: (event) => events.push(event as never),
		});
		const spawnSpy = vi.spyOn(runtime, "spawnTeammate");
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider({ temperature: 0.9 }),
		});
		const spawn = tools.find((tool) => tool.name === "team_spawn_teammate");
		await spawn?.execute(
			{
				agentId: "w",
				rolePrompt: "Write",
				temperature: "random",
				seed: "RANDOM",
				temperature_range: "10%",
			},
			lead,
		);
		const options = spawnSpy.mock.calls[0]?.[0];
		const sampling = options?.sampling as {
			temperature: number;
			seed: number;
		};
		expect(sampling).toMatchObject({
			seedRandom: true,
			temperatureBase: 0.9,
			temperatureRange: 10,
		});
		expect(sampling.temperature).toBeGreaterThanOrEqual(0.81);
		expect(sampling.temperature).toBeLessThanOrEqual(0.99);
		expect(Number.isInteger(sampling.seed)).toBe(true);
		expect(options?.config.temperature).toBe(sampling.temperature);
		const spawned = events.find((event) => event.type === "teammate_spawned");
		expect(spawned?.teammate).toMatchObject({
			temperature: sampling.temperature,
			seed: sampling.seed,
			seedRandom: true,
			temperatureBase: 0.9,
			temperatureRange: 10,
		});
	});

	it("ride on the teammate's state, for its row, and survive a hydrate", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider({ temperature: 0.9 }),
		});
		const spawn = tools.find((tool) => tool.name === "team_spawn_teammate");
		await spawn?.execute(
			{ agentId: "w", rolePrompt: "Write", seed: "random", temperature: 0.4 },
			lead,
		);
		const member = runtime
			.exportState()
			.members.find((entry) => entry.agentId === "w");
		expect(member?.sampling).toMatchObject({
			seedRandom: true,
			temperature: 0.4,
		});
		expect(Number.isInteger(member?.sampling?.seed)).toBe(true);

		const restored = new AgentTeamsRuntime({ teamName: "test-team" });
		restored.hydrateState(JSON.parse(JSON.stringify(runtime.exportState())));
		expect(
			restored.exportState().members.find((entry) => entry.agentId === "w")
				?.sampling,
		).toEqual(member?.sampling);
	});

	it("restore as they were drawn, without drawing again", () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const spawnSpy = vi.spyOn(runtime, "spawnTeammate");
		bootstrapAgentTeams({
			runtime,
			teammateConfigProvider: makeTeammateConfigProvider({ temperature: 0.5 }),
			restoredTeammates: [
				{
					agentId: "w",
					rolePrompt: "Write",
					temperature: 0.713,
					seed: 2847193,
					seedRandom: true,
					temperatureBase: 0.7,
					temperatureRange: 2,
				},
			],
		});
		const options = spawnSpy.mock.calls[0]?.[0];
		expect(options?.config.temperature).toBe(0.713);
		expect(options?.sampling).toEqual({
			temperature: 0.713,
			seed: 2847193,
			seedRandom: true,
			temperatureBase: 0.7,
			temperatureRange: 2,
		});
	});

	it("come back with a restored teammate", () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const spawnSpy = vi.spyOn(runtime, "spawnTeammate");
		bootstrapAgentTeams({
			runtime,
			teammateConfigProvider: makeTeammateConfigProvider(),
			restoredTeammates: [
				{ agentId: "w", rolePrompt: "Write", temperature: 0.3, seed: 2 },
			],
		});
		const options = spawnSpy.mock.calls[0]?.[0];
		expect(options?.config.temperature).toBe(0.3);
		expect(options?.sampling).toEqual({ temperature: 0.3, seed: 2 });
	});
});

/**
 * A teammate runs in an engine session of its own, as a `spawn_agent` agent
 * does. With none it fell back to the LEAD's: its requests went out as the
 * lead's engine session and its compaction read and re-rooted the lead's.
 */
describe("a teammate's engine session", () => {
	const lead = { agentId: "lead", conversationId: "conv-1", iteration: 1 };

	it("is its own, under the lead's, and reaches its compaction", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		const spawnSpy = vi.spyOn(runtime, "spawnTeammate");
		const targets: Array<{ engineSessionId?: string }> = [];
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider({
				sessionId: "lead-session",
				createPrepareTurn: (target) => {
					targets.push(target ?? {});
					return undefined;
				},
			}),
		});
		const spawn = tools.find((tool) => tool.name === "team_spawn_teammate");
		await spawn?.execute({ agentId: "w1", rolePrompt: "Write" }, lead);
		await spawn?.execute({ agentId: "w2", rolePrompt: "Review" }, lead);

		const first = spawnSpy.mock.calls[0]?.[0]?.config.engineSessionId;
		const second = spawnSpy.mock.calls[1]?.[0]?.config.engineSessionId;
		expect(first).toMatch(/^lead-session~teammate-w1/);
		expect(second).toMatch(/^lead-session~teammate-w2/);
		expect(first).not.toBe(second);
		// The compaction pipeline is built in the same session's name.
		expect(targets.map((target) => target.engineSessionId)).toEqual([
			first,
			second,
		]);
	});
});

/**
 * A team reopened from its store: every date on a run comes back as a date.
 * `lastProgressAt` did not, so the first `team_list_runs` or
 * `team_await_runs` after a reload threw `value?.toISOString is not a
 * function` for any team with a finished run.
 */
describe("a team reloaded from its store", () => {
	const lead = { agentId: "lead", conversationId: "conv-1", iteration: 1 };

	async function finishedTeam(): Promise<AgentTeamsRuntime> {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		(
			runtime as unknown as {
				members: Map<string, Record<string, unknown>>;
			}
		).members.set("w", {
			agentId: "w",
			role: "teammate",
			status: "idle",
			runningCount: 0,
			lastMissionStep: 0,
			lastMissionAt: Date.now(),
			agent: {
				canStartRun: () => true,
				run: async () => ({
					text: "done",
					finishReason: "completed",
					iterations: 1,
					durationMs: 1,
					usage: { inputTokens: 1, outputTokens: 1 },
					messages: [
						{ role: "user", content: "the whole transcript" },
						{ role: "assistant", content: "done" },
					],
					toolCalls: [{ name: "read_files", input: {}, output: "a file" }],
				}),
				getMessages: () => [],
				abort: () => {},
			},
		});
		const run = runtime.startTeammateRun("w", "task");
		await runtime.awaitRun(run.id, 1);
		return runtime;
	}

	// The exported state is what every write of the team serializes, and it
	// carried each finished run's whole transcript: the state grew by a
	// conversation per run, rewritten on every event.
	it("exports a finished run's answer without its transcript", async () => {
		const [run] = (await finishedTeam()).exportState().runs ?? [];
		const result = run?.result as
			| { text?: string; messages?: unknown[]; toolCalls?: unknown[] }
			| undefined;
		expect(result?.text).toBe("done");
		expect(result?.messages).toEqual([]);
		expect(result?.toolCalls).toEqual([]);
	});

	async function listAndAwait(state: TeamRuntimeState): Promise<unknown[]> {
		const restored = new AgentTeamsRuntime({ teamName: "test-team" });
		restored.hydrateState(state);
		const tools = createAgentTeamsTools({
			runtime: restored,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const list = tools.find((tool) => tool.name === "team_list_runs");
		const wait = tools.find((tool) => tool.name === "team_await_runs");
		return [await list?.execute({}, lead), await wait?.execute({}, lead)];
	}

	it("lists and awaits its runs after a JSON round trip", async () => {
		const saved = JSON.parse(
			JSON.stringify((await finishedTeam()).exportState()),
		);
		for (const revive of [reviveTeamStateDates, reviveSessionTeamStateDates]) {
			const [listed, awaited] = await listAndAwait(revive(saved));
			for (const runs of [listed, awaited]) {
				expect(runs).toEqual([
					expect.objectContaining({
						status: "completed",
						lastProgressAt: expect.any(String),
					}),
				]);
			}
		}
	});

	it("lists and awaits its runs loaded from either store", async () => {
		const state = (await finishedTeam()).exportState();
		const dir = mkdtempSync(join(tmpdir(), "team-reload-"));
		try {
			for (const store of [
				new SqliteTeamStore({ teamDir: join(dir, "sqlite") }),
				new FileTeamStore({ teamDir: join(dir, "file") }),
			]) {
				store.init();
				store.persistRuntime("team", state, []);
				const loaded = store.loadRuntime("team").state;
				if (!loaded) {
					throw new Error("nothing loaded");
				}
				const [listed] = await listAndAwait(loaded);
				expect(listed).toEqual([
					expect.objectContaining({ lastProgressAt: expect.any(String) }),
				]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * An async run's answer reached the lead only as a 400-character preview,
 * and no tool returned the rest: a 5,000-character report came back as 400
 * (probe P7). team_await_runs now hands it over the way every other agent
 * report is: whole when short, else its opening and a full report to read.
 */
describe("an async run's answer", () => {
	const lead = {
		agentId: "lead",
		conversationId: "conv-1",
		iteration: 1,
		sessionId: "session-answers",
	};

	async function awaitAnswer(answer: string) {
		const runtime = new AgentTeamsRuntime({ teamName: "test-team" });
		(
			runtime as unknown as {
				members: Map<string, Record<string, unknown>>;
			}
		).members.set("w", {
			agentId: "w",
			role: "teammate",
			status: "idle",
			runningCount: 0,
			lastMissionStep: 0,
			lastMissionAt: Date.now(),
			agent: {
				canStartRun: () => true,
				run: async () => ({
					text: answer,
					finishReason: "completed",
					iterations: 1,
					durationMs: 1,
					usage: { inputTokens: 1, outputTokens: 1 },
					messages: [],
					toolCalls: [],
				}),
				getMessages: () => [],
				abort: () => {},
			},
		});
		const tools = createAgentTeamsTools({
			runtime,
			requesterId: "lead",
			teammateConfigProvider: makeTeammateConfigProvider(),
		});
		const run = runtime.startTeammateRun("w", "report");
		const wait = tools.find((tool) => tool.name === "team_await_runs");
		const one = (await wait?.execute({ runId: run.id }, lead)) as {
			resultSummary?: { text?: string; textPreview?: string };
		};
		const all = (await wait?.execute({}, lead)) as Array<{
			resultSummary?: { text?: string };
		}>;
		return { one, all };
	}

	it("comes back whole when it is short", async () => {
		const answer = "Found 2 defects: parser.ts:12 and lexer.ts:40.";
		const { one, all } = await awaitAnswer(answer);
		expect(one.resultSummary?.text).toBe(answer);
		expect(all[0]?.resultSummary?.text).toBe(answer);
	});

	it("comes back as its opening and a full report to read when it is long", async () => {
		const lines = Array.from(
			{ length: 100 },
			(_, index) => `finding ${index}: ${"x".repeat(40)}`,
		);
		const answer = lines.join("\n");
		expect(answer.length).toBeGreaterThan(4_000);
		const { one, all } = await awaitAnswer(answer);
		const text = one.resultSummary?.text ?? "";
		expect(text.startsWith(lines.slice(0, 5).join("\n"))).toBe(true);
		expect(text.length).toBeLessThan(1_300);
		const name = /read_agent_report\(name: "([^"]+)"\)/.exec(text)?.[1];
		expect(name).toBeDefined();
		const page = readAgentReport(lead.sessionId, name ?? "");
		expect(page).toContain("finding 99:");
		expect(page).toContain("the end of the report");
		// Filed once, however often it is awaited.
		expect(all[0]?.resultSummary?.text).toBe(text);
	});

	it("keeps the hand-back note whole after a long answer's opening", async () => {
		const note =
			'\n\n---\nThis agent worked on a private copy of the workspace; its changes are held for you as revisions (NOT written to disk):\n  - src/a.ts — revision #3 (changed by "w")';
		const { one } = await awaitAnswer(`${"y".repeat(3_000)}${note}`);
		expect(one.resultSummary?.text?.endsWith(note)).toBe(true);
	});
});
