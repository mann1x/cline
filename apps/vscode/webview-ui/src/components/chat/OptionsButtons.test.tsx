import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OptionsButtons } from "./OptionsButtons"

const askResponseMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		askResponse: askResponseMock,
	},
}))

describe("OptionsButtons", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("removes hover affordance from the other options immediately after a selection", async () => {
		askResponseMock.mockReturnValue(new Promise(() => undefined))

		render(<OptionsButtons isActive options={["Use this", "Use that"]} />)

		const selectedButton = screen.getByRole("button", { name: "Use this" })
		const otherButton = screen.getByRole("button", { name: "Use that" })

		expect(getComputedStyle(otherButton).cursor).toBe("pointer")

		fireEvent.click(selectedButton)

		expect(askResponseMock).toHaveBeenCalledTimes(1)
		await waitFor(() => {
			expect(getComputedStyle(selectedButton).cursor).toBe("default")
			expect(getComputedStyle(otherButton).cursor).toBe("default")
		})

		fireEvent.click(otherButton)

		expect(askResponseMock).toHaveBeenCalledTimes(1)
	})

	it("re-enables options after askResponse rejects", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
		askResponseMock.mockRejectedValue(new Error("failed"))

		render(<OptionsButtons isActive options={["Use this", "Use that"]} />)

		const selectedButton = screen.getByRole("button", { name: "Use this" })
		const otherButton = screen.getByRole("button", { name: "Use that" })

		fireEvent.click(selectedButton)

		expect(askResponseMock).toHaveBeenCalledTimes(1)
		await waitFor(() => {
			expect(selectedButton).not.toBeDisabled()
			expect(otherButton).not.toBeDisabled()
			expect(getComputedStyle(otherButton).cursor).toBe("pointer")
		})

		consoleError.mockRestore()
	})
})

describe("an option the model recommended", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		askResponseMock.mockResolvedValue(undefined)
	})

	it("shows the mark beside the option and sends the option without it", async () => {
		render(<OptionsButtons isActive options={["Keep it", "Rewrite it (recommended)"]} />)

		expect(screen.getByText("Recommended")).toBeInTheDocument()
		expect(screen.getByText("Rewrite it")).toBeInTheDocument()

		fireEvent.click(screen.getByText("Rewrite it"))

		await waitFor(() => expect(askResponseMock).toHaveBeenCalledWith(expect.objectContaining({ text: "Rewrite it" })))
	})

	it("looks exactly as it did when nothing is recommended", () => {
		render(<OptionsButtons isActive options={["Dark", "Light"]} />)

		expect(screen.queryByText("Recommended")).not.toBeInTheDocument()
	})
})
