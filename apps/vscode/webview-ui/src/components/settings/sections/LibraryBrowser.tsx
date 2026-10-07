import type { LibraryBookDetails, LibraryBookView, LibrarySectionView, LibraryShelfView } from "@shared/retrieval-status"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useRef, useState } from "react"
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
/** "Its 1 book goes to", "Its 3 books go to". */
const goTo = (books: number) => `Its ${count(books, "book")} ${books === 1 ? "goes" : "go"} to`
const kb = (bytes: number) =>
	bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * What is ticked for export. A ticked section stands for every shelf in it
 * and a ticked shelf for every book on it, so a whole is never also listed
 * by its parts.
 */
export interface Picked {
	sections: ReadonlySet<number>
	shelves: ReadonlySet<number>
	/** Book id → the shelf it is on. */
	books: ReadonlyMap<number, number>
}
export type Tick = "all" | "some" | "none"
export const NOTHING_PICKED: Picked = { sections: new Set(), shelves: new Set(), books: new Map() }

/** Folds ticks into the largest whole they make, and drops what is gone. */
export function tidyPicked(picked: Picked, sections: readonly LibrarySectionView[]): Picked {
	const shelfIds = new Set(sections.flatMap((section) => section.shelves.map((shelf) => shelf.id)))
	const wholeSections = new Set([...picked.sections].filter((id) => sections.some((section) => section.id === id)))
	const wholeShelves = new Set([...picked.shelves].filter((id) => shelfIds.has(id)))
	const books = new Map([...picked.books].filter(([, shelfId]) => shelfIds.has(shelfId)))
	for (const section of sections) {
		for (const shelf of section.shelves) {
			const on = [...books].filter(([, shelfId]) => shelfId === shelf.id).map(([id]) => id)
			if (shelf.books > 0 && on.length >= shelf.books) wholeShelves.add(shelf.id)
			if (wholeSections.has(section.id) || wholeShelves.has(shelf.id)) for (const id of on) books.delete(id)
		}
		const filled = section.shelves.filter((shelf) => shelf.books > 0)
		if (filled.length > 0 && filled.every((shelf) => wholeShelves.has(shelf.id))) wholeSections.add(section.id)
		if (wholeSections.has(section.id)) for (const shelf of section.shelves) wholeShelves.delete(shelf.id)
	}
	return { sections: wholeSections, shelves: wholeShelves, books }
}

export function shelfTick(picked: Picked, section: LibrarySectionView, shelf: LibraryShelfView): Tick {
	if (picked.sections.has(section.id) || picked.shelves.has(shelf.id)) return "all"
	return [...picked.books.values()].includes(shelf.id) ? "some" : "none"
}

export function sectionTick(picked: Picked, section: LibrarySectionView): Tick {
	if (picked.sections.has(section.id)) return "all"
	return section.shelves.some((shelf) => shelfTick(picked, section, shelf) !== "none") ? "some" : "none"
}

/** A partly ticked section or shelf is ticked whole by a click; a whole one is cleared. */
export function toggleSection(picked: Picked, section: LibrarySectionView, sections: readonly LibrarySectionView[]): Picked {
	const wholeSections = new Set(picked.sections)
	const wholeShelves = new Set(picked.shelves)
	const books = new Map(picked.books)
	const shelfIds = new Set(section.shelves.map((shelf) => shelf.id))
	if (sectionTick(picked, section) === "all") wholeSections.delete(section.id)
	else wholeSections.add(section.id)
	for (const id of shelfIds) wholeShelves.delete(id)
	for (const [id, shelfId] of books) if (shelfIds.has(shelfId)) books.delete(id)
	return tidyPicked({ sections: wholeSections, shelves: wholeShelves, books }, sections)
}

/** Unticking part of a whole leaves the rest of it ticked. */
function splitSection(picked: Picked, section: LibrarySectionView): Picked {
	if (!picked.sections.has(section.id)) return picked
	const wholeSections = new Set(picked.sections)
	wholeSections.delete(section.id)
	return {
		...picked,
		sections: wholeSections,
		shelves: new Set([...picked.shelves, ...section.shelves.filter((shelf) => shelf.books > 0).map((shelf) => shelf.id)]),
	}
}

export function toggleShelf(
	picked: Picked,
	section: LibrarySectionView,
	shelf: LibraryShelfView,
	sections: readonly LibrarySectionView[],
): Picked {
	const split = splitSection(picked, section)
	const wholeShelves = new Set(split.shelves)
	const books = new Map([...split.books].filter(([, shelfId]) => shelfId !== shelf.id))
	if (shelfTick(picked, section, shelf) === "all") wholeShelves.delete(shelf.id)
	else wholeShelves.add(shelf.id)
	return tidyPicked({ ...split, shelves: wholeShelves, books }, sections)
}

export function bookTicked(picked: Picked, section: LibrarySectionView, book: LibraryBookView): boolean {
	return (
		picked.sections.has(section.id) ||
		(book.shelfId !== undefined && picked.shelves.has(book.shelfId)) ||
		picked.books.has(book.id)
	)
}

