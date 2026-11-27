/**
 * The board viewer's data on the webview side (pipelines plan phase 3,
 * section 9). The shapes are shared with the extension
 * (`@shared/board-viewer`); a message is still read defensively, because a
 * journal outlives the version that wrote it.
 */

import {
	BOARD_VIEWER_DATA,
	BOARD_VIEWER_REPLY,
	type ViewerData,
	type ViewerPipeline,
	type ViewerRequest,
	type ViewerRun,
} from "@shared/board-viewer"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { findLatestTaskGraph, type TaskGraphPanelSnapshot } from "@/components/chat/task-header/TaskGraphPanel"

export type {
	ViewerBoardTask,
	ViewerData,
	ViewerEvent,
	ViewerFocus,
	ViewerNodeOutput,
	ViewerNodeState,
	ViewerNodeStatus,
	ViewerPipeline,
	ViewerPipelineDefinition,
	ViewerPipelineNode,
	ViewerReplyMessage,
	ViewerRequest,
	ViewerRun,
	ViewerRunOp,
	ViewerVersion,
} from "@shared/board-viewer"

const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value)

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/** The data from a message, or undefined when it is not one of ours. */
export function readViewerMessage(message: unknown): ViewerData | undefined {
	if (!isObject(message) || message.type !== BOARD_VIEWER_DATA || !isObject(message.data)) {
		return undefined
	}
	const data = message.data
	return {
		workspace: typeof data.workspace === "string" ? data.workspace : "",
		...(typeof data.boardText === "string" ? { boardText: data.boardText } : {}),
		...(data.boardDraft === true ? { boardDraft: true } : {}),
		...(isObject(data.catalog)
			? {
					catalog: {
						tools: strings(data.catalog.tools),
						agents: strings(data.catalog.agents),
						functions: strings(data.catalog.functions),
					},
				}
			: {}),
		pipelines: Array.isArray(data.pipelines)
			? (data.pipelines.filter((entry) => isObject(entry) && typeof entry.slug === "string") as ViewerPipeline[]).map(
					(pipeline) => ({ ...pipeline, errors: Array.isArray(pipeline.errors) ? pipeline.errors : [] }),
				)
			: [],
		runs: Array.isArray(data.runs)
			? (data.runs.filter((entry) => isObject(entry) && typeof entry.id === "string") as ViewerRun[]).map((run) => ({
					...run,
					inputs: isObject(run.inputs) ? run.inputs : {},
					nodes: isObject(run.nodes) ? run.nodes : {},
					events: Array.isArray(run.events) ? run.events : [],
					eventCount: typeof run.eventCount === "number" ? run.eventCount : 0,
				}))
			: [],
		...(isObject(data.focus) ? { focus: data.focus as ViewerData["focus"] } : {}),
	}
}

/** The conversation's board, read with the task panel's own parser. */
export function readBoard(data: ViewerData | undefined): TaskGraphPanelSnapshot | undefined {
	if (!data?.boardText) return undefined
	return findLatestTaskGraph([{ ts: 0, type: "say", say: "task_graph", text: data.boardText } as ClineMessage])
}

const slug = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "pipeline"

/** The run's pipeline: by slug of the run's pipeline name, a test's without its `-test`. */
export function runBelongsTo(run: ViewerRun, pipeline: ViewerPipeline): boolean {
	const own = slug(run.pipeline)
	return [own, own.replace(/-test$/, "")].some((name) => name === pipeline.slug || name === slug(pipeline.name))
}

/** What the viewer is showing. */
export type ViewerSource = { kind: "board" } | { kind: "pipeline"; slug: string } | { kind: "run"; id: string }

/** The source a fresh panel opens on: its focus, else the board, else the newest run, else the first pipeline. */
export function initialSource(data: ViewerData): ViewerSource | undefined {
	const focus = data.focus
	if (focus?.run && data.runs.some((run) => run.id === focus.run)) return { kind: "run", id: focus.run }
	if (focus?.pipeline && data.pipelines.some((pipeline) => pipeline.slug === focus.pipeline)) {
		return { kind: "pipeline", slug: focus.pipeline }
	}
	if (focus?.board || data.boardText) return { kind: "board" }
	if (data.runs[0]) return { kind: "run", id: data.runs[0].id }
	if (data.pipelines[0]) return { kind: "pipeline", slug: data.pipelines[0].slug }
	// Nothing yet: the board, where the person can start one.
	return { kind: "board" }
}

/** A short duration: 840 ms, 12.4 s, 3 m 05 s, 1 h 02 m. */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ""
	if (ms < 1000) return `${Math.round(ms)} ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
	const s = Math.floor(ms / 1000)
	if (s < 3600) return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`
	return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} m`
}

/** What the extension answered to a request. */
export interface ViewerReply {
	ok: boolean
	errors: string[]
	lines: string[]
	/** The run a run action left running. */
	run?: string
	/** The pipeline a request made. */
	pipeline?: string
}

type Asked = Extract<ViewerRequest, { id: number }>
type Ask = Asked extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never

let nextRequest = 1
const waiting = new Map<number, (reply: ViewerReply) => void>()

/** A request the extension answers; `post` sends it (the platform's postMessage). */
export function ask(post: (request: ViewerRequest) => void, request: Ask): Promise<ViewerReply> {
	const id = nextRequest++
	return new Promise((resolve) => {
		waiting.set(id, resolve)
		post({ ...request, id } as ViewerRequest)
	})
}

/** Settles the request a reply answers; false when the message is not a reply. */
export function settleReply(message: unknown): boolean {
	if (!isObject(message) || message.type !== BOARD_VIEWER_REPLY || typeof message.id !== "number") return false
	const resolve = waiting.get(message.id)
	if (!resolve) return true
	waiting.delete(message.id)
	resolve({
		ok: message.ok === true,
		errors: Array.isArray(message.errors) ? message.errors.map(String) : [],
		lines: Array.isArray(message.lines) ? message.lines.map(String) : [],
		...(typeof message.run === "string" ? { run: message.run } : {}),
		...(typeof message.pipeline === "string" ? { pipeline: message.pipeline } : {}),
	})
	return true
}
