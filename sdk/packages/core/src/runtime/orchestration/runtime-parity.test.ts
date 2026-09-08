import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@cline/shared";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../../extensions/tools";
import { DefaultRuntimeBuilder } from "./runtime-builder";

type LegacyConfig = {
	providerId: string;
	modelId: string;
	apiKey: string;
	systemPrompt: string;
	cwd: string;
	enableTools: boolean;
	enableSpawnAgent: boolean;
	enableAgentTeams: boolean;
};

function legacyBuiltinTools(cwd: string): AgentTool[] {
	return createBuiltinTools({
		cwd,
		enableReadFiles: true,
		enableSearch: true,
		enableBash: true,
		enableWebFetch: true,
	});
}

function legacyBuildRuntimeEnvironment(
	config: LegacyConfig,
	createSpawnTool?: () => AgentTool,
): AgentTool[] {
	const tools: AgentTool[] = [];
	if (config.enableTools) {
		tools.push(...legacyBuiltinTools(config.cwd));
	}
	if (config.enableSpawnAgent && createSpawnTool) {
		const spawnTool = createSpawnTool();
		tools.push({
			...spawnTool,
			execute: async (input, context) => spawnTool.execute(input, context),
		});
	}
	return tools;
}

function normalizeParityToolNames(toolNames: string[]): string[] {
	// Skills are discovered from user/workspace config and can appear in tests
	// depending on the machine state. MCP tools may also be configured outside
	// the test workspace. They are intentionally excluded from strict legacy
	// parity checks.
	//
	// `create_agent` is excluded for a different reason: it is new, so the
	// legacy list cannot contain it and never will. This test asks whether the
	// legacy toolset still matches, not whether the toolset has grown -- that
	// question is asked by "offers create_agent..." below, which is where a
	// regression in it would show.
	return toolNames.filter(
		(toolName) =>
			toolName !== "skills" &&
			toolName !== "create_agent" &&
			!toolName.includes("__"),
	);
}

function makeEmptyWorkspaceCwd(): string {
	return mkdtempSync(join(tmpdir(), "runtime-parity-"));
}

function makeSpawnTool(): AgentTool {
	return {
		name: "spawn_agent",
		description: "Spawn a subagent",
		inputSchema: { type: "object", properties: {}, required: [] },
		execute: async () => ({ ok: true }),
	};
}

describe("runtime tool parity", () => {
	const envSnapshot = {
		HOME: process.env.HOME,
		CLINE_DIR: process.env.CLINE_DIR,
	};
	let isolatedHomeDir = "";

	beforeEach(() => {
		isolatedHomeDir = mkdtempSync(join(tmpdir(), "runtime-parity-home-"));
		process.env.HOME = isolatedHomeDir;
		process.env.CLINE_DIR = join(isolatedHomeDir, ".cline");
		setHomeDir(isolatedHomeDir);
		setClineDir(process.env.CLINE_DIR);
	});

	afterEach(() => {
		process.env.HOME = envSnapshot.HOME;
		process.env.CLINE_DIR = envSnapshot.CLINE_DIR;
		setHomeDir(envSnapshot.HOME ?? "~");
		setClineDir(envSnapshot.CLINE_DIR ?? join("~", ".cline"));
	});

	it("matches legacy tool list when tools+spawn are enabled", async () => {
		const config: LegacyConfig = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			apiKey: "key",
			systemPrompt: "test",
			cwd: makeEmptyWorkspaceCwd(),
			enableTools: true,
			enableSpawnAgent: true,
			enableAgentTeams: false,
		};
		const createSpawnTool = makeSpawnTool;
		const expected = normalizeParityToolNames(
			legacyBuildRuntimeEnvironment(config, createSpawnTool).map(
				(tool) => tool.name,
			),
		);
		const runtime = await new DefaultRuntimeBuilder().build({
			config,
			createSpawnTool,
		});
		const actual = runtime.tools.map((tool) => tool.name);

		expect(normalizeParityToolNames(actual)).toEqual(expected);
	});

	it("offers create_agent with the subagents it creates, and not without them", async () => {
		const base = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			apiKey: "key",
			systemPrompt: "test",
			cwd: makeEmptyWorkspaceCwd(),
			enableTools: true,
			enableAgentTeams: false,
		};

		const withSpawn = await new DefaultRuntimeBuilder().build({
			config: { ...base, enableSpawnAgent: true },
			createSpawnTool: makeSpawnTool,
		});
		expect(withSpawn.tools.map((tool) => tool.name)).toContain("create_agent");

		// Writing an agent file is pointless in a session that cannot run one.
		const withoutSpawn = await new DefaultRuntimeBuilder().build({
			config: { ...base, enableSpawnAgent: false },
		});
		expect(withoutSpawn.tools.map((tool) => tool.name)).not.toContain(
			"create_agent",
		);
	});

	it("matches legacy tool list when only spawn is enabled", async () => {
		const config: LegacyConfig = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			apiKey: "key",
			systemPrompt: "test",
			cwd: makeEmptyWorkspaceCwd(),
			enableTools: false,
			enableSpawnAgent: true,
			enableAgentTeams: false,
		};
		const createSpawnTool = makeSpawnTool;
		const expected = normalizeParityToolNames(
			legacyBuildRuntimeEnvironment(config, createSpawnTool).map(
				(tool) => tool.name,
			),
		);
		const runtime = await new DefaultRuntimeBuilder().build({
			config,
			createSpawnTool,
		});
		const actual = runtime.tools.map((tool) => tool.name);

		expect(normalizeParityToolNames(actual)).toEqual(expected);
	});

	it("matches legacy tool list when tools+spawn are disabled", async () => {
		const config: LegacyConfig = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			apiKey: "key",
			systemPrompt: "test",
			cwd: makeEmptyWorkspaceCwd(),
			enableTools: false,
			enableSpawnAgent: false,
			enableAgentTeams: false,
		};
		const expected = normalizeParityToolNames(
			legacyBuildRuntimeEnvironment(config).map((tool) => tool.name),
		);
		const runtime = await new DefaultRuntimeBuilder().build({ config });
		const actual = runtime.tools.map((tool) => tool.name);

		expect(normalizeParityToolNames(actual)).toEqual(expected);
	});
});
