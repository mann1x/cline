import type { RetrievalStatus } from "@shared/retrieval-status"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import type { RetrievalStatusHandle } from "../utils/useRetrievalStatus"

const megabytes = (bytes: number | undefined) => (bytes ? ` (about ${Math.round(bytes / 1024 / 1024)} MB)` : "")

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
	if (!status) {
		return <p className="text-xs text-(--vscode-descriptionForeground)">Reading the search engine's status…</p>
	}
	const { lancedb, embeddingModel } = status
	const described = describeLanceDb(lancedb)
	const canDownload = !lancedb.installed && !lancedb.installing && !lancedb.unsupported
	const stored =
		kind === "library"
			? `${status.library.documents} document${status.library.documents === 1 ? "" : "s"} in ${status.library.collections} collection${status.library.collections === 1 ? "" : "s"}, ${status.library.passages} passage${status.library.passages === 1 ? "" : "s"}`
			: `${status.memory.notes} note${status.memory.notes === 1 ? "" : "s"} in ${status.memory.memories.length} ${status.memory.memories.length === 1 ? "memory" : "memories"}`
	const total = kind === "library" ? status.library.documents : status.memory.notes
	const embedded = kind === "library" ? status.library.embeddedDocuments : status.memory.embeddedNotes
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
					: "none set. Tick “Use an embedding model” in the API configuration and name one on its Embedding tab."}
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
			{lancedb.installed && lancedb.working && !embeddingModel ? (
				<div className="text-(--vscode-descriptionForeground)">
					LanceDB is ready, and nothing uses it until an embedding model is named.
				</div>
			) : null}
		</div>
	)
}

export default RetrievalEngineStatus
