import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RootErrorBoundary } from "./RootErrorBoundary"

const reportWebviewError = vi.fn().mockResolvedValue({})
vi.mock("@/services/grpc-client", () => ({
	UiServiceClient: {
		reportWebviewError: (...args: unknown[]) => reportWebviewError(...args),
	},
}))

function Throws({ message }: { message: string }): JSX.Element {
	throw new Error(message)
}

describe("the last boundary in the webview", () => {
	beforeEach(() => {
		reportWebviewError.mockClear()
		// React logs the caught error itself; the test is about what we do next.
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	// The alternative is an unmounted tree, which in a webview is a blank grey
	// panel and looks exactly like a crash nobody can diagnose.
	it("renders the failure instead of nothing", () => {
		render(
			<RootErrorBoundary>
				<Throws message="state.providers is not iterable" />
			</RootErrorBoundary>,
		)

		expect(screen.getByText(/could not draw this view/i)).toBeInTheDocument()
		expect(screen.getByText(/state\.providers is not iterable/)).toBeInTheDocument()
	})

	// A distinct message per test on purpose: the reporter sends one failure
	// once, however many times React re-renders it, and that dedupe outlives a
	// single test.
	it("tells the extension host, which is the only place a report can read it", () => {
		render(
			<RootErrorBoundary>
				<Throws message="settings.parallelSessions of undefined" />
			</RootErrorBoundary>,
		)

		expect(reportWebviewError).toHaveBeenCalledTimes(1)
		expect(reportWebviewError.mock.calls[0][0].value).toContain("settings.parallelSessions of undefined")
	})

	it("sends a failure that repeats on every render only once", () => {
		render(
			<RootErrorBoundary>
				<Throws message="the same thing again" />
			</RootErrorBoundary>,
		)
		reportWebviewError.mockClear()
		render(
			<RootErrorBoundary>
				<Throws message="the same thing again" />
			</RootErrorBoundary>,
		)

		expect(reportWebviewError).not.toHaveBeenCalled()
	})

	it("stays out of the way when nothing throws", () => {
		render(
			<RootErrorBoundary>
				<div>chat</div>
			</RootErrorBoundary>,
		)

		expect(screen.getByText("chat")).toBeInTheDocument()
		expect(reportWebviewError).not.toHaveBeenCalled()
	})
})
