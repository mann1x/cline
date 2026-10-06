import type { LibraryBookDetails, LibraryBookView, LibrarySectionView, LibraryShelfView } from "@shared/retrieval-status"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useState } from "react"
import { SettingsCheckbox } from "../common/SettingsCheckbox"
import type { RetrievalStatusHandle } from "../utils/useRetrievalStatus"

interface LibraryBrowserProps {
	retrieval: RetrievalStatusHandle
}

/** What is being typed into, or confirmed: one thing at a time. */
type Pending =
	| { kind: "newSection"; value: string }
	| { kind: "newShelf"; sectionId: number; value: string }
	| { kind: "renameSection"; id: number; value: string }
	| { kind: "renameShelf"; id: number; value: string }
	| { kind: "renameBook"; id: number; value: string }
	| { kind: "deleteSection"; id: number }
	| { kind: "deleteShelf"; id: number }
	| { kind: "deleteBook"; id: number }
	| { kind: "purgeBook"; id: number }
	| { kind: "emptyTrash" }

const TRASH = -1
const muted = "text-(--vscode-descriptionForeground)"
const input =
	"flex-1 min-w-0 bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-(--vscode-input-border) px-1"
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const kb = (bytes: number) =>
	bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * The Library's shelves: sections, the shelves in them, the books on a
 * shelf, and the trash. Everything the librarian can do is here to do by
 * hand, and one thing more: deleting from the trash for good.
 */
