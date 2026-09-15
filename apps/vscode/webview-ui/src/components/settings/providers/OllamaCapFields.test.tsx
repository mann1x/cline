import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OllamaProvider } from "./OllamaProvider"

/**
 * Changing the two caps away from a value that is already stored.
 *
 * Reported from the panel, twice, against a build that was supposed to have
 * fixed it: "I still can't change from 64000 ... the update button lights up,
 * it doesn't save it, and same for the per-turn cap".
 *
 * This does NOT reproduce that report -- it passes, and it passed before any
 * change was made to chase it. It is here as the guard for the mechanism that
 * was suspected and ruled out: a store that echoes each write back a round trip
 * later, a configuration that loses its own cap and borrows the global one, and
 * a user retyping over both. The echo is the half the component cannot see on
 * its own, so the store here is a real one, with the latency a gRPC round trip
 * actually has -- an echo that resolves in the same tick hides every race.
 *
 * Whatever is behind the report is therefore somewhere this harness does not
 * go: the real toolkit text field rather than a plain input, a second panel
 * mounted beside this one, or the host handing back something other than what
 * it stored.
 */

const mocks = vi.hoisted(() => ({
	commitSelection: vi.fn(),
	getOllamaModelParameters: vi.fn(),
	getOllamaModels: vi.fn(),
	commitModelSelection: vi.fn(),
	handleApiKeyChange: vi.fn(),
	handleFieldChange: vi.fn(),
	handleModeFieldChange: vi.fn(),
	readConfig: vi.fn(),
	readCommittedSelection: vi.fn(),
	readExtensionState: vi.fn(),
	write: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mocks.readExtensionState(),
}))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		getOllamaModelParameters: mocks.getOllamaModelParameters,
		getOllamaModels: mocks.getOllamaModels,
	},
}))
vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: mocks.readConfig(), write: mocks.write, commitSelection: mocks.commitSelection }),
	fromProtobufProviderModelOverrides: (overrides: unknown) => overrides,
}))
vi.mock("@/hooks/useProviderModelSelection", () => ({
	useProviderModelSelection: () => ({
		committedSelection: mocks.readCommittedSelection(),
		selectedModel: { modelId: "qwen3:4b", modelInfo: {} },
		commitModelSelection: mocks.commitModelSelection,
	}),
}))
vi.mock("@shared/proto-conversions/models/modelOverrides", () => ({
	fromProtobufModelOverrides: (overrides: unknown) => overrides,
	toProtobufModelOverrides: (overrides: unknown) => overrides,
}))
vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: mocks.handleFieldChange,
		handleModeFieldChange: mocks.handleModeFieldChange,
	}),
}))
vi.mock("../utils/ApiConfigurationScopeContext", () => ({ useApiConfigurationScope: () => undefined }))
vi.mock("../utils/useProviderApiKeyField", () => ({
	useProviderApiKeyField: () => ({ savedApiKeyMask: "", handleApiKeyChange: mocks.handleApiKeyChange }),
}))
vi.mock("../OllamaModelPicker", () => ({ default: () => <div /> }))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/RequestTimingsToggle", () => ({ RequestTimingsToggle: () => <div /> }))
vi.mock("@/components/ui/label", () => ({ Label: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))
vi.mock("@/components/ui/select", () => ({
	Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectValue: () => <span />,
}))

// `DebouncedTextField` is part of what is under test, so the toolkit field it
// wraps is a real input here rather than a mock of the whole thing.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
	VSCodeLink: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	VSCodeTextArea: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
	VSCodeTextField: ({
		children,
		onInput,
		value,
	}: {
		children?: ReactNode
		onInput?: (event: { target: { value: string } }) => void
		value?: string
	}) => (
		<label>
			{children}
			<input onChange={(event) => onInput?.({ target: { value: event.target.value } })} value={value ?? ""} />
		</label>
	),
}))

/** The state the reporter's machine is actually in, from providers.json. */
const STORED_CAP = 64000

