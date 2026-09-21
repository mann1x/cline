import { openAiModelInfoSafeDefaults } from "@shared/api"
import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("./useProviderUsageCostDisplay", () => ({ useProviderUsageCostDisplay: () => "hide" }))

import { useDynamicProviderSelection } from "./useDynamicProviderSelection"

// This hook is what `ApiOptions` reads to give `OutputBudgetField` a window to
// fall back on when the provider stores none. The field's own tests pass that
// number in directly, so they prove the field reacts to it and nothing about
// where it comes from -- and "where it comes from" is the half that was
// missing, twice. opencoti has no case in the switch, so the answer has to
// come out of the default arm.
describe("useDynamicProviderSelection", () => {
	it("gives a catalog-only provider the OpenAI-compatible safe defaults", () => {
		const { result } = renderHook(() => useDynamicProviderSelection("opencoti", {}, "act"))

		expect(result.current.selectedModelInfo).toBe(openAiModelInfoSafeDefaults)
		expect(result.current.selectedModelInfo.contextWindow).toBe(128_000)
	})

	// The same arm serves llama.cpp, the other provider in the report.
	it("does the same for llama.cpp", () => {
		const { result } = renderHook(() => useDynamicProviderSelection("llama-cpp", undefined, "plan"))

		expect(result.current.selectedModelInfo.contextWindow).toBe(128_000)
	})

	// A provider that does have a case must still read its own committed info,
	// or this fallback would be masking real values.
	it("prefers a provider's committed model info over the fallback", () => {
		const { result } = renderHook(() =>
			useDynamicProviderSelection(
				"openai",
				{ actModeOpenAiModelId: "m", actModeOpenAiModelInfo: { contextWindow: 65_536 } } as never,
				"act",
			),
		)

		expect(result.current.selectedModelInfo.contextWindow).toBe(65_536)
	})
})
