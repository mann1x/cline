import {
	cancelLibraryImports,
	isLibrarianEnabled,
	LIBRARIAN_SKILL_NAME,
	type LibraryBook,
	scrapePage,
	setBundledSkillEnabled,
	sharedLibrary,
	TRASH_DAYS,
} from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import type {
	LibraryAction,
	LibraryBookDetails,
	LibraryBookView,
	LibraryCatalogueView,
	RetrievalActionResult,
	ScrapeState,
} from "@/shared/retrieval-status"
import { Logger } from "@/shared/services/Logger"
import { ensureBaseUrlScheme } from "./cline-session-factory"
import { readEmbeddingEndpoint, readLibrarySettings, readScrapeConfig, readScrapeSettings } from "./library-config"

/**
 * The Library's shelves, for the Settings panel that browses them: what is
 * there, and the same changes the librarian's tools make, done by hand.
 *
 * One thing is the panel's alone: emptying the trash. The model can put a
 * book in it and take one out, and only a person deletes for good.
 */

function toView(book: LibraryBook): LibraryBookView {
	const trashedAt = book.trashedAt
	return {
		id: book.id,
		title: book.title,
		description: book.description,
		...(book.shelfId !== undefined ? { shelfId: book.shelfId } : {}),
		...(book.metadata.authors?.length ? { authors: book.metadata.authors } : {}),
		...(book.metadata.edition ? { edition: book.metadata.edition } : {}),
		...(book.metadata.year ? { year: book.metadata.year } : {}),
		sources: book.sources,
		passages: book.passages,
		web: book.metadata.web !== undefined,
		updatedAt: book.updatedAt,
		...(trashedAt
			? {
					trashedAt,
					trashedFrom: `${book.trashedFrom?.section} / ${book.trashedFrom?.shelf}`,
					purgedOn: new Date(new Date(trashedAt).getTime() + TRASH_DAYS * 86_400_000).toISOString().slice(0, 10),
				}
			: {}),
	}
}

let lastPurge = 0

/** The sections and shelves. Also where the trash lets go of what is past its days, at most once an hour. */
export async function readLibraryCatalogue(): Promise<LibraryCatalogueView> {
	const catalogue = sharedLibrary().catalogue
	if (Date.now() - lastPurge > 3_600_000) {
		lastPurge = Date.now()
		try {
			const purged = await catalogue.purgeTrash()
			if (purged.books + purged.sources > 0) {
				Logger.log(
					`[Library] The trash let go of ${purged.books} book(s) and ${purged.sources} source(s) past ${TRASH_DAYS} days`,
				)
			}
		} catch (error) {
			Logger.warn(`[Library] The trash could not be emptied of what is past its days: ${error}`)
		}
	}
	const sections = catalogue.sections()
	return {
		sections,
		books: sections.reduce((sum, section) => sum + section.shelves.reduce((n, shelf) => n + shelf.books, 0), 0),
		trash: catalogue.books({ trashed: true }).length,
		problems: catalogue.problems().map((entry) => `${entry.book ? `"${entry.book}" ` : ""}${entry.problem}`),
		librarian: isLibrarianEnabled(),
		trashDays: TRASH_DAYS,
	}
}

export function readScrapeState(): ScrapeState {
	const state = StateManager.get()
	const settings = readScrapeSettings()
	const allowed = state.getGlobalSettingsKey("scrapeAllowed") === true
	const problem = !settings.enabled
		? undefined
		: !settings.baseUrl
			? "No endpoint address is set."
			: !allowed
				? "Not allowed yet: tick “Allow web scraping” in the API configuration."
				: undefined
	return {
		enabled: settings.enabled,
		allowed,
		baseUrl: settings.baseUrl,
		maxPages: settings.maxPages,
		maxDepth: settings.maxDepth,
		librarianOnly: settings.librarianOnly,
		keySet: Boolean(state.getSecretKey("scrapeApiKey")?.trim()),
		...(problem ? { problem } : {}),
	}
}

const safeName = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "library"
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

type Outcome = Pick<RetrievalActionResult, "books" | "book" | "check">

