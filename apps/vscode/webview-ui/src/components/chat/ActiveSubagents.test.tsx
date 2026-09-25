import type { ClineMessage, SubagentStatusItem } from "@shared/ExtensionMessage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ cancelSubagent: vi.fn(), restartSubagent: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { cancelSubagent: mocks.cancelSubagent, restartSubagent: mocks.restartSubagent },
}))

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

	// A teammate outlives the round its sub-agents ran in: both kinds' rows
	// are read, neither hiding the other.
	it("takes the working teammates as well as the sub-agents", () => {
		const teamRow = {
			ts: 150,
			type: "say",
			say: "subagent",
			text: JSON.stringify({
				kind: "team",
				status: "running",
				items: [
					item({ index: 1001, agentName: "helper", status: "running" }),
					item({ index: 1002, agentName: "idle-one", status: "completed" }),
				],
			}),
		} as ClineMessage
		const live = liveSubagentsFrom([teamRow, statusMessage([item({ index: 1, agentName: "js-syntactic" })], 200)])

		expect(live.map((entry) => entry.agentName)).toEqual(["js-syntactic", "helper"])
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

	// One line of tags, not a row per agent: fifty rows buried the chat.
	it("lists every agent as a tag with its name", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({ index: 1, agentName: "js-syntactic", latestToolCall: "editor" }),
						item({ index: 2, agentName: "html-structure-checker", latestToolCall: "read_files" }),
					]),
				]}
			/>,
		)

		expect(screen.getByText("2 agents working")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /js-syntactic/ })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /html-structure-checker/ })).toBeInTheDocument()
		// Details are behind the name, not on the tag.
		expect(screen.queryByText("editor")).not.toBeInTheDocument()
	})

	// A queued agent and a working one are the distinction the strip exists to
	// make: a clock while it waits for a slot, the spinner once it runs.
	it("shows a clock for a queued agent and a spinner for a running one", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({ index: 1, agentName: "busy" }),
						item({ index: 2, agentName: "waiting", status: "pending" }),
					]),
				]}
			/>,
		)

		expect(screen.getByRole("button", { name: "busy (running)" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "waiting (queued)" })).toBeInTheDocument()
		expect(screen.getByLabelText("queued")).toBeInTheDocument()
		expect(screen.getByLabelText("running")).toBeInTheDocument()
		expect(screen.getByText(/1 running, 1 queued/)).toBeInTheDocument()
	})

	// Reported the first time the badge was seen: "'on node-mucuczcm' what is
	// this? ... I expect to see Node1 or Node2". The id is a storage key the
	// settings panel never shows.
	it("names the node the way the settings panel does, in the agent's box", () => {
		render(
			<ActiveSubagents
				messages={[statusMessage([item({ index: 1, agentName: "js-syntactic", nodeId: "primary", nodeLabel: "Node1" })])]}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.getByText("on Node1")).toBeInTheDocument()
		expect(screen.queryByText(/primary/)).not.toBeInTheDocument()
	})

	// #78: the provider and model, beside the agent's name, while it runs.
	it("names the provider and model an agent is running on", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([item({ index: 1, agentName: "js-syntactic", providerId: "opencoti", modelId: "v9-agentic" })]),
				]}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.getByText("opencoti/v9-agentic")).toBeInTheDocument()
	})

	it("says how many times an agent has compacted, beside its tools", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({
							index: 1,
							agentName: "js-syntactic",
							toolCalls: 4,
							compactions: 2,
							compactionsByCause: { overflow: 1, manual: 1 },
						}),
					]),
				]}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.getByText("4 tools")).toBeInTheDocument()
		expect(screen.getByText("2 compactions").getAttribute("title")).toBe("Compactions: 1 × overflow recovery, 1 × manual")
	})

	it("says nothing about compactions for an agent that has had none", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "calm", toolCalls: 4 })])]} />)

		fireEvent.click(screen.getByRole("button", { name: /calm/ }))
		expect(screen.queryByText(/compaction/)).not.toBeInTheDocument()
	})

	// A run recorded before nodes were named still has to say something.
	it("falls back to the id when the run carries no name", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "old", nodeId: "node-mucuczcm" })])]} />)

		fireEvent.click(screen.getByRole("button", { name: /old/ }))
		expect(screen.getByText("on node-mucuczcm")).toBeInTheDocument()
	})

	it("says an agent is queued rather than pretending it is thinking", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "waiting", status: "pending" })])]} />)

		fireEvent.click(screen.getByRole("button", { name: /waiting/ }))
		expect(screen.getByText("queued")).toBeInTheDocument()
	})

	// 8240 2026-09-24: every worker's pool shared 4 of its 5,627 tokens, on
	// every turn, and it was in the server log and nowhere a user would look.
	it("shows what the agent has been doing, and marks what went wrong", () => {
		const divergence =
			"Pool 5 shared only 4 of its 5,627 tokens: this request's prompt diverges from the pool at token 4, so each turn prefills the whole prompt again."
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({
							index: 1,
							agentName: "js-syntactic",
							activity: [
								{ at: 1_000, text: "read_files manic_miner.html" },
								{ at: 2_000, text: divergence, severity: "warn" },
							],
						}),
					]),
				]}
			/>,
		)

		// Marked on its tag, before anything is opened.
		expect(screen.getByLabelText("has a warning")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.getByText("Activity")).toBeInTheDocument()
		expect(screen.getByText("read_files manic_miner.html")).toBeInTheDocument()
		const warning = screen.getByText(divergence).closest("li")
		expect(warning?.className).toContain("text-[#e8912d]")
		expect(warning?.querySelector('[aria-label="warning"]')).not.toBeNull()
	})

	// Two agents hung after a server restart, and Stop was the only control.
	it("restarts an agent by the id its spawn tool announced", () => {
		mocks.restartSubagent.mockResolvedValue({})
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "stuck", cancelId: "lead::call-3" })])]} />)

		fireEvent.click(screen.getByRole("button", { name: /stuck/ }))
		fireEvent.click(screen.getByRole("button", { name: "Restart stuck" }))
		expect(mocks.restartSubagent).toHaveBeenCalledWith(expect.objectContaining({ value: "lead::call-3" }))
		expect(screen.getByText("Restarting…")).toBeInTheDocument()
	})

	it("opens the agent's box when its name is clicked, and closes it again", () => {
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
		expect(screen.getByText("editor")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: /js-syntactic/ }))
		expect(screen.queryByText("fix the mangled braces on line 90")).not.toBeInTheDocument()
	})

	// What it is writing is what tells a stuck agent from a working one.
	it("shows the last lines of the agent's output in its box", () => {
		const output = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"].join("\n")
		render(
			<ActiveSubagents
				messages={[statusMessage([item({ index: 1, agentName: "js", latestOutput: output, latestOutputKind: "text" })])]}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /js/ }))
		expect(screen.getByText("Output")).toBeInTheDocument()
		const tail = screen.getByText(/line 8/)
		expect(tail.textContent).toContain("line 3")
		expect(tail.textContent).not.toContain("line 2")
	})

	it("labels reasoning as thinking, not as output", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({ index: 1, agentName: "js", latestOutput: "considering the brace", latestOutputKind: "reasoning" }),
					]),
				]}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /js/ }))
		expect(screen.getByText("Thinking")).toBeInTheDocument()
	})

	// The panel outliving the agent it describes would claim work is still
	// going on.
	it("closes the box when its agent finishes", () => {
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

/**
 * Stopping one agent. `cancelTask` was the only control, and it is the wrong
 * one here: a fan-out of five where one grinds has four finished reports, and
 * cancelling the session throws them away with the lead's context.
 */
describe("stopping a running agent", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.cancelSubagent.mockResolvedValue(undefined)
	})

	// Inside the agent's box, below its name: the stop is a decision about one
	// agent, taken after looking at it.
	it("stops the agent whose box is open, by the id that agent announced", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({ index: 1, agentName: "js-syntactic", cancelId: "s1::call-1" }),
						item({ index: 2, agentName: "html", cancelId: "s1::call-2" }),
					]),
				]}
			/>,
		)

		// The strip-wide "Stop all agents" is there; no single agent's stop is.
		expect(screen.queryByRole("button", { name: /^Stop (?!all agents)/ })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /^html/ }))
		fireEvent.click(screen.getByRole("button", { name: "Stop html" }))

		expect(mocks.cancelSubagent).toHaveBeenCalledTimes(1)
		expect(mocks.cancelSubagent.mock.calls[0][0]).toMatchObject({ value: "s1::call-2" })
	})

	// An abort is a request: the run may be inside a model call that has to
	// come back first, so the agent stays. Without this the button looks like
	// it did nothing and invites a second press.
	it("will not be pressed twice", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "js", cancelId: "s1::c" })])]} />)

		fireEvent.click(screen.getByRole("button", { name: /^js/ }))
		const button = screen.getByRole("button", { name: "Stop js" })
		fireEvent.click(button)
		fireEvent.click(button)

		expect(mocks.cancelSubagent).toHaveBeenCalledTimes(1)
		expect(button).toBeDisabled()
	})

	// A run recorded before agents carried a stop id has nothing to send.
	it("offers no stop it cannot send", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1, agentName: "old" })])]} />)

		fireEvent.click(screen.getByRole("button", { name: /old/ }))
		// The strip-wide "Stop all agents" is there; no single agent's stop is.
		expect(screen.queryByRole("button", { name: /^Stop (?!all agents)/ })).not.toBeInTheDocument()
	})
})

