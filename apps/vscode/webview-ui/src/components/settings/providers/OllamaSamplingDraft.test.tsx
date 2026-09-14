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
	handleApiKeyChange: vi.fn(),
	handleFieldChange: vi.fn(),
	handleModeFieldChange: vi.fn(),
	readConfig: vi.fn(),
	write: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: {}, maxToolResultChars: undefined }),
}))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { getOllamaModelParameters: mocks.getOllamaModelParameters },
}))
vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: mocks.readConfig(), write: mocks.write, commitSelection: mocks.commitSelection }),
	fromProtobufProviderModelOverrides: () => undefined,
}))
vi.mock("@/hooks/useProviderModelSelection", () => ({
	useProviderModelSelection: () => ({
		committedSelection: undefined,
		selectedModel: { modelId: "qwen3:4b", modelInfo: {} },
		commitModelSelection: vi.fn(),
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
	})

	/** Render with a live store, and hand back the field named `label`. */
	async function openSampling(label: string, stored: Record<string, unknown>) {
		let sampling = { ...stored }
		let bump = () => {}
		mocks.readConfig.mockImplementation(() => ({ sampling }))
		mocks.write.mockImplementation(async (patch: { sampling?: Record<string, unknown> }) => {
			if (patch.sampling) {
				sampling = { ...patch.sampling }
				bump()
			}
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
		return { field, type, read: () => sampling }
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

	it("lets a field be cleared", async () => {
		const { field, type, read } = await openSampling("repeat_penalty", { repeatPenalty: 1.1 })

		await type("")

		expect(field.value).toBe("")
		expect(read().repeatPenalty).toBeUndefined()
	})
})
