import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_NO_TOOL_CALL_NUDGES } from "@cline/agents";
import {
	type AgentExtension,
	type AgentTool,
	createContributionRegistry,
	type Message,
} from "@cline/shared";
import { setHomeDir } from "@cline/shared/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createUserInstructionConfigService } from "../../extensions/config";
import { PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME } from "../../extensions/tools/command-guard-extension";
import {
	__resetAgentRounds,
	roundsFor,
} from "../../extensions/tools/team/agent-rounds";
import { TelemetryService } from "../../services/telemetry/TelemetryService";
import type { CoreSessionConfig } from "../../types/config";
import { DefaultRuntimeBuilder } from "./runtime-builder";

function makeSpawnTool(): AgentTool {
	return {
		name: "spawn_agent",
		description: "Spawn a subagent",
		inputSchema: { type: "object", properties: {}, required: [] },
		execute: async () => ({ ok: true }),
	};
}

function makeBaseConfig(
	overrides: Partial<CoreSessionConfig> = {},
): CoreSessionConfig {
	return {
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: "key",
		systemPrompt: "test",
		cwd: process.cwd(),
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		...overrides,
	};
}

async function collectExtensionTools(
	extensions?: AgentExtension[],
): Promise<AgentTool[]> {
	const registry = createContributionRegistry<
		AgentExtension,
		AgentTool,
		Message[]
	>({
		extensions: extensions ?? [],
	});
	await registry.initialize();
	return registry.getRegisteredTools();
}

