import { describe, expect, it } from "vitest"
import {
	buildSamplingPatch,
	type SamplingDialect,
	type SamplingFieldKey,
	samplingFieldsFor,
	samplingProblem,
} from "./sampling-fields"

// repeat_last_n -1 showed no error on Ollama and was never saved: the panel and
// the save checked two different ranges. This holds the two to one answer for
// every field the panel offers on every engine.

const INT32_MAX = 2_147_483_647

const engines: readonly { name: string; dialect: SamplingDialect; providerId: string }[] = [
	{ name: "Ollama", dialect: "ollama", providerId: "ollama" },
	{ name: "llama.cpp", dialect: "llamacpp", providerId: "openai" },
	{ name: "opencoti", dialect: "llamacpp", providerId: "opencoti" },
]

function candidates(field: { kind: "number" | "integer"; min?: number; max?: number }): string[] {
	const step = field.kind === "integer" ? 1 : 0.01
	const values = new Set<number>([-1, 0, 1, 0.5, 1.5, INT32_MAX, INT32_MAX + 1, -2])
	if (field.min !== undefined) {
		values.add(field.min)
		values.add(field.min - step)
	}
	if (field.max !== undefined) {
		values.add(field.max)
		values.add(field.max + step)
	}
	return [...values].map((value) => String(Number(value.toFixed(6))))
}

describe("the save keeps exactly what the panel accepts", () => {
	for (const engine of engines) {
		for (const field of samplingFieldsFor(engine.dialect, engine.providerId)) {
			it(`${engine.name} ${field.label}`, () => {
				for (const raw of candidates(field)) {
					const accepted = samplingProblem(field, raw) === undefined
					const saved = buildSamplingPatch({
						dialect: engine.dialect,
						providerId: engine.providerId,
						stored: undefined,
						draft: { [field.key]: raw },
					})[field.key as SamplingFieldKey]
					expect({ raw, saved }).toEqual({ raw, saved: accepted ? Number(raw) : undefined })

					// And what was saved survives the next save of another field.
					if (accepted) {
						const other = field.key === "temperature" ? "topK" : "temperature"
						const again = buildSamplingPatch({
							dialect: engine.dialect,
							providerId: engine.providerId,
							stored: { [field.key]: Number(raw) },
							draft: { [other]: "1" },
						})
						expect({ raw, kept: again[field.key as SamplingFieldKey] }).toEqual({ raw, kept: Number(raw) })
					}
				}
			})
		}
	}
})

// Upstream llama.cpp answers 400 to a value outside these, for every request of
// the session (tools/server/server-schema.cpp, set_hard_limits). Fields it does
// not bound are absent.
const LLAMACPP_HARD_LIMITS: Partial<Record<SamplingFieldKey, { min: number; max: number }>> = {
	repeatLastN: { min: 0, max: INT32_MAX },
	numKeep: { min: -1, max: INT32_MAX },
	numPredict: { min: -1, max: INT32_MAX },
}

describe("nothing the panel accepts is refused by upstream llama.cpp", () => {
	for (const field of samplingFieldsFor("llamacpp", "openai")) {
		const limits = LLAMACPP_HARD_LIMITS[field.key]
		if (!limits) {
			continue
		}
		it(field.label, () => {
			for (const raw of candidates(field)) {
				if (samplingProblem(field, raw) === undefined) {
					expect(Number(raw)).toBeGreaterThanOrEqual(limits.min)
					expect(Number(raw)).toBeLessThanOrEqual(limits.max)
				}
			}
		})
	}
})

describe("an integer field refuses a decimal", () => {
	it("rather than saving a truncated value", () => {
		const field = samplingFieldsFor("ollama", "ollama").find((entry) => entry.key === "repeatLastN")
		expect(field && samplingProblem(field, "64.5")).toMatch(/whole number/)
		expect(
			buildSamplingPatch({ dialect: "ollama", providerId: "ollama", stored: undefined, draft: { repeatLastN: "64.5" } })
				.repeatLastN,
		).toBeUndefined()
	})
})
