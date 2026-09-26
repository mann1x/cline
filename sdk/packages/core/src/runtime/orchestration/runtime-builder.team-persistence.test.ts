import { describe, expect, it, vi } from "vitest";

const createBuiltinToolsMock = vi.fn(() => []);
const bootstrapAgentTeamsMock = vi.fn(() => ({
	tools: [],
	restoredFromPersistence: true,
	restoredTeammates: ["restored-1"],
}));

let runtimeInstance: MockAgentTeamsRuntime | undefined;
type MockTeamEvent = Record<string, unknown>;
type BootstrapCall = {
	teammateConfigProvider: {
		getRuntimeConfig(): unknown;
	};
};

class MockAgentTeamsRuntime {
	private readonly onTeamEvent?: (event: MockTeamEvent) => void;

	constructor(options: { onTeamEvent?: (event: MockTeamEvent) => void }) {
		this.onTeamEvent = options.onTeamEvent;
		runtimeInstance = this;
	}

	emit(event: MockTeamEvent): void {
		this.onTeamEvent?.(event);
	}

	hydrateState = vi.fn();
	exportState = vi.fn(() => ({
		members: [],
		tasks: [],
		mailbox: [],
		missionLog: [],
		runs: [],
		outcomes: [],
		outcomeFragments: [],
	}));
	markStaleRunsInterrupted = vi.fn();
	recoverActiveRuns = vi.fn();
	getTeammateIds = vi.fn(() => []);
	shutdownTeammate = vi.fn();
}

// Partial rather than a replacement list. Written as a full replacement, this
// mock broke whenever the module gained an export -- a failure that says
// nothing about the builder and everything about the shape of the mock, and
// which reads at a glance like someone else's problem. Spreading the real
// module means only the three things this file actually substitutes are named,
// and anything the builder newly reaches for resolves for real.
vi.mock("../../extensions/tools/team", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/tools/team")>()),
	AgentTeamsRuntime: MockAgentTeamsRuntime,
	bootstrapAgentTeams: bootstrapAgentTeamsMock,
	// A pass-through gate: this file is about what the builder persists, and a
	// real one would make its assertions depend on scheduling. The gate's own
	// behaviour, and which endpoint each agent is held to, are covered in
	// `agent-slot-gate.test.ts` and `configured-agent-tool.test.ts`.
	createAgentSlotGateRegistry: () => ({
		for: () => ({
			run: <T>(task: () => Promise<T>) => task(),
			active: () => 0,
		}),
		active: () => 0,
	}),
	createDelegatedAgentConfigProvider: (config: Record<string, unknown>) => {
		let runtimeConfig = { ...config };
		return {
			getRuntimeConfig: () => runtimeConfig,
			getConnectionConfig: () => ({
				providerId: runtimeConfig.providerId,
				modelId: runtimeConfig.modelId,
				apiKey: runtimeConfig.apiKey,
				baseUrl: runtimeConfig.baseUrl,
				headers: runtimeConfig.headers,
				providerConfig: runtimeConfig.providerConfig,
				knownModels: runtimeConfig.knownModels,
				thinking: runtimeConfig.thinking,
			}),
			updateConnectionDefaults: (overrides: Record<string, unknown>) => {
				runtimeConfig = { ...runtimeConfig, ...overrides };
			},
		};
	},
}));

vi.mock("../../extensions/tools", () => ({
	ALL_DEFAULT_TOOL_NAMES: [],
	createBuiltinTools: createBuiltinToolsMock,
	ToolPresets: {
		development: {},
		readonly: {},
	},
	resolveToolPresetName: () => "development",
	resolveToolRoutingConfig: () => [],
	DEFAULT_MODEL_TOOL_ROUTING_RULES: [],
}));

let teamStoreInstance: MockTeamStore | undefined;
class MockTeamStore {
	constructor() {
		teamStoreInstance = this;
	}

	loadRuntime = vi.fn(() => ({
		state: {
			teamId: "team_1",
			teamName: "test",
			members: [],
			tasks: [],
			mailbox: [],
			missionLog: [],
			runs: [],
			outcomes: [],
			outcomeFragments: [],
		},
		teammates: [
			{
				agentId: "restored-1",
				rolePrompt: "Persisted teammate",
				modelId: "claude-sonnet-4-5-20250929",
				maxIterations: 4,
			},
		],
		interruptedRunIds: [],
	}));
	handleTeamEvent = vi.fn();
	persistRuntime = vi.fn();
}

