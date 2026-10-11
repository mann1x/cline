import { fireEvent, render, screen } from "@testing-library/react"
import type { ButtonHTMLAttributes, PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ContextWindow from "./ContextWindow"

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
	beforeEach(() => vi.clearAllMocks())

	it("runs the shared compact handler after confirmation instead of sending /compact as a message", () => {
		const compactTask = vi.fn().mockResolvedValue(true)
		const onSendMessage = vi.fn()

		render(
			<ContextWindow
				compactDisabled={false}
				compactTask={compactTask}
				contextTokensUsed={120_000}
				contextWindow={200_000}
				onSendMessage={onSendMessage}
				useAutoCondense={false}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /compact task/i }))
		fireEvent.click(screen.getByRole("button", { name: /^compact$/i }))

		expect(compactTask).toHaveBeenCalledTimes(1)
		expect(onSendMessage).not.toHaveBeenCalled()
	})

	it("ends the bar at the granted window and says it is smaller than configured", () => {
		render(
			<ContextWindow
				compactDisabled={false}
				compactTask={vi.fn()}
				contextTokensUsed={20_000}
				contextWindow={262_144}
				contextWindowGrant={{ grantedTokens: 163_840, askedTokens: 262_144 }}
				useAutoCondense={false}
			/>,
		)
		expect(screen.getByTestId("context-window-granted-note").textContent).toContain("smaller than configured")
	})

	it("says nothing about a grant it was not given", () => {
		render(
			<ContextWindow
				compactDisabled={false}
				compactTask={vi.fn()}
				contextTokensUsed={20_000}
				contextWindow={262_144}
				useAutoCondense={false}
			/>,
		)
		expect(screen.queryByTestId("context-window-granted-note")).toBeNull()
	})

	it("disables compaction during API error recovery", () => {
		render(
			<ContextWindow
				compactDisabled={true}
				compactTask={vi.fn()}
				contextTokensUsed={120_000}
				contextWindow={200_000}
				useAutoCondense={false}
			/>,
		)

		expect(screen.getByRole("button", { name: /compact task/i })).toBeDisabled()
	})
})
