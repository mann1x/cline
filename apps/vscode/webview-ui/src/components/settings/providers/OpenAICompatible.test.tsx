import { ApiFormat } from "@shared/proto/cline/models"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ChangeEventHandler, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAICompatibleProvider } from "./OpenAICompatible"

const mocks = vi.hoisted(() => ({
	commitSelection: vi.fn(),
	handleFieldChange: vi.fn(),
	handleModeFieldChange: vi.fn(),
	refreshOpenAiModels: vi.fn(),
	useDynamicProviderSelection: vi.fn(),
	useExtensionState: vi.fn(),
	useProviderConfig: vi.fn(),
	write: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: mocks.useExtensionState,
}))

vi.mock("@/hooks/useDynamicProviderSelection", () => ({
	useDynamicProviderSelection: mocks.useDynamicProviderSelection,
}))

vi.mock("@/hooks/useProviderConfig", () => ({
	fromProtobufProviderModelOverrides: (overrides: Record<string, unknown> | undefined) =>
		overrides ? { ...overrides } : undefined,
	useProviderConfig: mocks.useProviderConfig,
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		refreshOpenAiModels: mocks.refreshOpenAiModels,
	},
}))

vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: mocks.handleFieldChange,
		handleModeFieldChange: mocks.handleModeFieldChange,
	}),
}))

