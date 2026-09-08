import type { AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import { buildConfiguredAgentToolDescriptors } from "./configured-agent-tool";
import {
	delegateToConfiguredAgent,
	findConfiguredAgent,
	listConfiguredAgentSummaries,
	renderDelegationForTranscript,
	UnknownConfiguredAgentError,
} from "./delegate-to-agent";

function makeAgent(
	overrides: Partial<ConfiguredAgentConfig> = {},
): ConfiguredAgentConfig {
	return {
		name: "qa",
		description: "Runs the QA skill over a change",
		systemPrompt: "You are QA.",
		...overrides,
	};
}

/** A stand-in for the `subagent_*` tool the runtime builds. */
function makeSubagentTool(
	agents: readonly ConfiguredAgentConfig[],
	name: string,
	execute: AgentTool["execute"],
): AgentTool {
	const toolName = buildConfiguredAgentToolDescriptors(agents).find(
		(d) => d.config.name === name,
	)?.toolName;
	if (!toolName) throw new Error(`no descriptor for ${name}`);
	return {
		name: toolName,
		description: "",
		inputSchema: { type: "object" },
		execute,
	};
}

describe("listConfiguredAgentSummaries", () => {
	it("pairs each agent with the tool the model would call", () => {
		const agents = [makeAgent(), makeAgent({ name: "netops" })];
		const summaries = listConfiguredAgentSummaries(agents);
		expect(summaries.map((s) => s.name)).toEqual(["netops", "qa"]);
		for (const summary of summaries) {
			expect(summary.toolName).toMatch(/^subagent_/);
		}
	});

	it("carries where the agent runs, so a picker can show it", () => {
		const summaries = listConfiguredAgentSummaries([
			makeAgent({ profile: "local-qwen", skills: ["qa"] }),
		]);
		expect(summaries[0]).toMatchObject({
			profile: "local-qwen",
			skills: ["qa"],
		});
	});

	it("is empty rather than throwing when nothing is configured", () => {
		expect(listConfiguredAgentSummaries(undefined)).toEqual([]);
		expect(listConfiguredAgentSummaries([])).toEqual([]);
	});
});

describe("findConfiguredAgent", () => {
	const agents = [makeAgent(), makeAgent({ name: "NetOps" })];

	it("matches the name the user typed, whatever its case", () => {
		expect(findConfiguredAgent(agents, "netops")?.name).toBe("NetOps");
		expect(findConfiguredAgent(agents, "  QA  ")?.name).toBe("qa");
	});

	it("also matches the tool name, which is what the model calls it", () => {
		const toolName = listConfiguredAgentSummaries(agents)[0].toolName;
		expect(findConfiguredAgent(agents, toolName)?.toolName).toBe(toolName);
	});

	it("finds nothing for a name nobody has", () => {
		expect(findConfiguredAgent(agents, "reviewer")).toBeUndefined();
		expect(findConfiguredAgent(agents, "")).toBeUndefined();
	});
});

describe("delegateToConfiguredAgent", () => {
	it("runs the agent's own tool and reports what came back", async () => {
		const agents = [makeAgent()];
		const execute = vi.fn().mockResolvedValue({
			text: "3 tests fixed",
			iterations: 12,
			finishReason: "stop",
			usage: { inputTokens: 100, outputTokens: 20 },
		});
		const tool = makeSubagentTool(agents, "qa", execute);

		const result = await delegateToConfiguredAgent({
			agents,
			tools: [tool],
			agentName: "qa",
			prompt: "  run the suite  ",
			sessionId: "s1",
			parentAgentId: "agent_lead",
			conversationId: "c1",
		});

		expect(result).toMatchObject({
			agentName: "qa",
			text: "3 tests fixed",
			iterations: 12,
		});
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		// The task reaches the agent trimmed, and the lead agent is named as the
		// parent so the delegated run is not orphaned.
		expect(execute).toHaveBeenCalledWith(
			{ prompt: "run the suite" },
			expect.objectContaining({
				agentId: "agent_lead",
				sessionId: "s1",
				conversationId: "c1",
				metadata: { delegatedByUser: true },
			}),
		);
	});

	it("names the agents that do exist when asked for one that does not", async () => {
		const agents = [makeAgent(), makeAgent({ name: "netops" })];
		await expect(
			delegateToConfiguredAgent({
				agents,
				tools: [],
				agentName: "reviewer",
				prompt: "look at this",
				parentAgentId: "a",
			}),
		).rejects.toThrow(/no agent named "reviewer".*netops.*qa/s);
	});

	it("says subagents are off, rather than that the agent is missing", async () => {
		// The file parsed, so the agent exists; the tool is absent because the
		// session was built with subagents disabled. Those are different problems
		// and only one of them is the user's spelling.
		const agents = [makeAgent()];
		await expect(
			delegateToConfiguredAgent({
				agents,
				tools: [],
				agentName: "qa",
				prompt: "run the suite",
				parentAgentId: "a",
			}),
		).rejects.toThrow(/Subagents are turned off/);
	});

	it("refuses an empty task", async () => {
		await expect(
			delegateToConfiguredAgent({
				agents: [makeAgent()],
				tools: [],
				agentName: "qa",
				prompt: "   ",
				parentAgentId: "a",
			}),
		).rejects.toThrow(/needs a description/);
	});

	it("lets a failure inside the agent surface as itself", async () => {
		const agents = [makeAgent()];
		const tool = makeSubagentTool(agents, "qa", async () => {
			throw new Error("provider 401");
		});
		await expect(
			delegateToConfiguredAgent({
				agents,
				tools: [tool],
				agentName: "qa",
				prompt: "run the suite",
				parentAgentId: "a",
			}),
		).rejects.toThrow("provider 401");
	});

	it("reports no agents at all differently from a misspelling", () => {
		const error = new UnknownConfiguredAgentError("qa", []);
		expect(error.message).toMatch(/\.cline\/agents/);
	});
});

describe("renderDelegationForTranscript", () => {
	const base = {
		agentName: "qa",
		toolName: "subagent_qa",
		iterations: 3,
		durationMs: 1000,
	};

	it("says who did the work and what they were asked", () => {
		const text = renderDelegationForTranscript(
			{ ...base, text: "3 tests fixed" },
			"run the suite",
		);
		expect(text).toContain('delegated this to the "qa" agent');
		expect(text).toContain("run the suite");
		expect(text).toContain("3 tests fixed");
	});

	it("does not pretend a silent agent reported something", () => {
		const text = renderDelegationForTranscript({ ...base, text: "   " }, "go");
		expect(text).toContain("finished without reporting anything");
	});
});
