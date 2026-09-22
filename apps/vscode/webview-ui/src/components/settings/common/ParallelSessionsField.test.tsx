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

	// The panel asks the server now. Where it says PolyKV or elastic slots are
	// on, the field stops describing the server and becomes the user's own
	// ceiling, and the copy names which controller is doing the deciding.
	it("says the number is a ceiling when the server says PolyKV is on", () => {
		const text = parallelSessionsDescription("opencoti", "polykv")
		expect(text).toMatch(/PolyKV admission is on/)
		expect(text).toMatch(/ceiling/i)
		expect(text).toMatch(/leave it empty/i)
	})

	it("says the number is a ceiling when the server says elastic slots are on", () => {
		const text = parallelSessionsDescription("opencoti", "elastic")
		expect(text).toMatch(/elastic slots are on/i)
		expect(text).toMatch(/leave it empty/i)
	})

	// The trap this closes: a plain opencoti has a fixed --parallel like any
	// llama.cpp server, and being told "leave it empty to let the engine
	// decide" there leaves it at one with nothing deciding.
	it("does not offer the engine's decision on an opencoti that has neither on", () => {
		const text = parallelSessionsDescription("opencoti", "fixed")
		expect(text).not.toMatch(/leave it empty/i)
		expect(text).not.toMatch(/ceiling/i)
		expect(text).toMatch(/neither PolyKV nor elastic slots/i)
	})

	// Not yet answered, or not answerable. Both cases are stated, and the copy
	// says it could not tell rather than guessing either way.
	it("states both cases, and says so, when the server could not be asked", () => {
		const text = parallelSessionsDescription("opencoti", "unknown")
		expect(text).toMatch(/could not be asked/i)
		expect(text).toMatch(/ceiling/i)
	})
})
