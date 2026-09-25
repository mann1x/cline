import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes, PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ContextWindow from "./ContextWindow"

const condense = vi.fn().mockResolvedValue(undefined)

vi.mock("@/services/grpc-client", () => ({
	SlashServiceClient: {
		condense: (request: unknown) => condense(request),
	},
}))

vi.mock("@shared/proto/cline/common", () => ({
	StringRequest: {
		create: (request: unknown) => request,
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

vi.mock("@/components/ui/hover-card", () => ({
	HoverCard: ({ children }: PropsWithChildren) => <div>{children}</div>,
	HoverCardContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	HoverCardTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))

vi.mock("@/components/ui/progress", () => ({
	Progress: ({ value }: { value?: number }) => (
		<div aria-label="Context window usage progress" role="progressbar">
			{value}
		</div>
	),
}))

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock("@/components/ui/button", () => ({
	Button: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
		<button {...props}>{children}</button>
	),
}))

describe("ContextWindow compact button", () => {
	beforeEach(() => {
		condense.mockClear()
	})

	it("runs the compact RPC after confirmation instead of sending /compact as a message", async () => {
		const onSendMessage = vi.fn()

		render(
			<ContextWindow
				contextTokensUsed={120_000}
				contextWindow={200_000}
				onSendMessage={onSendMessage}
				useAutoCondense={false}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /compact task/i }))
		fireEvent.click(screen.getByRole("button", { name: /^compact$/i }))

		await waitFor(() => expect(condense).toHaveBeenCalledWith({ value: "compact" }))
		expect(onSendMessage).not.toHaveBeenCalled()
	})

	it("ends the bar at the granted window and says it is smaller than configured", () => {
		render(
			<ContextWindow
				contextTokensUsed={20_000}
				contextWindow={262_144}
				contextWindowGrant={{ grantedTokens: 163_840, askedTokens: 262_144 }}
				useAutoCondense={false}
			/>,
		)
		expect(screen.getByTestId("context-window-granted-note").textContent).toContain("smaller than configured")
	})

	it("says nothing about a grant it was not given", () => {
		render(<ContextWindow contextTokensUsed={20_000} contextWindow={262_144} useAutoCondense={false} />)
		expect(screen.queryByTestId("context-window-granted-note")).toBeNull()
	})
})
