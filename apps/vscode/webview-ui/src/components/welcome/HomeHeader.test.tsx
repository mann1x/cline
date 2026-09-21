import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ environment: "production" }),
}))
vi.mock("@/services/grpc-client", () => ({ UiServiceClient: { openWalkthrough: vi.fn() } }))
vi.mock("@shared/proto/cline/common", () => ({ EmptyRequest: { create: () => ({}) } }))

import HomeHeader from "./HomeHeader"

describe("HomeHeader", () => {
	// This panel is the first thing a session shows, and it was showing another
	// product's mark. The Cerebriline one is the same drawing as the activity-bar
	// icon, so the thing in the sidebar and the thing at the top of a new session
	// are one mark at two sizes.
	it("shows the Cerebriline mark", () => {
		render(<HomeHeader />)

		expect(screen.getByTitle("Cerebriline")).toBeTruthy()
	})

	it("keeps the heading it had", () => {
		render(<HomeHeader />)

		expect(screen.getByText("What can I do for you?")).toBeTruthy()
	})
})
