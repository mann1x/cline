import type { ModelInfo } from "@shared/api"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ useProviderModels: vi.fn() }))

vi.mock("@/hooks/useProviderModels", () => ({ useProviderModels: mocks.useProviderModels }))
vi.mock("../ModelDescriptionMarkdown", () => ({ ModelDescriptionMarkdown: () => null }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeDropdown: ({ children }: { children?: React.ReactNode }) => <select>{children}</select>,
	VSCodeOption: ({ children }: { children?: React.ReactNode }) => <option>{children}</option>,
}))

import { ModelCapabilityRows, ModelInfoView } from "./ModelInfoView"

/** A local model: no prices, no tiers, nothing to bill. */
const localModel: ModelInfo = {
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: false,
} as ModelInfo

describe("ModelInfoView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.useProviderModels.mockReturnValue({ models: {} })
	})

	it("shows its own Advanced section when it owns the capability rows", () => {
		render(<ModelInfoView modelInfo={localModel} selectedModelId="local-model" />)

		expect(screen.getByText("Advanced")).toBeTruthy()
		expect(screen.getByText("Images")).toBeTruthy()
		expect(screen.getByText("Prompt Caching")).toBeTruthy()
	})

	// opencoti and llama.cpp render the sampler's "Advanced" and then this one
	// directly underneath, so the panel showed the word twice with different
	// contents under each. The capability rows move into the sampler's section;
	// on a local model that empties this one completely, and an empty
	// collapsible is a header promising content that is not there.
	it("renders no Advanced section at all once the capabilities move and nothing else is billable", () => {
		render(<ModelInfoView capabilitiesElsewhere modelInfo={localModel} selectedModelId="local-model" />)

		expect(screen.queryByText("Advanced")).toBeNull()
		expect(screen.queryByText("Images")).toBeNull()
	})

	// The same form serves a paid OpenAI-compatible endpoint, where the section
	// still carries cache pricing. Moving the capabilities must not take the
	// prices with them.
	it("keeps its Advanced section for a billable model even with the capabilities moved", () => {
		const paid = {
			...localModel,
			supportsPromptCache: true,
			cacheReadsPrice: 0.3,
			cacheWritesPrice: 3.75,
		} as ModelInfo

		render(<ModelInfoView capabilitiesElsewhere modelInfo={paid} selectedModelId="paid-model" />)

		expect(screen.getByText("Advanced")).toBeTruthy()
		expect(screen.getByText("Cache Reads")).toBeTruthy()
		// Still moved, even though the section survived for another reason.
		expect(screen.queryByText("Images")).toBeNull()
	})
})

describe("ModelCapabilityRows", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.useProviderModels.mockReturnValue({ models: {} })
	})

	it("reports the three capabilities so the sampler's section can host them", () => {
		render(<ModelCapabilityRows modelInfo={localModel} selectedModelId="local-model" />)

		expect(screen.getByText("Images")).toBeTruthy()
		expect(screen.getByText("Browser")).toBeTruthy()
		expect(screen.getByText("Prompt Caching")).toBeTruthy()
	})
})
