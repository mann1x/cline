import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import {
	foldJournal,
	listPipelines,
	listPipelineVersions,
	PIPELINE_RUNS_DIR,
	readJournal,
	readPipelineVersion,
} from "@cline/core"
import type {
	ViewerCatalog,
	ViewerData,
	ViewerEvent,
	ViewerFocus,
	ViewerNodeState,
	ViewerPipeline,
	ViewerPipelineDefinition,
	ViewerRun,
	ViewerVersion,
} from "@/shared/board-viewer"

/** The newest runs the panel lists. Older ones stay in their journals. */
export const VIEWER_MAX_RUNS = 40
/** A run's last events the panel gets, for Activity and the inspector. */
export const VIEWER_MAX_EVENTS = 500

export interface CollectInput {
	workspace: string
	/** The conversation's latest `task_graph` row text. */
	boardText?: string
	/** The board is the draft for the next new conversation. */
	boardDraft?: boolean
	catalog?: ViewerCatalog
	focus?: ViewerFocus
	maxRuns?: number
	maxEvents?: number
}

/**
 * Everything the board viewer shows, read from the workspace: the pipeline
 * files, the newest run journals folded the way the runner folds them, and
 * the conversation's board as it was handed in. Read-only, and safe on a
 * workspace with neither folder.
 */
export function collectViewerData(input: CollectInput): ViewerData {
	const { workspace } = input
	return {
		workspace,
		...(input.boardText ? { boardText: input.boardText } : {}),
		...(input.boardDraft ? { boardDraft: true } : {}),
		pipelines: readPipelines(workspace),
		runs: readRuns(workspace, input.maxRuns ?? VIEWER_MAX_RUNS, input.maxEvents ?? VIEWER_MAX_EVENTS),
		...(input.catalog ? { catalog: input.catalog } : {}),
		...(input.focus ? { focus: input.focus } : {}),
	}
}

function readPipelines(workspace: string): ViewerPipeline[] {
	let files: ReturnType<typeof listPipelines>
	try {
		files = listPipelines(workspace)
	} catch {
		return []
	}
	return files.map((file) => {
		const approvedText =
			file.approved && !file.isApproved ? readPipelineVersion(workspace, file.slug, file.approved.hash)?.text : undefined
		let versions: ViewerVersion[] = []
		try {
			versions = listPipelineVersions(workspace, file.slug).map(({ text: _text, ...version }) => version)
		} catch {
			versions = []
		}
		return {
			name: file.name,
			slug: file.slug,
			path: file.path,
			hash: file.hash,
			text: file.text,
			valid: file.valid,
			errors: file.errors,
			isApproved: file.isApproved,
			...(file.approved ? { approved: { ...file.approved } } : {}),
			...(file.definition ? { definition: file.definition as unknown as ViewerPipelineDefinition } : {}),
			...(file.author ? { author: file.author } : {}),
			...(approvedText !== undefined ? { approvedText } : {}),
			...(versions.length ? { versions } : {}),
		}
	})
}

function readRuns(workspace: string, maxRuns: number, maxEvents: number): ViewerRun[] {
	const dir = join(workspace, PIPELINE_RUNS_DIR)
	if (!existsSync(dir)) return []
	let journals: { id: string; path: string; mtime: number }[]
	try {
		journals = readdirSync(dir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => {
				const path = join(dir, file)
				return { id: file.slice(0, -".jsonl".length), path, mtime: statSync(path).mtimeMs }
			})
	} catch {
		return []
	}
	journals.sort((a, b) => b.mtime - a.mtime || b.id.localeCompare(a.id))
	const runs: ViewerRun[] = []
	for (const journal of journals.slice(0, maxRuns)) {
		const events = readJournal(journal.path)
		if (events.length === 0) continue
		const fold = foldJournal(events)
		const head = fold.run
		const nodes: Record<string, ViewerNodeState> = {}
		for (const [id, state] of fold.nodes) {
			nodes[id] = { ...state } as ViewerNodeState
		}
		runs.push({
			id: head?.run ?? journal.id,
			pipeline: head?.pipeline ?? journal.id,
			hash: head?.hash ?? "",
			status: fold.status,
			...(fold.startedAt !== undefined ? { startedAt: fold.startedAt } : {}),
			...(fold.endedAt !== undefined ? { endedAt: fold.endedAt } : {}),
			...(fold.error ? { error: fold.error } : {}),
			...(head?.task ? { task: head.task } : {}),
			...(head?.from ? { from: head.from } : {}),
			...(head?.parent ? { parent: head.parent } : {}),
			inputs: head?.inputs ?? {},
			...(head?.definition ? { definition: head.definition as unknown as ViewerPipelineDefinition } : {}),
			nodes,
			events: events.slice(-maxEvents) as unknown as ViewerEvent[],
			eventCount: events.length,
		})
	}
	return runs
}

/** The focus for a file the panel was opened from: a pipeline file names its pipeline. */
export function focusForFile(path: string | undefined): ViewerFocus | undefined {
	if (!path) return undefined
	const match = /[\\/]\.cerebriline[\\/]pipelines[\\/]([^\\/]+)\.pipeline\.json$/.exec(path)
	if (match) return { pipeline: match[1] }
	const run = /[\\/]\.cerebriline[\\/]pipeline-runs[\\/]([^\\/]+)\.jsonl$/.exec(path)
	return run ? { run: run[1] } : undefined
}
