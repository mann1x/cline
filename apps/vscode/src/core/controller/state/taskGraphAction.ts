import { String as ProtoString, type StringRequest } from "@shared/proto/cline/common"
import { openBoardViewer } from "@/core/webview/board-viewer-hooks"
import type { Controller } from ".."

/**
 * The task panel's one call: a change to the board, as JSON
 * (`{op:"update", updates:[…]}` with `task_update`'s fields, or
 * `{op:"plan", tasks:[…]}` with `task_plan`'s). Applied as the person's; the
 * model is told what changed with its next look. Answers `{ok, lines}`, the
 * lines being what the board said back. Also `{op:"memories"}` (where a board
 * can be saved) and `{op:"save", memory, keepUpdated}` (save it there).
 * Saved plans: `{op:"templates"}` (the list), `{op:"template-use", name,
 * vars}` (its tasks go on the board as the person's) and
 * `{op:"template-save", name, description?, where?}` (the board as one).
 * `{op:"open-viewer"}` opens the board in the editor-area viewer.
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
	} else if (action?.op === "remove" && Array.isArray((action as { ids?: unknown }).ids)) {
		const ids = (action as { ids: unknown[] }).ids.filter((id): id is string => typeof id === "string")
		answer = controller.taskGraphAction({ op: "remove", ids })
	} else if (action?.op === "memories") {
		const memories = await controller.taskBoardMemories()
		return ProtoString.create({ value: JSON.stringify({ ok: memories.enabled, lines: [], memories }) })
	} else if (action?.op === "save") {
		const save = parsed as { memory?: unknown; keepUpdated?: unknown }
		answer = await controller.saveTaskBoard({
			...(typeof save.memory === "string" ? { memory: save.memory } : {}),
			keepUpdated: save.keepUpdated === true,
		})
	} else if (action?.op === "templates") {
		return ProtoString.create({
			value: JSON.stringify({ ok: true, lines: [], templates: controller.taskTemplates() }),
		})
	} else if (action?.op === "template-use") {
		const use = parsed as { name?: unknown; vars?: unknown }
		const vars =
			use.vars && typeof use.vars === "object" && !Array.isArray(use.vars)
				? Object.fromEntries(
						Object.entries(use.vars as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
					)
				: {}
		answer = controller.useTaskTemplate(typeof use.name === "string" ? use.name : "", vars)
	} else if (action?.op === "template-save") {
		const save = parsed as { name?: unknown; description?: unknown; where?: unknown }
		answer = controller.saveTaskTemplate(
			typeof save.name === "string" ? save.name : "",
			typeof save.description === "string" ? save.description : undefined,
			save.where === "user" ? "user" : "workspace",
		)
	} else if (action?.op === "open-viewer") {
		answer = openBoardViewer({ board: true })
			? { ok: true, lines: [] }
			: { ok: false, lines: ["This editor has no board viewer."] }
	} else {
		answer = { ok: false, lines: ["Not a board change: send {op:'update', updates:[…]} or {op:'plan', tasks:[…]}."] }
	}
	return ProtoString.create({ value: JSON.stringify(answer) })
}
