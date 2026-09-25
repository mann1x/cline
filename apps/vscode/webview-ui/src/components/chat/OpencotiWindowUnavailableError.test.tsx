import { fireEvent, render, screen } from "@testing-library/react"
import type { ButtonHTMLAttributes, PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import OpencotiWindowUnavailableError from "./OpencotiWindowUnavailableError"

const askResponse = vi.fn().mockResolvedValue(undefined)
const navigateToHistory = vi.fn()

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { askResponse: (request: unknown) => askResponse(request) },
}))
vi.mock("@shared/proto/cline/task", () => ({
	AskResponseRequest: { create: (request: unknown) => request },
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ navigateToHistory }),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

describe("the Can't resume card", () => {
	it("says what the conversation needs and what the server has", () => {
		render(
			<OpencotiWindowUnavailableError
				details={{ asked: 262_144, floor: 262_144, largestAdmissible: 131_072, resume: true }}
			/>,
		)
		expect(screen.getByText("Can't resume this conversation")).toBeTruthy()
		expect(screen.getByText("It was opened with a 256k window and needs the same to continue.")).toBeTruthy()
		expect(screen.getByText("The server has 128k free right now.")).toBeTruthy()
	})

	it("retries only when asked, and opens the history", () => {
		render(<OpencotiWindowUnavailableError details={{ asked: 262_144, resume: true, largestAdmissible: 1 }} />)
		expect(askResponse).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		expect(askResponse).toHaveBeenCalledWith({ responseType: "yesButtonClicked" })
		fireEvent.click(screen.getByRole("button", { name: "View history" }))
		expect(navigateToHistory).toHaveBeenCalled()
	})

	// A new session had its one wait; it gets the same card with Retry.
	it("offers a new session Retry alone", () => {
		render(
			<OpencotiWindowUnavailableError
				details={{ asked: 262_144, floor: 131_072, largestAdmissible: 65_536, resume: false }}
			/>,
		)
		expect(screen.getByText("Can't open this conversation")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "View history" })).toBeNull()
	})
})
