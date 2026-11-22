import { describe, expect, it } from "vitest"
import { matchesFilter } from "./text-filter"

describe("matchesFilter", () => {
	it("matches everything when nothing is typed", () => {
		expect(matchesFilter("", "anything")).toBe(true)
		expect(matchesFilter("   ", "anything")).toBe(true)
	})

	it("needs every word, in any order and case", () => {
		expect(matchesFilter("128K qwen", "local · qwen36 27b 128k")).toBe(true)
		expect(matchesFilter("qwen sonnet", "local · qwen36 27b 128k")).toBe(false)
	})

	it("looks across all the fields given", () => {
		expect(matchesFilter("docker deploy", "docker-compose", "Deploy a stack")).toBe(true)
		expect(matchesFilter("deploy", "docker-compose", undefined)).toBe(false)
	})
})
