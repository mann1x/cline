import { strict as assert } from "node:assert"
import { EmptyRequest } from "@shared/proto/cline/common"
import { DelegateRequest } from "@shared/proto/cline/slash"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { delegate } from "./delegate"
import { listAgents } from "./listAgents"

describe("delegate slash handler", () => {
	it("runs the named agent and returns what it reported", async () => {
		const delegateToAgent = vi.fn().mockResolvedValue({
			agentName: "qa",
			toolName: "subagent_qa",
			text: "3 tests fixed",
			iterations: 12,
			durationMs: 41_000,
		})
		const controller = { delegateToAgent } as unknown as Controller

		const response = await delegate(controller, DelegateRequest.create({ agentName: "qa", prompt: "run the suite" }))

		assert.deepEqual(delegateToAgent.mock.calls[0], ["qa", "run the suite"])
		assert.equal(response.agentName, "qa")
		assert.equal(response.text, "3 tests fixed")
		assert.equal(response.iterations, 12)
		// Sent back so the UI can say how long it took without timing it itself.
		assert.equal(Number(response.durationMs), 41_000)
	})

	it("lets a failed delegation surface rather than reporting an empty run", async () => {
		// A silent empty response would read as "the agent had nothing to say",
		// which is a very different thing from "the agent could not be run".
		const controller = {
			delegateToAgent: vi.fn().mockRejectedValue(new Error('no agent named "qa"')),
		} as unknown as Controller

		await assert.rejects(
			() => delegate(controller, DelegateRequest.create({ agentName: "qa", prompt: "go" })),
			/no agent named/,
		)
	})
})

describe("listAgents slash handler", () => {
	it("says where each agent runs when it names somewhere", async () => {
		const controller = {
			listConfiguredAgents: vi.fn().mockResolvedValue([
				{ name: "qa", description: "Runs QA", toolName: "subagent_qa", profile: "local-qwen" },
				{ name: "netops", description: "Networks", toolName: "subagent_netops", modelId: "qwen3.6" },
				{ name: "plain", description: "Inherits the session", toolName: "subagent_plain" },
			]),
		} as unknown as Controller

		const response = await listAgents(controller, EmptyRequest.create({}))

		assert.deepEqual(
			response.agents.map((agent) => [agent.name, agent.runsOn]),
			[
				["qa", "local-qwen"],
				["netops", "qwen3.6"],
				// Empty rather than invented: this agent runs on the session's model,
				// and naming one would claim a configuration the file does not have.
				["plain", ""],
			],
		)
	})

	it("is empty when nothing is configured", async () => {
		const controller = {
			listConfiguredAgents: vi.fn().mockResolvedValue([]),
		} as unknown as Controller
		const response = await listAgents(controller, EmptyRequest.create({}))
		assert.equal(response.agents.length, 0)
	})
})
