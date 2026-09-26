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
	},
}))
vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: (id: string) => {
		mocks.configIds.push(id)
		return { config: {}, write: vi.fn(), commitSelection: vi.fn() }
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
vi.mock("../utils/ApiConfigurationScopeContext", () => ({ useApiConfigurationScope: () => undefined }))
vi.mock("../utils/useProviderApiKeyField", () => ({
	useProviderApiKeyField: () => ({ savedApiKeyMask: "", handleApiKeyChange: vi.fn() }),
}))
vi.mock("../OllamaModelPicker", () => ({ default: () => <div /> }))
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

	it("is unchanged for Ollama", async () => {
		render(<OllamaProvider currentMode="act" showModelOptions />)
		expect(mocks.configIds).toContain("ollama")
		expect(mocks.placeholders).toContain("Default: http://localhost:11434")
		await waitFor(() => expect(mocks.getOllamaModels).toHaveBeenCalled())
		expect(mocks.getOllamaModels.mock.calls[0]?.[0]).toMatchObject({ value: "http://ollama-box:11434" })
		expect(screen.getByText("ollama.com account")).toBeInTheDocument()
	})
})
