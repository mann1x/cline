import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ViewErrorBoundary } from "./ViewErrorBoundary"

const reportWebviewError = vi.fn().mockResolvedValue({})
vi.mock("@/services/grpc-client", () => ({
	UiServiceClient: {
		reportWebviewError: (...args: unknown[]) => reportWebviewError(...args),
	},
}))

function Throws({ message }: { message: string }): JSX.Element {
	throw new Error(message)
}

describe("one view's blast radius", () => {
	beforeEach(() => {
		reportWebviewError.mockClear()
		// React logs the caught error itself; the test is about what we do next.
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	// The whole point of this boundary existing below the root one: the chat is
	// mounted beside the overlay views and must survive one of them throwing.
	it("leaves everything outside the view standing", () => {
		render(
			<div>
				<ViewErrorBoundary viewName="Settings">
					<Throws message="Cannot read properties of undefined (reading 'length')" />
				</ViewErrorBoundary>
				<div>chat</div>
			</div>,
		)

		expect(screen.getByText("chat")).toBeInTheDocument()
		expect(screen.getByText(/Settings could not be drawn/i)).toBeInTheDocument()
		expect(screen.getByText(/reading 'length'/)).toBeInTheDocument()
	})

	it("closes the broken view rather than making the user reload", () => {
		const onDone = vi.fn()
		render(
			<ViewErrorBoundary onDone={onDone} viewName="Settings">
				<Throws message="a view that cannot be drawn" />
			</ViewErrorBoundary>,
		)

		fireEvent.click(screen.getByRole("button", { name: /close this view/i }))
		expect(onDone).toHaveBeenCalledTimes(1)
	})

	it("names the view in what it reports, so a log says which one fell over", () => {
		render(
			<ViewErrorBoundary viewName="MCP servers">
				<Throws message="servers.map is not a function" />
			</ViewErrorBoundary>,
		)

		expect(reportWebviewError).toHaveBeenCalledTimes(1)
		expect(reportWebviewError.mock.calls[0][0].value).toContain("MCP servers failed to render")
		expect(reportWebviewError.mock.calls[0][0].value).toContain("servers.map is not a function")
	})

	it("stays out of the way when nothing throws", () => {
		render(
			<ViewErrorBoundary viewName="History">
				<div>history</div>
			</ViewErrorBoundary>,
		)

		expect(screen.getByText("history")).toBeInTheDocument()
		expect(reportWebviewError).not.toHaveBeenCalled()
	})
})