/** Do one of the Library panel's actions. Resolves with what to tell the user, or nothing. */
export async function runLibraryAction(request: LibraryAction, outcome: Outcome): Promise<string | undefined> {
	const library = sharedLibrary()
	const catalogue = library.catalogue
	const settings = readLibrarySettings()
	const book = (bookId: number) => {
		const found = catalogue.book(bookId)
		if (!found) {
			throw new Error("That book is no longer there.")
		}
		return found
	}
	switch (request.action) {
		case "libraryBooks":
			outcome.books = catalogue.books({ shelfId: request.shelfId }).map(toView)
			return undefined
		case "libraryTrash":
			outcome.books = catalogue.books({ trashed: true }).map(toView)
			return undefined
		case "libraryBook": {
			const found = book(request.bookId)
			const images = catalogue.images(found.id)
			const details: LibraryBookDetails = {
				...toView(found),
				directory: catalogue.bookDirectory(found),
				metadata: found.metadata,
				sourceList: [...catalogue.sources(found.id), ...catalogue.sources(found.id, { removed: true })].map((source) => ({
					id: source.id,
					kind: source.kind,
					name: source.name,
					...(source.url ? { url: source.url } : {}),
					bytes: source.bytes,
					addedAt: source.addedAt,
					...(source.removedAt ? { removedAt: source.removedAt } : {}),
				})),
				pictures: images.length,
				describedPictures: images.filter((image) => image.description).length,
			}
			outcome.book = details
			return undefined
		}
		case "librarySection": {
			if (request.op === "create") {
				const made = catalogue.ensureSection(request.name ?? "", request.description)
				return `Section "${made.name}" is there.`
			}
			if (request.id === undefined) {
				throw new Error("Which section?")
			}
			if (request.op === "delete") {
				const trashed = catalogue.deleteSection(request.id)
				return `Section removed. ${count(trashed, "book")} moved to the trash.`
			}
			catalogue.updateSection(request.id, {
				...(request.name !== undefined ? { name: request.name } : {}),
				...(request.description !== undefined ? { description: request.description } : {}),
			})
			return undefined
		}
		case "libraryShelf": {
			if (request.op === "create") {
				if (request.sectionId === undefined) {
					throw new Error("Which section is the shelf for?")
				}
				const made = catalogue.ensureShelf(request.sectionId, request.name ?? "", request.description)
				return `Shelf "${made.name}" is there.`
			}
			if (request.id === undefined) {
				throw new Error("Which shelf?")
			}
			if (request.op === "delete") {
				const trashed = catalogue.deleteShelf(request.id)
				return `Shelf removed. ${count(trashed, "book")} moved to the trash.`
			}
			catalogue.updateShelf(request.id, {
				...(request.name !== undefined ? { name: request.name } : {}),
				...(request.description !== undefined ? { description: request.description } : {}),
				...(request.sectionId !== undefined ? { sectionId: request.sectionId } : {}),
			})
			return undefined
		}
		case "libraryBookEdit": {
			catalogue.updateBook(book(request.bookId).id, {
				...(request.title !== undefined ? { title: request.title } : {}),
				...(request.description !== undefined ? { description: request.description } : {}),
				...(request.shelfId !== undefined ? { shelfId: request.shelfId } : {}),
			})
			return undefined
		}
		case "libraryBookDelete": {
			const found = book(request.bookId)
			catalogue.trashBook(found.id)
			return `"${found.title}" is in the trash for ${TRASH_DAYS} days.`
		}
		case "libraryBookRestore": {
			const restored = catalogue.restoreBook(book(request.bookId).id)
			const shelf = catalogue.shelf(restored.shelfId ?? -1)
			return `"${restored.title}" is back on ${shelf?.section} / ${shelf?.name}.`
		}
		case "libraryBookPurge": {
			const found = book(request.bookId)
			if (!found.trashedAt) {
				throw new Error("Only a book in the trash is deleted for good.")
			}
			await catalogue.purgeBook(found.id)
			return `"${found.title}" is deleted.`
		}
		case "libraryCancelImport": {
			const cancelled = cancelLibraryImports()
			return cancelled > 0 ? "The import is cancelled; the model gets its report." : "No import is running."
		}
		case "libraryEmptyTrash": {
			const purged = await catalogue.purgeTrash(0)
			return `The trash is empty: ${count(purged.books, "book")} deleted.`
		}
		case "librarySource": {
			if (request.op === "remove") {
				await catalogue.removeSource(request.sourceId)
			} else {
				await catalogue.restoreSource(request.sourceId, settings)
			}
			return undefined
		}
		case "libraryExport": {
			let name = "library"
			let scope: Parameters<typeof catalogue.export>[0] = { library: true }
			const picked = request.selection
			const pickedCount =
				(picked?.sectionIds?.length ?? 0) + (picked?.shelfIds?.length ?? 0) + (picked?.bookIds?.length ?? 0)
			if (picked && pickedCount > 0) {
				// One thing ticked names the file after it; several are "selection".
				const only =
					pickedCount > 1
						? undefined
						: picked.bookIds?.length
							? catalogue.book(picked.bookIds[0])?.title
							: picked.shelfIds?.length
								? catalogue.shelf(picked.shelfIds[0])?.name
								: catalogue.sections().find((section) => section.id === picked.sectionIds?.[0])?.name
				name = only ?? "selection"
				scope = { selection: picked }
			} else if (request.bookId !== undefined) {
				name = book(request.bookId).title
				scope = { bookId: request.bookId }
			} else if (request.shelfId !== undefined) {
				name = catalogue.shelf(request.shelfId)?.name ?? name
				scope = { shelfId: request.shelfId }
			} else if (request.sectionId !== undefined) {
				name = catalogue.sections().find((section) => section.id === request.sectionId)?.name ?? name
				scope = { sectionId: request.sectionId }
			}
			const chosen = await HostProvider.window.showSaveDialog({
				options: {
					defaultPath: `${safeName(name)}.library.tar.gz`,
					filters: { "Cerebriline Library": { extensions: ["gz"] } },
				},
			})
			if (!chosen.selectedPath) {
				return undefined
			}
			const result = await catalogue.export(scope, chosen.selectedPath)
			return `Wrote ${count(result.books, "book")} (${(result.bytes / 1024 / 1024).toFixed(1)} MB) to ${result.file}. Vectors are not in it; they are made again where it is imported.`
		}
		case "libraryImport": {
			const chosen = await HostProvider.window.showOpenDialogue({
				canSelectMany: false,
				openLabel: "Import into the Library",
				filters: { files: ["gz"] },
			})
			const path = chosen.paths[0]
			if (!path) {
				return undefined
			}
			const result = await catalogue.import(path, {
				settings,
				...(request.existing ? { existing: request.existing } : {}),
			})
			const embedding = readEmbeddingEndpoint()
			if (embedding && result.imported.length > 0) {
				// In the background: a shelf of books is many requests, and the
				// panel shows what is left to embed either way.
				void library.embedPending({ embedding, settings }).catch((error) => {
					Logger.warn(`[Library] Embedding the imported books stopped: ${error}`)
				})
			}
			return `Imported ${count(result.imported.length, "book")}${
				result.skipped.length
					? `; left out ${result.skipped.map((entry) => `"${entry.title}" (${entry.reason})`).join(", ")}`
					: ""
			}.`
		}
		case "setLibrarian":
			setBundledSkillEnabled(LIBRARIAN_SKILL_NAME, request.enabled)
			return request.enabled
				? "The librarian is on. It is offered to tasks started from now on."
				: "The librarian is off. Tasks started from now on can search the Library and not change it."
		case "setScrape": {
			const state = StateManager.get()
			const current = readScrapeSettings()
			state.setGlobalState(
				"scrapeSettings",
				JSON.stringify({
					enabled: request.enabled ?? current.enabled,
					baseUrl: request.baseUrl ?? current.baseUrl,
					maxPages: request.maxPages ?? current.maxPages,
					maxDepth: request.maxDepth ?? current.maxDepth,
					librarianOnly: request.librarianOnly ?? current.librarianOnly,
				}),
			)
			if (request.allowed !== undefined) {
				state.setGlobalState("scrapeAllowed", request.allowed)
			}
			if (request.apiKey !== undefined) {
				state.setSecret("scrapeApiKey", request.apiKey.trim() || undefined)
			}
			return undefined
		}
		case "checkScrape": {
			// The endpoint as typed, allowed or not yet: the check is how the
			// user finds out whether it is worth allowing.
			const typed = readScrapeSettings()
			const apiKey = StateManager.get().getSecretKey("scrapeApiKey")?.trim() || undefined
			const endpoint =
				readScrapeConfig() ??
				(typed.baseUrl ? { baseUrl: ensureBaseUrlScheme(typed.baseUrl), ...(apiKey ? { apiKey } : {}) } : undefined)
			if (!endpoint) {
				outcome.check = { ok: false, detail: "No endpoint address is set." }
				return undefined
			}
			try {
				const page = await scrapePage(endpoint, "https://example.com/")
				outcome.check = {
					ok: true,
					detail: `Read ${page.url}${page.title ? ` (“${page.title}”)` : ""}: ${page.markdown.length} characters.`,
				}
			} catch (error) {
				outcome.check = { ok: false, detail: error instanceof Error ? error.message : String(error) }
			}
			return undefined
		}
		default:
			throw new Error("Unknown action.")
	}
}
