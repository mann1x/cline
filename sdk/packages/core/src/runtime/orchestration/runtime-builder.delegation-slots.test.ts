import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { TEAM_TOOL_NAMES } from "../../extensions/tools/team/team-tools";
import type { CoreSessionConfig } from "../../types/config";
import { DefaultRuntimeBuilder } from "./runtime-builder";

/** Collects the host log, typed as the runtime's logger expects. */
function recordingLogger(lines: string[]): CoreSessionConfig["logger"] {
	return {
		log: (message: string) => {
			lines.push(message);
		},
		debug: () => {},
	};
}

function makeBaseConfig(
	overrides: Partial<CoreSessionConfig> = {},
): CoreSessionConfig {
	return {
		providerId: "ollama",
		modelId: "qwen3-coder",
		apiKey: "key",
		systemPrompt: "test",
		cwd: process.cwd(),
		enableTools: true,
		enableSpawnAgent: true,
		enableAgentTeams: true,
		...overrides,
	};
}

function names(tools: AgentTool[]): string[] {
	return tools.map((tool) => tool.name);
}

function teamToolsIn(tools: AgentTool[]): string[] {
	const team = new Set<string>(TEAM_TOOL_NAMES);
	return names(tools).filter((name) => team.has(name));
}

/**
 * A one-slot endpoint queues a delegated agent behind the agent that spawned
 * it, and says nothing while it does. The tools are therefore not offered:
 * measured on a live transaction against a default Ollama, the model spent
 * three turns spawning a teammate, being refused, and cleaning up.
 */
describe("delegation tools against the endpoint's slot count", () => {
	it("withholds spawn_agent and the team tools on a one-slot endpoint", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ maxConcurrentAgents: 1 }),
			createSpawnTool: () => stubSpawnTool(),
		});

		expect(names(runtime.tools)).not.toContain("spawn_agent");
		expect(teamToolsIn(runtime.tools)).toEqual([]);
	});

	it("offers them once the endpoint serves more than one", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ maxConcurrentAgents: 3 }),
			createSpawnTool: () => stubSpawnTool(),
		});

		expect(names(runtime.tools)).toContain("spawn_agent");
		expect(teamToolsIn(runtime.tools).length).toBeGreaterThan(0);
	});

	// `undefined` is a host that never resolved a count. Reading it as one
	// would take delegation away from every host that has not been taught to
	// ask, which is not what the count says.
	it("leaves a host that resolved no count alone", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig(),
			createSpawnTool: () => stubSpawnTool(),
		});

		expect(names(runtime.tools)).toContain("spawn_agent");
		expect(teamToolsIn(runtime.tools).length).toBeGreaterThan(0);
	});

	// `0` is the host saying admission control decides -- opencoti with PolyKV,
	// where agents share a KV pool and the server paces them.
	it("leaves an uncapped endpoint alone", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ maxConcurrentAgents: 0 }),
			createSpawnTool: () => stubSpawnTool(),
		});

		expect(names(runtime.tools)).toContain("spawn_agent");
		expect(teamToolsIn(runtime.tools).length).toBeGreaterThan(0);
	});

	// Absent tools are their own confusion, so the one place that knows why
	// says it out loud.
	it("says why they are missing", async () => {
		const lines: string[] = [];
		await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				maxConcurrentAgents: 1,
				logger: recordingLogger(lines),
			}),
			createSpawnTool: () => stubSpawnTool(),
		});

		const withheld = lines.filter((line) => line.includes("withheld"));
		expect(withheld).toHaveLength(1);
		expect(withheld[0]).toContain("1 request at a time");
		expect(withheld[0]).toContain("parallel sessions");
	});

	it("says nothing when the host asked for neither", async () => {
		const lines: string[] = [];
		await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				maxConcurrentAgents: 1,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				logger: recordingLogger(lines),
			}),
			createSpawnTool: () => stubSpawnTool(),
		});

		expect(lines.filter((line) => line.includes("withheld"))).toEqual([]);
	});
});

function stubSpawnTool(): AgentTool {
	return {
		name: "spawn_agent",
		description: "spawn",
		inputSchema: { type: "object", properties: {} },
		execute: async () => ({ query: "spawn", result: "", success: true }),
	} as unknown as AgentTool;
}
