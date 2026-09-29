import assert from "node:assert/strict"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

const installs = vi.hoisted(() => [] as string[][])
vi.mock("@/sdk/document-reader-languages", () => ({
	installDocumentReaderLanguages: vi.fn(async (languages: string[]) => {
		installs.push(languages)
	}),
}))

function makeController() {
	const controller = {
		task: undefined,
		postStateToWebview: vi.fn(async () => undefined),
		stateManager: {
			getGlobalSettingsKey: vi.fn(() => undefined),
			setGlobalState: vi.fn(),
		},
	}
	return controller as unknown as Controller & {
		stateManager: { setGlobalState: ReturnType<typeof vi.fn> }
	}
}

function written(controller: ReturnType<typeof makeController>, key = "extractDocumentEnabled") {
	const calls = controller.stateManager.setGlobalState.mock.calls as Array<[string, unknown]>
	return calls.filter(([written]) => written === key).at(-1)?.[1]
}

// The Document Reader switch posts `extractDocumentEnabled`. A field the handler does not
// read would leave the switch flipping in the panel and the stored value --
// the one the session factory reads -- untouched.
describe("updateSettings — extractDocumentEnabled", () => {
	it("stores both values the switch sends", async () => {
		for (const value of [true, false]) {
			const controller = makeController()

			await updateSettings(controller, UpdateSettingsRequest.create({ extractDocumentEnabled: value }))

			assert.equal(written(controller), value)
		}
	})

	it("leaves the stored value alone when the field is absent", async () => {
		const controller = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ subagentCommandsEnabled: true }))

		assert.equal(written(controller), undefined)
	})
})

describe("updateSettings — the Document Reader's own settings", () => {
	it("stores an OCR engine it knows, and the default for one it does not", async () => {
		for (const [sent, stored] of [
			["vision", "vision"],
			["off", "off"],
			["tesseract", "tesseract"],
			["paddle", "tesseract"],
		]) {
			const controller = makeController()
			await updateSettings(controller, UpdateSettingsRequest.create({ extractDocumentOcr: sent }))
			assert.equal(written(controller, "extractDocumentOcr"), stored)
		}
	})

	it("stores languages as a clean list and installs them", async () => {
		installs.length = 0
		const controller = makeController()
		await updateSettings(controller, UpdateSettingsRequest.create({ extractDocumentOcrLanguages: "eng+DEU, fra fra" }))
		assert.equal(written(controller, "extractDocumentOcrLanguages"), "eng,deu,fra")
		assert.deepEqual(installs, [["eng", "deu", "fra"]])
	})

	it("keeps English when every language is cleared", async () => {
		const controller = makeController()
		await updateSettings(controller, UpdateSettingsRequest.create({ extractDocumentOcrLanguages: "" }))
		assert.equal(written(controller, "extractDocumentOcrLanguages"), "eng")
	})

	it("stores the describe-pictures switch", async () => {
		const controller = makeController()
		await updateSettings(controller, UpdateSettingsRequest.create({ extractDocumentDescribeImages: true }))
		assert.equal(written(controller, "extractDocumentDescribeImages"), true)
	})
})