describe("changing a cap the configuration already has", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers({ shouldAdvanceTime: true })
		mocks.getOllamaModelParameters.mockResolvedValue({ values: {} })
		mocks.getOllamaModels.mockResolvedValue({ values: ["qwen3:4b"] })
		// The global cap holds the same number, which is what makes this worth
		// testing: a configuration that loses its own value falls back to it and
		// the field refills with the number the user is trying to get rid of.
		mocks.readExtensionState.mockReturnValue({ apiConfiguration: {}, maxToolResultChars: STORED_CAP })
		mocks.commitModelSelection.mockResolvedValue(undefined)
	})

	async function openPanel(initial: Record<string, unknown>, apiConfiguration: Record<string, unknown> = {}) {
		// Which profile is loaded, as the profile bar records it. A load changes
		// this, and the drafts below belong to the profile they were typed under.
		let activeProfile = JSON.stringify({ act: "first" })
		mocks.readExtensionState.mockImplementation(() => ({
			apiConfiguration,
			maxToolResultChars: STORED_CAP,
			activeApiConfigurationProfile: activeProfile,
		}))
		let config: Record<string, unknown> = { contextWindow: 131072, ...initial }
		let selection: Record<string, unknown> | undefined = { modelId: "qwen3:4b", overrides: undefined }
		let bump = () => {}
		mocks.readConfig.mockImplementation(() => config)
		mocks.readCommittedSelection.mockImplementation(() => selection)
		mocks.write.mockImplementation(async (patch: Record<string, unknown>) => {
			// The write is a gRPC round trip: the echo lands a few hundred
			// milliseconds later, which is after the debounce has cleared its
			// pending flag and often after the next keystroke. A mock that
			// resolves in the same tick hides exactly the race being chased.
			await new Promise((resolve) => setTimeout(resolve, 250))
			config = { ...config, ...patch }
			// What the host store does with a zero: it clears the field rather
			// than storing it (store.ts), and the panel then has none of its own.
			for (const key of ["contextWindow", "maxToolResultChars"] as const) {
				if (typeof config[key] === "number" && (config[key] as number) <= 0) {
					delete config[key]
				}
			}
			bump()
		})
		mocks.commitModelSelection.mockImplementation(async (next: Record<string, unknown>) => {
			selection = { ...(selection ?? {}), ...next }
			bump()
		})
		const view = render(<OllamaProvider currentMode="act" showModelOptions={true} />)
		bump = () => act(() => view.rerender(<OllamaProvider currentMode="act" showModelOptions={true} />))
		await act(async () => {
			vi.advanceTimersByTime(10)
		})
		return {
			field: (label: string) => screen.getByLabelText(label) as HTMLInputElement,
			/** One keystroke, built on what the box currently holds. */
			press: async (input: HTMLInputElement, char: string) => {
				await act(async () => {
					fireEvent.change(input, { target: { value: input.value + char } })
				})
				await act(async () => {
					vi.advanceTimersByTime(150)
				})
			},
			clear: async (input: HTMLInputElement) => {
				await act(async () => {
					fireEvent.change(input, { target: { value: "" } })
				})
				await act(async () => {
					vi.advanceTimersByTime(150)
				})
			},
			/** Let every in-flight write land before reading the store. */
			settle: async () => {
				await act(async () => {
					vi.advanceTimersByTime(1000)
				})
			},
			/** Close the panel and open it again, which is what loses the draft. */
			remount: async () => {
				view.unmount()
				const reopened = render(<OllamaProvider currentMode="act" showModelOptions={true} />)
				bump = () => act(() => reopened.rerender(<OllamaProvider currentMode="act" showModelOptions={true} />))
				await act(async () => {
					vi.advanceTimersByTime(10)
				})
			},
			/** Load another profile: the bar writes the store, then the name. */
			switchProfile: async (name: string, providerConfig: Record<string, unknown>) => {
				config = { ...providerConfig }
				activeProfile = JSON.stringify({ act: name })
				bump()
				await act(async () => {
					vi.advanceTimersByTime(150)
				})
			},
			stored: () => config,
			committed: () => selection,
		}
	}

	it("keeps a tool-result cap typed over the stored one", async () => {
		const panel = await openPanel({ maxToolResultChars: STORED_CAP })
		const cap = panel.field("Tool Results Character Cap")
		expect(cap.value).toBe(String(STORED_CAP))

		// Select-all and retype, which is what clearing the box does.
		await panel.clear(cap)
		for (const char of "32000") {
			await panel.press(cap, char)
		}

		await panel.settle()
		expect(cap.value).toBe("32000")
		expect(panel.stored().maxToolResultChars).toBe(32000)
	})

	// The report, reproduced: "I erased one char at a time from 64000, and when
	// I removed the whole thing and left it blank the Update profile button
	// disappeared" -- blank and 64000 being the same state is what a borrowed
	// global looks like from the outside. The panel showed the global setting as
	// the field's *value*, so clearing this configuration's own cap refilled the
	// box with the number being erased, and the next keystroke landed on it.
	it("does not refill a cleared cap with the global one", async () => {
		const panel = await openPanel({ maxToolResultChars: STORED_CAP })
		const cap = panel.field("Tool Results Character Cap")

		await panel.clear(cap)
		await panel.settle()

		// Cleared means "the global setting decides", which the placeholder says.
		// It must not come back as the contents of the box.
		expect(panel.stored().maxToolResultChars).toBeUndefined()
		expect(cap.value).toBe("")

		// And it must still be blank when the panel is opened again: the draft
		// that holds the typed text does not outlive the mount, so this is the
		// state the user actually comes back to.
		await panel.remount()
		expect(panel.field("Tool Results Character Cap").value).toBe("")
	})

	// The same question of the context window, which has a borrowed value of its
	// own: the legacy `ollamaApiOptionsCtxNum` settings key, kept as a migration
	// fallback for an entry that predates providers.json. The reporter's log
	// shows 110000 -- a number in no providers.json entry -- being written back
	// during profile work, which is what a borrowed value does once something
	// saves what is on screen.
	it("does not refill a cleared context window from the legacy settings key", async () => {
		const panel = await openPanel({ contextWindow: 131072 }, { ollamaApiOptionsCtxNum: "110000" })
		const window = panel.field("Model Context Window")
		expect(window.value).toBe("131072")

		await panel.clear(window)
		await panel.settle()
		expect(panel.stored().contextWindow).toBeUndefined()

		await panel.remount()
		expect(panel.field("Model Context Window").value).toBe("")
	})

	// Reported: "I changed typical_p, updated the profile, switched to a profile
	// without it and it was still there, and the profile asked me to update."
	// The draft is deliberately sticky — that is what makes a decimal typeable,
	// because it must survive the store echoing an older value back. A profile
	// load is not an echo: it is the store being replaced wholesale, and the
	// panel has to show what was loaded rather than what was typed under the
	// profile before it.
	it("drops what was typed under the previous profile", async () => {
		const panel = await openPanel({ maxToolResultChars: STORED_CAP })
		const cap = panel.field("Tool Results Character Cap")

		await panel.clear(cap)
		for (const char of "32000") {
			await panel.press(cap, char)
		}
		await panel.settle()
		expect(cap.value).toBe("32000")

		// Another profile, carrying a cap of its own. Same model, which is what
		// makes this visible: switching model already cleared the draft, so the
		// fault only showed when two profiles shared one.
		await panel.switchProfile("second", { contextWindow: 131072, maxToolResultChars: 8000 })

		expect(panel.field("Tool Results Character Cap").value).toBe("8000")
	})

	it("keeps a per-turn output cap typed over the stored one", async () => {
		const panel = await openPanel({ maxToolResultChars: STORED_CAP })
		const perTurn = panel.field("Per-Turn Max Output Tokens")

		await panel.clear(perTurn)
		for (const char of "4096") {
			await panel.press(perTurn, char)
		}

		await panel.settle()
		expect(perTurn.value).toBe("4096")
		expect((panel.committed()?.overrides as { maxTokens?: number } | undefined)?.maxTokens).toBe(4096)
	})
})
