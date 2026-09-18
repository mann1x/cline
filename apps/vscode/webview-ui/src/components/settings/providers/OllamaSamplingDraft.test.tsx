import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OllamaProvider } from "./OllamaProvider"

/**
 * Typing a decimal into the sampling fields.
 *
 * Each one commits through a 100ms debounce and then round-trips back as
 * `initialValue`, so the field's contents get written twice: once by the user,
 * once by the echo. Reported from the panel: `0.0` could not be entered into
 * temperature, min_p, repeat_penalty, presence_penalty or frequency_penalty,
 * and "if I go very fast it accepts it" — the shape of a race rather than of a
 * rejected value.
 *
 * The echo is the half the component cannot see on its own, so the store here
 * is a real one: `write` lands in `config.sampling` and re-renders.
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
		// The account strip under the picker reads this on mount. It renders
		// nothing for an unreachable server, which is what these tests want.
		readOllamaAccount: async () => ({ reachable: false, models: [] }),
	},
}))
vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: mocks.readConfig(), write: mocks.write, commitSelection: mocks.commitSelection }),
	fromProtobufProviderModelOverrides: () => undefined,
}))
vi.mock("@/hooks/useProviderModelSelection", () => ({
	useProviderModelSelection: () => ({
		committedSelection: undefined,
		selectedModel: { modelId: "qwen3:4b", modelInfo: {} },
		commitModelSelection: mocks.commitModelSelection,
	}),
}))
vi.mock("@shared/proto-conversions/models/modelOverrides", () => ({
	fromProtobufModelOverrides: () => undefined,
	toProtobufModelOverrides: () => undefined,
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

// `DebouncedTextField` is the wrapper under test, so the toolkit field it wraps
// is a real input here rather than a mock of the whole thing.
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

describe("typing a decimal into an Ollama sampling field", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers({ shouldAdvanceTime: true })
		mocks.getOllamaModelParameters.mockResolvedValue({ values: {} })
		mocks.getOllamaModels.mockResolvedValue({ values: ["qwen3:4b"] })
		mocks.readExtensionState.mockReturnValue({ apiConfiguration: {}, maxToolResultChars: undefined })
		mocks.commitModelSelection.mockResolvedValue(undefined)
	})

	/** Render with a live store, and hand back the field named `label`. */
	async function openSampling(label: string, stored: Record<string, unknown>, rest: Record<string, unknown> = {}) {
		let config: Record<string, unknown> = { ...rest, sampling: { ...stored } }
		let bump = () => {}
		mocks.readConfig.mockImplementation(() => config)
		mocks.write.mockImplementation(async (patch: Record<string, unknown>) => {
			// The store the panel is really writing to: a patch lands, and the
			// new value comes back as `initialValue` on the next render.
			config = { ...config, ...patch }
			if (patch.sampling !== undefined) {
				config.sampling = { ...(patch.sampling as Record<string, unknown>) }
			}
			for (const key of ["contextWindow", "maxToolResultChars"] as const) {
				if (typeof config[key] === "number" && (config[key] as number) <= 0) {
					delete config[key]
				}
			}
			bump()
		})
		const view = render(<OllamaProvider currentMode="act" showModelOptions={true} />)
		bump = () => act(() => view.rerender(<OllamaProvider currentMode="act" showModelOptions={true} />))
		await act(async () => {
			fireEvent.click(screen.getByText("Advanced"))
		})
		const field = screen.getByLabelText(label) as HTMLInputElement
		/** One keystroke, then the debounce and whatever the store echoes back. */
		const type = async (text: string) => {
			await act(async () => {
				fireEvent.change(field, { target: { value: text } })
			})
			await act(async () => {
				vi.advanceTimersByTime(150)
			})
		}
		/**
		 * One keystroke, as a keyboard makes it.
		 *
		 * The new value is built from what the field currently holds rather
		 * than passed in whole, because that is the difference between a test
		 * and the bug: if the echo has refilled the box behind the user, the
		 * next character lands on the refilled text.
		 */
		const press = async (char: string) => {
			await act(async () => {
				fireEvent.change(field, { target: { value: field.value + char } })
			})
			await act(async () => {
				vi.advanceTimersByTime(150)
			})
		}
		return { field, type, press, read: () => (config.sampling ?? {}) as Record<string, unknown> }
	}

	it("keeps the decimal when the store echoes a shorter rendering back", async () => {
		// `String(0)` is "0", so a committed zero renders two characters shorter
		// than what was typed. The field must not take the echo.
		const { field, type, read } = await openSampling("temperature", { temperature: 1 })

		await type("0")
		await type("0.")
		await type("0.0")

		expect(field.value).toBe("0.0")
		expect(read().temperature).toBe(0)
	})

	// Every field the panel was reported broken on, and `top_p`, which was
	// reported working — it is in here because "top_p is fine" was a timing
	// accident rather than a difference in the field, and a test that only
	// covered the ones that failed would enshrine that.
	it.each([
		["temperature", 1],
		["min_p", 0.05],
		["top_p", 0.9],
		["repeat_penalty", 1.1],
		["presence_penalty", 1.5],
		["frequency_penalty", 0.5],
	])("can type 0.0 into %s", async (label, before) => {
		const stored: Record<string, unknown> = {
			temperature: "temperature",
			min_p: "minP",
			top_p: "topP",
			repeat_penalty: "repeatPenalty",
			presence_penalty: "presencePenalty",
			frequency_penalty: "frequencyPenalty",
		}
		const { field, type, read } = await openSampling(label, { [stored[label] as string]: before })

		await type("0")
		await type("0.")
		await type("0.0")

		expect(field.value).toBe("0.0")
		expect(read()[stored[label] as string]).toBe(0)
	})

	/**
	 * The audit, as a test.
	 *
	 * Every editable number in this panel falls back to something when it holds
	 * nothing -- the stored value, a borrowed global, or a hard-coded default --
	 * and every one of them commits through the same debounce and echo. So the
	 * question for all of them is the same: can the box be emptied and retyped?
	 * The tool-result cap is the one that was reported ("I have it at 64000 and
	 * I cannot change it"), and it is the worst of them because clearing it
	 * clears this configuration's own value and the panel then borrows the
	 * global one and puts it straight back.
	 */
	it.each([
		["Model Context Window", "40000"],
		["Tool Results Character Cap", "32000"],
		["Per-Turn Max Output Tokens", "8000"],
		["Request Timeout (ms)", "600000"],
	])("can empty %s and type a new number into it", async (label, typed) => {
		// The reported state: the cap is set globally, not on this
		// configuration, so the box shows a borrowed 64000 and clearing it
		// clears nothing — the global comes straight back.
		mocks.readExtensionState.mockReturnValue({ apiConfiguration: {}, maxToolResultChars: 64000 })
		const { field, type, press } = await openSampling(label, {}, { contextWindow: 131072 })

		await type("")
		expect(field.value).toBe("")

		for (const char of typed) {
			await press(char)
		}
		expect(field.value).toBe(typed)
	})

	/**
	 * And the number has to be *saved*, not merely displayed.
	 *
	 * The check above asserts `field.value`, which is the draft -- the fix that
	 * stopped the box refilling itself. It says nothing about whether anything
	 * was written, so a cap that types cleanly and persists nothing passes it.
	 * That is the state the panel was actually in: the report came back as "it
	 * is still 64000 and I cannot change it" after the typing was fixed,
	 * because the value never reached providers.json and the next read
	 * borrowed the global again.
	 */
	it("writes the tool-result cap that was typed, not just shows it", async () => {
		mocks.readExtensionState.mockReturnValue({ apiConfiguration: {}, maxToolResultChars: 64000 })
		const { type, press } = await openSampling("Tool Results Character Cap", {}, { contextWindow: 131072 })

		await type("")
		for (const char of "32000") {
			await press(char)
		}
		await act(async () => {
			await Promise.resolve()
		})

		const written = mocks.write.mock.calls.map(([patch]: [Record<string, unknown>]) => patch)
		expect(written.some((patch) => patch.maxToolResultChars === 32000)).toBe(true)
	})

	/**
	 * The context window writes twice, and the order matters.
	 *
	 * `commitModelSelection` rebuilds the provider entry from a fresh read of
	 * providers.json and then republishes it. Issued alongside the context
	 * window write rather than after it, it could rebuild from a record that
	 * did not carry the new window yet, and the republished entry put the old
	 * number back -- with the panel then matching what was stored, so no
	 * unsaved change was reported either.
	 */
	it("does not commit the model selection until the window has been written", async () => {
		let writeResolved = false
		let commitSawWrite: boolean | undefined
		mocks.commitModelSelection.mockImplementation(async () => {
			commitSawWrite = writeResolved
		})
		const { type } = await openSampling("Model Context Window", {}, { contextWindow: 64000 })
		mocks.write.mockImplementation(async () => {
			// One turn of the microtask queue, which is all a real RPC needs to
			// let a second one overtake it.
			await Promise.resolve()
			await Promise.resolve()
			writeResolved = true
		})

		await type("40000")
		await act(async () => {
			await Promise.resolve()
		})

		expect(mocks.commitModelSelection).toHaveBeenCalled()
		expect(commitSawWrite).toBe(true)
	})

	it("lets a field be cleared", async () => {
		const { field, type, read } = await openSampling("repeat_penalty", { repeatPenalty: 1.1 })

		await type("")

		expect(field.value).toBe("")
		expect(read().repeatPenalty).toBeUndefined()
	})
})