/** `onShelf` is every book on the book's shelf, to tick the others when one leaves a whole shelf. */
export function toggleBook(
	picked: Picked,
	section: LibrarySectionView,
	book: LibraryBookView,
	onShelf: readonly LibraryBookView[],
	sections: readonly LibrarySectionView[],
): Picked {
	const shelfId = book.shelfId
	if (shelfId === undefined) return picked
	if (!bookTicked(picked, section, book)) {
		return tidyPicked({ ...picked, books: new Map([...picked.books, [book.id, shelfId]]) }, sections)
	}
	const split = splitSection(picked, section)
	const wholeShelves = new Set(split.shelves)
	const books = new Map(split.books)
	if (wholeShelves.delete(shelfId)) {
		for (const other of onShelf) books.set(other.id, shelfId)
	}
	books.delete(book.id)
	return tidyPicked({ ...split, shelves: wholeShelves, books }, sections)
}

/** The checkbox a section, shelf or book is ticked with: on, off, or partly. */
const TickBox = ({
	tick,
	label,
	disabled,
	onToggle,
}: {
	tick: Tick
	label: string
	disabled?: boolean
	onToggle: () => void
}) => {
	const box = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (box.current) box.current.indeterminate = tick === "some"
	}, [tick])
	return (
		<input
			aria-label={label}
			checked={tick === "all"}
			className="m-0 shrink-0 cursor-pointer align-middle accent-(--vscode-checkbox-selectBackground) disabled:cursor-default"
			disabled={disabled}
			onChange={onToggle}
			ref={box}
			title={disabled ? "Nothing here to export" : label}
			type="checkbox"
		/>
	)
}

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
	const [picked, setPicked] = useState<Picked>(NOTHING_PICKED)

	const load = useCallback(
		async (shelfId: number | undefined) => {
			if (shelfId === undefined) {
				setBooks([])
				return
			}
			const result = await ask(shelfId === TRASH ? { action: "libraryTrash" } : { action: "libraryBooks", shelfId })
			const loaded = result?.books ?? []
			setBooks(loaded)
			if (shelfId !== TRASH) {
				// A book ticked on this shelf that is no longer on it, moved or deleted, is not exported.
				const here = new Set(loaded.map((book) => book.id))
				setPicked((current) => {
					const books = new Map([...current.books].filter(([id, on]) => on !== shelfId || here.has(id)))
					return books.size === current.books.size ? current : { ...current, books }
				})
			}
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
	const ticked = tidyPicked(picked, catalogue.sections)
	const tickedCount = ticked.sections.size + ticked.shelves.size + ticked.books.size
	const tickedSummary = [
		ticked.sections.size ? count(ticked.sections.size, "section") : "",
		ticked.shelves.size ? count(ticked.shelves.size, "shelf", "shelves") : "",
		ticked.books.size ? count(ticked.books.size, "book") : "",
	]
		.filter(Boolean)
		.join(", ")
	const exportPicked = () =>
		void run(
			tickedCount > 0
				? {
						action: "libraryExport",
						selection: {
							sectionIds: [...ticked.sections],
							shelfIds: [...ticked.shelves],
							bookIds: [...ticked.books.keys()],
						},
					}
				: { action: "libraryExport" },
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

	/** Asked under the row it is about, answered Yes or No. */
	const confirm = (question: string, yes: () => void) => (
		<div className="flex flex-wrap items-center gap-2 my-1 px-2 py-1 bg-(--vscode-inputValidation-warningBackground) border border-(--vscode-inputValidation-warningBorder)">
			<span className="flex-1 min-w-0 break-words">{question}</span>
			<span className="whitespace-nowrap">
				<VSCodeButton disabled={busy} onClick={yes}>
					Yes
				</VSCodeButton>{" "}
				<VSCodeButton appearance="secondary" onClick={() => setPending(undefined)}>
					No
				</VSCodeButton>
			</span>
		</div>
	)
	const trashButton = (label: string, ask: Pending) => (
		<VSCodeButton appearance="icon" aria-label={label} disabled={busy} onClick={() => setPending(ask)} title={label}>
			<span className="codicon codicon-trash" />
		</VSCodeButton>
	)

	const bookRow = (book: LibraryBookView, section?: LibrarySectionView) => {
		const trashed = book.trashedAt !== undefined
		return (
			<div className="py-1 border-t border-(--vscode-panel-border)" key={book.id}>
				<div className="flex items-start gap-2">
					{section && !trashed ? (
						<span className="pt-0.5">
							<TickBox
								label={`Export "${book.title}"`}
								onToggle={() => setPicked(toggleBook(ticked, section, book, books, catalogue.sections))}
								tick={bookTicked(ticked, section, book) ? "all" : "none"}
							/>
						</span>
					) : null}
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
						{trashed ? (
							<>
								<VSCodeButton
									appearance="icon"
									disabled={busy}
									onClick={() => void act({ action: "libraryBookRestore", bookId: book.id })}
									title={`Put "${book.title}" back on its shelf`}>
									Restore
								</VSCodeButton>
								{trashButton(`Delete "${book.title}" for good`, { kind: "purgeBook", id: book.id })}
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
								{trashButton(`Move "${book.title}" to the trash`, { kind: "deleteBook", id: book.id })}
							</>
						)}
					</div>
				</div>
				{pending?.kind === "deleteBook" && pending.id === book.id
					? confirm(
							`Move "${book.title}" to the trash? It is kept there ${catalogue.trashDays} days.`,
							() => void act({ action: "libraryBookDelete", bookId: book.id }),
						)
					: null}
				{pending?.kind === "purgeBook" && pending.id === book.id
					? confirm(
							`Delete "${book.title}" for good? This cannot be undone.`,
							() => void act({ action: "libraryBookPurge", bookId: book.id }),
						)
					: null}
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
				<TickBox
					disabled={shelf.books === 0}
					label={`Export the shelf "${shelf.name}"`}
					onToggle={() => setPicked(toggleShelf(ticked, section, shelf, catalogue.sections))}
					tick={shelfTick(ticked, section, shelf)}
				/>
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
					{trashButton(`Remove the shelf "${shelf.name}"`, { kind: "deleteShelf", id: shelf.id })}
				</span>
			</div>
			{pending?.kind === "deleteShelf" && pending.id === shelf.id
				? confirm(
						shelf.books > 0
							? `Remove the shelf "${shelf.name}"? ${goTo(shelf.books)} the trash for ${catalogue.trashDays} days.`
							: `Remove the empty shelf "${shelf.name}"?`,
						() => void act({ action: "libraryShelf", op: "delete", id: shelf.id }),
					)
				: null}
			{open === shelf.id ? (
				<div className="pl-4 pb-1">
					{books.length === 0 ? (
						<div className={muted}>No books on this shelf.</div>
					) : (
						books.map((book) => bookRow(book, section))
					)}
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
					onClick={exportPicked}
					title={tickedCount > 0 ? `Export what is ticked: ${tickedSummary}` : "Export the whole Library"}>
					Export…
				</VSCodeButton>
			</div>
			{catalogue.books > 0 ? (
				<div className={`flex flex-wrap items-center gap-2 ${muted}`}>
					{tickedCount > 0 ? (
						<>
							<span>Export… writes what is ticked: {tickedSummary}.</span>
							<VSCodeButton appearance="icon" onClick={() => setPicked(NOTHING_PICKED)}>
								Clear
							</VSCodeButton>
						</>
					) : (
						<span>Export… writes the whole Library. Tick sections, shelves or books to export only those.</span>
					)}
				</div>
			) : null}
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
						<TickBox
							disabled={section.shelves.every((shelf) => shelf.books === 0)}
							label={`Export the section "${section.name}"`}
							onToggle={() => setPicked(toggleSection(ticked, section, catalogue.sections))}
							tick={sectionTick(ticked, section)}
						/>
						{pending?.kind === "renameSection" && pending.id === section.id ? (
							nameField(
								`New name for ${section.name}`,
								(value) => void act({ action: "librarySection", op: "update", id: section.id, name: value }),
							)
						) : (
							<span className="flex-1 min-w-0 font-medium break-words">{section.name}</span>
						)}
						<span className="whitespace-nowrap">
							<VSCodeButton
								appearance="icon"
								disabled={busy}
								onClick={() => setPending({ kind: "newShelf", sectionId: section.id, value: "" })}>
								New shelf
							</VSCodeButton>
							<VSCodeButton
								appearance="icon"
								disabled={busy}
								onClick={() => setPending({ kind: "renameSection", id: section.id, value: section.name })}>
								Rename
							</VSCodeButton>
							{trashButton(`Remove the section "${section.name}"`, { kind: "deleteSection", id: section.id })}
						</span>
					</div>
					{pending?.kind === "deleteSection" && pending.id === section.id
						? (() => {
								const inIt = section.shelves.reduce((sum, shelf) => sum + shelf.books, 0)
								return confirm(
									`Remove the section "${section.name}" and its ${count(section.shelves.length, "shelf", "shelves")}?${
										inIt > 0 ? ` ${goTo(inIt)} the trash for ${catalogue.trashDays} days.` : ""
									}`,
									() => void act({ action: "librarySection", op: "delete", id: section.id }),
								)
							})()
						: null}
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
						<VSCodeButton appearance="icon" disabled={busy} onClick={() => setPending({ kind: "emptyTrash" })}>
							Empty
						</VSCodeButton>
					</div>
					{pending?.kind === "emptyTrash"
						? confirm(
								`Delete the ${count(catalogue.trash, "book")} in the trash for good? This cannot be undone.`,
								() => void act({ action: "libraryEmptyTrash" }),
							)
						: null}
					{open === TRASH ? <div className="pl-4">{books.map((book) => bookRow(book))}</div> : null}
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
