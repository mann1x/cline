import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BackgroundAgents } from "./BackgroundAgents"

const listBackgroundDelegations = vi.fn()
const controlBackgroundDelegation = vi.fn().mockResolvedValue({ value: true })
vi.mock("@/services/grpc-client", () => ({
	SlashServiceClient: {
		listBackgroundDelegations: (...args: unknown[]) => listBackgroundDelegations(...args),
		controlBackgroundDelegation: (...args: unknown[]) => controlBackgroundDelegation(...args),
	},
}))

const RUNNING = {
	id: "bg_1",
	agentName: "reviewer",
	prompt: "review the diff",
	status: "running",
	startedAt: Date.now(),
	activity: "read_files",
	iterations: 2,
	error: "",
	endedAt: 0,
}

describe("the background agents panel", () => {
	beforeEach(() => {
		listBackgroundDelegations.mockReset()
		controlBackgroundDelegation.mockClear()
	})

	it("shows what each agent is doing", async () => {
		listBackgroundDelegations.mockResolvedValue({ runs: [RUNNING] })

		render(<BackgroundAgents />)

		expect(await screen.findByText("reviewer")).toBeInTheDocument()
		expect(screen.getByText(/read_files/)).toBeInTheDocument()
		expect(screen.getByText(/turn 2/)).toBeInTheDocument()
	})

	// A finished run has already put its report into the conversation. A row
	// left behind would claim the work is still going on.
	it("shows nothing at all when no run is live", async () => {
		listBackgroundDelegations.mockResolvedValue({
			runs: [{ ...RUNNING, status: "completed" }],
		})

		const { container } = render(<BackgroundAgents />)

		await waitFor(() => expect(listBackgroundDelegations).toHaveBeenCalled())
		expect(container).toBeEmptyDOMElement()
	})

	it("pauses a running agent and resumes a paused one from the same button", async () => {
		listBackgroundDelegations.mockResolvedValue({ runs: [RUNNING] })
		render(<BackgroundAgents />)

		fireEvent.click(await screen.findByLabelText("Pause this agent"))

		await waitFor(() => expect(controlBackgroundDelegation).toHaveBeenCalled())
		expect(controlBackgroundDelegation.mock.calls[0][0]).toMatchObject({ id: "bg_1", action: "pause" })
	})

	it("stops one outright", async () => {
		listBackgroundDelegations.mockResolvedValue({ runs: [RUNNING] })
		render(<BackgroundAgents />)

		fireEvent.click(await screen.findByLabelText("Stop this agent"))

		await waitFor(() => expect(controlBackgroundDelegation).toHaveBeenCalled())
		expect(controlBackgroundDelegation.mock.calls[0][0]).toMatchObject({ id: "bg_1", action: "stop" })
	})

	it("says nothing when the session cannot answer", async () => {
		listBackgroundDelegations.mockRejectedValue(new Error("no runtime"))

		const { container } = render(<BackgroundAgents />)

		await waitFor(() => expect(listBackgroundDelegations).toHaveBeenCalled())
		expect(container).toBeEmptyDOMElement()
	})
})