describe("DefaultRuntimeBuilder", () => {
	const previousHome = process.env.HOME;
	const previousGlobalSettingsPath = process.env.CLINE_GLOBAL_SETTINGS_PATH;
	const tempDirs: string[] = [];

	afterEach(() => {
		process.env.HOME = previousHome;
		setHomeDir(previousHome ?? "~");
		process.env.CLINE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("includes builtin tools when enabled", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig(),
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names.length).toBeGreaterThan(0);
		expect(names).not.toContain("spawn_agent");
	});

	describe("the profile's tool selection", () => {
		it("withholds the tools the provider config names", async () => {
			const withEverything = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig(),
			});
			expect(withEverything.tools.map((tool) => tool.name)).toContain("grep");

			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig({
					providerConfig: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
						tools: { disabled: ["grep", "awk"] },
					},
				}),
			});

			const names = runtime.tools.map((tool) => tool.name);
			expect(names).not.toContain("grep");
			expect(names).not.toContain("awk");
			// Only what it named: a selection is a deny list, so everything it is
			// silent about is still there.
			expect(names).toContain("read_files");
			expect(names).toContain("editor");
		});

		it("leaves the toolset alone when the profile names nothing", async () => {
			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig({
					providerConfig: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
						tools: { disabled: [] },
					},
				}),
			});

			expect(runtime.tools.map((tool) => tool.name)).toContain("grep");
		});

		/**
		 * The read limit, off.
		 *
		 * It defaults to on because a model that reads a whole file pays for it
		 * in every later request -- a tool result is re-sent for the rest of the
		 * run. A capable model paginates without being made to, and the refusal
		 * then only costs it a turn, so which behaviour is wanted is a judgement
		 * about the model and belongs on the profile.
		 */
		async function readWholeFile(config: CoreSessionConfig, body: string) {
			const dir = mkdtempSync(join(tmpdir(), "read-limit-"));
			tempDirs.push(dir);
			const file = join(dir, "big.ts");
			writeFileSync(file, body);
			const runtime = await new DefaultRuntimeBuilder().build({
				config: { ...config, cwd: dir },
			});
			const readFiles = runtime.tools.find(
				(tool) => tool.name === "read_files",
			);
			if (!readFiles) {
				throw new Error("read_files was not built");
			}
			return await readFiles.execute({ files: [{ path: file }] } as never, {
				agentId: "a",
				conversationId: "c",
				iteration: 1,
			});
		}

		const OVERSIZED = `${"x".repeat(80)}\n`.repeat(500); // ~40KB

		it("refuses an oversized read by default", async () => {
			const result = await readWholeFile(makeBaseConfig(), OVERSIZED);
			expect(JSON.stringify(result)).toMatch(/too large/i);
		});

		it("returns it whole when the profile turns the read limit off", async () => {
			const result = await readWholeFile(
				makeBaseConfig({
					providerConfig: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
						tools: { readLimitEnabled: false },
					},
				}),
				OVERSIZED,
			);
			expect(JSON.stringify(result)).not.toMatch(/too large/i);
		});

		it("refuses at the threshold the profile sets", async () => {
			// Well under the 40KB body and well over the default, so only a
			// threshold that is actually read produces a refusal here.
			const result = await readWholeFile(
				makeBaseConfig({
					providerConfig: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
						tools: { readLimitChars: 30_000 },
					},
				}),
				OVERSIZED,
			);
			expect(JSON.stringify(result)).toMatch(/max: 30000/);
		});

		it("does not put back a tool the session never built", async () => {
			// The selection can only withhold. Whether `generate_image` exists at
			// all is answered by whether an image endpoint is configured, and a
			// profile that could claim otherwise would be a switch that does
			// nothing.
			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig({
					providerConfig: {
						providerId: "anthropic",
						modelId: "claude-sonnet-4-6",
						tools: { disabled: ["generate_image"] },
					},
				}),
			});

			expect(runtime.tools.map((tool) => tool.name)).not.toContain(
				"generate_image",
			);
		});
	});

	it("derives enabled provider tools without registering a local executor", async () => {
		const settingsRoot = mkdtempSync(join(tmpdir(), "cline-model-tools-"));
		tempDirs.push(settingsRoot);
		process.env.CLINE_GLOBAL_SETTINGS_PATH = join(
			settingsRoot,
			"global-settings.json",
		);
		writeFileSync(
			process.env.CLINE_GLOBAL_SETTINGS_PATH,
			JSON.stringify({ tools: { web_search: { enabled: true } } }),
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig(),
		});

		expect(runtime.modelTools).toEqual([{ name: "web_search" }]);
		expect(runtime.tools.some((tool) => tool.name === "web_search")).toBe(
			false,
		);
	});

	it("requests provider image generation for supported language models", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				providerId: "openai-native",
				modelId: "gpt-5.4",
			}),
		});

		expect(runtime.modelTools).toContainEqual({
			name: "image_generation",
			outputFormat: "png",
		});
		expect(runtime.tools.some((tool) => tool.name === "image_generation")).toBe(
			false,
		);
	});

	it("forwards runtime logger for downstream agent creation", async () => {
		const logger = {
			debug: () => {},
			log: () => {},
		};
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				enableTools: false,
				logger,
			}),
		});

		expect(runtime.logger).toBe(logger);
	});

	it("loads configured agent files as named subagent tools", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "cline-agent-home-"));
		const workspaceRoot = mkdtempSync(join(tmpdir(), "cline-agent-workspace-"));
		tempDirs.push(tempHome, workspaceRoot);
		setHomeDir(tempHome);

		const globalAgentsDir = join(tempHome, ".cline", "agents");
		mkdirSync(globalAgentsDir, { recursive: true });
		writeFileSync(
			join(globalAgentsDir, "code-reviewer.yml"),
			`---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Execute_Command, Read_File
modelId: anthropic/claude-sonnet-4.6
---
You are a code reviewer.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				cwd: workspaceRoot,
				workspaceRoot,
				enableSpawnAgent: true,
				enableAgentTeams: false,
			}),
			createSpawnTool: makeSpawnTool,
		});

		const configuredAgentTool = runtime.tools.find(
			(tool) => tool.name === "subagent_code_reviewer",
		);
		expect(configuredAgentTool).toBeDefined();
		expect(configuredAgentTool?.description).toContain(
			'Use the "code-reviewer" subagent',
		);
		expect(runtime.tools.map((tool) => tool.name)).toContain("spawn_agent");
	});

	/**
	 * A profile is deleted in Settings; the agent file naming it is not
	 * rewritten. Without this the first sign is a failed delegation partway
	 * through a task, which reads as the subagent being broken rather than as
	 * configuration that went stale.
	 */
	it("warns at load about an agent naming a profile that no longer exists", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "cline-agent-home-"));
		const workspaceRoot = mkdtempSync(join(tmpdir(), "cline-agent-workspace-"));
		tempDirs.push(tempHome, workspaceRoot);
		setHomeDir(tempHome);

		const agentsDir = join(workspaceRoot, ".cline", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "code-reviewer.yml"),
			`---
name: code-reviewer
description: Reviews code
profile: vision-box
---
You are a code reviewer.`,
			"utf8",
		);

		const lines: string[] = [];
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				cwd: workspaceRoot,
				workspaceRoot,
				enableSpawnAgent: true,
				logger: {
					log: (message: string) => {
						lines.push(message);
					},
					debug: () => undefined,
				},
				resolveProfileConnection: () => undefined,
				listProfileNames: () => ["cheap-and-fast"],
			}),
			createSpawnTool: makeSpawnTool,
		});

		const warning = lines.find((line) => line.includes("no longer exists"));
		expect(warning).toContain("code-reviewer");
		expect(warning).toContain("vision-box");
		expect(warning).toContain("cheap-and-fast");
		await runtime.shutdown("test");
	});

	it("says nothing when the profile an agent names resolves", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "cline-agent-home-"));
		const workspaceRoot = mkdtempSync(join(tmpdir(), "cline-agent-workspace-"));
		tempDirs.push(tempHome, workspaceRoot);
		setHomeDir(tempHome);

		const agentsDir = join(workspaceRoot, ".cline", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "code-reviewer.yml"),
			`---
name: code-reviewer
description: Reviews code
profile: vision-box
---
You are a code reviewer.`,
			"utf8",
		);

		const lines: string[] = [];
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				cwd: workspaceRoot,
				workspaceRoot,
				enableSpawnAgent: true,
				logger: {
					log: (message: string) => {
						lines.push(message);
					},
					debug: () => undefined,
				},
				resolveProfileConnection: () => ({ providerId: "anthropic" }),
				listProfileNames: () => ["vision-box"],
			}),
			createSpawnTool: makeSpawnTool,
		});

		expect(
			lines.find((line) => line.includes("no longer exists")),
		).toBeUndefined();
		await runtime.shutdown("test");
	});

	it("does not register root skills when only configured agents declare skills", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "cline-agent-home-"));
		const workspaceRoot = mkdtempSync(join(tmpdir(), "cline-agent-workspace-"));
		const cwd = join(workspaceRoot, "packages", "app");
		tempDirs.push(tempHome, workspaceRoot);
		setHomeDir(tempHome);
		mkdirSync(cwd, { recursive: true });

		const agentsDir = join(workspaceRoot, ".cline", "agents");
		const skillDir = join(workspaceRoot, ".cline", "skills", "review");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "code-reviewer.yml"),
			`---
name: code-reviewer
description: Reviews code
tools: use_skill
skills: review
---
You are a code reviewer.`,
			"utf8",
		);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: review
---
Use the review guidance.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				cwd,
				workspaceRoot,
				enableSpawnAgent: true,
			}),
			configExtensions: [],
			createSpawnTool: makeSpawnTool,
		});

		expect(runtime.tools.map((tool) => tool.name)).toContain(
			"subagent_code_reviewer",
		);
		expect(runtime.tools.map((tool) => tool.name)).not.toContain("skills");
		expect(
			(await collectExtensionTools(runtime.extensions)).map(
				(tool) => tool.name,
			),
		).not.toContain("skills");
		await runtime.shutdown("test");
	});

	it("forwards telemetry for downstream runtime consumers", async () => {
		const telemetry = new TelemetryService();
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				enableTools: false,
				telemetry,
			}),
		});

		expect(runtime.telemetry).toBe(telemetry);
	});

	it("uses readonly preset in plan mode", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "plan",
			}),
		});

		expect(runtime.tools.map((tool) => tool.name)).not.toContain("editor");
	});

	it("registers the plan-mode command-guard hook only in plan mode", async () => {
		const planRuntime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "plan",
			}),
		});
		const actRuntime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig(),
		});

		const planGuards = (planRuntime.extensions ?? []).filter(
			(extension) => extension.name === PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
		);
		expect(planGuards).toHaveLength(1);
		expect(planGuards[0]?.hooks?.beforeTool).toBeTypeOf("function");
		expect(
			(actRuntime.extensions ?? []).map((extension) => extension.name),
		).not.toContain(PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME);
	});

	it("does not register the plan-mode command-guard when tools are disabled", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "plan",
				enableTools: false,
			}),
		});

		expect(
			(runtime.extensions ?? []).map((extension) => extension.name),
		).not.toContain(PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME);
	});

	it("uses yolo preset only when yolo mode is explicit", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "yolo",
			}),
			toolExecutors: {
				submit: async () => "submitted",
			},
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).not.toContain("ask_question");
		expect(names).toContain("submit_and_exit");
		expect(runtime.completionPolicy).toMatchObject({
			requireCompletionTool: true,
		});
	});

	it("requires completion only when submit_and_exit is available", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "yolo",
			}),
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).not.toContain("submit_and_exit");
		expect(runtime.completionPolicy?.requireCompletionTool).toBeUndefined();
		// Not requiring a completion tool is not the same as letting a turn with
		// no tool calls end the run silently.
		expect(runtime.completionPolicy?.maxNoToolCallNudges).toBe(
			DEFAULT_MAX_NO_TOOL_CALL_NUDGES,
		);
	});

	it("keeps ask_question available in non-yolo modes", async () => {
		for (const mode of ["act", "plan"] as const) {
			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig({
					mode,
				}),
				toolExecutors: {
					submit: async () => "submitted",
					askQuestion: async () => "question",
				},
			});

			const names = runtime.tools.map((tool) => tool.name);
			expect(names).toContain("ask_question");
			expect(names).not.toContain("submit_and_exit");
			expect(runtime.completionPolicy?.requireCompletionTool).toBeUndefined();
		}
	}, 10_000);

	it("does not infer yolo preset from auto-approval alone", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "act",
				toolPolicies: {
					"*": { autoApprove: true },
				},
			}),
			toolExecutors: {
				submit: async () => "submitted",
				askQuestion: async () => "question",
			},
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).toContain("ask_question");
		expect(names).not.toContain("submit_and_exit");
	});

	it("uses yolo preset runtime defaults for spawn and teams", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: {
				...makeBaseConfig({
					enableTools: false,
					mode: "yolo",
				}),
			} as CoreSessionConfig,
			createSpawnTool: makeSpawnTool,
		});

		expect(runtime.tools.map((tool) => tool.name)).not.toContain("spawn_agent");
		expect(runtime.completionPolicy?.requireCompletionTool).toBeUndefined();
	});

	it("uses apply_patch instead of editor for codex/gpt model IDs in act mode", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				providerId: "openai",
				modelId: "openai/gpt-5.4",
				mode: "act",
			}),
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).toContain("apply_patch");
		expect(names).not.toContain("editor");
	});

	it("keeps editor for non-codex/non-gpt model IDs in act mode", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "act",
			}),
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).toContain("editor");
		expect(names).not.toContain("apply_patch");
	});

	it("applies custom tool routing rules from session config", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				mode: "act",
				toolRoutingRules: [
					{
						mode: "act",
						providerIdIncludes: ["anthropic"],
						modelIdIncludes: ["claude"],
						enableTools: ["apply_patch"],
						disableTools: ["editor"],
					},
				],
			}),
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).toContain("apply_patch");
		expect(names).not.toContain("editor");
	});

	it("omits builtin tools when disabled", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				enableTools: false,
			}),
		});

		expect(runtime.tools).toEqual([]);
	});

	it("omits tools disabled by policy from the advertised runtime tool list", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				toolPolicies: {
					run_commands: { enabled: false },
					read_files: { enabled: false },
				},
			}),
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).not.toContain("run_commands");
		expect(names).not.toContain("read_files");
		expect(names).toContain("search_codebase");
	});

	it("omits tools disabled by global settings from the advertised runtime tool list", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "runtime-builder-global-"));
		const settingsPath = join(tempRoot, "global-settings.json");
		process.env.CLINE_GLOBAL_SETTINGS_PATH = settingsPath;
		writeFileSync(
			settingsPath,
			JSON.stringify({ disabledTools: ["search_codebase"] }, null, 2),
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig(),
		});

		const names = runtime.tools.map((tool) => tool.name);
		expect(names).not.toContain("search_codebase");
		expect(names).toContain("read_files");
	});

	it("adds spawn tool when enabled", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				enableTools: false,
				enableSpawnAgent: true,
			}),
			createSpawnTool: makeSpawnTool,
		});

		expect(runtime.tools.map((tool) => tool.name)).toContain("spawn_agent");
	});

	it("provides a shutdown helper", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				enableTools: false,
			}),
		});

		await expect(runtime.shutdown("test")).resolves.toBeUndefined();
	});

	it("includes MCP tools from configured servers", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "runtime-builder-mcp-"));
		const serverPath = join(tempRoot, "mock-mcp-server.js");
		const settingsPath = join(tempRoot, "cline_mcp_settings.json");
		const previousSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;

		writeFileSync(
			serverPath,
			`let buffer = "";
function write(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } });
    return;
  }
  if (message.method === "tools/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: [] } }] } });
    return;
  }
  if (message.method === "tools/call") {
    write({ jsonrpc: "2.0", id: message.id, result: { echoed: message.params?.arguments?.value ?? null } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const separator = buffer.indexOf("\\n");
    if (separator < 0) break;
    const line = buffer.slice(0, separator).trim();
    buffer = buffer.slice(separator + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "notifications/initialized") continue;
    handle(message);
  }
});`,
			"utf8",
		);
		writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					mcpServers: {
						mock: {
							command: process.execPath,
							args: [serverPath],
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);

		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
		try {
			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig(),
			});
			expect(runtime.tools.map((tool) => tool.name)).toContain("mock__echo");
			await runtime.shutdown("test");
		} finally {
			process.env.CLINE_MCP_SETTINGS_PATH = previousSettingsPath;
		}
	});

	it("combines hub-owned Agent Plugin skills and MCP servers with client instructions", async () => {
		const tempRoot = realpathSync.native(
			mkdtempSync(join(tmpdir(), "runtime-builder-agent-plugin-")),
		);
		tempDirs.push(tempRoot);
		const previousSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;
		process.env.CLINE_MCP_SETTINGS_PATH = join(
			tempRoot,
			"missing-settings.json",
		);
		const pluginRoot = join(tempRoot, "portable");
		const pluginSkillRoot = join(pluginRoot, "skills", "portable-review");
		const pluginSkillPath = join(pluginSkillRoot, "SKILL.md");
		const localSkillRoot = join(tempRoot, "local-skills", "local-review");
		const serverPath = join(pluginRoot, "server.js");
		mkdirSync(pluginSkillRoot, { recursive: true });
		mkdirSync(localSkillRoot, { recursive: true });
		writeFileSync(
			pluginSkillPath,
			"---\nname: portable-review\ndescription: Review with the portable plugin\n---\nUse portable guidance.",
			"utf8",
		);
		writeFileSync(
			join(localSkillRoot, "SKILL.md"),
			"---\nname: local-review\ndescription: Review locally\n---\nUse local guidance.",
			"utf8",
		);
		writeFileSync(
			serverPath,
			`let buffer = "";
