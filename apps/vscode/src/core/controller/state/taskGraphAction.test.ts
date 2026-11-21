import { StringRequest } from "@shared/proto/cline/common"
import { describe, expect, it } from "vitest"
import type { Controller } from ".."
import { taskGraphAction } from "./taskGraphAction"

async function act(value: string, seen: unknown[]): Promise<{ ok: boolean; lines: string[] }> {
	const controller = {
		taskGraphAction: (action: unknown) => {
			seen.push(action)
			return { ok: true, lines: ["T1 now done."] }
		},
	} as unknown as Controller
	const response = await taskGraphAction(controller, StringRequest.create({ value }))
	return JSON.parse(response.value)
}

describe("taskGraphAction", () => {
	it("passes an update or a plan to the controller, and its answer back", async () => {
		const seen: unknown[] = []
		const updates = [{ id: "T1", status: "done" }]
		expect(await act(JSON.stringify({ op: "update", updates }), seen)).toEqual({ ok: true, lines: ["T1 now done."] })
		await act(JSON.stringify({ op: "plan", tasks: [{ title: "x" }] }), seen)
		expect(seen).toEqual([
			{ op: "update", updates },
			{ op: "plan", tasks: [{ title: "x" }] },
		])
	})

	it("refuses anything else without reaching the board", async () => {
		const seen: unknown[] = []
		for (const value of ["{not json", JSON.stringify({ op: "delete" }), JSON.stringify({ op: "update", updates: "T1" })]) {
			expect((await act(value, seen)).ok).toBe(false)
		}
		expect(seen).toEqual([])
	})
})
