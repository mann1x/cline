import { describe, expect, it } from "vitest"
import { type ScopedModelSetting, scopedSettingsPatch } from "./scopedSettingsPatch"

const SETTINGS: ScopedModelSetting[] = [
	"visionModeApiConfiguration",
	"agentsModeApiConfiguration",
	"escalationModeApiConfiguration",
]

describe("scopedSettingsPatch", () => {
	// The whole point: one tab writing another tab's field is invisible — the
	// save reports success and the wrong model changes.
	it.each(SETTINGS)("writes %s and nothing else", (setting) => {
		const patch = scopedSettingsPatch(setting, '{"global":{}}')

		expect(Object.keys(patch)).toEqual([setting])
		expect(patch[setting]).toBe('{"global":{}}')
	})

	// A tab whose key is missing from the switch would return an empty patch,
	// and `UpdateSettingsRequest.create({})` is a valid request that writes
	// nothing at all.
	it("never returns an empty patch", () => {
		for (const setting of SETTINGS) {
			expect(Object.keys(scopedSettingsPatch(setting, "x"))).toHaveLength(1)
		}
	})
})
