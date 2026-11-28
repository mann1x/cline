import { describe, expect, it } from "vitest"
import {
	autoStartMessage,
	parseStartSkills,
	serializeStartSkills,
	setStartSkill,
	setStartSkillMessage,
	withStartSkills,
} from "./start-skills"

describe("start skills", () => {
	it("round-trips, dropping junk and duplicates", () => {
		expect(parseStartSkills('[{"name":"brief"},{"name":"brief"},{"x":1},{"name":" plan ","message":" go "}]')).toEqual([
			{ name: "brief" },
			{ name: "plan", message: "go" },
		])
		expect(parseStartSkills("not json")).toEqual([])
		expect(serializeStartSkills([])).toBe("")
	})

	it("switches a skill on and off and keeps its message while on", () => {
		let skills = setStartSkill([], "brief", true)
		skills = setStartSkillMessage(skills, "brief", "Summarize the repo")
		expect(skills).toEqual([{ name: "brief", message: "Summarize the repo" }])
		expect(setStartSkill(skills, "brief", true)).toEqual(skills)
		expect(setStartSkill(skills, "brief", false)).toEqual([])
		expect(setStartSkillMessage(skills, "brief", "  ")).toEqual([{ name: "brief" }])
	})

	it("puts the skills in front of the first message unless it already names them", () => {
		const skills = [{ name: "brief" }, { name: "house-style" }]
		expect(withStartSkills("fix the login bug", skills)).toBe("/brief /house-style fix the login bug")
		expect(withStartSkills("/brief fix it", skills)).toBe("/house-style /brief fix it")
		expect(withStartSkills("use /house-style.md and /brief", skills)).toBe("use /house-style.md and /brief")
		expect(withStartSkills("see /briefing", [{ name: "brief" }])).toBe("/brief see /briefing")
		expect(withStartSkills("hello", [])).toBe("hello")
	})

	it("starts a chat by itself only when a skill has a message", () => {
		expect(autoStartMessage([{ name: "brief" }])).toBeUndefined()
		expect(autoStartMessage([{ name: "brief", message: "What changed since yesterday?" }, { name: "house-style" }])).toBe(
			"/brief /house-style What changed since yesterday?",
		)
	})
})
