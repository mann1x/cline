import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SamplingSection } from "./SamplingSection"
import { resetPendingSampling, samplingFieldsFor } from "./sampling-fields"
import { ThinkingBudgetField } from "./ThinkingBudgetField"

/**
 * The sampler on the OpenAI-compatible form, which is how llama.cpp and
 * opencoti are reached.
 *
 * Reported: "please replicate all the sampling parameters in advanced ollama
 * provider api to model configuration menu of opencoti/llama". The sending half
 * already existed — `LLAMACPP_SAMPLING_WIRE_NAMES` maps every one of these —
 * so what was missing was the half that lets a value be set.
 */

type Config = { sampling?: Record<string, unknown> }

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Config } }))

vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Config>(mocks.config.current)
			const write = useCallback(async (patch: Config) => {
				mocks.write(patch)
				// The host round trip. Nothing a panel writes is visible to it
				// until this resolves, which is the whole reason the section
				// keeps its own copy of what it sent.
				await Promise.resolve()
				setConfig((previous) => ({ ...previous, ...(patch.sampling !== undefined ? { sampling: patch.sampling } : {}) }))
			}, [])
			return { config, write }
		},
	}
})

vi.mock("./DebouncedTextField", () => ({
	DebouncedTextField: ({
		initialValue,
		onChange,
		children,
	}: {
		initialValue: string
		onChange: (value: string) => void
		children?: React.ReactNode
	}) => (
		// The label wraps its input, which is how `getByLabelText` finds a field
		// by the parameter name shown above it.
		<label>
			{children}
			<input defaultValue={initialValue} onChange={(event) => onChange(event.target.value)} />
		</label>
	),
}))
vi.mock("@/components/ui/select", () => ({
	Select: ({
		value,
		onValueChange,
		children,
	}: {
		value?: string
		onValueChange?: (value: string) => void
		children?: React.ReactNode
	}) => (
		<select data-testid="thinking-level" onChange={(event) => onValueChange?.(event.target.value)} value={value}>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}))
vi.mock("./DebouncedTextArea", () => ({
	DebouncedTextArea: ({ initialValue, onChange }: { initialValue: string; onChange: (value: string) => void }) => (
		<textarea defaultValue={initialValue} onChange={(event) => onChange(event.target.value)} />
	),
}))

function lastSampling(): Record<string, unknown> | undefined {
	const call = mocks.write.mock.calls.at(-1)
	return call?.[0]?.sampling
}

function fieldNamed(label: string): HTMLInputElement {
	return screen.getByLabelText(label) as HTMLInputElement
}

describe("the sampling section on a llama.cpp endpoint", () => {
	beforeEach(() => {
		resetPendingSampling()
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = {}
	})

	it("offers every parameter the engine reads, under the engine's own name", () => {
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		for (const label of ["temperature", "top_k", "top_p", "min_p", "typical_p", "repeat_last_n", "repeat_penalty"]) {
			expect(fieldNamed(label)).toBeInTheDocument()
		}
		for (const label of ["presence_penalty", "frequency_penalty", "seed", "n_keep"]) {
			expect(fieldNamed(label)).toBeInTheDocument()
		}
		expect(screen.getByLabelText("stop")).toBeInTheDocument()
	})

	// The per-turn cap belongs to the automatic output budget, which is computed
	// against the window and against what the last request was actually capped
	// to. A fixed number set here would be the smaller of the two more and more
	// often as the window filled, and would win silently.
	it("does not offer num_predict", () => {
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		expect(screen.queryByLabelText("num_predict")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("n_predict")).not.toBeInTheDocument()
	})

	// `-ngl` is decided when the server starts; there is no per-request form, so
	// a field for it would be a control the server does not read.
	it("does not offer num_gpu", () => {
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		expect(screen.queryByLabelText("num_gpu")).not.toBeInTheDocument()
	})

	it("sends a value that was typed", async () => {
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		fireEvent.change(fieldNamed("top_p"), { target: { value: "0.95" } })
		await act(async () => {})

		expect(lastSampling()?.topP).toBe(0.95)
	})

	// The same race the Ollama panel was reported with: `Number("0.")` is 0, and
	// a committed 0 renders back over the field.
	it("does not commit a half-typed decimal", () => {
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		fireEvent.change(fieldNamed("temperature"), { target: { value: "0." } })

		expect(mocks.write).not.toHaveBeenCalled()
	})

	it("refuses a value outside the parameter's range and says so", () => {
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		fireEvent.change(fieldNamed("top_p"), { target: { value: "9" } })

		expect(screen.getByText(/top_p cannot be above 1/)).toBeInTheDocument()
		expect(lastSampling()?.topP).toBeUndefined()
	})

	// The section is written whole, so a second field touched before the first
	// write comes back must compose from the first one -- not from the config
	// the render it was created in was holding.
	it("keeps an earlier value when a second field is typed before the write lands", () => {
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		fireEvent.change(fieldNamed("temperature"), { target: { value: "0.4" } })
		fireEvent.change(fieldNamed("top_k"), { target: { value: "40" } })

		expect(lastSampling()).toMatchObject({ temperature: 0.4, topK: 40 })
	})

	it("clears the whole section on request", async () => {
		mocks.config.current = { sampling: { temperature: 0.4, topK: 40, stop: [] } }
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		fireEvent.click(screen.getByText("Clear all sampling parameters"))
		await act(async () => {})

		expect(lastSampling()).toEqual({ stop: [] })
	})

	// A value set while the profile pointed at Ollama is still the user's. The
	// section writes the whole thing, so dropping a field it does not display
	// would clear it the first time any other control was touched.
	it("carries a parameter it does not display", () => {
		mocks.config.current = { sampling: { numPredict: 4096, stop: [] } }
		render(<SamplingSection dialect="llamacpp" providerId="opencoti" />)
		fireEvent.click(screen.getByText("Advanced"))

		fireEvent.change(fieldNamed("temperature"), { target: { value: "0.4" } })

		expect(lastSampling()).toMatchObject({ numPredict: 4096, temperature: 0.4 })
	})
})

describe("the sampler and the thinking level, on one panel", () => {
	beforeEach(() => {
		resetPendingSampling()
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = {}
	})

	// Both write the same section, and the store replaces it wholesale. Picking
	// a level composes its write from what sampling holds -- so a temperature
	// typed a moment earlier, still in flight, has to be visible to it. It is
	// not visible through `config`, which is a round trip behind; the two
	// controls are separate components, so neither can hold it for the other.
	//
	// Without the shared record this reads as "I set the temperature, changed
	// the thinking level, and the temperature went back to what it was".
	it("keeps a sampler value the thinking level was picked on top of", async () => {
		render(
			<>
				<SamplingSection dialect="llamacpp" providerId="opencoti" />
				<ThinkingBudgetField providerId="opencoti" />
			</>,
		)
		fireEvent.click(screen.getByText("Advanced"))

		fireEvent.change(fieldNamed("temperature"), { target: { value: "0.4" } })
		fireEvent.change(screen.getByTestId("thinking-level"), { target: { value: "medium" } })

		expect(lastSampling()).toMatchObject({ temperature: 0.4 })
		await act(async () => {})
	})
})

describe("the two dialects", () => {
	it("name the same parameter as their own engine does", () => {
		const ollama = samplingFieldsFor("ollama")
		const llamacpp = samplingFieldsFor("llamacpp")

		expect(ollama.find((field) => field.key === "numKeep")?.label).toBe("num_keep")
		expect(llamacpp.find((field) => field.key === "numKeep")?.label).toBe("n_keep")
		// Ollama keeps both of the ones llama.cpp has no request form for.
		expect(ollama.map((field) => field.key)).toContain("numGpu")
		expect(ollama.map((field) => field.key)).toContain("numPredict")
	})

	/**
	 * The sending side, copied rather than imported: `@cline/llms` pulls in Node
	 * dependencies the webview bundle does not resolve, so this is the guard
	 * that the two lists have not drifted apart. A field shown here that is
	 * absent there is a control that does nothing; a name that differs is a
	 * value sent under a key the server ignores.
	 *
	 * Source of truth: `LLAMACPP_SAMPLING_WIRE_NAMES` in
	 * `sdk/packages/llms/src/providers/vendors/llamacpp-sampling.ts`. Three of
	 * its entries are not numeric parameters and so are not in this catalog:
	 * `stop` and `reasoning_budget_message` have controls of their own, and
	 * `n_predict` is deliberately not offered at all -- the automatic output
	 * budget owns that number.
	 */
	it("names every numeric parameter as the request does", () => {
		const wireNames: Record<string, string> = {
			temperature: "temperature",
			topK: "top_k",
			topP: "top_p",
			minP: "min_p",
			typicalP: "typical_p",
			repeatLastN: "repeat_last_n",
			repeatPenalty: "repeat_penalty",
			presencePenalty: "presence_penalty",
			frequencyPenalty: "frequency_penalty",
			seed: "seed",
			numKeep: "n_keep",
		}
		const shown = Object.fromEntries(samplingFieldsFor("llamacpp").map((field) => [field.key, field.label]))

		expect(shown).toEqual(wireNames)
	})
})
