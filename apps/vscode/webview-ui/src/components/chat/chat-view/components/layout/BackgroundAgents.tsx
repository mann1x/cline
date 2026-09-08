import { EmptyRequest } from "@shared/proto/cline/common"
import type { BackgroundDelegation } from "@shared/proto/cline/slash"
import { BackgroundDelegationControl } from "@shared/proto/cline/slash"
import { useCallback, useEffect, useRef, useState } from "react"
import { SlashServiceClient } from "@/services/grpc-client"

/** Fast enough to feel live, slow enough to cost nothing. */
const POLL_MS = 1000

/** Running or paused: the ones there is still anything to do about. */
function isLive(run: BackgroundDelegation): boolean {
	return run.status === "running" || run.status === "paused"
}

function elapsed(startedAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
	if (seconds < 60) {
		return `${seconds}s`
	}
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

function truncate(text: string, width: number): string {
	const trimmed = text.trim()
	return trimmed.length > width ? `${trimmed.slice(0, width)}...` : trimmed
}

/**
 * The agents working while the user carries on.
 *
 * Only live runs are shown. A finished one has already put its report into the
 * conversation, so a row left behind would claim work is still going on.
 *
 * Polled rather than pushed: the things that move a row -- a turn starting, a
 * tool starting -- happen several times a second per run, and a poll collapses
 * those into one redraw. It costs one call a second while something is running
 * and nothing at all while nothing is.
 */
export function BackgroundAgents() {
	const [runs, setRuns] = useState<BackgroundDelegation[]>([])
	// Read by the interval, which outlives the render that scheduled it.
	const hasLiveRef = useRef(false)

	const refresh = useCallback(() => {
		SlashServiceClient.listBackgroundDelegations(EmptyRequest.create({}))
			.then((response) => {
				const live = response.runs.filter(isLive)
				hasLiveRef.current = live.length > 0
				setRuns((previous) => (sameRows(previous, live) ? previous : live))
			})
			.catch(() => {
				// A session with no runtime for this has none to show, and a
				// panel is not the place to report that.
			})
	}, [])

	useEffect(() => {
		refresh()
		const timer = setInterval(refresh, POLL_MS)
		return () => clearInterval(timer)
	}, [refresh])

	const control = (id: string, action: "pause" | "resume" | "stop") => {
		SlashServiceClient.controlBackgroundDelegation(BackgroundDelegationControl.create({ id, action }))
			.then(refresh)
			.catch((error) => console.error("Failed to control a background agent:", error))
	}

	if (runs.length === 0) {
		return null
	}

	return (
		<div className="mx-3 mt-2.5 mb-2.5 rounded-xs border border-editor-group-border bg-code/70 px-2.5 py-2 shadow-xs">
			<div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-description">
				<span aria-hidden="true" className="codicon codicon-organization text-[12px]" />
				<span>{runs.length === 1 ? "1 background agent" : `${runs.length} background agents`}</span>
			</div>
			<div className="flex max-h-28 flex-col gap-1.5 overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
				{runs.map((run) => {
					const paused = run.status === "paused"
					return (
						<div
							className="flex items-start gap-2 rounded-[3px] bg-input-background/40 px-2 py-1.5 text-xs"
							key={run.id}>
							<span className="min-w-0 flex-1 break-words text-foreground">
								<span className="font-medium">{run.agentName}</span>
								<span className="text-description"> {truncate(run.prompt, 64)}</span>
							</span>
							<span className="flex h-5 shrink-0 items-center rounded-[3px] border border-editor-group-border px-1.5 text-[10px] leading-none text-description">
								{paused ? "paused" : (run.activity ?? "starting")}
								{run.iterations ? ` · turn ${run.iterations}` : ""} · {elapsed(Number(run.startedAt))}
							</span>
							<button
								aria-label={paused ? "Resume this agent" : "Pause this agent"}
								className="-my-1.5 flex size-5 shrink-0 items-center justify-center rounded-[3px] text-description hover:bg-toolbar-hover-background hover:text-foreground"
								onClick={() => control(run.id, paused ? "resume" : "pause")}
								title={
									paused
										? "Resume this agent"
										: "Pause this agent — it stops before its next request, not mid-answer"
								}
								type="button">
								<span
									aria-hidden="true"
									className={`codicon ${paused ? "codicon-play" : "codicon-debug-pause"} text-[12px]`}
								/>
							</button>
							<button
								aria-label="Stop this agent"
								className="-my-1.5 flex size-5 shrink-0 items-center justify-center rounded-[3px] text-description hover:bg-toolbar-hover-background hover:text-foreground"
								onClick={() => control(run.id, "stop")}
								title="Stop this agent — it reports nothing back"
								type="button">
								<span aria-hidden="true" className="codicon codicon-stop-circle text-[12px]" />
							</button>
						</div>
					)
				})}
			</div>
		</div>
	)
}

/**
 * Whether a redraw would show anything different.
 *
 * A poll returns fresh objects every time, and handing React new ones on every
 * tick re-renders the panel once a second for nothing.
 */
function sameRows(a: readonly BackgroundDelegation[], b: readonly BackgroundDelegation[]): boolean {
	if (a.length !== b.length) {
		return false
	}
	return a.every((run, index) => {
		const other = b[index]
		return (
			run.id === other.id &&
			run.status === other.status &&
			run.activity === other.activity &&
			run.iterations === other.iterations
		)
	})
}
