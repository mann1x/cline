import type { MemoryNoteView } from "@shared/retrieval-status"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import type { RetrievalStatusHandle } from "../utils/useRetrievalStatus"

interface MemoryNotesProps {
	retrieval: RetrievalStatusHandle
	/** The memory whose notes are shown. */
	name: string
	/** How it is named in the panel: "Main" for the main memory. */
	label: string
	onClose: () => void
}

type Filter = "all" | MemoryNoteView["status"]

const STATUS_LABEL: Record<MemoryNoteView["status"], string> = {
	noted: "noted",
	confirmed: "confirmed",
	outdated: "outdated",
}

/** The colour of a note's status chip: a verdict reads at a glance. */
const statusClass = (status: MemoryNoteView["status"]) =>
	status === "confirmed"
		? "border-(--vscode-testing-iconPassed) text-(--vscode-testing-iconPassed)"
		: status === "outdated"
			? "border-(--vscode-errorForeground) text-(--vscode-errorForeground)"
			: "border-(--vscode-panel-border) text-(--vscode-descriptionForeground)"

/**
 * One memory's notes, with the user's verdict on each.
 *
 * The model keeps notes and can only leave them noted. Here the user
 * confirms a note, marks it outdated with the reason, puts it back to
 * noted, or forgets it; and merges the notes that say the same. Each
 * verdict is kept with its reason, which the model is shown with the note. A
 * confirmed note is read as settled, an outdated one is not attached to a
 * message again.
 */