vi.mock("@radix-ui/react-tooltip", () => ({
	TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeDropdown: ({
		children,
		id,
		onChange,
		value,
		"aria-label": ariaLabel,
	}: {
		children?: ReactNode
		id?: string
		onChange?: ChangeEventHandler<HTMLSelectElement>
		value?: string
		"aria-label"?: string
	}) => (
		<select aria-label={ariaLabel} id={id} onChange={onChange} value={value}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
	VSCodeCheckbox: ({
		checked,
		children,
		onChange,
	}: {
		checked?: boolean
		children?: ReactNode
		onChange?: ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))

vi.mock("../common/ApiKeyField", () => ({
	ApiKeyField: ({
		initialValue,
		onChange,
		providerName,
	}: {
		initialValue?: string
		onChange: (value: string) => void
		providerName: string
	}) => (
		<input aria-label={`${providerName} API key`} onChange={(event) => onChange(event.target.value)} value={initialValue} />
	),
}))

vi.mock("../common/BaseUrlField", () => ({
	BaseUrlField: ({
		disabled,
		initialValue,
		label,
		onChange,
	}: {
		disabled?: boolean
		initialValue?: string
		label: string
		onChange: (value: string) => void
	}) => (
		<label>
			{label}
			<input
				aria-label={label}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				value={initialValue ?? ""}
			/>
		</label>
	),
}))

vi.mock("../common/DebouncedTextField", () => ({
	DebouncedTextField: ({
		children,
		disabled,
		initialValue,
		onChange,
		placeholder,
	}: {
		children?: ReactNode
		disabled?: boolean
		initialValue?: string
		onChange: (value: string) => void
		placeholder?: string
	}) => (
		<label>
			{children}
			<input
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				value={initialValue ?? ""}
			/>
		</label>
	),
}))

vi.mock("../common/ModelInfoView", () => ({ ModelInfoView: () => null }))
vi.mock("../ReasoningEffortSelector", () => ({ default: () => null }))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function renderProvider() {
	return render(<OpenAICompatibleProvider currentMode="act" providerId="custom-openai" showModelOptions={false} />)
}

function setCommittedSelection(overrides: Record<string, unknown>, modelInfo: Record<string, unknown> = {}) {
	mocks.useProviderConfig.mockReturnValue({
		config: {
			actSelection: {
				providerId: "custom-openai",
				modelId: "custom-model",
				modelInfo: {
					contextWindow: 128_000,
					inputPrice: 0,
					maxTokens: -1,
					outputPrice: 0,
					temperature: 0,
					tiers: [],
					...modelInfo,
				},
				overrides,
			},
			apiKeyLength: 12,
			baseUrl: "http://localhost:1234/v1",
			headers: {},
			providerId: "custom-openai",
		},
		commitSelection: mocks.commitSelection,
		write: mocks.write,
	})
}

describe("OpenAICompatibleProvider", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		mocks.commitSelection.mockResolvedValue(undefined)
		mocks.write.mockResolvedValue(undefined)
		mocks.refreshOpenAiModels.mockResolvedValue({ values: [] })
		mocks.useExtensionState.mockReturnValue({
			apiConfiguration: { azureApiVersion: "2025-04-01-preview", azureIdentity: false },
			remoteConfigSettings: undefined,
		})
		mocks.useDynamicProviderSelection.mockReturnValue({
			selectedModelId: "custom-model",
			selectedModelInfo: {
				contextWindow: 128_000,
				inputPrice: 0,
				maxTokens: -1,
				outputPrice: 0,
				temperature: 0,
			},
		})
		mocks.useProviderConfig.mockReturnValue({
			config: {
				apiKeyLength: 12,
				baseUrl: "http://localhost:1234/v1",
				headers: {},
				providerId: "custom-openai",
			},
			commitSelection: mocks.commitSelection,
			write: mocks.write,
		})
	})

	it("refreshes keyless endpoints and displays only the saved-key mask", async () => {
		renderProvider()

		await act(async () => {})

		expect(mocks.refreshOpenAiModels).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: "http://localhost:1234/v1", apiKey: "" }),
		)
		expect(screen.getByLabelText("OpenAI Compatible API key")).toHaveValue("••••••••••••")
	})

	it("persists base URL and API key edits made before config loads", async () => {
		// The initial provider-config read resolves asynchronously; edits made
		// in that window must still be written, not silently dropped.
		mocks.useProviderConfig.mockReturnValue({
			config: undefined,
			commitSelection: mocks.commitSelection,
			write: mocks.write,
		})
		renderProvider()
		await act(async () => {})

		fireEvent.change(screen.getByPlaceholderText("Enter base URL..."), {
			target: { value: "http://early.example:1234/v1" },
		})
		fireEvent.change(screen.getByLabelText("OpenAI Compatible API key"), { target: { value: "early-secret" } })

		expect(mocks.write).toHaveBeenCalledWith({ baseUrl: "http://early.example:1234/v1" })
		expect(mocks.write).toHaveBeenCalledWith({ apiKey: "early-secret" })
	})

	it("writes a newly entered API key without echoing a stored key into config", async () => {
		renderProvider()
		await act(async () => {})

		fireEvent.change(screen.getByLabelText("OpenAI Compatible API key"), { target: { value: "new-secret" } })

		expect(mocks.write).toHaveBeenCalledWith({ apiKey: "new-secret" })
	})

	it("commits ordinary model selections by ID only", async () => {
		mocks.refreshOpenAiModels.mockResolvedValue({ values: ["listed-model"] })
		renderProvider()
		await act(async () => {})

		fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "listed-model" } })

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "listed-model",
		})
	})

	it("carries the current user-authored overrides when only the model id changes", async () => {
		mocks.refreshOpenAiModels.mockResolvedValue({ values: ["custom-model", "listed-model"] })
		setCommittedSelection({ contextWindow: 1_300_000, inputPrice: 3, outputPrice: 15 })
		renderProvider()
		await act(async () => {})

		fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "listed-model" } })

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "listed-model",
			overrides: { contextWindow: 1_300_000, inputPrice: 3, outputPrice: 15 },
		})
	})

	it("keeps carried overrides as the base for edits made right after a model-id change", async () => {
		mocks.refreshOpenAiModels.mockResolvedValue({ values: ["custom-model", "listed-model"] })
		setCommittedSelection({ inputPrice: 3, outputPrice: 15 })
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "listed-model" } })
		// The window edit writes providers.json first and commits the override
		// after, so the commit lands a microtask later than the other fields'.
		await act(async () => {
			fireEvent.change(screen.getByLabelText("Model Context Window"), { target: { value: "64000" } })
		})

		expect(mocks.commitSelection).toHaveBeenLastCalledWith("act", {
			providerId: "custom-openai",
			modelId: "listed-model",
			overrides: { inputPrice: 3, outputPrice: 15, contextWindow: 64_000 },
		})
	})

	it("does not leak a pending Act model id into Plan edits after a mode switch", async () => {
		mocks.refreshOpenAiModels.mockResolvedValue({ values: ["custom-model", "listed-model"] })
		// The Act model-id commit stays unresolved across the mode switch.
		const actCommit = deferred<void>()
		mocks.commitSelection.mockReturnValueOnce(actCommit.promise)
		mocks.useProviderConfig.mockReturnValue({
			config: {
				actSelection: {
					providerId: "custom-openai",
					modelId: "custom-model",
					modelInfo: {
						contextWindow: 128_000,
						inputPrice: 0,
						maxTokens: -1,
						outputPrice: 0,
						temperature: 0,
						tiers: [],
					},
					overrides: { inputPrice: 3 },
				},
				planSelection: {
					providerId: "custom-openai",
					modelId: "plan-model",
					modelInfo: {
						contextWindow: 128_000,
						inputPrice: 0,
						maxTokens: -1,
						outputPrice: 0,
						temperature: 0,
						tiers: [],
					},
					overrides: { outputPrice: 5 },
				},
				apiKeyLength: 12,
				baseUrl: "http://localhost:1234/v1",
				headers: {},
				providerId: "custom-openai",
			},
			commitSelection: mocks.commitSelection,
			write: mocks.write,
		})
		const view = render(<OpenAICompatibleProvider currentMode="act" providerId="custom-openai" showModelOptions={false} />)
		await act(async () => {})

		fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "listed-model" } })

		view.rerender(<OpenAICompatibleProvider currentMode="plan" providerId="custom-openai" showModelOptions={false} />)
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))
		await act(async () => {
			fireEvent.change(screen.getByLabelText("Model Context Window"), { target: { value: "64000" } })
		})

		expect(mocks.commitSelection).toHaveBeenLastCalledWith("plan", {
			providerId: "custom-openai",
			modelId: "plan-model",
			overrides: { outputPrice: 5, contextWindow: 64_000 },
		})

		await act(async () => {
			actCommit.resolve(undefined)
		})
	})

	it("keeps a mode's pending overrides across a round trip to the other mode", async () => {
		// The first Act override commit stays unresolved across both mode
		// switches, so Act's accumulator can never reseed from read-back.
		const actCommit = deferred<void>()
		mocks.commitSelection.mockReturnValueOnce(actCommit.promise)
		mocks.useProviderConfig.mockReturnValue({
			config: {
				actSelection: {
					providerId: "custom-openai",
					modelId: "custom-model",
					modelInfo: {
						contextWindow: 128_000,
						inputPrice: 0,
						maxTokens: -1,
						outputPrice: 0,
						temperature: 0,
						tiers: [],
					},
					overrides: { inputPrice: 3 },
				},
				planSelection: {
					providerId: "custom-openai",
					modelId: "plan-model",
					modelInfo: {
						contextWindow: 128_000,
						inputPrice: 0,
						maxTokens: -1,
						outputPrice: 0,
						temperature: 0,
						tiers: [],
					},
					overrides: { outputPrice: 5 },
				},
				apiKeyLength: 12,
				baseUrl: "http://localhost:1234/v1",
				headers: {},
				providerId: "custom-openai",
			},
			commitSelection: mocks.commitSelection,
			write: mocks.write,
		})
		const view = render(<OpenAICompatibleProvider currentMode="act" providerId="custom-openai" showModelOptions={false} />)
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Model Context Window"), { target: { value: "64000" } })

		view.rerender(<OpenAICompatibleProvider currentMode="plan" providerId="custom-openai" showModelOptions={false} />)
		await act(async () => {})
		view.rerender(<OpenAICompatibleProvider currentMode="act" providerId="custom-openai" showModelOptions={false} />)
		await act(async () => {})

		fireEvent.change(screen.getByLabelText("Output Price / 1M tokens"), { target: { value: "20" } })

		expect(mocks.commitSelection).toHaveBeenLastCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: { inputPrice: 3, contextWindow: 64_000, outputPrice: 20 },
		})

		await act(async () => {
			actCommit.resolve(undefined)
		})
	})

	it("persists only the edited vision field while preserving existing overrides", async () => {
		setCommittedSelection({
			apiFormat: ApiFormat.OPENAI_RESPONSES,
			cacheReadsPrice: 0.5,
			cacheWritesPrice: 0.75,
			capabilities: ["tools", "streaming"],
			outputPrice: 2,
		})
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.click(screen.getByRole("checkbox", { name: "Supports Images" }))

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: {
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				cacheReadsPrice: 0.5,
				cacheWritesPrice: 0.75,
				capabilities: ["tools", "streaming"],
				outputPrice: 2,
				supportsVision: true,
			},
		})
	})

	it("persists one edit without adding resolved defaults", async () => {
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Input Price / 1M tokens"), { target: { value: "1.25" } })

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: { inputPrice: 1.25 },
		})
	})

	it.each([
		["Model Context Window", "contextWindow", "64000", 64_000],
		["Output Price / 1M tokens", "outputPrice", "2.5", 2.5],
	] as const)("maps %s only to the %s override", async (label, key, input, expected) => {
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		// Awaited for both rows: the context-window row commits after its
		// providers.json write, and awaiting a synchronous commit costs the
		// price row nothing.
		await act(async () => {
			fireEvent.change(screen.getByLabelText(label), { target: { value: input } })
		})

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: { [key]: expected },
		})
	})

	// The window is the number OutputBudgetField, the tool-result cap and
	// compaction are all read against, and they read it from providers.json --
	// `config.contextWindow` -- not from the model override this panel wrote.
	// So on opencoti and llama.cpp the operator typed a window, the panel
	// showed it, and the output budget's slider never appeared because the
	// value it sizes against was never written. Ollama writes both and is why
	// its slider works. Sequenced, not fired together, for the reason
	// OllamaProvider spells out: the selection commit rebuilds the entry from a
	// fresh read, so issuing them side by side lets it republish the old
	// number.
	it("writes the context window to providers.json as well as the override", async () => {
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		await act(async () => {
			fireEvent.change(screen.getByLabelText("Model Context Window"), { target: { value: "64000" } })
		})

		expect(mocks.write).toHaveBeenCalledWith({ contextWindow: 64_000 })
		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: { contextWindow: 64_000 },
		})
		expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(mocks.commitSelection.mock.invocationCallOrder[0])
	})

	// Clearing the box has to clear the stored window too, or the budget keeps
	// sizing against a number the panel no longer shows. Zero is how the wire
	// says "unset"; the host drops the key rather than storing a window of
	// nothing.
	it("clears the stored context window when the box is emptied", async () => {
		setCommittedSelection({ contextWindow: 64_000 })
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		await act(async () => {
			fireEvent.change(screen.getByLabelText("Model Context Window"), { target: { value: "" } })
		})

		expect(mocks.write).toHaveBeenCalledWith({ contextWindow: 0 })
	})

	it("clears one override while preserving unrelated fields", async () => {
		setCommittedSelection({
			apiFormat: ApiFormat.OPENAI_RESPONSES,
			capabilities: ["tools", "streaming"],
			inputPrice: 1.25,
		})
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Input Price / 1M tokens"), { target: { value: "" } })

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: {
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				capabilities: ["tools", "streaming"],
			},
		})
	})

	it("preserves apiFormat while editing pricing", async () => {
		setCommittedSelection({
			apiFormat: ApiFormat.OPENAI_RESPONSES,
			capabilities: ["tools"],
		})
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Input Price / 1M tokens"), { target: { value: "1.25" } })

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: {
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				capabilities: ["tools"],
				inputPrice: 1.25,
			},
		})
	})

	it("sends an empty replacement when the final override is cleared", async () => {
		setCommittedSelection({ inputPrice: 0.4 })
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Input Price / 1M tokens"), { target: { value: "" } })

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: {},
		})
	})

	// Both fields used to sit in Model Configuration and both wrote a store the
	// request reads, so which one the server saw came down to the order the body
	// was assembled in. The sampler below owns the temperature now, and the
	// automatic output budget owns the cap.
	it("leaves the parameters that have an owner elsewhere out of Model Configuration", async () => {
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		expect(screen.queryByLabelText("Temperature")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Max Output Tokens")).not.toBeInTheDocument()
	})

	it("shows invalid-number feedback without committing", async () => {
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Model Context Window"), { target: { value: "80000o" } })

		expect(screen.getByRole("alert")).toHaveTextContent("Model Context Window must be a valid number.")
		expect(mocks.commitSelection).not.toHaveBeenCalled()
	})

	it("merges rapid edits using the pending override set", async () => {
		renderProvider()
		await act(async () => {})
		fireEvent.click(screen.getByText("Model Configuration"))

		fireEvent.change(screen.getByLabelText("Output Price / 1M tokens"), { target: { value: "2.5" } })
		fireEvent.change(screen.getByLabelText("Input Price / 1M tokens"), { target: { value: "1.5" } })

		expect(mocks.commitSelection).toHaveBeenLastCalledWith("act", {
			providerId: "custom-openai",
			modelId: "custom-model",
			overrides: { inputPrice: 1.5, outputPrice: 2.5 },
		})
	})

	it("debounces model refreshes triggered by base URL edits", async () => {
		vi.useFakeTimers()
		renderProvider()
		await act(async () => {})
		expect(mocks.refreshOpenAiModels).toHaveBeenCalledTimes(1)

		fireEvent.change(screen.getByDisplayValue("http://localhost:1234/v1"), {
			target: { value: "http://localhost:5678/v1" },
		})
		expect(mocks.refreshOpenAiModels).toHaveBeenCalledTimes(1)

		await act(async () => {
			vi.advanceTimersByTime(499)
		})
		expect(mocks.refreshOpenAiModels).toHaveBeenCalledTimes(1)

		await act(async () => {
			vi.advanceTimersByTime(1)
		})
		expect(mocks.refreshOpenAiModels).toHaveBeenCalledTimes(2)
	})

	it("ignores a stale model-list response", async () => {
		vi.useFakeTimers()
		const oldRequest = deferred<{ values: string[] }>()
		const newRequest = deferred<{ values: string[] }>()
		mocks.refreshOpenAiModels.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
		renderProvider()

		fireEvent.change(screen.getByDisplayValue("http://localhost:1234/v1"), {
			target: { value: "http://localhost:5678/v1" },
		})
		await act(async () => {
			vi.advanceTimersByTime(500)
		})

		await act(async () => {
			newRequest.resolve({ values: ["new-model"] })
		})
		expect(screen.getByRole("option", { name: "new-model" })).toBeInTheDocument()

		await act(async () => {
			oldRequest.resolve({ values: ["stale-model"] })
		})
		expect(screen.queryByRole("option", { name: "stale-model" })).not.toBeInTheDocument()
		expect(screen.getByRole("option", { name: "new-model" })).toBeInTheDocument()
	})

	it("cancels a pending debounced refresh when unmounted", async () => {
		vi.useFakeTimers()
		const view = renderProvider()
		await act(async () => {})

		fireEvent.change(screen.getByDisplayValue("http://localhost:1234/v1"), {
			target: { value: "http://localhost:5678/v1" },
		})
		view.unmount()
		await act(async () => {
			vi.advanceTimersByTime(500)
		})

		expect(mocks.refreshOpenAiModels).toHaveBeenCalledTimes(1)
	})

	it("restores Azure settings and remote-config locks", async () => {
		mocks.useExtensionState.mockReturnValue({
			apiConfiguration: { azureApiVersion: "2025-04-01-preview", azureIdentity: true },
			remoteConfigSettings: {
				azureApiVersion: "2025-04-01-preview",
				openAiBaseUrl: "https://managed.example/v1",
				openAiHeaders: { "x-managed": "true" },
			},
		})
		renderProvider()
		await act(async () => {})

		expect(screen.getByDisplayValue("http://localhost:1234/v1")).toBeDisabled()
		expect(screen.getByRole("button", { name: "Add Header" })).toBeDisabled()
		expect(screen.getByLabelText("Set Azure API version")).toBeDisabled()
		expect(screen.getByRole("checkbox", { name: "Use Azure Identity Authentication" })).toBeChecked()
	})

	it("writes editable Azure settings through the legacy handlers", async () => {
		renderProvider()
		await act(async () => {})

		fireEvent.change(screen.getByLabelText("Set Azure API version"), { target: { value: "2026-01-01" } })
		fireEvent.click(screen.getByRole("checkbox", { name: "Use Azure Identity Authentication" }))

		expect(mocks.handleFieldChange).toHaveBeenCalledWith("azureApiVersion", "2026-01-01")
		expect(mocks.handleFieldChange).toHaveBeenCalledWith("azureIdentity", true)
	})

	// Ruled 2026-09-25, for the llama.cpp and opencoti forms alike: a window
	// below the fixed price plus the output room is warned about under the box.
	for (const providerId of ["llamacpp", "opencoti"]) {
		it(`warns on ${providerId} when the window is below the minimum`, async () => {
			mocks.useDynamicProviderSelection.mockReturnValue({
				selectedModelId: "custom-model",
				selectedModelInfo: { contextWindow: 16_384, inputPrice: 0, maxTokens: -1, outputPrice: 0, temperature: 0 },
			})
			render(<OpenAICompatibleProvider currentMode="act" providerId={providerId} showModelOptions={false} />)
			await act(async () => {})

			expect(screen.getByTestId("context-minimum-warning").textContent).toMatch(
				/^16,384 is below the [\d,]+ this profile needs .*output room 12,288\)\. Turns will be cut short or refused\.$/,
			)
		})

		it(`says nothing on ${providerId} when the window holds a turn`, async () => {
			mocks.useDynamicProviderSelection.mockReturnValue({
				selectedModelId: "custom-model",
				selectedModelInfo: { contextWindow: 262_144, inputPrice: 0, maxTokens: -1, outputPrice: 0, temperature: 0 },
			})
			render(<OpenAICompatibleProvider currentMode="act" providerId={providerId} showModelOptions={false} />)
			await act(async () => {})

			expect(screen.queryByTestId("context-minimum-warning")).toBeNull()
		})
	}
})
