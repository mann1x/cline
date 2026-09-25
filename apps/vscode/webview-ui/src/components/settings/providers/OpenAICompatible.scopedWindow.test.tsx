import { NODE_MODEL_ID, NODE_WINDOW_CASES } from "@shared/__tests__/scoped-context-window.fixtures"
import { openAiModelInfoSafeDefaults } from "@shared/api"
import { scopedContextWindow, scopedProviderConfigFromProfile } from "@shared/api-config-snapshot"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetProviderConfigEntries } from "@/hooks/useProviderConfig"
import { type ApiConfigurationScope, ApiConfigurationScopeContext } from "../utils/ApiConfigurationScopeContext"
import { OpenAICompatibleProvider } from "./OpenAICompatible"

// pandorum, 2026-09-25: Agents -> Node1 on opencoti. The box said 128000, the
// node's snapshot held 65536, and the agents ran at 256000. The box was showing
// `openAiModelInfoSafeDefaults` -- a scoped selection carries no model info, so
// the panel fell back to the safe default whatever was stored -- and because
// the echo guard compared against that same default, typing 128000 saved
// nothing. These run the real `useProviderConfig` inside a real scope, so what
// is asserted is what the Agents tab renders from its stored snapshot.

const mocks = vi.hoisted(() => ({
	readProviderConfig: vi.fn(),
	refreshOpenAiModels: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: { actModeApiProvider: "opencoti" }, remoteConfigSettings: undefined }),
}))

// The fallback a scoped selection lands on, exactly as the real hook resolves
// it for a provider with no legacy model-info field.
vi.mock("@/hooks/useDynamicProviderSelection", () => ({
	useDynamicProviderSelection: () => ({ selectedModelId: "", selectedModelInfo: openAiModelInfoSafeDefaults }),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		readProviderConfig: mocks.readProviderConfig,
		refreshOpenAiModels: mocks.refreshOpenAiModels,
	},
}))

vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldChange: vi.fn(), handleModeFieldChange: vi.fn() }),
}))

vi.mock("@radix-ui/react-tooltip", () => ({
	TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/tooltip", () => ({ Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</> }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
	VSCodeCheckbox: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
	VSCodeDropdown: ({ children }: { children?: ReactNode }) => <select>{children}</select>,
	VSCodeOption: ({ children }: { children?: ReactNode }) => <option>{children}</option>,
}))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => null }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => null }))
vi.mock("../common/SamplingSection", () => ({ SamplingSection: () => null }))
vi.mock("../common/ThinkingBudgetField", () => ({ ThinkingBudgetField: () => null }))
vi.mock("../common/RequestTimingsToggle", () => ({ RequestTimingsToggle: () => null }))
vi.mock("../common/DebouncedTextField", () => ({
	DebouncedTextField: ({
		children,
		initialValue,
		onChange,
		placeholder,
	}: {
		children?: ReactNode
		initialValue?: string
		onChange: (value: string) => void
		placeholder?: string
	}) => (
		<label>
			{children}
			<input onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={initialValue ?? ""} />
		</label>
	),
}))
// What the model summary would print as "Context:", surfaced as text.
vi.mock("../common/ModelInfoView", () => ({
	ModelInfoView: ({ modelInfo }: { modelInfo?: { contextWindow?: number } }) => (
		<div data-testid="model-info-context">
			{modelInfo?.contextWindow === undefined ? "" : String(modelInfo.contextWindow)}
		</div>
	),
	ModelCapabilityRows: () => null,
}))

function renderScoped(providerSettings: Record<string, unknown>) {
	const writeProviderSettings = vi.fn().mockResolvedValue(undefined)
	const commitModelSelection = vi.fn().mockResolvedValue(undefined)
	const scope: ApiConfigurationScope = {
		ownsProviderSettings: true,
		scopeKey: "agents",
		providerSettings,
		writeProviderSettings,
		commitModelSelection,
		save: vi.fn().mockResolvedValue(undefined),
	}
	render(
		<ApiConfigurationScopeContext.Provider value={scope}>
			<OpenAICompatibleProvider currentMode="act" providerId="opencoti" showModelOptions />
		</ApiConfigurationScopeContext.Provider>,
	)
	return { writeProviderSettings, commitModelSelection }
}

