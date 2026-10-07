import type { LibraryBookView, LibrarySectionView } from "@shared/retrieval-status"
import { describe, expect, it } from "vitest"
import {
	bookTicked,
	NOTHING_PICKED,
	type Picked,
	sectionTick,
	shelfTick,
	tidyPicked,
	toggleBook,
	toggleSection,
	toggleShelf,
} from "../LibraryBrowser"

const shelf = (id: number, sectionId: number, books: number) => ({
	id,
	sectionId,
	name: `shelf ${id}`,
	description: "",
	books,
	passages: 0,
})
const sections: LibrarySectionView[] = [
	{ id: 1, name: "Games", description: "", shelves: [shelf(10, 1, 2), shelf(11, 1, 1), shelf(12, 1, 0)] },
	{ id: 2, name: "Home", description: "", shelves: [shelf(20, 2, 3)] },
]
const [games, home] = sections
const book = (id: number, shelfId: number): LibraryBookView =>
	({ id, title: `book ${id}`, shelfId, sources: 1, passages: 1, web: false, updatedAt: "" }) as LibraryBookView
const onTen = [book(101, 10), book(102, 10)]
const onTwenty = [book(201, 20), book(202, 20), book(203, 20)]
const ids = (picked: Picked) => ({
	sections: [...picked.sections],
	shelves: [...picked.shelves],
	books: [...picked.books.keys()],
})

describe("ticking the Library for export", () => {
	it("mixes single books, whole shelves and whole sections from anywhere", () => {
		let picked = toggleBook(NOTHING_PICKED, home, onTwenty[1], onTwenty, sections)
		picked = toggleShelf(picked, games, games.shelves[1], sections)
		picked = toggleBook(picked, games, onTen[0], onTen, sections)
		expect(ids(picked)).toEqual({ sections: [], shelves: [11], books: [202, 101] })
		expect(sectionTick(picked, games)).toBe("some")
		expect(sectionTick(picked, home)).toBe("some")
		expect(shelfTick(picked, games, games.shelves[0])).toBe("some")
		expect(shelfTick(picked, games, games.shelves[1])).toBe("all")
		expect(shelfTick(picked, games, games.shelves[2])).toBe("none")
	})

	it("folds every book of a shelf into the shelf, and every filled shelf into the section", () => {
		let picked = toggleBook(NOTHING_PICKED, games, onTen[0], onTen, sections)
		picked = toggleBook(picked, games, onTen[1], onTen, sections)
		expect(ids(picked)).toEqual({ sections: [], shelves: [10], books: [] })
		// The empty shelf 12 does not have to be ticked for the section to be whole.
		picked = toggleShelf(picked, games, games.shelves[1], sections)
		expect(ids(picked)).toEqual({ sections: [1], shelves: [], books: [] })
		expect(sectionTick(picked, games)).toBe("all")
		expect(bookTicked(picked, games, onTen[1])).toBe(true)
	})

	it("unticking one book of a whole section leaves the rest ticked", () => {
		const whole = toggleSection(NOTHING_PICKED, games, sections)
		const picked = toggleBook(whole, games, onTen[0], onTen, sections)
		expect(ids(picked)).toEqual({ sections: [], shelves: [11], books: [102] })
		expect(sectionTick(picked, games)).toBe("some")
		expect(bookTicked(picked, games, onTen[0])).toBe(false)
	})

	it("unticking a shelf of a whole section leaves its other filled shelves", () => {
		const whole = toggleSection(NOTHING_PICKED, games, sections)
		expect(ids(toggleShelf(whole, games, games.shelves[0], sections))).toEqual({
			sections: [],
			shelves: [11],
			books: [],
		})
	})

	it("ticks a partly ticked section whole, and clears a whole one", () => {
		const some = toggleBook(NOTHING_PICKED, games, onTen[0], onTen, sections)
		const whole = toggleSection(some, games, sections)
		expect(ids(whole)).toEqual({ sections: [1], shelves: [], books: [] })
		expect(ids(toggleSection(whole, games, sections))).toEqual({ sections: [], shelves: [], books: [] })
	})

	it("drops what is no longer in the Library", () => {
		const picked = toggleBook(toggleShelf(NOTHING_PICKED, home, home.shelves[0], sections), games, onTen[0], onTen, sections)
		expect(ids(tidyPicked(picked, [games]))).toEqual({ sections: [], shelves: [], books: [101] })
		expect(ids(tidyPicked(picked, []))).toEqual({ sections: [], shelves: [], books: [] })
	})
})
