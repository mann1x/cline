import { String as ProtoString, type StringRequest } from "@shared/proto/cline/common"
import type { Controller } from ".."

/**
 * The task panel's one call: a change to the board, as JSON
 * (`{op:"update", updates:[…]}` with `task_update`'s fields, or
 * `{op:"plan", tasks:[…]}` with `task_plan`'s). Applied as the person's; the
 * model is told what changed with its next look. Answers `{ok, lines}`, the
 * lines being what the board said back. Also `{op:"memories"}` (where a board
 * can be saved) and `{op:"save", memory, keepUpdated}` (save it there).
 */
export async function taskGraphAction(controller: Controller, request: StringRequest): Promise<ProtoString> {
	let parsed: unknown
	try {
		parsed = JSON.parse(request.value)
	} catch {
		parsed = undefined
	}
	const action = parsed as { op?: unknown; updates?: unknown; tasks?: unknown } | undefined
	let answer: { ok: boolean; lines: string[] }
	if (action?.op === "update" && Array.isArray(action.updates)) {
		answer = controller.taskGraphAction({ op: "update", updates: action.updates })
	} else if (action?.op === "plan" && Array.isArray(action.tasks)) {
		answer = controller.taskGraphAction({ op: "plan", tasks: action.tasks })
	} else if (action?.op === "memories") {
		const memories = await controller.taskBoardMemories()
		return ProtoString.create({ value: JSON.stringify({ ok: memories.enabled, lines: [], memories }) })
	} else if (action?.op === "save") {
		const save = parsed as { memory?: unknown; keepUpdated?: unknown }
		answer = await controller.saveTaskBoard({
			...(typeof save.memory === "string" ? { memory: save.memory } : {}),
			keepUpdated: save.keepUpdated === true,
		})
	} else {
		answer = { ok: false, lines: ["Not a board change: send {op:'update', updates:[…]} or {op:'plan', tasks:[…]}."] }
	}
	return ProtoString.create({ value: JSON.stringify(answer) })
}
