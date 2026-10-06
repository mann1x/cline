import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { DEFAULT_LIBRARY_SETTINGS, type LibrarySettings } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Library } from "../../services/retrieval/library";
import type { DescribeImages } from "./executors/document/recognition";
import { createLibraryTools, type LibraryToolsConfig } from "./library-tools";

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures", "documents");
const CONTEXT = {} as AgentToolContext;

const chapter = (n: number, subject: string) =>
	`## Chapter ${n}\n\n${Array.from({ length: 40 }, (_u, i) => `Paragraph ${i} of chapter ${n} explains ${subject} in step ${i * n + 1} with care.`).join(" ")}\n`;
const BOOK = `# Engine Care\n\nISBN 978-1-4028-9462-6\n\n${chapter(1, "the thermostat and coolant")}\n${chapter(2, "the oil filter")}\n${chapter(3, "tyre pressure")}`;

describe("the Library tools", () => {
	let root: string;
	let workspace: string;
	let library: Library;
	let config: LibraryToolsConfig | undefined;
	let librarian: boolean;
	let pages: Record<string, string | (() => string)>;
	let requests: string[];
	let vision: DescribeImages | undefined;

	const on = (
		settings: Partial<LibrarySettings> = {},
		extra: Partial<LibraryToolsConfig> = {},
	): LibraryToolsConfig => ({
		settings: { ...DEFAULT_LIBRARY_SETTINGS, enabled: true, ...settings },
		...extra,
	});
	const scraper = { baseUrl: "http://scrape.test", maxPages: 5, maxDepth: 2 };

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "library-tools-"));
		workspace = join(root, "workspace");
		mkdirSync(workspace);
		pages = {};
		requests = [];
		// A scraping endpoint and a reranker, in one.
		const send = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body ?? "{}"));
			requests.push(
				`${init?.method ?? "GET"} ${url.replace("http://scrape.test", "")}`,
			);
			if (url.endsWith("/v2/scrape")) {
				const held = pages[body.url];
				const html = typeof held === "function" ? held() : held;
				return Response.json(
					html
						? {
								success: true,
								data: {
									html,
									metadata: {
										sourceURL: body.url,
										title: `Title of ${body.url}`,
										statusCode: 200,
									},
								},
							}
						: {
								success: true,
								data: {
									html: "",
									metadata: { sourceURL: body.url, statusCode: 404 },
								},
							},
				);
			}
			if (url.endsWith("/v2/search")) {
				return Response.json({
					success: true,
					data: {
						web: Object.keys(pages).map((link) => ({
							url: link,
							title: `Title of ${link}`,
							description: "About tilemaps.",
						})),
					},
				});
			}
			if (url.endsWith("/v2/crawl")) {
				return Response.json({ success: true, id: "job1" });
			}
			if (url.includes("/v2/crawl/job1")) {
				const skip = Number(new URL(url).searchParams.get("skip"));
				const all = Object.entries(pages).map(([link, held]) => ({
					html: typeof held === "function" ? held() : held,
					metadata: {
						sourceURL: link,
						title: `Title of ${link}`,
						statusCode: 200,
					},
				}));
				return Response.json({
					success: true,
					status: "completed",
					completed: all.length,
					total: all.length,
					data: all.slice(skip),
				});
			}
			return Response.json({
				results: (body.documents as string[]).map((text, index) => ({
					index,
					relevance_score: text.includes("thermostat") ? 0.93 : 0.2,
				})),
			});
		}) as typeof fetch;
		library = new Library({
			directory: join(root, "library"),
			runtimeDirectory: join(root, "no-runtime"),
			fetch: send,
		});
		config = on();
		librarian = true;
		vision = undefined;
		globalThis.fetch = send;
	});
	const realFetch = globalThis.fetch;
	afterEach(async () => {
		globalThis.fetch = realFetch;
		await library.close();
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	});

	const tools = () =>
		Object.fromEntries(
			createLibraryTools({
				cwd: workspace,
				getConfig: () => config,
				library,
				librarian,
				getDescribeImages: () => vision,
			}).map((tool) => [tool.name, tool]),
		);
	const call = async (name: string, input: unknown) =>
		String(await tools()[name].execute(input, CONTEXT));
	const write = (name: string, text: string) => {
		mkdirSync(join(workspace, name, ".."), { recursive: true });
		writeFileSync(join(workspace, name), text);
	};
	const addBook = (extra: Record<string, unknown> = {}) =>
		call("library_add", {
			paths: ["engine.md"],
			title: "Engine Care",
			description: "How to look after an engine.",
			section: "Cars",
			shelf: "Maintenance",
			authors: ["M. Echanic"],
			...extra,
		});

	it("offers nothing while the Library is off", () => {
		config = undefined;
		expect(tools()).toEqual({});
		config = on({ enabled: false });
		expect(tools()).toEqual({});
	});

	it("offers search and list always, and the rest only to a librarian", () => {
		librarian = false;
		expect(Object.keys(tools())).toEqual(["search_library", "list_library"]);
		librarian = true;
		expect(Object.keys(tools())).toEqual([
			"search_library",
			"list_library",
			"library_check",
			"library_add",
			"library_organize",
			"library_transfer",
		]);
		config = on({}, { scrape: scraper });
		expect(Object.keys(tools()).slice(-2)).toEqual([
			"web_scrape",
			"library_web_book",
		]);
	});

	it("stops answering when the Library is turned off mid-session", async () => {
		const search = tools().search_library;
		config = on({ enabled: false });
		expect(String(await search.execute({ query: "x" }, CONTEXT))).toContain(
			"turned off",
		);
	});

	it("adds a book to a shelf it makes, and finds a passage with where it is from", async () => {
		write("engine.md", BOOK);
		const added = await addBook();
		expect(added).toContain('"Engine Care" (#1): 1 source added');
		expect(added).toContain('made section "Cars" and shelf "Maintenance"');
		const [book] = library.catalogue.books();
		expect(book.metadata).toMatchObject({
			authors: ["M. Echanic"],
			isbn: "9781402894626",
		});
		expect(
			readdirSync(join(library.catalogue.bookDirectory(book), "sources")),
		).toHaveLength(1);

		const found = await call("search_library", { query: "thermostat coolant" });
		expect(found).toContain(
			"Cars / Maintenance / Engine Care — engine.md — Engine Care > Chapter 1",
		);
		expect(
			await call("search_library", {
				query: "thermostat",
				shelves: ["Cars / Maintenance"],
				books: ["#1"],
			}),
		).toContain("[1]");
		expect(
			await call("search_library", { query: "x", shelves: ["Nowhere"] }),
		).toContain('No shelf "Nowhere"');

		expect(await call("list_library", {})).toContain("  Maintenance: 1 book");
		expect(await call("list_library", { shelf: "Maintenance" })).toContain(
			'#1 "Engine Care" by M. Echanic',
		);
		const details = await call("list_library", { book: "Engine Care" });
		expect(details).toContain("On Cars / Maintenance.");
		expect(details).toContain("source 1: engine.md [file");
	});

	it("ends with a report of every file, and shows where it is as it goes", async () => {
		write("engine.md", BOOK);
		const updates: { status?: string; cancellable?: string }[] = [];
		const context = {
			...CONTEXT,
			emitUpdate: (update: unknown) => updates.push(update as never),
		};
		const added = String(
			await tools().library_add.execute(
				{
					paths: ["engine.md", "missing-folder"],
					title: "Engine care",
					description: "How to keep an engine running. Covers oil and belts.",
					section: "Workshop",
					shelf: "Engines",
				},
				context,
			),
		);
		expect(added).toMatch(/REPORT: 1 of 1 done/);
		expect(added).toMatch(/- engine\.md: added, [\d,]+ words, \d+ passages?/);
		expect(updates.length).toBeGreaterThan(1);
		expect(
			updates.every((update) => update.cancellable === "library-import"),
		).toBe(true);
		expect(
			updates.some((update) => /▶ engine\.md/.test(update.status ?? "")),
		).toBe(true);
		expect(updates.at(-1)?.status).toContain("✓ engine.md: added");
	});

	it("fails with the whole report when the import is cancelled", async () => {
		write("engine.md", BOOK);
		const stop = new AbortController();
		stop.abort();
		await expect(
			tools().library_add.execute(
				{
					paths: ["engine.md"],
					title: "Engine care",
					description: "How to keep an engine running. Covers oil and belts.",
					section: "Workshop",
					shelf: "Engines",
				},
				{ ...CONTEXT, signal: stop.signal },
			),
		).rejects.toThrow(
			/was cancelled: the run was stopped[\s\S]*Nothing was added to the Library\.[\s\S]*- engine\.md: NOT READ/,
		);
		expect(await call("list_library", {})).not.toContain("Engine care");
	});

	it("needs a title, a description and a shelf for a new book", async () => {
		write("engine.md", BOOK);
		expect(await call("library_add", { paths: ["engine.md"] })).toContain(
			"needs a `title`",
		);
		expect(
			await call("library_add", { paths: ["engine.md"], title: "T" }),
		).toContain("needs a `description`");
		expect(
			await call("library_add", {
				paths: ["engine.md"],
				title: "T",
				description: "D",
			}),
		).toContain("Say which `shelf`");
		expect(library.catalogue.books()).toEqual([]);
	});

	it("says what a file is and whether it is here, before anything is added", async () => {
		write("engine.md", BOOK);
		const fresh = await call("library_check", { paths: ["engine.md"] });
		expect(fresh).toContain('title "Engine Care"');
		expect(fresh).toContain("ISBN 9781402894626");
		expect(fresh).toContain("not in the Library.");
		await addBook();
		expect(await call("library_check", { paths: ["engine.md"] })).toContain(
			"ALREADY HERE: the same file is in #1",
		);
		// The same text saved again as another file.
		write("copy/engine-care.txt", `${BOOK}\n`);
		expect(await call("library_check", { paths: ["copy"] })).toContain(
			"SAME BOOK, another file",
		);
		// A second edition: a chapter more.
		write(
			"engine-2nd.md",
			`${BOOK}\n${chapter(4, "the gearbox")}\n${chapter(5, "the brakes")}`,
		);
		const edition = await call("library_check", { paths: ["engine-2nd.md"] });
		expect(edition).toContain("ANOTHER VERSION");
		expect(edition).toContain("Ask the user");
		expect(await call("library_check", { title: "engine care" })).toContain(
			"same title with #1",
		);
	});

	it("says what the files of one batch have to do with each other", async () => {
		write("in/engine.md", BOOK);
		write("in/engine-copy.md", BOOK);
		write("in/engine.txt", `${BOOK}\n\nTranscribed.`);
		write(
			"in/engine-2nd.md",
			`${BOOK}\n${chapter(4, "the gearbox")}\n${chapter(5, "the brakes")}`,
		);
		write("in/bread.md", `# Bread\n\n${chapter(1, "sourdough starters")}`);
		const checked = await call("library_check", { paths: ["in"] });
		expect(checked).toContain("IN THIS BATCH: is the same file as engine.md.");
		expect(checked).toMatch(
			/IN THIS BATCH: is the same book \(\d+% of the text\) as engine\.txt\./,
		);
		expect(checked).toMatch(
			/IN THIS BATCH: shares \d+% of its text, so is probably another version of, engine-2nd\.md\./,
		);
		expect(checked).toContain("ask before adding more than one");
		const bread = checked.slice(
			checked.indexOf("bread.md"),
			checked.indexOf("engine-2nd.md"),
		);
		expect(bread).not.toContain("IN THIS BATCH");
	});

	it("adds nothing over a book that looks the same until told what to do", async () => {
		write("engine.md", BOOK);
		await addBook();
		write(
			"engine-2nd.md",
			`${BOOK}\n${chapter(4, "the gearbox")}\n${chapter(5, "the brakes")}`,
		);
		const second = {
			paths: ["engine-2nd.md"],
			title: "Engine Care",
			edition: "2nd",
		};
		const stopped = await addBook(second);
		expect(stopped).toContain(
			"Nothing was added. This looks like a book the Library already has",
		);
		expect(library.catalogue.books()).toHaveLength(1);

		expect(await addBook(second)).toContain("Nothing was added");
		const kept = await addBook({ ...second, if_exists: "new_version" });
		expect(kept).toContain("(#2): 1 source added");
		expect(library.catalogue.book(2)?.metadata.versionOf).toMatchObject([
			{ title: "Engine Care" },
		]);
		expect(library.catalogue.books()).toHaveLength(2);
	});

	it("does not put two versions of a work in one book unasked", async () => {
		write("engine.md", BOOK);
		write(
			"engine-2nd.md",
			`${BOOK}\n${chapter(4, "the gearbox")}\n${chapter(5, "the brakes")}`,
		);
		write("engine.txt", `${BOOK}\n\nTranscribed.`);
		const both = { paths: ["engine.md", "engine-2nd.md"] };
		const stopped = await addBook(both);
		expect(stopped).toContain("different versions of one work");
		expect(stopped).toMatch(
			/engine\.md and engine-2nd\.md share \d+% of their text/,
		);
		expect(library.catalogue.books()).toEqual([]);
		// The same book in two formats is one book, with no question asked.
		expect(await addBook({ paths: ["engine.md", "engine.txt"] })).toContain(
			"2 sources added",
		);
		// And told to, the versions go together.
		expect(
			await call("library_add", {
				book: "#1",
				...both,
				if_exists: "add_anyway",
			}),
		).toContain("1 source added");
	});

	it("replaces a book by moving the old one to the trash", async () => {
		write("engine.md", BOOK);
		await addBook();
		write(
			"engine-2nd.md",
			`${BOOK}\n${chapter(4, "the gearbox")}\n${chapter(5, "the brakes")}`,
		);
		const replaced = await addBook({
			paths: ["engine-2nd.md"],
			edition: "2nd",
			if_exists: "replace",
		});
		expect(replaced).toContain(
			'Replaced #1 "Engine Care", which is in the trash for 30 days.',
		);
		expect(library.catalogue.books().map((book) => book.id)).toEqual([2]);
		expect(await call("list_library", { view: "trash" })).toContain(
			'#1 "Engine Care"',
		);
		// And the same file again is refused outright.
		expect(await addBook({ paths: ["engine-2nd.md"] })).toContain(
			"every file is already in the Library",
		);
	});

	it("adds files to an existing book: a DOCX, and an EPUB with its pictures described", async () => {
		write("engine.md", BOOK);
		await addBook();
		const seen: string[] = [];
		vision = async (images) =>
			images.map((image) => {
				seen.push(image.context ?? "");
				return "A cutaway drawing of a thermostat housing.";
			});
		const more = await call("library_add", {
			book: "#1",
			paths: [
				join(FIXTURES, "probe.docx"),
				join(FIXTURES, "probe.epub"),
				"missing.pdf",
			],
			if_exists: "add_anyway",
		});
		expect(more).toContain("2 sources added");
		expect(more).toContain("missing.pdf: no such file or folder.");
		expect(library.catalogue.sources(1)).toHaveLength(3);
		const images = library.catalogue.images(1);
		expect(images.length).toBeGreaterThan(0);
		expect(more).toContain(`${images.length} described`);
		expect(seen[0]).toContain("probe.");
		expect(images[0].description).toBe(
			"A cutaway drawing of a thermostat housing.",
		);
		// What a picture shows is searchable, through its alt text.
		expect(
			await call("search_library", { query: "cutaway thermostat housing" }),
		).toContain("[1]");
		// Turned off, the pictures are kept and not described.
		vision = undefined;
	});

	it("reorganises: sections, shelves, books, and back out of the trash", async () => {
		write("engine.md", BOOK);
		await addBook();
		const organize = (input: Record<string, unknown>) =>
			call("library_organize", input);
		expect(
			await organize({
				action: "create_shelf",
				section: "Cars",
				shelf: "Manuals",
			}),
		).toContain("Cars / Manuals is there");
		expect(
			await organize({
				action: "move_book",
				book: "Engine Care",
				shelf: "Cars / Manuals",
			}),
		).toContain("is now on Cars / Manuals");
		expect(
			await organize({
				action: "update_shelf",
				shelf: "Manuals",
				name: "Handbooks",
				to_section: "Vehicles",
			}),
		).toContain("is now Vehicles / Handbooks");
		expect(
			await organize({
				action: "update_section",
				section: "Vehicles",
				name: "Transport",
			}),
		).toContain('is now "Transport"');
		expect(
			await organize({
				action: "update_book",
				book: "#1",
				title: "Engine Care, revised",
				edition: "rev.",
			}),
		).toContain('"Engine Care, revised" by M. Echanic (rev.)');
		expect(
			await organize({ action: "move_book", book: "#1", shelf: "Nowhere" }),
		).toContain("Give the `section`");

		expect(
			await organize({ action: "delete_section", section: "Transport" }),
		).toContain("1 book moved to the trash");
		expect(await call("search_library", { query: "thermostat" })).toContain(
			"no books there to search",
		);
		expect(await organize({ action: "delete_book", book: "#1" })).toContain(
			"No book",
		);
		expect(await organize({ action: "restore_book", book: "#1" })).toContain(
			"is back on Transport / Handbooks",
		);
		expect(await call("search_library", { query: "thermostat" })).toContain(
			"[1]",
		);

		expect(await organize({ action: "remove_source", source: 1 })).toContain(
			"kept 30 days",
		);
		expect(await call("list_library", { book: "#1" })).toContain(
			"Taken out, kept 30 days: source 1",
		);
		expect(await organize({ action: "restore_source", source: 1 })).toContain(
			"is back in its book",
		);
		expect(await organize({ action: "empty_trash" })).toContain(
			'No action "empty_trash"',
		);
	});

	it("exports a book and imports it into another Library", async () => {
		write("engine.md", BOOK);
		await addBook();
		const exported = await call("library_transfer", {
			action: "export",
			book: "#1",
		});
		expect(exported).toContain("Exported 1 book");
		const file = join(workspace, "Engine-Care.library.tar.gz");
		expect(existsSync(file)).toBe(true);
		expect(
			await call("library_transfer", { action: "import", file }),
		).toContain('"Engine Care" left out: it is already here');

		const other = new Library({
			directory: join(root, "other"),
			runtimeDirectory: join(root, "no-runtime"),
		});
		try {
			const [transfer] = createLibraryTools({
				cwd: workspace,
				getConfig: () => config,
				library: other,
				librarian: true,
			}).filter((tool) => tool.name === "library_transfer");
			expect(
				String(await transfer.execute({ action: "import", file }, CONTEXT)),
			).toContain('- "Engine Care" on Cars / Maintenance');
			expect(other.catalogue.books()).toHaveLength(1);
		} finally {
			await other.close();
		}
	});

	it("reranks with the configured model and shows the relevance", async () => {
		write("engine.md", BOOK);
		await addBook();
		config = on(
			{},
			{ reranker: { baseUrl: "http://rerank.test", model: "r" } },
		);
		expect(await call("search_library", { query: "thermostat" })).toContain(
			"(relevance 0.93)",
		);
	});

	it("says why nothing was embedded when LanceDB is not installed", async () => {
		write("engine.md", BOOK);
		config = on(
			{},
			{ embedding: { baseUrl: "http://embed.test", model: "toy" } },
		);
		expect(await addBook()).toContain(
			"Not embedded: LanceDB is not installed yet.",
		);
	});

	describe("from the web", () => {
		const page = (subject: string) =>
			`<h1>${subject}</h1><p>${Array.from({ length: 30 }, (_u, i) => `Recipe ${i} for ${subject} with a tilemap layer.`).join(" ")}</p><div class="highlight-gdscript"><pre><span>func</span> _ready():\n    pass</pre></div>`;
		const create = (extra: Record<string, unknown> = {}) =>
			call("library_web_book", {
				action: "create",
				title: "Godot-Github",
				description: "GitHub recipes for Godot development.",
				section: "Game development",
				shelf: "Godot",
				query: "Github recipes for Godot development",
				links: ["https://example.com/a", "https://example.com/b"],
				...extra,
			});

		beforeEach(() => {
			config = on({}, { scrape: scraper });
			pages = {
				"https://example.com/a": page("terrain"),
				"https://example.com/b": page("navigation"),
			};
		});

		it("says scraping is not set up when it is not", async () => {
			const tool = tools().web_scrape;
			config = on();
			expect(
				String(await tool.execute({ action: "search", query: "x" }, CONTEXT)),
			).toContain("not set up");
		});

		it("searches, and reads a page with its code fenced", async () => {
			expect(
				await call("web_scrape", { action: "search", query: "godot" }),
			).toContain(
				"- https://example.com/a\n  Title of https://example.com/a — About tilemaps.",
			);
			const read = await call("web_scrape", {
				action: "read",
				url: "https://example.com/a",
			});
			expect(read).toContain("# terrain");
			expect(read).toContain("```gdscript\nfunc _ready():\n    pass\n```");
			expect(
				await call("web_scrape", { action: "read", url: "ftp://x" }),
			).toContain("needs a `url`");
		});

		it("makes a book from links and keeps the query and the links with it", async () => {
			const made = await create();
			expect(made).toContain('"Godot-Github" (#1): 2 pages read in');
			const [book] = library.catalogue.books();
			expect(book.metadata.web).toMatchObject({
				query: "Github recipes for Godot development",
				links: ["https://example.com/a", "https://example.com/b"],
				crawl: { depth: 0 },
			});
			expect(
				library.catalogue.sources(book.id).map((source) => source.url),
			).toEqual(["https://example.com/a", "https://example.com/b"]);
			expect(
				await call("search_library", { query: "navigation recipe" }),
			).toContain(
				"Game development / Godot / Godot-Github — https://example.com/b",
			);
			expect(await call("list_library", { book: "#1" })).toContain(
				"Made from the search: Github recipes for Godot development",
			);
			// The same again is not made twice.
			expect(await create()).toContain(
				"Nothing was made. The Library already has",
			);
			expect(library.catalogue.books()).toHaveLength(1);
		});

		it("keeps no book when no page could be read", async () => {
			pages = {};
			expect(await create()).toContain(
				"No page could be read, so the book was not kept.",
			);
			expect(library.catalogue.books()).toEqual([]);
		});

		it("checks a book for news, and brings it in only when asked to", async () => {
			await create();
			expect(
				await call("library_web_book", { action: "check", book: "#1" }),
			).toContain("0 new, 0 changed, 2 the same");
			pages["https://example.com/a"] = page("terrain and autotiles");
			const checked = await call("library_web_book", {
				action: "check",
				book: "Godot-Github",
			});
			expect(checked).toContain("0 new, 1 changed, 1 the same");
			expect(checked).toContain("changed: https://example.com/a");
			expect(await call("search_library", { query: "autotiles" })).toContain(
				"nothing found",
			);
			const updated = await call("library_web_book", {
				action: "update",
				book: "#1",
			});
			expect(updated).toContain("Brought in: 0 new, 1 replaced");
			expect(await call("search_library", { query: "autotiles" })).toContain(
				"[1]",
			);
			expect(library.catalogue.sources(1)).toHaveLength(2);
			expect(library.catalogue.book(1)?.metadata.web?.checkedAt).toBeTruthy();
		});

		it("does not call a page gone because the page budget stopped short of it", async () => {
			for (const name of ["c", "d", "e", "f"]) {
				pages[`https://example.com/${name}`] = page(`topic ${name}`);
			}
			const links = ["a", "b", "c", "d", "e"].map(
				(name) => `https://example.com/${name}`,
			);
			await create({ links: links.slice(0, 2) });
			await call("library_web_book", {
				action: "add",
				book: "#1",
				links: links.slice(2),
			});
			// Six links against a limit of five pages a call.
			await call("library_web_book", {
				action: "add",
				book: "#1",
				links: ["https://example.com/f"],
			});
			const checked = await call("library_web_book", {
				action: "check",
				book: "#1",
			});
			expect(checked).toContain(
				"5 pages read from 6 links: 0 new, 0 changed, 5 the same.",
			);
			expect(checked).toContain("Stopped at 5 pages");
			expect(checked).not.toContain("no longer found");
			// A page that is asked for and does not come back is gone, and kept.
			delete pages["https://example.com/b"];
			const gone = await call("library_web_book", {
				action: "check",
				book: "#1",
			});
			expect(gone).toContain("1 no longer found");
			expect(gone).toContain("not found now (kept): https://example.com/b");
		});

		it("does not call a page changed for a counter or a date", async () => {
			await create();
			pages["https://example.com/a"] =
				`${page("terrain")}<p>Read 1,204 times. Updated today.</p>`;
			const checked = await call("library_web_book", {
				action: "check",
				book: "#1",
			});
			expect(checked).toContain(
				"0 new, 0 changed, 2 the same (1 of them differ only in details such as dates and counters).",
			);
			expect(
				await call("library_web_book", { action: "update", book: "#1" }),
			).toContain("Brought in: 0 new, 0 replaced");
		});

		it("reads a page that looks changed once more before saying so", async () => {
			await create();
			// Caught half loaded once, then as it was.
			let reads = 0;
			const whole = page("terrain");
			pages["https://example.com/a"] = () =>
				reads++ === 0 ? "<h1>terrain</h1><p>Loading…</p>" : whole;
			const checked = await call("library_web_book", {
				action: "check",
				book: "#1",
			});
			expect(checked).toContain("0 new, 0 changed, 2 the same");
			expect(reads).toBe(2);
		});

		it("follows links as deep as asked, within the user's limits", async () => {
			pages["https://example.com/c"] = page("shaders");
			const made = await create({
				links: ["https://example.com/a"],
				depth: 9,
				limit: 99,
			});
			expect(made).toContain("3 pages read in");
			expect(made).toContain("followed 2 deep");
			expect(library.catalogue.book(1)?.metadata.web?.crawl).toEqual({
				depth: 2,
				limit: 5,
			});
			expect(requests).toContain("GET /v2/crawl/job1?skip=0");
			// A link added later joins the links it is checked against.
			pages["https://example.com/d"] = page("signals");
			expect(
				await call("library_web_book", {
					action: "add",
					book: "#1",
					links: ["https://example.com/d", "not a link"],
				}),
			).toContain("Not links, left out: not a link");
			expect(library.catalogue.book(1)?.metadata.web?.links).toEqual([
				"https://example.com/a",
				"https://example.com/d",
			]);
		});

		it("has nothing to check a book made from files against", async () => {
			write("engine.md", BOOK);
			await addBook();
			expect(
				await call("library_web_book", { action: "check", book: "#1" }),
			).toContain("was not made from web links");
		});
	});
});
