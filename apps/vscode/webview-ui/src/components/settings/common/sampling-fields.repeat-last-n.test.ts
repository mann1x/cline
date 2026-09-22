import { describe, expect, it } from "vitest"
import { samplingEngineFor, samplingFieldsFor, samplingProblem } from "./sampling-fields"

// Reported from pandorum: every request failed with
//   Field 'repeat_last_n': Value must be between 0 <= value <= 2147483647, but got -1
// The panel had offered -1 and its hint had promised it meant "the whole
// context". That is true of two engines and false of the third, and the third
// is the one that answers 400 rather than interpreting it.
//
//   Ollama            Options.normalize resolves any negative to num_ctx
//   opencoti          set_hard_limits(-1, INT32_MAX), "-1 = ctx-size"
//   llama.cpp         set_hard_limits(0, INT32_MAX), "0 = disabled" only
//
// opencoti and llama.cpp are both reached through the OpenAI-compatible form
// on the same "llamacpp" dialect, so the dialect alone cannot decide this.

const repeatLastN = (dialect: "ollama" | "llamacpp", providerId?: string) => {
	const field = samplingFieldsFor(dialect, providerId).find((entry) => entry.key === "repeatLastN")
	if (!field) {
		throw new Error("repeat_last_n is not offered")
	}
	return field
}

describe("which engine's rules apply", () => {
	it("separates opencoti from upstream llama.cpp inside one dialect", () => {
		expect(samplingEngineFor("llamacpp", "opencoti")).toBe("opencoti")
		expect(samplingEngineFor("llamacpp", "llamacpp")).toBe("llamacpp")
		expect(samplingEngineFor("llamacpp")).toBe("llamacpp")
		// A provider name never drags the other dialect across.
		expect(samplingEngineFor("ollama", "opencoti")).toBe("ollama")
	})
})

describe("repeat_last_n", () => {
	it("refuses -1 on upstream llama.cpp, which is the server that 400s", () => {
		const field = repeatLastN("llamacpp")

		expect(field.min).toBe(0)
		expect(samplingProblem(field, "-1")).toBeTruthy()
		expect(samplingProblem(field, "0")).toBeUndefined()
		expect(samplingProblem(field, "64")).toBeUndefined()
	})

	it("does not promise -1 where -1 is rejected", () => {
		expect(repeatLastN("llamacpp").hint).not.toContain("-1")
	})

	it("keeps -1 on Ollama, where it means the context window", () => {
		const field = repeatLastN("ollama")

		expect(field.min).toBe(-1)
		expect(samplingProblem(field, "-1")).toBeUndefined()
		expect(field.hint).toContain("-1")
	})

	// opencoti's fork widened the limit on purpose and documents the sentinel;
	// taking it away because it shares a dialect would be the opposite mistake.
	it("keeps -1 on opencoti, whose own schema allows it", () => {
		const field = repeatLastN("llamacpp", "opencoti")

		expect(field.min).toBe(-1)
		expect(samplingProblem(field, "-1")).toBeUndefined()
		expect(field.hint).toContain("-1")
	})

	it("still refuses anything below the sentinel on every engine", () => {
		for (const field of [repeatLastN("ollama"), repeatLastN("llamacpp", "opencoti"), repeatLastN("llamacpp")]) {
			expect(samplingProblem(field, "-2")).toBeTruthy()
		}
	})
})