describe("the agent's box, first row", () => {
	// Reported on pandorum 2026-09-23: "the panel with the agent status is
	// using too many rows for information that can be shown in the first row".
	// The stop sat on a row of its own, and the tool count, node and speed on
	// another below it.
	it("reads name, stop, tool count, current tool, node and speed in that order, on one row", () => {
		render(
			<ActiveSubagents
				messages={[
					statusMessage([
						item({
							index: 1,
							agentName: "css",
							cancelId: "s1::c",
							toolCalls: 1,
							latestToolCall: "read_files",
							nodeId: "primary",
							nodeLabel: "Node1",
							genTps: 23.4,
						}),
					]),
				]}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: /^css/ }))

		const stop = screen.getByRole("button", { name: "Stop css" })
		const row = stop.parentElement as HTMLElement
		const order = ["Stop", "1 tool", "read_files", "on Node1", "~23.4 tok/s"].map((text) =>
			Array.from(row.children).findIndex((child) => child.textContent === text),
		)
		expect(order.every((position) => position > 0)).toBe(true)
		expect([...order].sort((a, b) => a - b)).toEqual(order)
		expect(row).toContainElement(screen.getByRole("button", { name: "Close agent details" }))
	})

	// A queued agent is generating nothing; a rate left over from a previous
	// placement would say otherwise.
	it("shows no speed for an agent that is not running", () => {
		render(
			<ActiveSubagents
				messages={[statusMessage([item({ index: 1, agentName: "later", status: "pending", genTps: 12 })])]}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: /^later/ }))
		expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument()
	})
})