const LibraryBrowser = ({ retrieval }: LibraryBrowserProps) => {
	const { status, busy, run, ask, message, error } = retrieval
	const [open, setOpen] = useState<number>()
	const [books, setBooks] = useState<LibraryBookView[]>([])
	const [details, setDetails] = useState<LibraryBookDetails>()
	const [pending, setPending] = useState<Pending>()

	const load = useCallback(
		async (shelfId: number | undefined) => {
			if (shelfId === undefined) {
				setBooks([])
				return
			}
			const result = await ask(shelfId === TRASH ? { action: "libraryTrash" } : { action: "libraryBooks", shelfId })
			setBooks(result?.books ?? [])
		},
		[ask],
	)
	useEffect(() => {
		void load(open)
	}, [open, load])

	if (!status) {
		return null
	}
	const { catalogue } = status
	const shelves = catalogue.sections.flatMap((section) =>
		section.shelves.map((shelf) => ({ ...shelf, label: `${section.name} / ${shelf.name}` })),
	)

	/** Do it, then show the open shelf as it now is. */
	const act = async (action: Parameters<typeof run>[0]) => {
		setPending(undefined)
		const result = await run(action)
		await load(open)
		return result
	}
	const showDetails = async (bookId: number) => {
		if (details?.id === bookId) {
			setDetails(undefined)
			return
		}
		setDetails((await ask({ action: "libraryBook", bookId }))?.book)
	}
	const refreshDetails = async () => {
		if (details) {
			setDetails((await ask({ action: "libraryBook", bookId: details.id }))?.book)
		}
	}

	const nameField = (label: string, save: (value: string) => void) =>
		pending && "value" in pending ? (
			<span className="flex items-center gap-1 flex-1 min-w-0">
				<input
					aria-label={label}
					// biome-ignore lint/a11y/noAutofocus: the field appears because its button was just pressed
					autoFocus
					className={input}
					maxLength={120}
					onChange={(event) => setPending({ ...pending, value: event.target.value } as Pending)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && pending.value.trim()) save(pending.value)
						if (event.key === "Escape") setPending(undefined)
					}}
					value={pending.value}
				/>
				<VSCodeButton appearance="secondary" disabled={busy || !pending.value.trim()} onClick={() => save(pending.value)}>
					Save
				</VSCodeButton>
				<VSCodeButton appearance="icon" onClick={() => setPending(undefined)}>
					Cancel
				</VSCodeButton>
			</span>
		) : null

	const confirm = (label: string, yes: () => void) => (
		<span className="whitespace-nowrap">
			<VSCodeButton appearance="secondary" disabled={busy} onClick={yes}>
				{label}
			</VSCodeButton>{" "}
			<VSCodeButton appearance="icon" onClick={() => setPending(undefined)}>
				Keep
			</VSCodeButton>
		</span>
	)

	const bookRow = (book: LibraryBookView) => {
		const trashed = book.trashedAt !== undefined
		return (
			<div className="py-1 border-t border-(--vscode-panel-border)" key={book.id}>
				<div className="flex items-start gap-2">
					<div className="flex-1 min-w-0">
						{pending?.kind === "renameBook" && pending.id === book.id ? (
							nameField(
								`New title for ${book.title}`,
								(value) => void act({ action: "libraryBookEdit", bookId: book.id, title: value }),
							)
						) : (
							<div className="break-words">
								{book.title}
								{book.edition || book.year ? (
									<span className={muted}> ({[book.edition, book.year].filter(Boolean).join(", ")})</span>
								) : null}
							</div>
						)}
						<div className={muted}>
							{book.authors?.length ? `${book.authors.join(", ")} · ` : ""}
							{book.web ? "web pages · " : ""}
							{count(book.sources, "source")}, {count(book.passages, "passage")}
							{trashed ? ` · was on ${book.trashedFrom} · deleted for good on ${book.purgedOn}` : ""}
						</div>
					</div>
					<div className="text-right whitespace-nowrap">
						{pending?.kind === "deleteBook" && pending.id === book.id ? (
							confirm("Move to trash", () => void act({ action: "libraryBookDelete", bookId: book.id }))
						) : pending?.kind === "purgeBook" && pending.id === book.id ? (
							confirm("Delete for good", () => void act({ action: "libraryBookPurge", bookId: book.id }))
						) : trashed ? (
							<>
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={() => void act({ action: "libraryBookRestore", bookId: book.id })}
									title={`Put "${book.title}" back on its shelf`}>
									Restore
								</VSCodeButton>
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={() => setPending({ kind: "purgeBook", id: book.id })}
									title={`Delete "${book.title}" for good`}>
									Delete
								</VSCodeButton>
							</>
						) : (
							<>
								<VSCodeButton
									appearance="icon"
									onClick={() => void showDetails(book.id)}
									title="What it was made from">
									{details?.id === book.id ? "Hide" : "Details"}
								</VSCodeButton>
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={() => setPending({ kind: "renameBook", id: book.id, value: book.title })}>
									Rename
								</VSCodeButton>
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={() => void run({ action: "libraryExport", bookId: book.id })}
									title={`Write "${book.title}" to a file`}>
									Export
								</VSCodeButton>
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={() => setPending({ kind: "deleteBook", id: book.id })}>
									Delete
								</VSCodeButton>
							</>
						)}
					</div>
				</div>
				{!trashed && shelves.length > 1 ? (
					<label className={`flex items-center gap-1 mt-1 ${muted}`}>
						Shelf
						<select
							aria-label={`Shelf of ${book.title}`}
							className="bg-(--vscode-dropdown-background) text-(--vscode-dropdown-foreground) border border-(--vscode-dropdown-border)"
							disabled={busy}
							onChange={(event) =>
								void act({ action: "libraryBookEdit", bookId: book.id, shelfId: Number(event.target.value) })
							}
							value={book.shelfId}>
							{shelves.map((shelf) => (
								<option key={shelf.id} value={shelf.id}>
									{shelf.label}
								</option>
							))}
						</select>
					</label>
				) : null}
				{details?.id === book.id ? (
					<div className="mt-1 pl-2 border-l border-(--vscode-panel-border)">
						{details.description ? <div className="break-words">{details.description}</div> : null}
						<div className={`break-all ${muted}`}>
							Kept in <code>{details.directory}</code>
							{details.pictures > 0
								? ` · ${count(details.pictures, "picture")}, ${details.describedPictures} described`
								: ""}
						</div>
						{details.sourceList.map((source) => (
							<div className="flex items-center gap-2" key={source.id}>
								<span className={`flex-1 min-w-0 break-all ${source.removedAt ? "line-through opacity-70" : ""}`}>
									{source.url ?? source.name} <span className={muted}>· {kb(source.bytes)}</span>
								</span>
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={async () => {
										await run({
											action: "librarySource",
											op: source.removedAt ? "restore" : "remove",
											sourceId: source.id,
										})
										await refreshDetails()
										await load(open)
									}}
									title={
										source.removedAt
											? "Put this source back in the book"
											: `Take this source out; it is kept ${catalogue.trashDays} days`
									}>
									{source.removedAt ? "Restore" : "Remove"}
								</VSCodeButton>
							</div>
						))}
					</div>
				) : null}
			</div>
		)
	}

	const shelfRow = (section: LibrarySectionView, shelf: LibraryShelfView) => (
		<div className="pl-3" key={shelf.id}>
			<div className="flex items-center gap-2 py-0.5">
				{pending?.kind === "renameShelf" && pending.id === shelf.id ? (
					nameField(
						`New name for ${shelf.name}`,
						(value) => void act({ action: "libraryShelf", op: "update", id: shelf.id, name: value }),
					)
				) : (
					<button
						aria-expanded={open === shelf.id}
						className="flex-1 min-w-0 text-left bg-transparent border-0 p-0 text-(--vscode-foreground) cursor-pointer"
						onClick={() => {
							setDetails(undefined)
							setOpen(open === shelf.id ? undefined : shelf.id)
						}}
						type="button">
						<span className={`codicon codicon-chevron-${open === shelf.id ? "down" : "right"} align-middle`} />{" "}
						{shelf.name} <span className={muted}>· {count(shelf.books, "book")}</span>
					</button>
				)}
				<span className="whitespace-nowrap">
					{pending?.kind === "deleteShelf" && pending.id === shelf.id ? (
						confirm(
							shelf.books > 0 ? `Remove, ${count(shelf.books, "book")} to trash` : "Remove shelf",
							() => void act({ action: "libraryShelf", op: "delete", id: shelf.id }),
						)
					) : (
						<>
							{catalogue.sections.length > 1 ? (
								<select
									aria-label={`Section of ${shelf.name}`}
									className="bg-(--vscode-dropdown-background) text-(--vscode-dropdown-foreground) border border-(--vscode-dropdown-border) align-middle"
									disabled={busy}
									onChange={(event) =>
										void act({
											action: "libraryShelf",
											op: "update",
											id: shelf.id,
											sectionId: Number(event.target.value),
										})
									}
									title="Move this shelf to another section"
									value={section.id}>
									{catalogue.sections.map((entry) => (
										<option key={entry.id} value={entry.id}>
											{entry.name}
										</option>
									))}
								</select>
							) : null}
							<VSCodeButton
								appearance="icon"
								disabled={busy}
								onClick={() => setPending({ kind: "renameShelf", id: shelf.id, value: shelf.name })}>
								Rename
							</VSCodeButton>
							<VSCodeButton
								appearance="icon"
								disabled={busy || shelf.books === 0}
								onClick={() => void run({ action: "libraryExport", shelfId: shelf.id })}>
								Export
							</VSCodeButton>
							<VSCodeButton
								appearance="icon"
								disabled={busy}
								onClick={() => setPending({ kind: "deleteShelf", id: shelf.id })}>
								Delete
							</VSCodeButton>
						</>
					)}
				</span>
			</div>
			{open === shelf.id ? (
				<div className="pl-4 pb-1">
					{books.length === 0 ? <div className={muted}>No books on this shelf.</div> : books.map(bookRow)}
				</div>
			) : null}
		</div>
	)

	return (
		<div className="flex flex-col gap-2 text-xs">
			<div className="pt-3 border-t border-(--vscode-panel-border) font-medium text-sm">Shelves</div>
			<div>
				<SettingsCheckbox
					checked={catalogue.librarian}
					onChange={async (checked) => {
						await run({ action: "setLibrarian", enabled: checked })
					}}>
					Let the model act as librarian
				</SettingsCheckbox>
				<p className={`mt-1 ${muted}`}>
					Turns on the built-in <code>librarian</code> skill and its tools, so a task can add books, sort them onto
					shelves, check for duplicates and other editions, and make books from web pages. Ask for it: “act as a
					librarian, catalogue these ebooks”. Without it a task can search the Library and not change it. Whatever the
					model deletes goes to the trash here for {catalogue.trashDays} days.
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<span className="flex-1">
					{count(catalogue.sections.length, "section")}, {count(shelves.length, "shelf", "shelves")},{" "}
					{count(catalogue.books, "book")}
				</span>
				<VSCodeButton
					appearance="secondary"
					disabled={busy}
					onClick={() => setPending({ kind: "newSection", value: "" })}>
					New section
				</VSCodeButton>
				<VSCodeButton appearance="secondary" disabled={busy} onClick={() => void act({ action: "libraryImport" })}>
					Import…
				</VSCodeButton>
				<VSCodeButton
					appearance="secondary"
					disabled={busy || catalogue.books === 0}
					onClick={() => void run({ action: "libraryExport" })}>
					Export all…
				</VSCodeButton>
			</div>
			{pending?.kind === "newSection" ? (
				<div className="flex">
					{nameField(
						"Name of the new section",
						(value) => void act({ action: "librarySection", op: "create", name: value }),
					)}
				</div>
			) : null}

			{catalogue.sections.length === 0 ? (
				<p className={muted}>
					Nothing on the shelves yet. Make a section and a shelf here, or let the librarian make them as it adds books.
				</p>
			) : null}
			{catalogue.sections.map((section) => (
				<div className="border border-(--vscode-panel-border) rounded-sm p-2" key={section.id}>
					<div className="flex items-center gap-2">
						{pending?.kind === "renameSection" && pending.id === section.id ? (
							nameField(
								`New name for ${section.name}`,
								(value) => void act({ action: "librarySection", op: "update", id: section.id, name: value }),
							)
						) : (
							<span className="flex-1 min-w-0 font-medium break-words">{section.name}</span>
						)}
						<span className="whitespace-nowrap">
							{pending?.kind === "deleteSection" && pending.id === section.id ? (
								confirm(
									`Remove with ${count(section.shelves.length, "shelf", "shelves")}`,
									() => void act({ action: "librarySection", op: "delete", id: section.id }),
								)
							) : (
								<>
									<VSCodeButton
										appearance="icon"
										disabled={busy}
										onClick={() => setPending({ kind: "newShelf", sectionId: section.id, value: "" })}>
										New shelf
									</VSCodeButton>
									<VSCodeButton
										appearance="icon"
										disabled={busy}
										onClick={() =>
											setPending({ kind: "renameSection", id: section.id, value: section.name })
										}>
										Rename
									</VSCodeButton>
									<VSCodeButton
										appearance="icon"
										disabled={busy || section.shelves.every((shelf) => shelf.books === 0)}
										onClick={() => void run({ action: "libraryExport", sectionId: section.id })}>
										Export
									</VSCodeButton>
									<VSCodeButton
										appearance="icon"
										disabled={busy}
										onClick={() => setPending({ kind: "deleteSection", id: section.id })}>
										Delete
									</VSCodeButton>
								</>
							)}
						</span>
					</div>
					{pending?.kind === "newShelf" && pending.sectionId === section.id ? (
						<div className="flex pl-3 py-0.5">
							{nameField(
								`Name of the new shelf in ${section.name}`,
								(value) => void act({ action: "libraryShelf", op: "create", sectionId: section.id, name: value }),
							)}
						</div>
					) : null}
					{section.shelves.length === 0 ? <div className={`pl-3 ${muted}`}>No shelves.</div> : null}
					{section.shelves.map((shelf) => shelfRow(section, shelf))}
				</div>
			))}

			{catalogue.trash > 0 ? (
				<div className="border border-(--vscode-panel-border) rounded-sm p-2">
					<div className="flex items-center gap-2">
						<button
							aria-expanded={open === TRASH}
							className="flex-1 text-left bg-transparent border-0 p-0 text-(--vscode-foreground) cursor-pointer"
							onClick={() => {
								setDetails(undefined)
								setOpen(open === TRASH ? undefined : TRASH)
							}}
							type="button">
							<span className={`codicon codicon-chevron-${open === TRASH ? "down" : "right"} align-middle`} /> Trash{" "}
							<span className={muted}>
								· {count(catalogue.trash, "book")}, each kept {catalogue.trashDays} days
							</span>
						</button>
						{pending?.kind === "emptyTrash" ? (
							confirm(
								`Delete ${count(catalogue.trash, "book")} for good`,
								() => void act({ action: "libraryEmptyTrash" }),
							)
						) : (
							<VSCodeButton appearance="icon" disabled={busy} onClick={() => setPending({ kind: "emptyTrash" })}>
								Empty
							</VSCodeButton>
						)}
					</div>
					{open === TRASH ? <div className="pl-4">{books.map(bookRow)}</div> : null}
				</div>
			) : null}

			{catalogue.problems.length > 0 ? (
				<div className="text-(--vscode-errorForeground)">
					{catalogue.problems.slice(0, 20).map((problem) => (
						<div key={problem}>{problem}</div>
					))}
				</div>
			) : null}
			{message ? <p className={muted}>{message}</p> : null}
			{error ? <p className="text-(--vscode-errorForeground)">{error}</p> : null}
		</div>
	)
}

export default LibraryBrowser
