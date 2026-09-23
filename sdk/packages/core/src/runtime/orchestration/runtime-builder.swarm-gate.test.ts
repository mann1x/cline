import { resetPolykvAvailability } from "@cline/llms";
import type { AgentTool } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreSessionConfig } from "../../types/config";
import { DefaultRuntimeBuilder } from "./runtime-builder";

/**
 * A `/props` answer, and a count of how often it was asked for.
 *
 * `pools_enabled` is the whole question: it is false on a server booted without
 * `--polykv-max-pools`, which is the default, and true only where the engine
 * really does hold a pool tree.
 */
function propsServer(poolsEnabled: boolean) {
	const fetchImpl = vi.fn(async () =>
		Response.json({
			build_info: "b1789787714-c588c4f47",
			features: [],
			opencoti: { polykv: { pools_enabled: poolsEnabled } },
		}),
	);
	return fetchImpl as unknown as typeof fetch & { mock: { calls: unknown[] } };
}

function config(
	overrides: Partial<CoreSessionConfig> = {},
	providerOverrides: Record<string, unknown> = {},
): CoreSessionConfig {
	return {
		providerId: "opencoti",
		modelId: "lfm2.5",
		apiKey: "key",
		systemPrompt: "test",
		cwd: process.cwd(),
		enableTools: true,
		enableSpawnAgent: true,
		maxConcurrentAgents: 0,
		providerConfig: {
			providerId: "opencoti",
			baseUrl: "http://127.0.0.1:8240/v1",
			polykv: { swarm: true },
			...providerOverrides,
		},
		...overrides,
	} as CoreSessionConfig;
}

function stubTool(name: string): AgentTool {
	return {
		name,
		description: name,
		inputSchema: { type: "object", properties: {} },
		execute: async () => ({ query: name, result: "", success: true }),
	} as unknown as AgentTool;
}

/**
 * Whether `spawn_agent` was handed the swarm -- its `merge` mode.
 *
 * The swarm is not a tool of its own any more: asked for one, the model
 * reaches for `spawn_agent` first (the sx4bp lead did, with a swarm tool
 * offered or not), and one tool is one schema less in every request.
 */
async function swarmOffered(input: {
	config: CoreSessionConfig;
}): Promise<boolean> {
	let handed = false;
	const runtime = await new DefaultRuntimeBuilder().build({
		config: input.config,
		createSpawnTool: (options?: { swarm?: AgentTool }) => {
			handed = options?.swarm !== undefined;
			return stubTool("spawn_agent");
		},
		createSwarmTool: () => stubTool("spawn_swarm"),
	} as never);
	expect(runtime.tools.some((tool) => tool.name === "spawn_swarm")).toBe(false);
	return handed;
}

describe("spawn_agent's swarm mode is gated on an engine that has pools", () => {
	afterEach(() => {
		resetPolykvAvailability();
	});

	it("offers it when the server confirms pools_enabled", async () => {
		const fetchImpl = propsServer(true);
		expect(
			await swarmOffered({ config: config({}, { fetch: fetchImpl }) }),
		).toBe(true);
	});

	// The live test server answers exactly this, and used to get the tool
	// anyway: the old gate asked the profile which provider it was, not the
	// server what it had on. A swarm there fails on the first pool call, after
	// the schema has already been paid for out of the window.
	it("withholds it when the server says pools are off", async () => {
		const fetchImpl = propsServer(false);
		expect(
			await swarmOffered({ config: config({}, { fetch: fetchImpl }) }),
		).toBe(false);
	});

	// An unreachable server cannot confirm anything, and "cannot ask" is not
	// "yes" -- the same reading the slot limit takes.
	it("withholds it when the server cannot be reached", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(
			await swarmOffered({ config: config({}, { fetch: fetchImpl }) }),
		).toBe(false);
	});

	// The profile switch is checked first so a session that never asked for a
	// swarm never spends a round trip finding out it could not have had one.
	it("does not probe at all when the profile has swarms off", async () => {
		const fetchImpl = propsServer(true);
		expect(
			await swarmOffered({
				config: config({}, { fetch: fetchImpl, polykv: { swarm: false } }),
			}),
		).toBe(false);
		expect(fetchImpl.mock.calls).toHaveLength(0);
	});

	// Reported 2026-09-23: "if there's at least one Node supporting swarms, the
	// swarm should be offered". The lead here is an ollama model; the swarm is
	// on the node's opencoti, and its switch is the node's own.
	it("offers it when an agent node has swarms, whatever the lead runs on", async () => {
		const fetchImpl = propsServer(true);
		const leadOnOllama = config(
			{
				providerId: "ollama",
				agentNodes: [
					{
						id: "primary",
						priority: 1,
						capacity: 1,
						connection: { providerId: "ollama", modelId: "qwen" },
					},
					{
						id: "node-2",
						priority: 1,
						capacity: Number.POSITIVE_INFINITY,
						connection: {
							providerId: "opencoti",
							modelId: "gemma",
							baseUrl: "http://127.0.0.1:8240/v1",
							providerConfig: {
								providerId: "opencoti",
								baseUrl: "http://127.0.0.1:8240/v1",
								polykv: { swarm: true },
								fetch: fetchImpl,
							},
						},
					},
				],
			} as never,
			{ providerId: "ollama", polykv: undefined },
		);
		expect(await swarmOffered({ config: leadOnOllama })).toBe(true);
	});
});
