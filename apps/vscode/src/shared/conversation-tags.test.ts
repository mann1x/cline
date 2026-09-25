import { describe, expect, it } from "vitest"
import {
	MAX_TAG_LENGTH,
	MAX_TAGS_PER_CONVERSATION,
	matchesTagFilter,
	normalizeTags,
	removeTagFromQuery,
	splitTagQuery,
} from "./conversation-tags"

describe("normalizeTags", () => {
	it("trims, collapses spaces and drops empties", () => {
		expect(normalizeTags(["  big   refactor ", "", "   "])).toEqual(["big refactor"])
	})

	// Case does not make a new tag; the spelling the user typed first stays.
	it("de-duplicates case-insensitively, keeping the first spelling", () => {
		expect(normalizeTags(["Work", "work", "WORK", "ui"])).toEqual(["Work", "ui"])
	})

	it("clips long tags and caps the list", () => {
		expect(normalizeTags(["x".repeat(100)])[0]).toHaveLength(MAX_TAG_LENGTH)
		const many = Array.from({ length: MAX_TAGS_PER_CONVERSATION + 5 }, (_, index) => `t${index}`)
		expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_CONVERSATION)
	})

	// Stored metadata is whatever was on disk; only strings are tags.
	it("ignores anything that is not a string", () => {
		expect(normalizeTags(["a", 1, null, { tag: "b" }])).toEqual(["a"])
	})
})

describe("matchesTagFilter", () => {
	const tags = ["work", "UI"]

	it("passes everything with no filter", () => {
		expect(matchesTagFilter([], [])).toBe(true)
	})

	it("matches any tag by default", () => {
		expect(matchesTagFilter(tags, ["ui", "urgent"])).toBe(true)
		expect(matchesTagFilter(tags, ["urgent"])).toBe(false)
	})

	it("needs every tag in all mode", () => {
		expect(matchesTagFilter(tags, ["work", "ui"], true)).toBe(true)
		expect(matchesTagFilter(tags, ["work", "urgent"], true)).toBe(false)
	})
})

describe("splitTagQuery", () => {
	// The text half goes to the host's title search; a "#work" left in it
	// would match no title.
	it("takes #tags out of the text", () => {
		expect(splitTagQuery("fix the #ui login #work")).toEqual({ text: "fix the login", tags: ["ui", "work"] })
	})

	it("leaves a # inside a word alone", () => {
		expect(splitTagQuery("issue#12 in C#")).toEqual({ text: "issue#12 in C#", tags: [] })
	})

	it("reads a query that is only tags", () => {
		expect(splitTagQuery("#a #b")).toEqual({ text: "", tags: ["a", "b"] })
	})
})

describe("removeTagFromQuery", () => {
	it("takes out the tag in any case and leaves the rest as typed", () => {
		expect(removeTagFromQuery("fix #Work login #ui", "work")).toBe("fix login #ui")
	})

	it("removes a typed tag longer than the stored limit", () => {
		const long = "x".repeat(40)
		const { tags } = splitTagQuery(`#${long}`)
		expect(removeTagFromQuery(`#${long} rest`, tags[0])).toBe("rest")
	})

	it("leaves a word that only starts like the tag", () => {
		expect(removeTagFromQuery("#workshop #work", "work")).toBe("#workshop")
	})
})