function write(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "notifications/initialized") continue;
    if (message.method === "initialize") write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "portable", version: "1.0.0" } } });
    if (message.method === "tools/list") write({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Portable echo", inputSchema: { type: "object" } }] } });
    if (message.method === "tools/call") write({ jsonrpc: "2.0", id: message.id, result: { echoed: message.params?.arguments ?? null } });
  }
});`,
			"utf8",
		);
		const resolvedPluginRoot = realpathSync.native(pluginRoot);
		const resolvedPluginSkillRoot = realpathSync.native(pluginSkillRoot);
		const resolvedPluginSkillPath = realpathSync.native(pluginSkillPath);

		const clientInstructionService = createUserInstructionConfigService({
			skills: { directories: [join(tempRoot, "local-skills")] },
			rules: { directories: [] },
			workflows: { directories: [] },
		});
		let runtime:
			| Awaited<ReturnType<DefaultRuntimeBuilder["build"]>>
			| undefined;
		try {
			runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig({
					cwd: tempRoot,
					disableMcpSettingsTools: true,
				}),
				userInstructionService: clientInstructionService,
				agentPluginSkills: [
					{
						pluginName: "portable",
						pluginRoot: resolvedPluginRoot,
						directoryPath: resolvedPluginSkillRoot,
						filePath: resolvedPluginSkillPath,
						metadata: {
							name: "portable-review",
							description: "Review with the portable plugin",
						},
					},
				],
				agentPluginMcpServers: [
					{
						pluginName: "portable",
						pluginRoot: resolvedPluginRoot,
						pluginDataPath: join(tempRoot, "plugin-data"),
						serverName: "tools",
						registration: {
							name: "portable.tools",
							transport: {
								type: "stdio",
								command: process.execPath,
								args: [serverPath],
								cwd: resolvedPluginRoot,
							},
							metadata: {
								source: "agent-plugin",
								pluginDataPath: join(tempRoot, "plugin-data"),
							},
						},
					},
				],
			});

			// Matched on a substring, not on equality: an MCP tool's description
			// is the server's own text plus a clause naming the server, which is
			// the only place the model is told which server a tool belongs to.
			const mcpTool = runtime.tools.find((tool) =>
				tool.description?.includes("Portable echo"),
			);
			expect(existsSync(join(tempRoot, "plugin-data"))).toBe(true);
			expect(mcpTool).toBeDefined();
			// Plugin-qualified, which is the name the hub registered it under.
			expect(mcpTool?.description).toContain(
				'From the "portable.tools" MCP server.',
			);
			const extensionTools = await collectExtensionTools(runtime.extensions);
			const skillsTool = extensionTools.find((tool) => tool.name === "skills");
			expect(skillsTool).toBeDefined();
			if (!skillsTool) {
				throw new Error("Expected combined skills tool.");
			}
			expect(skillsTool.description).toContain("portable:portable-review");
			const context = {
				agentId: "agent-1",
				conversationId: "conv-1",
				iteration: 1,
			};
			const portableResult = await skillsTool.execute(
				{ skill: "portable:portable-review" },
				context,
			);
			expect(portableResult).toContain("Use portable guidance.");
			expect(portableResult).toContain(
				`<skill-root>${resolvedPluginSkillRoot}</skill-root>`,
			);
			await expect(
				skillsTool.execute({ skill: "local-review" }, context),
			).resolves.toContain("Use local guidance.");
		} finally {
			await runtime?.shutdown("test");
			clientInstructionService.stop();
			process.env.CLINE_MCP_SETTINGS_PATH = previousSettingsPath;
		}
	});

	it("skips MCP settings tools when disableMcpSettingsTools is true", async () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), "runtime-builder-mcp-disabled-"),
		);
		const serverPath = join(tempRoot, "mock-mcp-server.js");
		const settingsPath = join(tempRoot, "cline_mcp_settings.json");
		const previousSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;

		writeFileSync(
			serverPath,
			`let buffer = "";
