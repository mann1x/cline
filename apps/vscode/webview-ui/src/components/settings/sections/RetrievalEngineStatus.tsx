import type { RetrievalStatus } from "@shared/retrieval-status"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import type { RetrievalStatusHandle } from "../utils/useRetrievalStatus"

const megabytes = (bytes: number | undefined) => (bytes ? ` (about ${Math.round(bytes / 1024 / 1024)} MB)` : "")

/** A size on disk, in the unit that keeps it to a few digits. */
export function diskSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
	return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** LanceDB in one line, as a user would say it. */
export function describeLanceDb(lancedb: RetrievalStatus["lancedb"]): { state: string; tone: "ok" | "off" | "bad" } {
	if (lancedb.installing) {
		const progress = lancedb.progress
		return {
			state: progress
				? `Downloading LanceDB ${lancedb.version}: package ${progress.packageIndex + 1} of ${progress.packageCount}`
				: `Downloading LanceDB ${lancedb.version}`,
			tone: "off",
		}
	}
	if (lancedb.unsupported) {
		return { state: lancedb.unsupported, tone: "bad" }
	}
	if (!lancedb.installed) {
		return { state: `LanceDB ${lancedb.version} is not downloaded`, tone: "off" }
	}
	if (!lancedb.working) {
		return {
			state: `LanceDB ${lancedb.version} is downloaded but did not load: ${lancedb.error ?? "no reason given"}`,
			tone: "bad",
		}
	}
	return { state: `LanceDB ${lancedb.version} is downloaded and working`, tone: "ok" }
}

const TONE = {
	ok: "text-(--vscode-testing-iconPassed)",
	off: "text-(--vscode-descriptionForeground)",
	bad: "text-(--vscode-errorForeground)",
} as const

interface RetrievalEngineStatusProps {
	retrieval: RetrievalStatusHandle
	/** Which panel it is shown in: decides the counts under it. */
	kind: "library" | "memory"
}

/**
 * Where search by meaning stands: whether LanceDB is there and loads, which
 * embedding model feeds it, and how much of what is stored has vectors.
 * With a button to download it, because ticking "Use an embedding model" is
 * the only other thing that does, and that box is on another panel.
 */
