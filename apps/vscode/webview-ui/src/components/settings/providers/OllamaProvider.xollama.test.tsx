import { render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OllamaProvider } from "./OllamaProvider"

/**
 * xOllama takes Ollama's form under its own id: it speaks Ollama's API, runs
 * on its own port (22434) beside a stock Ollama, and has no ollama.com
 * account. An empty base URL is Ollama's default port to the host, so the
 * form has to name xOllama's for it.
 */

const mocks = vi.hoisted(() => ({
	configIds: [] as string[],
	getOllamaModels: vi.fn(),
	getOllamaModelParameters: vi.fn(),
	placeholders: [] as string[],
	scope: { current: undefined as { scopeKey: string } | undefined },
	config: { current: {} as Record<string, unknown> },
	write: vi.fn(),
	fields: [] as { placeholder?: string; onChange: (value: string) => unknown }[],
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	// Ollama's legacy base URL, which xOllama must not borrow.
	useExtensionState: () => ({ apiConfiguration: { ollamaBaseUrl: "http://ollama-box:11434" } }),
}))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		getOllamaModelParameters: mocks.getOllamaModelParameters,
		getOllamaModels: mocks.getOllamaModels,
		readOllamaAccount: async () => ({ reachable: false, models: [] }),
		readOllamaCloudUsage: async () => ({ state: "unreachable", usage: [], includedExhausted: false }),
		readXollamaModelStatus: async () => ({ reachable: false }),
	},
}))
vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: (id: string) => {
		mocks.configIds.push(id)
		return { config: mocks.config.current, write: mocks.write, commitSelection: vi.fn() }
	},
	fromProtobufProviderModelOverrides: (overrides: unknown) => overrides,
}))
vi.mock("@/hooks/useProviderModelSelection", () => ({
	useProviderModelSelection: () => ({
		committedSelection: undefined,
		selectedModel: { modelId: "omni-council", modelInfo: {} },
		commitModelSelection: vi.fn(),
	}),
}))
vi.mock("@shared/proto-conversions/models/modelOverrides", () => ({
	fromProtobufModelOverrides: (overrides: unknown) => overrides,
	toProtobufModelOverrides: (overrides: unknown) => overrides,
}))
vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldChange: vi.fn(), handleModeFieldChange: vi.fn() }),
}))
vi.mock("../utils/ApiConfigurationScopeContext", () => ({ useApiConfigurationScope: () => mocks.scope.current }))
vi.mock("../utils/useProviderApiKeyField", () => ({
	useProviderApiKeyField: () => ({ savedApiKeyMask: "", handleApiKeyChange: vi.fn() }),
}))
vi.mock("../OllamaModelPicker", () => ({ default: () => <div /> }))
vi.mock("../common/DebouncedTextField", () => ({
	DebouncedTextField: (props: { placeholder?: string; onChange: (value: string) => unknown }) => {
		mocks.fields.push(props)
		return <div />
	},
}))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({
	BaseUrlField: ({ placeholder }: { placeholder?: string }) => {
		mocks.placeholders.push(placeholder ?? "")
		return <div />
	},
}))
vi.mock("../common/OllamaAccountStrip", () => ({ OllamaAccountStrip: () => <div>ollama.com account</div> }))
vi.mock("../common/RequestTimingsToggle", () => ({ RequestTimingsToggle: () => <div /> }))
vi.mock("@/components/ui/label", () => ({ Label: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))
vi.mock("@/components/ui/select", () => ({
	Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	SelectValue: () => <span />,
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
	VSCodeLink: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	VSCodeTextArea: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
	VSCodeTextField: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
}))

describe("the Ollama form for xOllama", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.configIds.length = 0
		mocks.placeholders.length = 0
		mocks.scope.current = undefined
		mocks.config.current = {}
		mocks.fields.length = 0
		mocks.write.mockResolvedValue(undefined)
		mocks.getOllamaModels.mockResolvedValue({ values: [] })
		mocks.getOllamaModelParameters.mockResolvedValue({ values: {} })
	})

	it("keeps its own settings, asks its own port, and shows no ollama.com account", async () => {
		render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		expect(mocks.configIds).toContain("xollama")
		expect(mocks.configIds).not.toContain("ollama")
		expect(mocks.placeholders).toContain("Default: http://localhost:22434")
		await waitFor(() => expect(mocks.getOllamaModels).toHaveBeenCalled())
		expect(mocks.getOllamaModels.mock.calls[0]?.[0]).toMatchObject({ value: "http://localhost:22434" })
		expect(screen.queryByText("ollama.com account")).toBeNull()
	})

	// An unticked box on an Agents tab used to read as "thinking off" while the
	// agents ran with the session's thinking: unset there means "as the session
	// has it", and the panel has to say so.
	it("says an Agents tab that does not set thinking follows the session", async () => {
		mocks.scope.current = { scopeKey: "agentsModeApiConfiguration" }
		render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		expect(screen.getByText(/Not set on this tab/)).toBeInTheDocument()
		await waitFor(() => expect(mocks.getOllamaModels).toHaveBeenCalled())
	})

	it("says nothing of the kind once the tab has an answer, or on the session's own panel", async () => {
		mocks.scope.current = { scopeKey: "agentsModeApiConfiguration" }
		mocks.config.current = { reasoning: { enabled: false } }
		const first = render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		expect(screen.queryByText(/Not set on this tab/)).not.toBeInTheDocument()
		first.unmount()

		mocks.scope.current = undefined
		mocks.config.current = {}
		render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		expect(screen.queryByText(/Not set on this tab/)).not.toBeInTheDocument()
		await waitFor(() => expect(mocks.getOllamaModels).toHaveBeenCalled())
	})

	it("is unchanged for Ollama", async () => {
		render(<OllamaProvider currentMode="act" showModelOptions />)
		expect(mocks.configIds).toContain("ollama")
		expect(mocks.placeholders).toContain("Default: http://localhost:11434")
		await waitFor(() => expect(mocks.getOllamaModels).toHaveBeenCalled())
		expect(mocks.getOllamaModels.mock.calls[0]?.[0]).toMatchObject({ value: "http://ollama-box:11434" })
		expect(screen.getByText("ollama.com account")).toBeInTheDocument()
	})

	// The model's thinking level and the thinking budget are two controls. The
	// level dropdown lists what /api/show states, and only when it states any.
	it("offers the levels the model states, beside the budget", async () => {
		mocks.config.current = { reasoning: { enabled: true } }
		mocks.getOllamaModelParameters.mockResolvedValue({
			parameters: {},
			thinkingLevels: ["low", "medium", "xhigh"],
			thinkingDefault: "medium",
		})
		render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		await waitFor(() => expect(screen.getByText("Reasoning effort")).toBeInTheDocument())
		expect(screen.getByText("Default (medium)")).toBeInTheDocument()
		expect(screen.getByText("xhigh")).toBeInTheDocument()
		expect(screen.getByText("Thinking budget")).toBeInTheDocument()
	})

	it("offers no level for a model that is only on or off", async () => {
		mocks.config.current = { reasoning: { enabled: true } }
		mocks.getOllamaModelParameters.mockResolvedValue({ parameters: {}, thinkingLevels: [] })
		render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		await waitFor(() => expect(mocks.getOllamaModelParameters).toHaveBeenCalled())
		expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument()
		expect(screen.getByText("Thinking budget")).toBeInTheDocument()
	})

	it("keeps a stored level the model does not state on screen, with a warning", async () => {
		mocks.config.current = { reasoning: { enabled: true }, sampling: { reasoningLevel: "xhigh" } }
		mocks.getOllamaModelParameters.mockResolvedValue({ parameters: {}, thinkingLevels: [] })
		render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		await waitFor(() => expect(mocks.getOllamaModelParameters).toHaveBeenCalled())
		expect(screen.getByText("Reasoning effort")).toBeInTheDocument()
		expect(screen.getByText(/does not state the level "xhigh"/)).toBeInTheDocument()
	})

	// ol-88: Done waits for what a field's onChange returns. The window's
	// returned nothing, so Done could close the panel -- and a task start --
	// before the new size reached providers.json.
	it("hands Done the context window's write to wait for", async () => {
		let land: () => void = () => {}
		mocks.write.mockReturnValue(new Promise<void>((resolve) => (land = resolve)))
		render(<OllamaProvider currentMode="act" providerId="xollama" showModelOptions />)
		await waitFor(() => expect(mocks.getOllamaModels).toHaveBeenCalled())
		const field = mocks.fields.filter((f) => f.placeholder?.startsWith("Default: 32768")).at(-1)
		const pending = field?.onChange("128000")
		expect(pending).toBeInstanceOf(Promise)
		let settled = false
		void (pending as Promise<unknown>).then(() => (settled = true))
		await Promise.resolve()
		expect(settled).toBe(false)
		land()
		await pending
		expect(mocks.write).toHaveBeenCalledWith({ contextWindow: 128000 })
	})
})
