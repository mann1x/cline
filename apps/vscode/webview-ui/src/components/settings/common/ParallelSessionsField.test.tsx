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

/**
 * Reported by the tester on 2026-09-22, looking at the opencoti panel:
 *
 *   "the parallel sessions input is asking for 1-10 and says 1 is default, so
 *    none according to the instructions is 1. also why max 10? plus the
 *    description is for OLLAMA?? llama and opencoti provider should have their
 *    own description"
 *
 * Three separate faults in one paragraph of copy.
 */
describe("what the parallel-sessions copy says, per provider", () => {
	// It opened with OLLAMA_NUM_PARALLEL on every provider's panel, including
	// the two that have a --parallel flag and the hosted ones that have
	// neither.
	it("names the thing that actually sets it", () => {
		expect(parallelSessionsDescription("ollama")).toMatch(/OLLAMA_NUM_PARALLEL/)
		expect(parallelSessionsDescription("opencoti", "fixed")).toMatch(/--parallel/)
		expect(parallelSessionsDescription("anthropic")).toMatch(/plan allows/i)
	})

	it("does not tell an opencoti or a hosted user about Ollama", () => {
		expect(parallelSessionsDescription("opencoti", "polykv")).not.toMatch(/OLLAMA_NUM_PARALLEL/)
		expect(parallelSessionsDescription("opencoti", "fixed")).not.toMatch(/OLLAMA_NUM_PARALLEL/)
		expect(parallelSessionsDescription("anthropic")).not.toMatch(/OLLAMA_NUM_PARALLEL/)
	})

	// The OpenAI-Compatible form is the one id that genuinely covers both a
	// local llama.cpp and a hosted endpoint, so it names both rather than
	// picking one and being wrong half the time.
	it("names both cases for the OpenAI-compatible form", () => {
		const text = parallelSessionsDescription("openai")
		expect(text).toMatch(/llama\.cpp/)
		expect(text).toMatch(/--parallel/)
		expect(text).toMatch(/plan allows/i)
	})

	// "1 to 10" beside a field whose whole point on an elastic server is that
	// it may be left blank. A stated minimum of 1 reads as "blank is 1", which
	// is the opposite of what blank does there.
	it("states no minimum, because blank is not the minimum", () => {
		for (const text of [
			parallelSessionsDescription("ollama"),
			parallelSessionsDescription("opencoti", "polykv"),
			parallelSessionsDescription("anthropic"),
		]) {
			expect(text).not.toMatch(/\b1 to \d+\b/)
		}
	})

	// The tester's first complaint: nothing said what an empty field did, so
	// the range implied it. Where nothing else decides, it is now stated.
	it("says what an empty field means wherever nothing else decides it", () => {
		expect(parallelSessionsDescription("ollama")).toMatch(/empty field is read as one/i)
		expect(parallelSessionsDescription("opencoti", "fixed")).toMatch(/empty field is read as one/i)
		// ...and on an elastic server the opposite is true, so it is not said.
		expect(parallelSessionsDescription("opencoti", "polykv")).not.toMatch(/empty field is read as one/i)
	})

	// 10 was a claim about local llama.cpp servers, made before elastic
	// opencoti and while ignoring hosted plans. The tester's own profile sat
	// at exactly 10 -- a cap doing the choosing.
	it("no longer caps at ten", () => {
		expect(parallelSessionsDescription("ollama")).toMatch(/Up to 64\./)
		expect(parallelSessionsDescription("ollama")).not.toMatch(/\b10\b/)
	})
})
