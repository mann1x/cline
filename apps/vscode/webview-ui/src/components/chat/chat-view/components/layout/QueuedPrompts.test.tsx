import type { QueuedPrompt } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueuedPrompts } from "./QueuedPrompts"

const cancelQueuedPromptMock = vi.hoisted(() => vi.fn())
const pushQueuedPromptMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		cancelQueuedPrompt: (request: unknown) => cancelQueuedPromptMock(request),
		pushQueuedPrompt: (request: unknown) => pushQueuedPromptMock(request),
	},
}))

vi.mock("@shared/proto/cline/common", () => ({
	StringRequest: {
		create: (request: unknown) => request,
	},
}))

const queuedPrompts: QueuedPrompt[] = [
	{
		id: "prompt-1",
		prompt: "First queued message",
		delivery: "queue",
		attachmentCount: 0,
	},
	{
		id: "prompt-2",
		prompt: "Second queued message",
		delivery: "steer",
		attachmentCount: 1,
	},
]

describe("QueuedPrompts", () => {
	beforeEach(() => {
		cancelQueuedPromptMock.mockReset()
		cancelQueuedPromptMock.mockResolvedValue({})
		pushQueuedPromptMock.mockReset()
		pushQueuedPromptMock.mockResolvedValue({})
	})

	it("sends a queued message now from the row action, and offers that only while it waits", async () => {
		render(<QueuedPrompts items={queuedPrompts} />)

		// prompt-2 is already a steer: it has nothing left to push.
		const pushButtons = screen.getAllByRole("button", { name: "Send queued message now" })
		expect(pushButtons).toHaveLength(1)
		fireEvent.click(pushButtons[0])

		expect(pushQueuedPromptMock).toHaveBeenCalledTimes(1)
		expect(pushQueuedPromptMock).toHaveBeenCalledWith({ value: "prompt-1" })
		expect(cancelQueuedPromptMock).not.toHaveBeenCalled()
		expect(pushButtons[0]).toBeDisabled()

		await waitFor(() => expect(pushButtons[0]).not.toBeDisabled())
	})

	it("cancels a queued prompt from the row action", async () => {
		render(<QueuedPrompts items={queuedPrompts} />)

		const cancelButtons = screen.getAllByRole("button", { name: "Cancel queued message" })
		fireEvent.click(cancelButtons[0])

		expect(cancelQueuedPromptMock).toHaveBeenCalledTimes(1)
		expect(cancelQueuedPromptMock).toHaveBeenCalledWith({ value: "prompt-1" })
		expect(cancelButtons[0]).toBeDisabled()

		await waitFor(() => expect(cancelButtons[0]).not.toBeDisabled())
	})

	it("labels a note the runtime queued, and does not count it as the user's", () => {
		render(
			<QueuedPrompts
				items={[
					...queuedPrompts,
					{
						id: "prompt-3",
						prompt: "While your agents were running, the agent system reported agents stuck",
						delivery: "steer",
						attachmentCount: 0,
						origin: "harness",
					},
				]}
			/>,
		)

		expect(screen.getByText("2 messages from you, 1 note from Cerebriline")).toBeInTheDocument()
		expect(screen.getAllByText("Cerebriline")).toHaveLength(1)
	})

	it("does not render an empty queue", () => {
		const { container } = render(<QueuedPrompts items={[]} />)

		expect(container).toBeEmptyDOMElement()
	})
})
