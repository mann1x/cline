import type { AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { SpawnToolOptions } from "../../extensions/tools/team/spawn-agent-tool";
import { TEAM_TOOL_NAMES } from "../../extensions/tools/team/team-tools";
import type { CoreSessionConfig } from "../../types/config";
import { DefaultRuntimeBuilder } from "./runtime-builder";

function config(enableAgentTeams: boolean): CoreSessionConfig {
	return {
		providerId: "ollama",
		modelId: "qwen3-coder",
		apiKey: "key",
		systemPrompt: "test",
		cwd: process.cwd(),
		enableTools: true,
		enableSpawnAgent: true,
		enableAgentTeams,
		maxConcurrentAgents: 4,
	};
}

function stubSpawnTool(): AgentTool {
	return {
		name: "spawn_agent",
		description: "stub",
		inputSchema: { type: "object", properties: {} },
		execute: async () => ({}),
	} as unknown as AgentTool;
}

/**
 * Teammates are their own setting, off by default: eighteen tools and their
 * schemas in every request is a price most sessions never collect on. Off has
 * to mean off everywhere the model looks -- the tools themselves, and the
 * sentence in `spawn_agent` that sends the model to them.
 */
describe("the Teammates setting", () => {
	it("off: no team tool, and spawn_agent is not told they exist", async () => {
		const createSpawnTool = vi.fn((_options?: SpawnToolOptions) =>
			stubSpawnTool(),
		);
		const runtime = await new DefaultRuntimeBuilder().build({
			config: config(false),
			createSpawnTool,
		});

		const team = new Set<string>(TEAM_TOOL_NAMES);
		expect(runtime.tools.filter((tool) => team.has(tool.name))).toEqual([]);
		expect(runtime.tools.map((tool) => tool.name)).toContain("spawn_agent");
		expect(createSpawnTool.mock.calls[0]?.[0]?.teammates).not.toBe(true);
	});

	// Core's own default: a caller that says nothing (the SDK, a hub or
	// connector session) gets none, as VS Code and the CLI do. It fell back
	// to the mode preset, which said true.
	it("unset: no team tool", async () => {
		const { enableAgentTeams: _unset, ...unset } = config(true);
		const runtime = await new DefaultRuntimeBuilder().build({
			config: unset as CoreSessionConfig,
		});

		const team = new Set<string>(TEAM_TOOL_NAMES);
		expect(runtime.tools.filter((tool) => team.has(tool.name))).toEqual([]);
	});

	it("on: the team tools are offered, and spawn_agent points at them", async () => {
		const createSpawnTool = vi.fn((_options?: SpawnToolOptions) =>
			stubSpawnTool(),
		);
		const runtime = await new DefaultRuntimeBuilder().build({
			config: config(true),
			createSpawnTool,
		});

		const team = new Set<string>(TEAM_TOOL_NAMES);
		expect(
			runtime.tools.filter((tool) => team.has(tool.name)).length,
		).toBeGreaterThan(0);
		expect(createSpawnTool.mock.calls[0]?.[0]?.teammates).toBe(true);
	});

	// team_await_runs hands a long answer back as its opening and a full
	// report; the tool that reads it came only with spawn_agent.
	it("on: the full reports are readable with spawn_agent off", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: { ...config(true), enableSpawnAgent: false },
		});
		expect(
			runtime.tools.filter((tool) => tool.name === "read_agent_report"),
		).toHaveLength(1);
	});

	// The lead's controls reach a teammate's task. With no rounds to open,
	// the round-only ones (resume, retry, await) are not offered.
	it("on, spawn_agent off: the controls that reach a teammate are offered", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: {
				...config(true),
				enableSpawnAgent: false,
				sessionId: "lead-session",
			},
		});
		const names = runtime.tools.map((tool) => tool.name);
		for (const name of [
			"stop_agents",
			"restart_agent",
			"message_agents",
			"requeue_agent",
		]) {
			expect(names).toContain(name);
		}
		for (const name of ["resume_agent", "retry_failed", "await_agents"]) {
			expect(names).not.toContain(name);
		}
	});
});
