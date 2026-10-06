import { MAIN_MEMORY, type MemorySelection } from "@cline/shared"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { DebouncedTextField } from "../common/DebouncedTextField"
import type { RetrievalStatusHandle } from "../utils/useRetrievalStatus"

interface MemoryListProps {
	retrieval: RetrievalStatusHandle
	/** What this workspace's sessions use now. */
	selection: MemorySelection
	onSelect: (next: MemorySelection) => void
}

/** The name a workspace's own memory is offered under: its folder's. */
const workspaceMemoryName = (name: string) => name.trim() || "workspace"

/**
 * Every memory there is, whatever workspace it was made for, with what this
 * workspace's sessions may do with each: search it (any number), and keep
 * new notes in it (exactly one).
 */
const MemoryList = ({ retrieval, selection, onSelect }: MemoryListProps) => {
	const { status, busy, run, message, error } = retrieval
	const [newName, setNewName] = useState("")
	const [nameFieldKey, setNameFieldKey] = useState(0)
	const [confirmDelete, setConfirmDelete] = useState<string>()

	if (!status) {
		return null
	}
	const { memories } = status.memory
	const workspace = status.workspace
	const forThisWorkspace = memories.find((memory) => memory.workspace === workspace.key && workspace.key !== "")
	const names = new Set(memories.map((memory) => memory.name))
	// A choice naming a memory that is gone is shown as what it now does.
	const store = names.has(selection.store) ? selection.store : MAIN_MEMORY
	const recall = new Set(selection.recall.filter((name) => names.has(name)))

	const setRecall = (name: string, on: boolean) => {
		const next = new Set(recall)
		if (on) next.add(name)
		else next.delete(name)
		onSelect({ store, recall: memories.map((memory) => memory.name).filter((entry) => next.has(entry)) })
	}
	const create = async (name: string, forWorkspace: boolean) => {
		const result = await run({ action: "createMemory", name, ...(forWorkspace ? { forWorkspace: true } : {}) })
		if (result?.ok) {
			// Made for this workspace: searched here from now on. Where notes
			// are kept is left as it was, for the user to move.
			const made = result.status.memory.memories.find((memory) => !names.has(memory.name))
			if (made && forWorkspace) {
				onSelect({ store, recall: [...recall, made.name] })
			}
			setNewName("")
			setNameFieldKey((key) => key + 1)
		}
	}
	const remove = async (name: string) => {
		setConfirmDelete(undefined)
		const result = await run({ action: "deleteMemory", name })
		if (result?.ok && (selection.store === name || selection.recall.includes(name))) {
			onSelect({
				store: selection.store === name ? MAIN_MEMORY : store,
				recall: [...recall].filter((entry) => entry !== name),
			})
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<div>
				<div className="font-medium text-sm">Memories</div>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					All memories are kept in one place and listed here whichever workspace is open. For this workspace
					{workspace.path ? (
						<>
							{" "}
							(<code>{workspace.path}</code>)
						</>
					) : null}
					, tick <b>Recall</b> on every memory its tasks may search, and pick the one memory new notes are <b>stored</b>{" "}
					in. The model cannot reach a memory that is not ticked here.
				</p>
			</div>

			<table className="w-full text-xs border-collapse">
				<thead>
					<tr className="text-left text-(--vscode-descriptionForeground)">
						<th className="font-normal py-1 pr-2">Memory</th>
						<th className="font-normal py-1 pr-2">Notes</th>
						<th className="font-normal py-1 pr-2 text-center">Recall</th>
						<th className="font-normal py-1 pr-2 text-center">Store</th>
						<th className="font-normal py-1" />
					</tr>
				</thead>
				<tbody>
					{memories.map((memory) => (
						<tr className="border-t border-(--vscode-panel-border)" key={memory.name}>
							<td className="py-1 pr-2">
								<div>{memory.main ? "Main" : memory.name}</div>
								<div className="text-(--vscode-descriptionForeground)">
									{memory.main
										? "the memory every workspace starts on"
										: memory.workspace
											? memory.workspace === workspace.key
												? "made for this workspace"
												: `made for ${memory.workspace}`
											: "not tied to a workspace"}
								</div>
							</td>
							<td className="py-1 pr-2 tabular-nums">{memory.notes}</td>
							<td className="py-1 pr-2 text-center">
								<input
									aria-label={`Recall from ${memory.name}`}
									checked={recall.has(memory.name)}
									onChange={(event) => setRecall(memory.name, event.target.checked)}
									type="checkbox"
								/>
							</td>
							<td className="py-1 pr-2 text-center">
								<input
									aria-label={`Store to ${memory.name}`}
									checked={store === memory.name}
									name="memory-store"
									onChange={() => onSelect({ store: memory.name, recall: [...recall] })}
									type="radio"
								/>
							</td>
							<td className="py-1 text-right whitespace-nowrap">
								{confirmDelete === memory.name ? (
									<>
										<VSCodeButton
											appearance="secondary"
											disabled={busy}
											onClick={() => void remove(memory.name)}>
											Delete {memory.notes} note{memory.notes === 1 ? "" : "s"}
										</VSCodeButton>{" "}
										<VSCodeButton appearance="icon" onClick={() => setConfirmDelete(undefined)}>
											Keep
										</VSCodeButton>
									</>
								) : (
									<>
										<VSCodeButton
											appearance="icon"
											disabled={busy}
											onClick={() => void run({ action: "exportMemory", name: memory.name })}
											title={`Write "${memory.name}" to a file`}>
											Export
										</VSCodeButton>
										{memory.main ? null : (
											<VSCodeButton
												appearance="icon"
												disabled={busy}
												onClick={() => setConfirmDelete(memory.name)}
												title={`Delete "${memory.name}" and its notes`}>
												Delete
											</VSCodeButton>
										)}
									</>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{recall.size === 0 ? (
				<p className="text-xs text-(--vscode-errorForeground)">
					No memory is ticked for recall: this workspace's tasks find no notes, though they still store them.
				</p>
			) : !recall.has(store) ? (
				<p className="text-xs text-(--vscode-descriptionForeground)">
					Notes are stored in “{store === MAIN_MEMORY ? "Main" : store}”, which is not ticked for recall here: this
					workspace writes notes it does not read back.
				</p>
			) : null}

			{workspace.key && !forThisWorkspace ? (
				<div>
					<VSCodeButton
						appearance="secondary"
						disabled={busy}
						onClick={() => void create(workspaceMemoryName(workspace.name), true)}>
						Create a memory for this workspace ({workspaceMemoryName(workspace.name)})
					</VSCodeButton>
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						This workspace has no memory of its own. A new one is ticked for recall here; where notes are stored stays
						as it is until you move it.
					</p>
				</div>
			) : null}

			<div className="flex items-end gap-2">
				<div className="grow">
					<DebouncedTextField
						className="w-full"
						initialValue=""
						key={nameFieldKey}
						onChange={(value) => setNewName(value)}
						placeholder="A name, e.g. a client or a topic">
						<span className="font-medium">New memory</span>
					</DebouncedTextField>
				</div>
				<VSCodeButton
					appearance="secondary"
					disabled={busy || newName.trim() === ""}
					onClick={() => void create(newName, false)}>
					Create
				</VSCodeButton>
				<VSCodeButton
					appearance="secondary"
					disabled={busy}
					onClick={() => void run({ action: "importMemory" })}
					title="Read a memory written by Export, here or on another machine">
					Import…
				</VSCodeButton>
			</div>
			{message ? <p className="text-xs text-(--vscode-descriptionForeground)">{message}</p> : null}
			{error ? <p className="text-xs text-(--vscode-errorForeground)">{error}</p> : null}
		</div>
	)
}

export default MemoryList
