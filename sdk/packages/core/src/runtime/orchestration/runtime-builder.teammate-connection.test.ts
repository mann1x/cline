import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultRuntimeBuilder } from "./runtime-builder";
import { SessionRuntime } from "./session-runtime-orchestrator";

/**
 * A teammate on the Agents tab's connection stays on it.
 *
 * The host pushes the lead's key, base URL and headers to every live teammate
 * when the session's connection changes, or its OAuth key is refreshed
 * (`updateTeammateConnections`). That push went past the pinning every other
 * delegated agent gets, so a teammate given its own server by the Agents tab
 * was moved onto the lead's -- under its own model id.
 */
describe("a teammate's own connection", () => {
	let dir: string;
	const saved = {
		CLINE_DATA_DIR: process.env.CLINE_DATA_DIR,
		CLINE_TEAM_DATA_DIR: process.env.CLINE_TEAM_DATA_DIR,
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "teammate-connection-"));
		process.env.CLINE_DATA_DIR = dir;
		process.env.CLINE_TEAM_DATA_DIR = join(dir, "teams");
	});

	afterEach(() => {
		process.env.CLINE_DATA_DIR = saved.CLINE_DATA_DIR;
		process.env.CLINE_TEAM_DATA_DIR = saved.CLINE_TEAM_DATA_DIR;
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("is not overwritten by the lead's; what it does not name still follows", async () => {
		const built = await new DefaultRuntimeBuilder().build({
			config: {
				providerId: "openai-compatible",
				modelId: "lead-model",
				apiKey: "lead-key",
				baseUrl: "http://lead/v1",
				systemPrompt: "test",
				cwd: process.cwd(),
				sessionId: "session-connection",
				enableTools: false,
				enableSpawnAgent: false,
				enableAgentTeams: true,
				delegatedAgentConnection: {
					providerId: "openai-compatible",
					modelId: "agents-model",
					apiKey: "agents-key",
					baseUrl: "http://agents/v1",
				},
			},
		});
		const spawn = built.tools.find(
			(tool) => tool.name === "team_spawn_teammate",
		);
		await spawn?.execute(
			{ agentId: "w", rolePrompt: "Write" },
			{ agentId: "lead", conversationId: "c", iteration: 1 },
		);
		const updateConnection = vi.spyOn(
			SessionRuntime.prototype,
			"updateConnection",
		);

		built.teamRuntime?.updateTeammateConnections({
			apiKey: "refreshed-lead-key",
			baseUrl: "http://lead-moved/v1",
			headers: { "x-lead": "1" },
		});
		expect(updateConnection).toHaveBeenCalledTimes(1);
		expect(updateConnection).toHaveBeenCalledWith({
			headers: { "x-lead": "1" },
		});

		updateConnection.mockClear();
		built.teamRuntime?.updateTeammateConnections({ apiKey: "again" });
		expect(updateConnection).not.toHaveBeenCalled();
		await built.shutdown?.("test");
	});
});