const windowBox = () => screen.getByLabelText("Model Context Window") as HTMLInputElement

describe("the Model Context Window on a scoped tab", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		__resetProviderConfigEntries()
		// The shared providers.json entry, which a scoped tab must not read.
		mocks.readProviderConfig.mockResolvedValue({ providerId: "opencoti", contextWindow: 256_000 })
		mocks.refreshOpenAiModels.mockResolvedValue({ values: [] })
	})

	// The half of the contract the host suite does not cover: the host asserts
	// it resolves `scopedContextWindow` of these snapshots, this asserts the tab
	// shows it. Same fixtures on both sides.
	it.each(NODE_WINDOW_CASES.map((c) => [c.label, c] as const))("shows the stored %s", async (_label, windowCase) => {
		renderScoped(windowCase.providerConfig)
		await act(async () => {})

		const shown = scopedContextWindow(windowCase.providerConfig)
		expect(shown).toBe(windowCase.expected)
		expect(windowBox().value).toBe(shown === undefined ? "" : String(shown))
		expect(screen.getByTestId("model-info-context").textContent).toBe(shown === undefined ? "" : String(shown))
	})

	it("shows 65536 when 65536 is stored, not the 128000 default", async () => {
		renderScoped({ selectedModelId: NODE_MODEL_ID, contextWindow: 65_536 })
		await act(async () => {})

		expect(windowBox().value).toBe("65536")
		expect(screen.getByTestId("model-info-context").textContent).toBe("65536")
	})

	// Nothing stored is not 128000. The box is empty and says what happens.
	it("shows an empty box with a placeholder when the tab names no window", async () => {
		renderScoped({ selectedModelId: NODE_MODEL_ID })
		await act(async () => {})

		expect(windowBox().value).toBe("")
		expect(windowBox().placeholder).not.toContain(String(openAiModelInfoSafeDefaults.contextWindow))
		expect(windowBox().placeholder).toMatch(/not set/i)
		expect(screen.getByTestId("model-info-context").textContent).toBe("")
	})

	// The echo guard compared the typed value against the displayed default,
	// so the one number the default happened to equal could not be saved.
	it("saves 128000 typed over a stored 65536", async () => {
		const { writeProviderSettings, commitModelSelection } = renderScoped({
			selectedModelId: NODE_MODEL_ID,
			contextWindow: 65_536,
		})
		await act(async () => {})

		await act(async () => {
			fireEvent.change(windowBox(), { target: { value: "128000" } })
		})

		expect(writeProviderSettings).toHaveBeenCalledWith({ contextWindow: 128_000 })
		expect(commitModelSelection).toHaveBeenCalledWith({
			modelId: NODE_MODEL_ID,
			overrides: { contextWindow: 128_000 },
		})
	})

	it("saves 128000 typed into an empty box", async () => {
		const { writeProviderSettings } = renderScoped({ selectedModelId: NODE_MODEL_ID })
		await act(async () => {})

		await act(async () => {
			fireEvent.change(windowBox(), { target: { value: "128000" } })
		})

		expect(writeProviderSettings).toHaveBeenCalledWith({ contextWindow: 128_000 })
	})

	it("does not rewrite the stored value when it is typed again", async () => {
		const { writeProviderSettings, commitModelSelection } = renderScoped({
			selectedModelId: NODE_MODEL_ID,
			contextWindow: 65_536,
		})
		await act(async () => {})

		await act(async () => {
			fireEvent.change(windowBox(), { target: { value: "65536" } })
		})

		expect(writeProviderSettings).not.toHaveBeenCalled()
		expect(commitModelSelection).not.toHaveBeenCalled()
	})

	// A profile files its overrides as `modelOverrides`; loaded into Node1 they
	// become the tab's own. Also read as stored by a build that predates the
	// mapping, which copied the profile's config verbatim.
	it.each([
		["as a load now stores it", scopedProviderConfigFromProfile({ modelOverrides: { contextWindow: 65_536 } })],
		["as an older load stored it", { modelOverrides: { contextWindow: 65_536 } }],
	])("shows a loaded profile's modelOverrides window %s", async (_label, providerConfig) => {
		renderScoped({ ...providerConfig, selectedModelId: NODE_MODEL_ID })
		await act(async () => {})

		expect(windowBox().value).toBe("65536")
	})
})
