import type { MessageHistorySnapshot } from "@shared/message-history"
import { StringRequest } from "@shared/proto/cline/common"
import { describe, expect, it } from "vitest"
import type { Controller } from ".."
import { messageHistoryAction } from "./messageHistoryAction"

function controllerWith(stored: Record<string, unknown>): Controller {
	return {
		stateManager: {
			getGlobalSettingsKey: (key: string) => stored[key],
			getGlobalStateKey: (key: string) => stored[key],
			setGlobalState: (key: string, value: unknown) => {
				stored[key] = value
			},
		},
	} as unknown as Controller
}

async function act(controller: Controller, action: unknown): Promise<MessageHistorySnapshot> {
	const response = await messageHistoryAction(controller, StringRequest.create({ value: JSON.stringify(action) }))
	return JSON.parse(response.value) as MessageHistorySnapshot
}

describe("messageHistoryAction", () => {
	it("keeps the draft, and trades it for a history entry when the message is sent", async () => {
		const stored: Record<string, unknown> = { messageHistoryEnabled: true, messageHistoryLimit: 2 }
		const controller = controllerWith(stored)

		expect((await act(controller, { op: "draft", text: "half a thought" })).draft).toBe("half a thought")
		expect(await act(controller, { op: "load" })).toMatchObject({ enabled: true, limit: 2, draft: "half a thought" })

		await act(controller, { op: "push", text: "one" })
		await act(controller, { op: "push", text: "two" })
		expect(await act(controller, { op: "push", text: "three" })).toMatchObject({ history: ["two", "three"], draft: "" })
	})

	it("writes nothing and returns nothing while switched off", async () => {
		const stored: Record<string, unknown> = {
			messageHistoryEnabled: false,
			messageHistory: ["left over"],
			messageDraft: "left over",
		}
		const controller = controllerWith(stored)

		expect(await act(controller, { op: "push", text: "secret" })).toMatchObject({ enabled: false, history: [], draft: "" })
		await act(controller, { op: "draft", text: "secret" })
		expect(stored.messageHistory).toEqual(["left over"])
		expect(stored.messageDraft).toBe("left over")
	})

	it("ignores an action it cannot read", async () => {
		const stored: Record<string, unknown> = { messageHistory: ["one"] }
		const controller = controllerWith(stored)
		const response = await messageHistoryAction(controller, StringRequest.create({ value: "not json" }))
		expect(JSON.parse(response.value)).toMatchObject({ enabled: true, limit: 50, history: ["one"] })
	})
})