describe("stopping every agent at once", () => {
	beforeEach(() => {
		mocks.cancelSubagent.mockReset()
		mocks.cancelSubagent.mockResolvedValue({})
	})

	const round = () =>
		statusMessage([
			item({ index: 1, cancelId: "s::c#0" }),
			item({ index: 2, cancelId: "s::c#1", status: "pending" }),
			item({ index: 3 }),
		])

	it("asks first, and stops nothing when the user keeps them running", () => {
		render(<ActiveSubagents messages={[round()]} />)
		fireEvent.click(screen.getByRole("button", { name: "Stop all agents" }))
		expect(screen.getByText("Stop all agents?")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Keep running" }))
		expect(mocks.cancelSubagent).not.toHaveBeenCalled()
	})

	it("stops every running and queued agent that can be stopped once confirmed", () => {
		render(<ActiveSubagents messages={[round()]} />)
		fireEvent.click(screen.getByRole("button", { name: "Stop all agents" }))
		fireEvent.click(screen.getByRole("button", { name: "Stop 2 agents" }))
		expect(mocks.cancelSubagent.mock.calls.map(([request]) => request.value)).toEqual(["s::c#0", "s::c#1"])
	})

	it("offers no stop-all when nothing can be stopped", () => {
		render(<ActiveSubagents messages={[statusMessage([item({ index: 1 })])]} />)
		expect(screen.queryByRole("button", { name: "Stop all agents" })).toBeNull()
	})
})

describe("an agent that has stopped producing (#77)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("stops quoting a speed once output stops, and says how long it has been quiet", () => {
		render(
			<ActiveSubagents
				messages={[statusMessage([item({ index: 1, agentName: "writer", latestOutput: "text", genTps: 21.5 })])]}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: /writer/ }))
		expect(screen.getByText("~21.5 tok/s")).toBeInTheDocument()
		expect(screen.queryByText(/no activity/)).not.toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(6_000)
		})
		expect(screen.queryByText("~21.5 tok/s")).not.toBeInTheDocument()
		expect(screen.getByText("idle")).toBeInTheDocument()
		expect(screen.queryByText(/no activity/)).not.toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(25_000)
		})
		expect(screen.getByText("no activity for 31s")).toBeInTheDocument()
	})
})