function write(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } });
    return;
  }
  if (message.method === "tools/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: [] } }] } });
    return;
  }
  if (message.method === "tools/call") {
    write({ jsonrpc: "2.0", id: message.id, result: { echoed: message.params?.arguments?.value ?? null } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "notifications/initialized") continue;
    handle(message);
  }
});`,
			"utf8",
		);
		writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					mcpServers: {
						mock: {
							command: process.execPath,
							args: [serverPath],
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);

		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
		try {
			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig({
					disableMcpSettingsTools: true,
				}),
			});
			expect(runtime.tools.map((tool) => tool.name)).not.toContain(
				"mock__echo",
			);
			await runtime.shutdown("test");
		} finally {
			process.env.CLINE_MCP_SETTINGS_PATH = previousSettingsPath;
		}
	});

	it("skips broken MCP servers without crashing", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "runtime-builder-mcp-bad-"));
		const serverPath = join(tempRoot, "malformed-mcp-server.js");
		const settingsPath = join(tempRoot, "cline_mcp_settings.json");
		const previousSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;

		writeFileSync(
			serverPath,
			`process.stdin.once("data", () => {
  process.stdout.write("{]\\n");
});`,
			"utf8",
		);
		writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					mcpServers: {
						broken: {
							command: process.execPath,
							args: [serverPath],
							// Keep the test fast: the Content-Length fallback
							// attempt otherwise waits out the default connect
							// budget against this silent server.
							timeout: 1,
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);

		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
		try {
			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig(),
			});
			const mcpTools = runtime.tools.filter((t) =>
				t.name.startsWith("broken__"),
			);
			expect(mcpTools).toEqual([]);
			await runtime.shutdown("test");
		} finally {
			process.env.CLINE_MCP_SETTINGS_PATH = previousSettingsPath;
		}
	});

	it("skips invalid MCP settings file without crashing", async () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), "runtime-builder-mcp-invalid-"),
		);
		const settingsPath = join(tempRoot, "cline_mcp_settings.json");
		const previousSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;

		writeFileSync(settingsPath, "{ not valid json !!!", "utf8");

		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
		try {
			const runtime = await new DefaultRuntimeBuilder().build({
				config: makeBaseConfig(),
			});
			const mcpTools = runtime.tools.filter((t) => t.name.includes("__"));
			expect(mcpTools).toEqual([]);
			await runtime.shutdown("test");
		} finally {
			process.env.CLINE_MCP_SETTINGS_PATH = previousSettingsPath;
		}
	});

	it("includes skills tool when workspace skills are available", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runtime-builder-skills-"));
		const skillDir = join(cwd, ".cline", "skills", "commit");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: commit
description: Create commit message
---
Use conventional commits.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ cwd }),
		});
		const extensionTools = await collectExtensionTools(runtime.extensions);

		expect(runtime.tools.map((tool) => tool.name)).not.toContain("skills");
		expect(extensionTools.map((tool) => tool.name)).toContain("skills");
		await runtime.shutdown("test");
	});

	it("includes skills bundled in discovered plugin packages", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runtime-builder-plugin-skills-"));
		process.env.HOME = cwd;
		setHomeDir(cwd);
		const pluginDir = join(cwd, ".cline", "plugins", "review-plugin");
		const skillDir = join(pluginDir, "skills", "review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(pluginDir, "package.json"),
			JSON.stringify(
				{
					name: "review-plugin",
					private: true,
					cline: {
						plugins: [{ paths: ["./index.ts"] }],
					},
				},
				null,
				2,
			),
			"utf8",
		);
		writeFileSync(join(pluginDir, "index.ts"), "export default {}", "utf8");
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: review
description: Review code
---
Use the review plugin guidance.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ cwd }),
		});
		const extensionTools = await collectExtensionTools(runtime.extensions);
		const skillsTool = extensionTools.find((tool) => tool.name === "skills");
		expect(skillsTool).toBeDefined();
		if (!skillsTool) {
			throw new Error("Expected skills tool.");
		}

		const result = await skillsTool.execute(
			{ skill: "review" },
			{
				agentId: "agent-1",
				conversationId: "conv-1",
				iteration: 1,
			},
		);
		expect(result).toContain("<command-name>review</command-name>");
		expect(result).toContain("Use the review plugin guidance.");

		await runtime.shutdown("test");
	});

	it("uses explicit plugin skill directories instead of rediscovering plugins", async () => {
		const cwd = mkdtempSync(
			join(tmpdir(), "runtime-builder-active-plugin-skills-"),
		);
		process.env.HOME = cwd;
		setHomeDir(cwd);
		const pluginDir = join(cwd, ".cline", "plugins", "review-plugin");
		const skillRoot = join(pluginDir, "skills");
		const skillDir = join(skillRoot, "review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(pluginDir, "package.json"),
			JSON.stringify({
				name: "review-plugin",
				private: true,
				cline: {
					plugins: [{ paths: ["./index.ts"] }],
				},
			}),
			"utf8",
		);
		writeFileSync(join(pluginDir, "index.ts"), "export default {}", "utf8");
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: review
description: Review code
---
Use the review plugin guidance.`,
			"utf8",
		);

		const inactiveRuntime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ cwd }),
			pluginSkillDirectories: [],
		});
		const inactiveExtensionTools = await collectExtensionTools(
			inactiveRuntime.extensions,
		);
		expect(inactiveExtensionTools.map((tool) => tool.name)).not.toContain(
			"skills",
		);
		await inactiveRuntime.shutdown("test");

		const activeRuntime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ cwd }),
			pluginSkillDirectories: [skillRoot],
		});
		const activeExtensionTools = await collectExtensionTools(
			activeRuntime.extensions,
		);
		const skillsTool = activeExtensionTools.find(
			(tool) => tool.name === "skills",
		);
		expect(skillsTool).toBeDefined();
		await activeRuntime.shutdown("test");
	});

	it("does not include bundled plugin skills when plugins are disabled", async () => {
		const cwd = mkdtempSync(
			join(tmpdir(), "runtime-builder-plugin-skills-disabled-"),
		);
		process.env.HOME = cwd;
		setHomeDir(cwd);
		const pluginDir = join(cwd, ".cline", "plugins", "review-plugin");
		const skillDir = join(pluginDir, "skills", "review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(pluginDir, "package.json"),
			JSON.stringify({
				name: "review-plugin",
				private: true,
				cline: {
					plugins: [{ paths: ["./index.ts"] }],
				},
			}),
			"utf8",
		);
		writeFileSync(join(pluginDir, "index.ts"), "export default {}", "utf8");
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: review
---
Use the review plugin guidance.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ cwd }),
			configExtensions: ["skills"],
		});
		const extensionTools = await collectExtensionTools(runtime.extensions);

		expect(extensionTools.map((tool) => tool.name)).not.toContain("skills");

		await runtime.shutdown("test");
	});

	it("allows tool routing rules to disable skills even when skills exist", async () => {
		const cwd = mkdtempSync(
			join(tmpdir(), "runtime-builder-skills-routing-disabled-"),
		);
		const skillDir = join(cwd, ".cline", "skills", "commit");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: commit
description: Create commit message
---
Use conventional commits.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				providerId: "openrouter",
				modelId: "google/gemini-3-flash-preview",
				cwd,
				toolRoutingRules: [
					{
						mode: "act",
						providerIdIncludes: ["openrouter"],
						modelIdIncludes: ["gemini"],
						disableTools: ["skills"],
					},
				],
			}),
		});

		expect(runtime.tools.map((tool) => tool.name)).not.toContain("skills");
		expect(
			(await collectExtensionTools(runtime.extensions)).map(
				(tool) => tool.name,
			),
		).not.toContain("skills");
		await runtime.shutdown("test");
	});

	it("marks configured but disabled skills in executor metadata", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runtime-builder-skills-disabled-"));
		const enabledDir = join(cwd, ".cline", "skills", "commit");
		const disabledDir = join(cwd, ".cline", "skills", "review");
		mkdirSync(enabledDir, { recursive: true });
		mkdirSync(disabledDir, { recursive: true });
		writeFileSync(
			join(enabledDir, "SKILL.md"),
			`---
name: commit
---
Enabled skill.`,
			"utf8",
		);
		writeFileSync(
			join(disabledDir, "SKILL.md"),
			`---
name: review
disabled: true
---
Disabled skill.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ cwd }),
		});

		const extensionTools = await collectExtensionTools(runtime.extensions);
		const skillsTool = extensionTools.find((tool) => tool.name === "skills");
		expect(skillsTool).toBeDefined();
		if (!skillsTool) {
			throw new Error("Expected skills tool.");
		}

		const disabledResult = await skillsTool.execute(
			{ skill: "review" },
			{
				agentId: "agent-1",
				conversationId: "conv-1",
				iteration: 1,
			},
		);
		expect(disabledResult).toContain("configured but disabled");

		await runtime.shutdown("test");
	});

	it("scopes skills tool to session-configured skills", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runtime-builder-skills-scoped-"));
		const commitDir = join(cwd, ".cline", "skills", "commit");
		const reviewDir = join(cwd, ".cline", "skills", "review");
		mkdirSync(commitDir, { recursive: true });
		mkdirSync(reviewDir, { recursive: true });
		writeFileSync(
			join(commitDir, "SKILL.md"),
			`---
name: commit
---
Commit skill.`,
			"utf8",
		);
		writeFileSync(
			join(reviewDir, "SKILL.md"),
			`---
name: review
---
Review skill.`,
			"utf8",
		);

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				cwd,
				skills: ["commit"],
			}),
		});

		const extensionTools = await collectExtensionTools(runtime.extensions);
		const skillsTool = extensionTools.find((tool) => tool.name === "skills");
		expect(skillsTool).toBeDefined();
		if (!skillsTool) {
			throw new Error("Expected skills tool.");
		}

		const known = await skillsTool.execute(
			{ skill: "commit" },
			{
				agentId: "agent-1",
				conversationId: "conv-1",
				iteration: 1,
			},
		);
		expect(known).toContain("<command-name>commit</command-name>");

		const blocked = await skillsTool.execute(
			{ skill: "review" },
			{
				agentId: "agent-1",
				conversationId: "conv-1",
				iteration: 1,
			},
		);
		expect(blocked).toContain('Skill "review" not found.');
		expect(blocked).toContain("Available skills: commit");

		await runtime.shutdown("test");
	});

	it("does not register the skills tool when all configured skills are disabled", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "runtime-disabled-skills-"));
		const skillDir = join(cwd, ".cline", "skills", "review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: review
disabled: true
---
Review skill.`,
			"utf8",
		);
		const userInstructionService = createUserInstructionConfigService({
			skills: { directories: [join(cwd, ".cline", "skills")] },
			rules: { directories: [] },
			workflows: { directories: [] },
		});

		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ cwd }),
			userInstructionService,
		});

		const extensionTools = await collectExtensionTools(runtime.extensions);
		expect(extensionTools.map((tool) => tool.name)).not.toContain("skills");

		await runtime.shutdown("test");
	});
});

// Lead-agent-control spec, A: where the lead can delegate, a background round
// still out holds its completion; where it cannot, nothing is added.
describe("the lead's completion and its background rounds", () => {
	afterEach(() => {
		__resetAgentRounds();
	});

	it("is held while a round of the session runs", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				sessionId: "rounds-guard",
				enableSpawnAgent: true,
			}),
			createSpawnTool: makeSpawnTool,
		});
		const guard = runtime.completionPolicy?.completionGuard;
		expect(guard?.()).toBeUndefined();
		const handle = roundsFor("rounds-guard").open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: true,
			agents: [{ name: "bg", task: "t" }],
		});
		void handle.run(
			0,
			{ agentId: "lead", iteration: 1, sessionId: "rounds-guard" } as never,
			() => new Promise(() => {}),
		);
		expect(guard?.()).toContain(
			"Round r1 (spawn_agent, 1 agent) is still running",
		);
	});

	it("carries no rounds guard without delegation", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({ sessionId: "rounds-none" }),
		});
		expect(runtime.completionPolicy?.completionGuard).toBeUndefined();
	});
});