const MemoryNotes = ({ retrieval, name, label, onClose }: MemoryNotesProps) => {
	const { busy, run } = retrieval
	const [notes, setNotes] = useState<MemoryNoteView[]>()
	const [filter, setFilter] = useState<Filter>("all")
	const [settling, setSettling] = useState<{ id: string; status: "confirmed" | "outdated"; reason: string }>()
	const [confirmForget, setConfirmForget] = useState<string>()
	const [open, setOpen] = useState<string>()

	useEffect(() => {
		let cancelled = false
		void run({ action: "memoryNotes", name }).then((result) => {
			if (!cancelled && result?.notes) setNotes(result.notes)
		})
		return () => {
			cancelled = true
		}
	}, [name, run])

	const act = async (request: Parameters<typeof run>[0]) => {
		const result = await run(request)
		if (result?.notes) setNotes(result.notes)
	}

	if (!notes) {
		return <p className="text-xs text-(--vscode-descriptionForeground)">Reading the notes of “{label}”…</p>
	}
	const shown = filter === "all" ? notes : notes.filter((note) => note.status === filter)
	const counts = {
		noted: notes.filter((note) => note.status === "noted").length,
		confirmed: notes.filter((note) => note.status === "confirmed").length,
		outdated: notes.filter((note) => note.status === "outdated").length,
	}

	return (
		<div className="flex flex-col gap-2 border border-(--vscode-panel-border) p-2">
			<div className="flex items-center gap-2 flex-wrap">
				<div className="font-medium text-sm grow">Notes in “{label}”</div>
				<select
					aria-label="Show notes"
					className="text-xs bg-(--vscode-dropdown-background) text-(--vscode-dropdown-foreground) border border-(--vscode-dropdown-border)"
					onChange={(event) => setFilter(event.target.value as Filter)}
					value={filter}>
					<option value="all">All ({notes.length})</option>
					<option value="noted">Noted ({counts.noted})</option>
					<option value="confirmed">Confirmed ({counts.confirmed})</option>
					<option value="outdated">Outdated ({counts.outdated})</option>
				</select>
				<VSCodeButton
					appearance="secondary"
					disabled={busy || notes.length < 2}
					onClick={() => void act({ action: "consolidateMemory", name })}
					title="Merge the notes that say nearly the same into the oldest of them">
					Merge near-duplicates
				</VSCodeButton>
				<VSCodeButton appearance="icon" onClick={onClose}>
					Close
				</VSCodeButton>
			</div>
			<p className="text-xs text-(--vscode-descriptionForeground)">
				The model keeps notes as <b>noted</b>. Confirm the ones that hold, with why, and the model reads them as settled;
				mark one <b>outdated</b>, with why, and it is no longer attached to your messages.
			</p>
			{shown.length === 0 ? (
				<p className="text-xs text-(--vscode-descriptionForeground)">
					{notes.length === 0 ? "No notes yet." : "No notes with that status."}
				</p>
			) : (
				<ul className="flex flex-col gap-2 list-none p-0 m-0">
					{shown.map((note) => (
						<li className="border-t border-(--vscode-panel-border) pt-2 text-xs" key={note.id}>
							<div className="flex items-center gap-1 flex-wrap">
								<code>{note.id}</code>
								<span className={`border rounded-sm px-1 ${statusClass(note.status)}`}>
									{STATUS_LABEL[note.status]}
								</span>
								{note.kind !== "fact" ? <span className="border rounded-sm px-1">{note.kind}</span> : null}
								<span className="text-(--vscode-descriptionForeground)">
									{note.createdAt.slice(0, 10)}
									{note.by
										? `, by ${note.by === "model" ? "the model" : note.by === "user" ? "you" : "import"}`
										: ""}
									{note.recalled > 0 ? `, given ${note.recalled}×` : ""}
									{note.expiresAt ? `, expires ${note.expiresAt.slice(0, 10)}` : ""}
								</span>
							</div>
							<div className="mt-1 whitespace-pre-wrap">{note.text}</div>
							{note.reason ? <div className="mt-1">Because: {note.reason}</div> : null}
							{note.status === "outdated" && note.settledReason ? (
								<div className="mt-1 text-(--vscode-errorForeground)">Outdated: {note.settledReason}</div>
							) : null}
							{note.status === "confirmed" && note.settledReason ? (
								<div className="mt-1 text-(--vscode-testing-iconPassed)">Confirmed: {note.settledReason}</div>
							) : null}
							{note.places.length > 0 || note.tags.length > 0 ? (
								<div className="mt-1 text-(--vscode-descriptionForeground)">
									{note.places.length > 0 ? (
										<>
											at{" "}
											{note.places.map((place, index) => (
												<span key={place}>
													{index > 0 ? ", " : ""}
													<code>{place}</code>
												</span>
											))}
										</>
									) : null}
									{note.places.length > 0 && note.tags.length > 0 ? " · " : ""}
									{note.tags.length > 0 ? `tags: ${note.tags.join(", ")}` : ""}
								</div>
							) : null}
							{note.evidence.length > 0 || note.history.length > 0 || note.merged.length > 0 ? (
								<button
									className="mt-1 text-(--vscode-textLink-foreground) bg-transparent border-0 p-0 cursor-pointer text-xs"
									onClick={() => setOpen(open === note.id ? undefined : note.id)}
									type="button">
									{open === note.id ? "Hide" : "Show"} its evidence ({note.evidence.length}), earlier wording (
									{note.history.length})
									{note.merged.length > 0 ? ` and the notes merged into it (${note.merged.join(", ")})` : ""}
								</button>
							) : null}
							{open === note.id ? (
								<div className="mt-1 pl-2 border-l border-(--vscode-panel-border) flex flex-col gap-1">
									{note.evidence.map((line) => (
										<div key={line}>Evidence: {line}</div>
									))}
									{note.history.map((entry) => (
										<div key={entry.at}>
											Until {entry.at.slice(0, 10)}:{" "}
											<span className="whitespace-pre-wrap">{entry.text}</span>
										</div>
									))}
								</div>
							) : null}
							<div className="mt-1 flex items-center gap-1 flex-wrap">
								{settling?.id === note.id ? (
									<>
										<input
											aria-label={`Why ${note.id} is ${settling.status}`}
											className="grow bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-(--vscode-input-border) px-1"
											onChange={(event) => setSettling({ ...settling, reason: event.target.value })}
											onKeyDown={(event) => {
												if (event.key === "Escape") setSettling(undefined)
											}}
											placeholder={
												settling.status === "confirmed" ? "Why it holds" : "Why it no longer holds"
											}
											value={settling.reason}
										/>
										<VSCodeButton
											appearance="secondary"
											disabled={busy || settling.reason.trim() === ""}
											onClick={() => {
												void act({
													action: "settleNote",
													name,
													id: note.id,
													status: settling.status,
													reason: settling.reason,
												})
												setSettling(undefined)
											}}>
											{settling.status === "confirmed" ? "Confirm" : "Mark outdated"}
										</VSCodeButton>
										<VSCodeButton appearance="icon" onClick={() => setSettling(undefined)}>
											Cancel
										</VSCodeButton>
									</>
								) : confirmForget === note.id ? (
									<>
										<VSCodeButton
											appearance="secondary"
											disabled={busy}
											onClick={() => {
												void act({ action: "forgetNote", name, id: note.id })
												setConfirmForget(undefined)
											}}>
											Forget {note.id}
										</VSCodeButton>
										<VSCodeButton appearance="icon" onClick={() => setConfirmForget(undefined)}>
											Keep
										</VSCodeButton>
									</>
								) : (
									<>
										{note.status !== "confirmed" ? (
											<VSCodeButton
												appearance="icon"
												disabled={busy}
												onClick={() => setSettling({ id: note.id, status: "confirmed", reason: "" })}>
												Confirm…
											</VSCodeButton>
										) : null}
										{note.status !== "outdated" ? (
											<VSCodeButton
												appearance="icon"
												disabled={busy}
												onClick={() => setSettling({ id: note.id, status: "outdated", reason: "" })}>
												Outdated…
											</VSCodeButton>
										) : null}
										{note.status !== "noted" ? (
											<VSCodeButton
												appearance="icon"
												disabled={busy}
												onClick={() =>
													void act({ action: "settleNote", name, id: note.id, status: "noted" })
												}>
												Back to noted
											</VSCodeButton>
										) : null}
										<VSCodeButton appearance="icon" disabled={busy} onClick={() => setConfirmForget(note.id)}>
											Forget
										</VSCodeButton>
									</>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

export default MemoryNotes
