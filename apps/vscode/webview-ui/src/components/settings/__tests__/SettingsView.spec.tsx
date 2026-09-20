import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SettingsView from "../SettingsView"
import { __resetPendingEdits, registerPendingEdit } from "../utils/pendingEdits"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		version: "4.100.145",
		extensionVariant: "standard",
		environment: "production",
		settingsInitialModelTab: undefined,
	}),
}))

vi.mock("@/context/ClineAuthContext", () => ({
	useClineAuth: () => ({ activeOrganization: null, clineUser: null }),
}))

vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { resetState: vi.fn() },
}))

// The tab bodies are irrelevant here and pull in the whole provider panel.
vi.mock("../sections/ApiConfigurationSection", () => ({ default: () => <div>api config</div> }))
vi.mock("../sections/GeneralSettingsSection", () => ({ default: () => <div>general</div> }))
vi.mock("../sections/FeatureSettingsSection", () => ({ default: () => <div>features</div> }))
vi.mock("../sections/TerminalSettingsSection", () => ({ default: () => <div>terminal</div> }))
vi.mock("../sections/RemoteConfigSection", () => ({ RemoteConfigSection: () => <div>remote</div> }))
vi.mock("../sections/AboutSection", () => ({ default: () => <div>about</div> }))
vi.mock("../sections/DebugSection", () => ({ default: () => <div>debug</div> }))

describe("SettingsView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		__resetPendingEdits()
	})

	/**
	 * The numeric settings wait 800ms before they write. Anything that takes the
	 * field off the screen inside that window has to end the wait itself, or the
	 * value the user is looking at never reaches providers.json -- and on the
	 * measured install it did not, three times in one afternoon.
	 */
	describe("a field still inside its debounce", () => {
		it("is saved when the panel is closed", async () => {
			const flush = vi.fn()
			registerPendingEdit({ pending: () => true, flush, discard: () => {} })
			const onDone = vi.fn()
			render(<SettingsView onDone={onDone} />)

			fireEvent.click(screen.getByText("Done"))

			await waitFor(() => expect(onDone).toHaveBeenCalled())
			expect(flush).toHaveBeenCalled()
		})

		it("is saved before the view it is on goes away", async () => {
			// Order, not just occurrence: a flush issued after the unmount reads a
			// component that is no longer there.
			const order: string[] = []
			registerPendingEdit({
				pending: () => true,
				flush: () => order.push("flush"),
				discard: () => {},
			})
			const onDone = vi.fn(() => {
				order.push("done")
			})
			render(<SettingsView onDone={onDone} />)

			fireEvent.click(screen.getByText("Done"))

			await waitFor(() => expect(order).toEqual(["flush", "done"]))
		})

		it("is saved when another settings tab is opened", () => {
			const flush = vi.fn()
			registerPendingEdit({ pending: () => true, flush, discard: () => {} })
			render(<SettingsView onDone={vi.fn()} />)

			fireEvent.click(screen.getByTestId("tab-terminal"))

			expect(flush).toHaveBeenCalled()
		})

		it("is left alone when there is nothing pending", () => {
			const flush = vi.fn()
			registerPendingEdit({ pending: () => false, flush, discard: () => {} })
			render(<SettingsView onDone={vi.fn()} />)

			fireEvent.click(screen.getByTestId("tab-general"))

			expect(flush).not.toHaveBeenCalled()
		})
	})
})
