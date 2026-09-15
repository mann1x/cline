import { describe, expect, it } from "vitest"
import { parallelSessionsDescription } from "./ParallelSessionsField"

describe("the Parallel Sessions description", () => {
	// On a fixed server the number describes the server, and leaving it empty
	// has to mean one: a request that finds no free slot queues silently, and
	// nothing reports that.
	it("says what an empty field means on a fixed server", () => {
		const text = parallelSessionsDescription("ollama")
		expect(text).toMatch(/queues the request instead of refusing it/)
		expect(text).not.toMatch(/ceiling/i)
	})

	// opencoti with PolyKV or elastic slots on decides for itself, so there the
	// field stops describing the server and becomes the user's own ceiling —
	// the opposite of what the shared copy says, which is why it is said.
	it("says the number is a ceiling on opencoti, and that empty hands it to the engine", () => {
		const text = parallelSessionsDescription("opencoti")
		expect(text).toMatch(/ceiling/i)
		expect(text).toMatch(/leave it empty/i)
	})
})