vi.mock("../../services/storage/team-store", () => ({
	createLocalTeamStore: () => new MockTeamStore(),
}));

describe("DefaultRuntimeBuilder team persistence boundary", () => {
	it("persists teammate specs and runtime state from team events", async () => {
		const { DefaultRuntimeBuilder } = await import("./runtime-builder");
		const onTeamRestored = vi.fn();

		await new DefaultRuntimeBuilder().build({
			config: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "key",
				headers: {
					Authorization: "Bearer team-token",
				},
				systemPrompt: "test",
				cwd: process.cwd(),
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: true,
			},
			onTeamRestored,
		});

		expect(bootstrapAgentTeamsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				restoredFromPersistence: true,
				restoredTeammates: [expect.objectContaining({ agentId: "restored-1" })],
				teammateConfigProvider: expect.objectContaining({
					getRuntimeConfig: expect.any(Function),
				}),
			}),
		);
		const bootstrapCall = (
			bootstrapAgentTeamsMock.mock.calls as unknown as Array<[BootstrapCall]>
		)[0]?.[0];
		expect(bootstrapCall).toBeDefined();
		expect(bootstrapCall?.teammateConfigProvider.getRuntimeConfig()).toEqual(
			expect.objectContaining({
				headers: {
					Authorization: "Bearer team-token",
				},
			}),
		);
		expect(onTeamRestored).toHaveBeenCalledTimes(1);
		expect(runtimeInstance).toBeDefined();
		expect(teamStoreInstance).toBeDefined();
		if (!runtimeInstance || !teamStoreInstance) {
			throw new Error("Expected mocked runtime and team store instances");
		}

		expect(runtimeInstance.markStaleRunsInterrupted).not.toHaveBeenCalled();
		expect(runtimeInstance.recoverActiveRuns).toHaveBeenCalledWith(
			"runtime_recovered",
		);

		runtimeInstance.emit({
			type: "teammate_spawned",
			agentId: "python-poet",
			teammate: {
				rolePrompt: "Write concise Python-focused haiku",
				modelId: "claude-sonnet-4-5-20250929",
				maxIterations: 7,
			},
		});
		expect(teamStoreInstance.handleTeamEvent).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				type: "teammate_spawned",
				agentId: "python-poet",
			}),
		);
		expect(teamStoreInstance.persistRuntime).toHaveBeenCalled();

		// A shutdown the lead asked for, with or without a reason, removes it:
		// `reason` is optional in the tool's schema, and a model omits it.
		runtimeInstance.emit({
			type: "teammate_shutdown",
			agentId: "python-poet",
		});
		expect(teamStoreInstance.handleTeamEvent).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				type: "teammate_shutdown",
				agentId: "python-poet",
			}),
		);
		expect(teamStoreInstance.persistRuntime).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.not.arrayContaining([
				expect.objectContaining({ agentId: "python-poet" }),
			]),
		);

		runtimeInstance.emit({
			type: "teammate_spawned",
			agentId: "python-poet",
			teammate: { rolePrompt: "Write concise Python-focused haiku" },
		});
		runtimeInstance.emit({
			type: "teammate_shutdown",
			agentId: "python-poet",
			reason: "manual_restart",
		});
		expect(teamStoreInstance.persistRuntime).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.not.arrayContaining([
				expect.objectContaining({ agentId: "python-poet" }),
			]),
		);

		runtimeInstance.emit({
			type: "teammate_spawned",
			agentId: "java-poet",
			teammate: {
				rolePrompt: "Write concise Java-focused haiku",
			},
		});
		runtimeInstance.emit({
			type: "teammate_shutdown",
			agentId: "java-poet",
			reason: "cli_run_shutdown",
		});
		expect(teamStoreInstance.persistRuntime).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.arrayContaining([
				expect.objectContaining({ agentId: "java-poet" }),
			]),
		);

		// team_cleanup wiped the team without a word to the store, so a reload
		// brought back the team it had removed.
		runtimeInstance.emit({ type: "team_cleaned" });
		expect(teamStoreInstance.persistRuntime).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(Object),
			[],
		);
	});

	// The runtime going down shuts its teammates down with the host's reason,
	// whatever the host calls it; they are kept, to come back with the session.
	it("keeps the teammates of a runtime that is shutting down, for restore", async () => {
		const { DefaultRuntimeBuilder } = await import("./runtime-builder");
		const built = await new DefaultRuntimeBuilder().build({
			config: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "key",
				systemPrompt: "test",
				cwd: process.cwd(),
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: true,
			},
		});
		if (!runtimeInstance || !teamStoreInstance) {
			throw new Error("Expected mocked runtime and team store instances");
		}
		const runtime = runtimeInstance;
		runtime.emit({
			type: "teammate_spawned",
			agentId: "w",
			teammate: { rolePrompt: "Write" },
		});
		runtime.getTeammateIds.mockReturnValue(["w"] as never);
		runtime.shutdownTeammate.mockImplementation(((
			agentId: string,
			reason?: string,
		) => {
			runtime.emit({ type: "teammate_shutdown", agentId, reason });
		}) as never);

		await built.shutdown?.("some_host_reason");

		expect(teamStoreInstance.persistRuntime).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.arrayContaining([expect.objectContaining({ agentId: "w" })]),
		);
	});

	it("forwards cline workspace metadata to teammate runtime bootstrap config", async () => {
		const { DefaultRuntimeBuilder } = await import("./runtime-builder");
		bootstrapAgentTeamsMock.mockClear();

		await new DefaultRuntimeBuilder().build({
			config: {
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				apiKey: "key",
				systemPrompt: `Base instructions.

# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo",
      "latestGitBranchName": "main"
    }
  }
}`,
				cwd: "/repo/demo",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: true,
			},
		});

		expect(bootstrapAgentTeamsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				teammateConfigProvider: expect.objectContaining({
					getRuntimeConfig: expect.any(Function),
				}),
			}),
		);
		const clineBootstrapCall = (
			bootstrapAgentTeamsMock.mock.calls as unknown as Array<[BootstrapCall]>
		)[0]?.[0];
		expect(clineBootstrapCall).toBeDefined();
		expect(
			clineBootstrapCall?.teammateConfigProvider.getRuntimeConfig(),
		).toEqual(
			expect.objectContaining({
				providerId: "cline",
				cwd: "/repo/demo",
			}),
		);
	});

	// Every team event was persisted: a BEGIN IMMEDIATE transaction writing
	// the whole exported state, once per streamed chunk of every teammate --
	// with every finished run's transcript in it. Only a change of state is
	// written now.
	it("writes the team on a change of state, not on a teammate's streamed chunks", async () => {
		const { DefaultRuntimeBuilder } = await import("./runtime-builder");
		await new DefaultRuntimeBuilder().build({
			config: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiKey: "key",
				systemPrompt: "test",
				cwd: process.cwd(),
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: true,
			},
		});
		if (!runtimeInstance || !teamStoreInstance) {
			throw new Error("Expected mocked runtime and team store instances");
		}
		teamStoreInstance.persistRuntime.mockClear();
		teamStoreInstance.handleTeamEvent.mockClear();
		runtimeInstance.exportState.mockClear();

		const chunks = 100;
		for (let index = 0; index < chunks; index++) {
			runtimeInstance.emit({
				type: "agent_event",
				agentId: "w",
				event: {
					type: "content_start",
					contentType: index % 2 === 0 ? "text" : "reasoning",
					text: `token ${index}`,
				},
			});
		}
		// The run heartbeat and live activity of a running run are progress,
		// not state.
		runtimeInstance.emit({
			type: "run_progress",
			run: { id: "run_00001", agentId: "w", status: "running" },
			message: "heartbeat",
		});
		expect(teamStoreInstance.persistRuntime).toHaveBeenCalledTimes(0);
		expect(teamStoreInstance.handleTeamEvent).toHaveBeenCalledTimes(0);
		expect(runtimeInstance.exportState).toHaveBeenCalledTimes(0);

		runtimeInstance.emit({
			type: "run_completed",
			run: { id: "run_00001", agentId: "w", status: "completed" },
		});
		expect(teamStoreInstance.persistRuntime).toHaveBeenCalledTimes(1);
		expect(teamStoreInstance.handleTeamEvent).toHaveBeenCalledTimes(1);
		expect(runtimeInstance.exportState).toHaveBeenCalledTimes(1);
	});
});