const RetrievalEngineStatus = ({ retrieval, kind }: RetrievalEngineStatusProps) => {
	const { status, busy, run } = retrieval
	const [confirmDelete, setConfirmDelete] = useState<string>()
	if (!status) {
		return <p className="text-xs text-(--vscode-descriptionForeground)">Reading the search engine's status…</p>
	}
	const { lancedb, embeddingModel, embedding } = status
	const described = describeLanceDb(lancedb)
	const canDownload = !lancedb.installed && !lancedb.installing && !lancedb.unsupported
	const stored =
		kind === "library"
			? `${status.library.documents} document${status.library.documents === 1 ? "" : "s"} in ${status.library.collections} collection${status.library.collections === 1 ? "" : "s"}, ${status.library.passages} passage${status.library.passages === 1 ? "" : "s"}`
			: `${status.memory.notes} note${status.memory.notes === 1 ? "" : "s"} in ${status.memory.memories.length} ${status.memory.memories.length === 1 ? "memory" : "memories"}`
	const total = kind === "library" ? status.library.documents : status.memory.notes
	const embedded = kind === "library" ? status.library.embeddedDocuments : status.memory.embeddedNotes
	const things = kind === "library" ? "document" : "note"
	const waiting = Math.max(0, total - embedded)
	const job = status.embedJobs?.[kind]
	const vectorSets = (kind === "library" ? status.library.vectorSets : status.memory.vectorSets) ?? []
	const canEmbed = lancedb.installed && lancedb.working && embeddingModel !== undefined && waiting > 0 && !job?.running
	return (
		<div className="rounded border border-(--vscode-panel-border) p-2 text-xs flex flex-col gap-1">
			<div className="font-medium text-sm">Search engine</div>
			<div>
				<span className="text-(--vscode-descriptionForeground)">Stored: </span>
				{stored}
			</div>
			<div>
				<span className="text-(--vscode-descriptionForeground)">By keyword: </span>
				working, nothing to download
			</div>
			<div>
				<span className="text-(--vscode-descriptionForeground)">By meaning: </span>
				<span className={TONE[described.tone]}>{described.state}</span>
			</div>
			<div>
				<span className="text-(--vscode-descriptionForeground)">Embedding model: </span>
				{embeddingModel
					? `${embeddingModel}, ${embedded} of ${total} ${kind === "library" ? "documents" : "notes"} have vectors`
					: `none in use. ${embedding.problem ?? "Name one on the Embedding tab of the API configuration."}`}
			</div>
			{lancedb.lastInstallError && !lancedb.installing && !lancedb.installed ? (
				<div className={TONE.bad}>The last download failed: {lancedb.lastInstallError}</div>
			) : null}
			{canDownload ? (
				<div className="mt-1">
					<VSCodeButton appearance="secondary" disabled={busy} onClick={() => void run({ action: "installVectors" })}>
						Download LanceDB{megabytes(lancedb.installBytes)}
					</VSCodeButton>
				</div>
			) : null}
			{job?.running ? (
				<div>
					Embedding with {embeddingModel}: {job.total > 0 ? `${job.done} of ${job.total} ${things}s` : "starting"}…
				</div>
			) : null}
			{canEmbed ? (
				<div className="mt-1">
					<VSCodeButton
						appearance="secondary"
						disabled={busy}
						onClick={() => void run({ action: "embedNow", target: kind })}>
						Embed {waiting} {things}
						{waiting === 1 ? "" : "s"} now
					</VSCodeButton>
					<p className="mt-1 text-(--vscode-descriptionForeground)">
						{waiting === total
							? `Nothing here has vectors for ${embeddingModel} yet, so it is found by keyword only.`
							: `${waiting} of ${total} ${things}s have no vectors for ${embeddingModel} and are found by keyword only.`}{" "}
						Otherwise they are embedded the next time {kind === "library" ? "a document is added" : "a note is kept"}.
					</p>
				</div>
			) : null}
			{!job?.running && job?.result ? <div className="text-(--vscode-descriptionForeground)">{job.result}</div> : null}
			{!job?.running && job?.error ? <div className={TONE.bad}>{job.error}</div> : null}
			{vectorSets.length > 0 ? (
				<div className="mt-1">
					<div className="text-(--vscode-descriptionForeground)">
						Vectors on disk, one set per embedding model and vector size. A set that is not in use is kept so that
						going back to its model costs nothing.
					</div>
					{vectorSets.map((set) => (
						<div className="flex items-center justify-between gap-2" key={set.table}>
							<span>
								{set.model}, {set.dimension} dimensions, {set.vectors} vector{set.vectors === 1 ? "" : "s"},{" "}
								{diskSize(set.bytes)}
								{set.current ? " (in use)" : ""}
							</span>
							{set.current ? null : confirmDelete === set.table ? (
								<span className="whitespace-nowrap">
									<VSCodeButton
										appearance="secondary"
										disabled={busy}
										onClick={() => {
											setConfirmDelete(undefined)
											void run({ action: "deleteVectors", target: kind, table: set.table })
										}}>
										Delete {set.vectors} vectors
									</VSCodeButton>{" "}
									<VSCodeButton appearance="icon" onClick={() => setConfirmDelete(undefined)}>
										Keep
									</VSCodeButton>
								</span>
							) : (
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={() => setConfirmDelete(set.table)}
									title={`Delete the vectors made with ${set.model}`}>
									Delete
								</VSCodeButton>
							)}
						</div>
					))}
				</div>
			) : null}
			{lancedb.installed && lancedb.working && !embeddingModel ? (
				<div className="text-(--vscode-descriptionForeground)">
					LanceDB is ready, and nothing uses it until an embedding model is named.
				</div>
			) : null}
		</div>
	)
}

export default RetrievalEngineStatus
