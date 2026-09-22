import type { ClineMessage, SubagentStatusItem } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ActiveSubagents, liveSubagentsFrom } from "./ActiveSubagents"

/**
 * Measured on pandorum 2026-09-22: a fan-out of three configured agents ran
 * for four minutes, and for all but the first seconds of it the conversation
 * showed the lead's last tool call and nothing else. The sub-agent row scrolls
 * away with the message that started it, so there was no way to tell whether
 * the agents were working, queued or dead without opening the extension log.
 */

function item(overrides: Partial<SubagentStatusItem> & { index: number }): SubagentStatusItem {
	return {
		prompt: "do the thing",
		status: "running",
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
		...overrides,
	}
}

function statusMessage(items: SubagentStatusItem[], ts = 100): ClineMessage {
	return {
		ts,
		type: "say",
		say: "subagent",
		text: JSON.stringify({
			status: "running",
			total: items.length,
			completed: items.filter((entry) => entry.status === "completed").length,
			items,
		}),
	} as ClineMessage
}

describe("reading the live agents out of the conversation", () => {
	it("takes the running ones from the most recent status", () => {
		const live = liveSubagentsFrom([
			statusMessage([item({ index: 1, agentName: "js-syntactic" })], 100),
			statusMessage(
				[item({ index: 1, agentName: "js-syntactic", status: "completed" }), item({ index: 2, agentName: "html" })],
				200,
			),
		])

		expect(live.map((entry) => entry.agentName)).toEqual(["html"])
	})

	// Each status message replaces the previous one for the same batch, so
	// reading further back would resurrect agents that have already finished.
	it("does not fall back to an older status when the newest has none live", () => {
		const live = liveSubagentsFrom([
			statusMessage([item({ index: 1, agentName: "js-syntactic" })], 100),
			statusMessage([item({ index: 1, agentName: "js-syntactic", status: "completed" })], 200),
		])

		expect(live).toEqual([])
	})

	it("is nothing at all on a conversation that spawned no agents", () => {
		expect(liveSubagentsFrom([{ ts: 1, type: "say", say: "text", text: "hello" } as ClineMessage])).toEqual([])
	})

	it("survives a status message that is not JSON", () => {
		expect(liveSubagentsFrom([{ ts: 1, type: "say", say: "subagent", text: "{oh no" } as ClineMessage])).toEqual([])
	})
})

describe("the working-agents strip", () => {
	it("shows nothing when no agent is running", () => {
		const { container } = render(<ActiveSubagents messages={[]} />)
		expect(container).toBeEmptyDOMElement()
	})

	it("names each agent, what it is doing, and where it is doing it", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({
							index: 1,
							agentName: "js-syntactic",
							latestToolCall: "editor",
							nodeId: "node-mucvow61",
							nodeLabel: "Node3",
						}),
						item({ index: 2, agentName: "html-structure-checker", latestToolCall: "read_files" }),
					]),
				]}
			/>,
		)

		expect(screen.getByText("2 agents working")).toBeInTheDocument()
		expect(screen.getByText("js-syntactic")).toBeInTheDocument()
		expect(screen.getByText("Node3")).toBeInTheDocument()
		expect(screen.getByText("editor")).toBeInTheDocument()
		expect(screen.getByText("read_files")).toBeInTheDocument()
	})

	// A queued agent and a working one are the distinction the strip exists to
	// make -- the reported run had three agents where only one was ever
	// running.
	// Reported the first time the badge was seen: "'on node-mucuczcm' what is
	// this? ... I expect to see Node1 or Node2". The id is a storage key the
	// settings panel never shows.
	it("names the node the way the settings panel does", () => {
		render(
			<ActiveSubagents
				messages={[statusMessage([item({ index: 1, agentName: "js-syntactic", nodeId: "primary", nodeLabel: "Node1" })])]}
			/>,
		)

		expect(screen.getByText("Node1")).toBeInTheDocument()
		expect(screen.queryByText("primary")).not.toBeInTheDocument()
	})

	// A run recorded before nodes were named still has to say something.
	it("falls back to the id when the run carries no name", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "old", nodeId: "node-mucuczcm" })])]} />)

		expect(screen.getByText("node-mucuczcm")).toBeInTheDocument()
	})

	it("says an agent is queued rather than pretending it is thinking", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "waiting", status: "pending" })])]} />)

		expect(screen.getByText("queued")).toBeInTheDocument()
	})

	it("opens the agent's task when it is clicked, and closes it again", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({
							index: 1,
							agentName: "js-syntactic",
							prompt: "fix the mangled braces on line 90",
							latestToolCall: "editor",
						}),
					]),
				]}
			/>,
		)

		expect(screen.queryByText("fix the mangled braces on line 90")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.getByText("fix the mangled braces on line 90")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.queryByText("fix the mangled braces on line 90")).not.toBeInTheDocument()
	})

	// The panel outliving the agent it describes would claim work is still
	// going on.
	it("closes the panel when its agent finishes", () => {
		const running = [
			statusMessage([item({ index: 1, agentName: "js-syntactic", prompt: "fix the braces" })], 100),
		] as ClineMessage[]
		const { rerender } = render(<ActiveSubagents messages={running} />)

		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.getByText("fix the braces")).toBeInTheDocument()

		rerender(
			<ActiveSubagents
				messages={[
					...running,
					statusMessage(
						[item({ index: 1, agentName: "js-syntactic", prompt: "fix the braces", status: "completed" })],
						200,
					),
				]}
			/>,
		)

		expect(screen.queryByText("fix the braces")).not.toBeInTheDocument()
	})
})
