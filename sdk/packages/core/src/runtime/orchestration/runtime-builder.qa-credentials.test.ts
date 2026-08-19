import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import type { CoreSessionConfig } from "../../types/config";
import { DefaultRuntimeBuilder } from "./runtime-builder";

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

function runCommands(tools: AgentTool[]): AgentTool {
	const tool = tools.find((candidate) => candidate.name === "run_commands");
	if (!tool) {
		throw new Error("run_commands is not in this runtime's tools");
	}
	return tool;
}

/**
 * The failure this guards against is silence. `createBuiltinToolsList` takes its
 * arguments positionally and is called from four places; a credential set that
 * reaches the session config but not the call site produces a session where the
 * feature simply never happens, with nothing anywhere saying so.
 */
describe("QA credentials reaching the tools", () => {
	it("names them on run_commands for the session's own tools", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				qaCredentials: [{ name: "QA_USER", value: "qa-account@example.test" }],
			}),
		});

		expect(runCommands(runtime.tools).description).toContain("QA_USER");
	});

	it("never puts the value in the description", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig({
				qaCredentials: [{ name: "QA_USER", value: "qa-account@example.test" }],
			}),
		});

		expect(runCommands(runtime.tools).description).not.toContain(
			"qa-account@example.test",
		);
	});

	it("says nothing about credentials when the host configured none", async () => {
		const runtime = await new DefaultRuntimeBuilder().build({
			config: makeBaseConfig(),
		});

		expect(runCommands(runtime.tools).description).not.toContain(
			"QA credentials",
		);
	});
});
