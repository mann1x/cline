/**
 * The librarian's tools: everything that changes the Library.
 *
 * They come with the `librarian` skill, which says how the work is done:
 * check whether a book is already here before adding it, ask the user when
 * it is another edition, put it on the shelf it belongs on. The tools keep
 * the rules that must hold whoever is asking: nothing is added over a book
 * that looks the same without being told to, and nothing is deleted, only
 * moved to the trash.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import {
	type BookMatch,
	type BookMetadata,
	type Catalogue,
	type LibraryBook,
	TRASH_DAYS,
} from "../../services/retrieval/catalogue";
import { textFingerprint } from "../../services/retrieval/fingerprint";
import {
	crawlSite,
	mapSite,
	type ScrapedPage,
	type ScrapeFailure,
	scrapePage,
	searchWeb,
} from "../../services/retrieval/firecrawl";
import { type Library, sharedLibrary } from "../../services/retrieval/library";
import { DOCUMENT_EXTENSIONS } from "./executors/document/formats";
import {
	type BookDocument,
	describeBookPictures,
	readDocumentForBook,
} from "./executors/document-extract";
import {
	activeConfig,
	type CreateLibraryToolsOptions,
	describeBook,
	describeBookLine,
	describeShelves,
	errorText,
	LIBRARY_OFF,
	type LibraryToolsConfig,
	plural,
	resolveShelf,
	strings,
	text,
} from "./library-tools";

export const LIBRARIAN_TOOL_NAMES = [
	"library_check",
	"library_add",
	"library_organize",
	"library_transfer",
	"web_scrape",
	"library_web_book",
] as const;

/** Read as they are; everything in DOCUMENT_EXTENSIONS goes through the Document Reader. */
const TEXT_EXTENSIONS = new Set([
	".md",
	".mdx",
	".markdown",
	".txt",
	".text",
	".rst",
	".adoc",
	".org",
	".tex",
]);
const DOCUMENT_EXTENSION_SET = new Set(DOCUMENT_EXTENSIONS);
const MAX_FILES_PER_CALL = 200;
const MAX_TEXT_FILE_BYTES = 50 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
/** A book can be large and its pictures many: a call may run this long. */
const LONG_CALL_MS = 60 * 60_000;
/** Text this much the same is the same book; less, another edition of it. */
const SAME_TEXT = 0.9;

const NO_SCRAPER =
	"Web scraping is not set up for this session. The user sets the endpoint under Settings > Features and allows it in the API configuration; do not call this again in this task.";

interface ReadSource {
	file: string;
	name: string;
	sha256: string;
	document: BookDocument;
	isbn?: string;
	fingerprint: number[];
}

const readCache = new Map<string, ReadSource>();

async function sha256OfFile(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file))
		hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** An ISBN printed in the first pages, when there is one. */
export function findIsbn(markdown: string): string | undefined {
	const found =
		/ISBN(?:-1[03])?[:\s]*((?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx])/.exec(
			markdown.slice(0, 40_000),
		);
	return found ? found[1].replace(/[\s-]/g, "").toUpperCase() : undefined;
}

async function filesUnder(
	target: string,
	found: string[],
	skipped: { count: number },
): Promise<void> {
	const entries = await fs.readdir(target, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const full = path.join(target, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			await filesUnder(full, found, skipped);
		} else if (entry.isFile()) {
			const extension = path.extname(entry.name).toLowerCase();
			if (
				!TEXT_EXTENSIONS.has(extension) &&
				!DOCUMENT_EXTENSION_SET.has(extension)
			) {
				continue;
			}
			if (found.length >= MAX_FILES_PER_CALL) skipped.count++;
			else found.push(full);
		}
	}
}

async function resolveFiles(
	cwd: string,
	paths: readonly string[],
): Promise<{ files: string[]; notes: string[] }> {
	const files: string[] = [];
	const notes: string[] = [];
	const skipped = { count: 0 };
	for (const given of paths) {
		const full = path.resolve(cwd, given);
		const stat = await fs.stat(full).catch(() => undefined);
		if (!stat) {
			notes.push(`${given}: no such file or folder.`);
		} else if (stat.isDirectory()) {
			const before = files.length;
			await filesUnder(full, files, skipped);
			if (files.length === before && skipped.count === 0) {
				notes.push(`${given}: no documents or text files inside.`);
			}
		} else if (files.length >= MAX_FILES_PER_CALL) {
			skipped.count++;
		} else {
			files.push(full);
		}
	}
	if (skipped.count > 0) {
		notes.push(
			`${skipped.count} more file(s) were left for another call: one call takes at most ${MAX_FILES_PER_CALL}.`,
		);
	}
	return { files, notes };
}

/** A file as text, with its pictures, its hash and its fingerprint. Read once a session. */
async function readSource(
	file: string,
	config: LibraryToolsConfig,
	library: Library,
): Promise<ReadSource> {
	const stat = await fs.stat(file);
	const key = `${file}:${stat.size}:${stat.mtimeMs}`;
	const cached = readCache.get(key);
	if (cached) return cached;
	const extension = path.extname(file).toLowerCase();
	let document: BookDocument;
	if (DOCUMENT_EXTENSION_SET.has(extension)) {
		document = await readDocumentForBook(file, {
			scratchDir: path.join(library.directory, "scratch"),
			reader: config.documentReader,
		});
	} else {
		if (stat.size > MAX_TEXT_FILE_BYTES) {
			throw new Error(
				`it is ${Math.round(stat.size / 1024 / 1024)} MB of text, past the ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB one file may be`,
			);
		}
		const data = await fs.readFile(file);
		if (data.subarray(0, 8192).includes(0)) {
			throw new Error(
				"it is not a text file or a format the Document Reader reads",
			);
		}
		const markdown = data.toString("utf8");
		const heading = /^#\s+(.+)$/m.exec(markdown.slice(0, 2000))?.[1]?.trim();
		document = {
			markdown,
			format: "text" as BookDocument["format"],
			...(heading ? { title: heading } : {}),
			bytes: stat.size,
			notes: [],
			images: [],
		};
	}
	if (!document.markdown.trim()) {
		throw new Error(
			`there is no text in it${document.notes.length ? ` (${document.notes.join(" ")})` : ""}`,
		);
	}
	const read: ReadSource = {
		file,
		name: path.basename(file),
		sha256: await sha256OfFile(file),
		document,
		isbn: findIsbn(document.markdown),
		fingerprint: textFingerprint(document.markdown),
	};
	if (readCache.size > 32) readCache.clear();
	readCache.set(key, read);
	return read;
}

type Verdict = "here" | "same book" | "other version" | "new";

interface Judged {
	verdict: Verdict;
	matches: BookMatch[];
	line: string;
}

function where(catalogue: Catalogue, book: LibraryBook): string {
	if (book.trashedAt) return "in the trash";
	const shelf =
		book.shelfId !== undefined ? catalogue.shelf(book.shelfId) : undefined;
	return shelf ? `on ${shelf.section} / ${shelf.name}` : "in the Library";
}

/** Whether what is about to be added is here already, and as what. */
function judge(
	catalogue: Catalogue,
	input: {
		sha256?: string;
		url?: string;
		title?: string;
		authors?: readonly string[];
		isbn?: string;
		fingerprint?: readonly number[];
	},
	exceptBookId?: number,
): Judged {
	const matches = catalogue
		.findSimilar(input)
		.filter((match) => match.book.id !== exceptBookId);
	if (matches.length === 0) {
		return { verdict: "new", matches, line: "not in the Library." };
	}
	const said = (match: BookMatch) =>
		`#${match.book.id} "${match.book.title}"${match.book.metadata.edition ? ` (${match.book.metadata.edition})` : ""}, ${where(catalogue, match.book)}`;
	const same = matches.find(
		(match) => match.reason === "same file" || match.reason === "same link",
	);
	if (same) {
		return {
			verdict: "here",
			matches,
			line: `ALREADY HERE: the ${same.reason === "same file" ? "same file" : "same link"} is in ${said(same)}.${same.book.trashedAt ? " Restore that book instead of adding it again." : " Skip it."}`,
		};
	}
	const similar = matches
		.filter((match) => match.reason === "similar text")
		.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))[0];
	if (similar && (similar.similarity ?? 0) >= SAME_TEXT) {
		return {
			verdict: "same book",
			matches,
			line: `SAME BOOK, another file: ${Math.round((similar.similarity ?? 0) * 100)}% of its text is in ${said(similar)}. Skip it, or add it to that book as another source if the user wants this format kept too.`,
		};
	}
	const named = matches.find((match) => match.reason !== "similar text");
	const other = similar ?? named;
	return {
		verdict: "other version",
		matches,
		line: `ANOTHER VERSION, it seems: ${matches
			.map(
				(match) =>
					`${match.reason}${match.similarity !== undefined ? ` (${Math.round(match.similarity * 100)}% in common)` : ""} with ${said(match)}`,
			)
			.join(
				"; ",
			)}. Ask the user whether to keep both (if_exists "new_version") or to replace ${other ? `#${other.book.id}` : "it"} (if_exists "replace").`,
	};
}

function metadataFrom(request: Record<string, unknown>): BookMetadata {
	const metadata: BookMetadata = {};
	const authors = strings(request.authors ?? request.author);
	if (authors.length > 0) metadata.authors = authors;
	for (const key of ["edition", "language", "isbn", "publisher"] as const) {
		const value = text(request[key]);
		if (value) metadata[key] = value;
	}
	const year = Number(request.year);
	if (Number.isInteger(year) && year > 0) metadata.year = year;
	const tags = strings(request.tags);
	if (tags.length > 0) metadata.tags = tags;
	return metadata;
}

/** The one book a reference names, or the reason there is not exactly one. */
function oneBook(
	catalogue: Catalogue,
	reference: string,
	options: { trashed?: boolean } = {},
): LibraryBook | string {
	const found = catalogue.findBooks(reference, options);
	if (found.length === 1) return found[0];
	if (found.length === 0) {
		return `No book "${reference}"${options.trashed ? " in the trash" : " on the shelves"}. list_library shows what is there${options.trashed ? ' (view "trash")' : ""}.`;
	}
	return `${found.length} books are called "${reference}": ${found.map((book) => `#${book.id} (${where(catalogue, book)})`).join(", ")}. Name it by its number.`;
}

/** The shelf to put a book on, made if it does not exist yet. */
function placeFor(
	catalogue: Catalogue,
	request: Record<string, unknown>,
): { shelfId: number; label: string; made: string[] } | string {
	const section = text(request.section);
	const shelf = text(request.shelf);
	if (!shelf) return "Say which `shelf` (and `section`) the book goes on.";
	const existing = resolveShelf(catalogue, shelf, section);
	if (existing) {
		return {
			shelfId: existing.id,
			label: `${existing.section} / ${existing.name}`,
			made: [],
		};
	}
	if (!section) {
		return `No shelf "${shelf}" yet. Give the \`section\` it belongs in and it is made.\n${describeShelves(catalogue)}`;
	}
	const made: string[] = [];
	if (!catalogue.findSection(section)) made.push(`section "${section}"`);
	const inSection = catalogue.ensureSection(section);
	const created = catalogue.ensureShelf(
		inSection.id,
		shelf.split("/").pop() ?? shelf,
	);
	made.push(`shelf "${created.name}"`);
	return {
		shelfId: created.id,
		label: `${inSection.name} / ${created.name}`,
		made,
	};
}

async function embedNew(
	library: Library,
	config: LibraryToolsConfig,
	collectionIds: readonly number[],
	options: CreateLibraryToolsOptions,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!config.embedding) return undefined;
	try {
		const embedded = await library.embedPending({
			embedding: config.embedding,
			settings: config.settings,
			collectionIds,
			...(signal ? { signal } : {}),
		});
		return embedded.skipped
			? `Not embedded: ${embedded.skipped} Search is by keyword until it is.`
			: `Embedded ${plural(embedded.chunks, "passage")} with ${config.embedding.model}, for search by meaning.`;
	} catch (error) {
		options.onError?.("[library] embedding failed", error);
		return `Embedding stopped (${errorText(error)}). The book is searchable by keyword; the rest is embedded the next time something is added.`;
	}
}

function createLibraryCheckTool(options: CreateLibraryToolsOptions): AgentTool {
	return createTool({
		name: "library_check",
		description:
			"Before adding anything to the Library: read the files (or take the links) and say, for each, whether it is already there. It reports the title, author and ISBN found in each file, and one of: not in the Library; already here (the same file or link); the same book in another file; or another version of a book that is here. Changes nothing. Call it for every file before library_add, and tell the user what it found when it is another version.",
		inputSchema: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description:
						"Files or folders to check, absolute or relative to the workspace.",
				},
				links: {
					type: "array",
					items: { type: "string" },
					description: "Web links to check.",
				},
				title: {
					type: "string",
					description: "A title to look for, when there is no file yet.",
				},
			},
		},
		readOnly: true,
		timeoutMs: LONG_CALL_MS,
		retryable: false,
		execute: async (input: unknown, context): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return LIBRARY_OFF;
			const request = (input ?? {}) as Record<string, unknown>;
			const library = options.library ?? sharedLibrary();
			const catalogue = library.catalogue;
			const paths = strings(request.paths ?? request.path);
			const links = strings(request.links);
			const title = text(request.title);
			if (paths.length === 0 && links.length === 0 && !title) {
				return "`library_check` needs `paths`, `links` or a `title`.";
			}
			const lines: string[] = [];
			const { files, notes } = await resolveFiles(options.cwd, paths);
			lines.push(...notes);
			for (const file of files) {
				if (context?.signal?.aborted) break;
				try {
					const read = await readSource(file, config, library);
					const judged = judge(catalogue, {
						sha256: read.sha256,
						title: read.document.title,
						authors: read.document.author ? [read.document.author] : [],
						isbn: read.isbn,
						fingerprint: read.fingerprint,
					});
					const words = read.document.markdown.split(/\s+/).length;
					lines.push(
						`${file}`,
						`  ${[
							read.document.title
								? `title "${read.document.title}"`
								: "no title in the file",
							read.document.author ? `by ${read.document.author}` : undefined,
							read.isbn ? `ISBN ${read.isbn}` : undefined,
							`${words.toLocaleString("en-US")} words`,
							plural(read.document.images.length, "picture"),
						]
							.filter(Boolean)
							.join(", ")}`,
						`  ${judged.line}`,
						...read.document.notes.map((note) => `  ${note}`),
					);
				} catch (error) {
					lines.push(`${file}`, `  could not be read: ${errorText(error)}`);
				}
			}
			for (const link of links) {
				lines.push(link, `  ${judge(catalogue, { url: link }).line}`);
			}
			if (title) {
				lines.push(`"${title}"`, `  ${judge(catalogue, { title }).line}`);
			}
			return lines.join("\n");
		},
	});
}

function createLibraryAddTool(options: CreateLibraryToolsOptions): AgentTool {
	return createTool({
		name: "library_add",
		description: `Add one book to the Library from files: text and markdown as they are, and ${[...new Set(DOCUMENT_EXTENSIONS.map((extension) => extension.slice(1)))].slice(0, 10).join(", ")} and the other formats the Document Reader reads. One call is one book; several files in a call are that book's sources (its volumes, or the same book in two formats). Give a new book its title, a description of two or three sentences, and the section and shelf it belongs on (made if they do not exist). Or name an existing \`book\` to add the files to it. The files are copied into the Library, their pictures taken out and described. If the book looks like one already there, nothing is added and you are told why: ask the user, then call again with if_exists.`,
		inputSchema: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description:
						"The book's files, absolute or relative to the workspace.",
				},
				book: {
					type: "string",
					description:
						"An existing book, by title or number (#12), to add the files to. Leave out for a new book.",
				},
				title: { type: "string", description: "The new book's title." },
				description: {
					type: "string",
					description:
						"What the book is and what it covers, in two or three sentences.",
				},
				section: {
					type: "string",
					description: "The section its shelf is in.",
				},
				shelf: { type: "string", description: "The shelf it goes on." },
				authors: { type: "array", items: { type: "string" } },
				edition: { type: "string", description: 'Such as "2nd" or "v4.3".' },
				year: { type: "integer" },
				language: { type: "string" },
				isbn: { type: "string" },
				publisher: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				if_exists: {
					type: "string",
					enum: ["stop", "new_version", "replace", "add_anyway"],
					description:
						'What to do when it looks like a book already there. "stop" (the default) adds nothing and reports. "new_version" keeps both. "replace" moves the old one to the trash. "add_anyway" adds it regardless. Only after the user has said which.',
				},
			},
			required: ["paths"],
		},
		timeoutMs: LONG_CALL_MS,
		retryable: false,
		execute: async (input: unknown, context): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return LIBRARY_OFF;
			const request = (input ?? {}) as Record<string, unknown>;
			const library = options.library ?? sharedLibrary();
			const catalogue = library.catalogue;
			const paths = strings(request.paths ?? request.path);
			if (paths.length === 0) {
				return "`library_add` needs `paths`: the book's files.";
			}
			const ifExists = text(request.if_exists) || "stop";
			const bookReference = text(request.book);
			let target: LibraryBook | undefined;
			if (bookReference) {
				const found = oneBook(catalogue, bookReference);
				if (typeof found === "string") return found;
				target = found;
			} else {
				if (!text(request.title)) {
					return "A new book needs a `title`. Or name an existing `book` to add the files to.";
				}
				if (!text(request.description)) {
					return "A new book needs a `description`: what it is and what it covers, in two or three sentences.";
				}
			}

			const { files, notes } = await resolveFiles(options.cwd, paths);
			const lines = [...notes];
			const read: Awaited<ReturnType<typeof readSource>>[] = [];
			for (const file of files) {
				if (context?.signal?.aborted) return "Stopped; nothing was added.";
				try {
					read.push(await readSource(file, config, library));
				} catch (error) {
					lines.push(`${file}: not read, ${errorText(error)}`);
				}
			}
			if (read.length === 0) {
				return ["Nothing was added: no file could be read.", ...lines].join(
					"\n",
				);
			}

			// Is it here already. Each file is judged, and the book by its title.
			const metadata = metadataFrom(request);
			const judgedFiles = read.map((source) => ({
				source,
				judged: judge(
					catalogue,
					{
						sha256: source.sha256,
						isbn: metadata.isbn ?? source.isbn,
						title: target ? undefined : text(request.title),
						authors: metadata.authors,
						fingerprint: source.fingerprint,
					},
					target?.id,
				),
			}));
			const here = judgedFiles.filter(
				(entry) => entry.judged.verdict === "here",
			);
			const doubtful = judgedFiles.filter(
				(entry) =>
					entry.judged.verdict === "same book" ||
					entry.judged.verdict === "other version",
			);
			if (ifExists !== "add_anyway" && here.length === judgedFiles.length) {
				return [
					"Nothing was added: every file is already in the Library.",
					...here.map((entry) => `${entry.source.file}: ${entry.judged.line}`),
				].join("\n");
			}
			if (doubtful.length > 0 && ifExists === "stop") {
				return [
					"Nothing was added. This looks like a book the Library already has:",
					...doubtful.map(
						(entry) => `${entry.source.file}: ${entry.judged.line}`,
					),
					...here.map((entry) => `${entry.source.file}: ${entry.judged.line}`),
					'Tell the user what was found and ask: keep both (call again with if_exists "new_version"), replace the old one (if_exists "replace"), or leave it.',
				].join("\n");
			}

			const made: string[] = [];
			const replaced: LibraryBook[] = [];
			if (!target) {
				const place = placeFor(catalogue, request);
				if (typeof place === "string") return place;
				made.push(...place.made);
				const older = [
					...new Map(
						doubtful
							.flatMap((entry) => entry.judged.matches)
							.filter((match) => !match.book.trashedAt)
							.map((match) => [match.book.id, match.book]),
					).values(),
				];
				if (ifExists === "new_version" && older.length > 0) {
					metadata.versionOf = older.map((book) => ({
						uid: book.uid,
						title: book.title,
						...(book.metadata.edition
							? { edition: book.metadata.edition }
							: {}),
					}));
				}
				if (ifExists === "replace") {
					for (const book of older) {
						catalogue.trashBook(book.id);
						replaced.push(book);
					}
				}
				const first = read[0];
				if (!metadata.authors && first.document.author) {
					metadata.authors = [first.document.author];
				}
				if (!metadata.isbn && first.isbn) metadata.isbn = first.isbn;
				target = catalogue.createBook({
					shelfId: place.shelfId,
					title: text(request.title),
					description: text(request.description),
					metadata,
				});
				lines.push(
					`New book ${describeBookLine(target).split(":")[0]} on ${place.label}${made.length ? ` (made ${made.join(" and ")})` : ""}.`,
				);
			}

			const describe =
				config.settings.describeImages &&
				config.settings.describeImagesLimit > 0
					? options.getDescribeImages?.()
					: undefined;
			let added = 0;
			let passages = 0;
			let pictures = 0;
			let described = 0;
			let undescribed = 0;
			for (const { source, judged } of judgedFiles) {
				if (context?.signal?.aborted) break;
				if (judged.verdict === "here" && ifExists !== "add_anyway") {
					lines.push(`${source.name}: left out. ${judged.line}`);
					continue;
				}
				try {
					if (source.document.images.length > 0) {
						if (describe) {
							const result = await describeBookPictures(
								source.document,
								describe,
								{
									documentName: source.name,
									limit: config.settings.describeImagesLimit,
								},
							);
							described += result.described;
							undescribed += result.candidates - result.described;
						} else {
							undescribed += source.document.images.length;
						}
					}
					const result = await catalogue.addSource(
						target.id,
						{
							kind: "file",
							name: source.name,
							path: source.file,
							text: source.document.markdown,
							title: source.document.title,
							metadata: {
								format: source.document.format,
								...(source.document.author
									? { author: source.document.author }
									: {}),
								...(source.isbn ? { isbn: source.isbn } : {}),
							},
							images: source.document.images,
						},
						config.settings,
					);
					if (result.outcome === "unchanged") {
						lines.push(`${source.name}: already a source of this book.`);
						continue;
					}
					added++;
					passages += result.passages;
					pictures += result.images;
					lines.push(
						`${source.name}: added as source ${result.source.id}, ${plural(result.passages, "passage")}${result.images ? `, ${plural(result.images, "picture")}` : ""}${source.document.notes.length ? `. ${source.document.notes.join(" ")}` : ""}`,
					);
				} catch (error) {
					lines.push(`${source.name}: not added, ${errorText(error)}`);
				}
			}
			const summary = [
				`"${target.title}" (#${target.id}): ${plural(added, "source")} added, ${plural(passages, "passage")}, searchable by keyword now.`,
			];
			if (pictures > 0) {
				summary.push(
					describe
						? `${plural(pictures, "picture")} kept, ${described} described${undescribed > 0 ? `; ${undescribed} have no description` : ""}.`
						: `${plural(pictures, "picture")} kept, none described: ${config.settings.describeImages ? "no vision model is set (Settings > Library, or the Vision tab)" : "describing pictures is turned off in Settings > Library"}.`,
				);
			}
			for (const book of replaced) {
				summary.push(
					`Replaced #${book.id} "${book.title}", which is in the trash for ${TRASH_DAYS} days.`,
				);
			}
			if (added > 0) {
				const embedded = await embedNew(
					library,
					config,
					[target.collectionId],
					options,
					context?.signal,
				);
				if (embedded) summary.push(embedded);
			}
			return [...summary, ...lines].join("\n");
		},
	});
}

function createLibraryOrganizeTool(
	options: CreateLibraryToolsOptions,
): AgentTool {
	return createTool({
		name: "library_organize",
		description: `Reorganise the Library: sections, shelves and the books on them. One action a call.
- create_section (section, description) · update_section (section, name?, description?) · delete_section (section)
- create_shelf (section, shelf, description) · update_shelf (shelf, name?, description?, to_section?) · delete_shelf (shelf)
- move_book (book, shelf, section?) · update_book (book, title?, description?, authors?, edition?, year?, language?, isbn?, publisher?, tags?) · delete_book (book) · restore_book (book, shelf?)
- merge_books (book, into): every source of \`book\` moves into \`into\`
- remove_source (source) · restore_source (source): by the source number list_library gives for a book
Nothing here is final: a deleted book, the books of a deleted shelf or section, and a removed source go to the trash for ${TRASH_DAYS} days, where restore_book and restore_source find them. Emptying the trash is the user's, in Settings.`,
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"create_section",
						"update_section",
						"delete_section",
						"create_shelf",
						"update_shelf",
						"delete_shelf",
						"move_book",
						"update_book",
						"delete_book",
						"restore_book",
						"merge_books",
						"remove_source",
						"restore_source",
					],
				},
				section: { type: "string" },
				shelf: {
					type: "string",
					description: 'A shelf, as "Section / Shelf" or its name.',
				},
				book: {
					type: "string",
					description: "A book, by title or number (#12).",
				},
				into: {
					type: "string",
					description: "merge_books: the book that receives.",
				},
				source: { type: "integer", description: "A source's number." },
				name: { type: "string", description: "The new name." },
				to_section: {
					type: "string",
					description: "update_shelf: the section to move it to.",
				},
				title: { type: "string" },
				description: { type: "string" },
				authors: { type: "array", items: { type: "string" } },
				edition: { type: "string" },
				year: { type: "integer" },
				language: { type: "string" },
				isbn: { type: "string" },
				publisher: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
			},
			required: ["action"],
		},
		timeoutMs: LONG_CALL_MS,
		retryable: false,
		execute: async (input: unknown): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return LIBRARY_OFF;
			const request = (input ?? {}) as Record<string, unknown>;
			const library = options.library ?? sharedLibrary();
			const catalogue = library.catalogue;
			const action = text(request.action);
			const sectionName = text(request.section);
			const shelfName = text(request.shelf);
			const section = () => {
				if (!sectionName) return "Say which `section`.";
				return (
					catalogue.findSection(sectionName) ??
					`No section "${sectionName}".\n${describeShelves(catalogue)}`
				);
			};
			const shelf = () => {
				if (!shelfName) return "Say which `shelf`.";
				return (
					resolveShelf(catalogue, shelfName, sectionName) ??
					`No shelf "${shelfName}", or more than one of that name: say "Section / Shelf".\n${describeShelves(catalogue)}`
				);
			};
			try {
				switch (action) {
					case "create_section": {
						if (!sectionName) return "Say the `section`'s name.";
						const existed = catalogue.findSection(sectionName);
						const made = catalogue.ensureSection(
							sectionName,
							text(request.description),
						);
						return existed
							? `Section "${made.name}" is already there.`
							: `Section "${made.name}" made.`;
					}
					case "update_section": {
						const found = section();
						if (typeof found === "string") return found;
						catalogue.updateSection(found.id, {
							...(text(request.name) ? { name: text(request.name) } : {}),
							...(typeof request.description === "string"
								? { description: request.description }
								: {}),
						});
						return `Section "${found.name}" is now "${text(request.name) || found.name}"${typeof request.description === "string" ? ", with its new description" : ""}.`;
					}
					case "delete_section": {
						const found = section();
						if (typeof found === "string") return found;
						const trashed = catalogue.deleteSection(found.id);
						return `Section "${found.name}" and its ${plural(found.shelves.length, "shelf", "shelves")} removed. ${plural(trashed, "book")} moved to the trash, kept ${TRASH_DAYS} days.`;
					}
					case "create_shelf": {
						if (!shelfName) return "Say the `shelf`'s name.";
						if (!sectionName) return "Say which `section` the shelf goes in.";
						const inSection = catalogue.ensureSection(sectionName);
						const made = catalogue.ensureShelf(
							inSection.id,
							shelfName,
							text(request.description),
						);
						return `Shelf ${inSection.name} / ${made.name} is there.`;
					}
					case "update_shelf": {
						const found = shelf();
						if (typeof found === "string") return found;
						const destination = text(request.to_section);
						const toSection = destination
							? catalogue.ensureSection(destination)
							: undefined;
						catalogue.updateShelf(found.id, {
							...(text(request.name) ? { name: text(request.name) } : {}),
							...(typeof request.description === "string"
								? { description: request.description }
								: {}),
							...(toSection ? { sectionId: toSection.id } : {}),
						});
						const now = catalogue.shelf(found.id);
						return `Shelf ${found.section} / ${found.name} is now ${now?.section} / ${now?.name}.`;
					}
					case "delete_shelf": {
						const found = shelf();
						if (typeof found === "string") return found;
						const trashed = catalogue.deleteShelf(found.id);
						return `Shelf ${found.section} / ${found.name} removed. ${plural(trashed, "book")} moved to the trash, kept ${TRASH_DAYS} days.`;
					}
					case "move_book": {
						const book = oneBook(catalogue, text(request.book));
						if (typeof book === "string") return book;
						const place = placeFor(catalogue, request);
						if (typeof place === "string") return place;
						catalogue.updateBook(book.id, { shelfId: place.shelfId });
						return `"${book.title}" is now on ${place.label}${place.made.length ? ` (made ${place.made.join(" and ")})` : ""}.`;
					}
					case "update_book": {
						const book = oneBook(catalogue, text(request.book));
						if (typeof book === "string") return book;
						const updated = catalogue.updateBook(book.id, {
							...(text(request.title) ? { title: text(request.title) } : {}),
							...(typeof request.description === "string"
								? { description: request.description }
								: {}),
							metadata: metadataFrom(request),
						});
						return describeBook(catalogue, updated);
					}
					case "delete_book": {
						const book = oneBook(catalogue, text(request.book));
						if (typeof book === "string") return book;
						catalogue.trashBook(book.id);
						return `"${book.title}" (#${book.id}) is in the trash, kept ${TRASH_DAYS} days. restore_book brings it back.`;
					}
					case "restore_book": {
						const book = oneBook(catalogue, text(request.book), {
							trashed: true,
						});
						if (typeof book === "string") return book;
						let shelfId: number | undefined;
						if (shelfName) {
							const place = placeFor(catalogue, request);
							if (typeof place === "string") return place;
							shelfId = place.shelfId;
						}
						const restored = catalogue.restoreBook(book.id, shelfId);
						const at = catalogue.shelf(restored.shelfId ?? -1);
						return `"${restored.title}" is back on ${at?.section} / ${at?.name}.`;
					}
					case "merge_books": {
						const from = oneBook(catalogue, text(request.book));
						if (typeof from === "string") return from;
						const into = oneBook(catalogue, text(request.into));
						if (typeof into === "string") return into;
						const merged = await catalogue.mergeBooks(
							from.id,
							into.id,
							config.settings,
						);
						return `${plural(merged.moved, "source")} of "${from.title}" moved into "${into.title}"${merged.alreadyThere ? `; ${merged.alreadyThere} were already there` : ""}. "${from.title}" is in the trash, kept ${TRASH_DAYS} days.`;
					}
					case "remove_source": {
						const source = catalogue.source(Number(request.source));
						if (!source)
							return "No such source. list_library with a `book` gives their numbers.";
						await catalogue.removeSource(source.id);
						return `Source ${source.id} (${source.url ?? source.name}) taken out of its book, kept ${TRASH_DAYS} days. restore_source brings it back.`;
					}
					case "restore_source": {
						const source = catalogue.source(Number(request.source));
						if (!source) return "No such source.";
						await catalogue.restoreSource(source.id, config.settings);
						return `Source ${source.id} (${source.url ?? source.name}) is back in its book.`;
					}
					default:
						return `No action "${action}". See the tool's description for the actions.`;
				}
			} catch (error) {
				return `Not done: ${errorText(error)}`;
			}
		},
	});
}

function createLibraryTransferTool(
	options: CreateLibraryToolsOptions,
): AgentTool {
	return createTool({
		name: "library_transfer",
		description:
			'Export or import the Library. "export" writes the whole Library, or one section, shelf or book, to a file: the books\' own files, their text, pictures and descriptions, and where each stood. "import" reads such a file in: sections and shelves are made where missing, and a book already here is left alone unless `existing` says otherwise.',
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["export", "import"] },
				file: {
					type: "string",
					description:
						"The file to write or read, absolute or relative to the workspace. Export names it `.library.tar.gz` when left out.",
				},
				section: { type: "string", description: "export: only this section." },
				shelf: {
					type: "string",
					description:
						"export: only this shelf. import: put every book on this shelf.",
				},
				book: { type: "string", description: "export: only this book." },
				existing: {
					type: "string",
					enum: ["skip", "replace", "copy"],
					description:
						'import: a book already here is left ("skip", the default), replaced, or brought in beside it as a copy.',
				},
			},
			required: ["action"],
		},
		timeoutMs: LONG_CALL_MS,
		retryable: false,
		execute: async (input: unknown): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return LIBRARY_OFF;
			const request = (input ?? {}) as Record<string, unknown>;
			const library = options.library ?? sharedLibrary();
			const catalogue = library.catalogue;
			const action = text(request.action);
			try {
				if (action === "export") {
					let scope: Parameters<Catalogue["export"]>[0] = { library: true };
					let stem = "library";
					if (text(request.book)) {
						const book = oneBook(catalogue, text(request.book));
						if (typeof book === "string") return book;
						scope = { bookId: book.id };
						stem = book.title;
					} else if (text(request.shelf)) {
						const shelf = resolveShelf(
							catalogue,
							text(request.shelf),
							text(request.section),
						);
						if (!shelf)
							return `No shelf "${text(request.shelf)}".\n${describeShelves(catalogue)}`;
						scope = { shelfId: shelf.id };
						stem = shelf.name;
					} else if (text(request.section)) {
						const section = catalogue.findSection(text(request.section));
						if (!section)
							return `No section "${text(request.section)}".\n${describeShelves(catalogue)}`;
						scope = { sectionId: section.id };
						stem = section.name;
					}
					const file = path.resolve(
						options.cwd,
						text(request.file) ||
							`${stem.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "library"}.library.tar.gz`,
					);
					await fs.mkdir(path.dirname(file), { recursive: true });
					const result = await catalogue.export(scope, file);
					return `Exported ${plural(result.books, "book")} (${plural(result.files, "file")}, ${(result.bytes / 1024 / 1024).toFixed(1)} MB) to ${result.file}. Vectors are not in it; they are made again where it is imported.`;
				}
				if (action === "import") {
					if (!text(request.file)) return "`import` needs the `file` to read.";
					const file = path.resolve(options.cwd, text(request.file));
					let shelfId: number | undefined;
					if (text(request.shelf)) {
						const place = placeFor(catalogue, request);
						if (typeof place === "string") return place;
						shelfId = place.shelfId;
					}
					const existing = text(request.existing);
					const result = await catalogue.import(file, {
						settings: config.settings,
						...(shelfId !== undefined ? { shelfId } : {}),
						...(existing === "replace" || existing === "copy"
							? { existing }
							: {}),
					});
					const lines = [
						`Imported ${plural(result.imported.length, "book")}${result.skipped.length ? `, left ${result.skipped.length} out` : ""}.`,
						...result.imported.map(
							(book) => `- "${book.title}" on ${book.section} / ${book.shelf}`,
						),
						...result.skipped.map(
							(book) => `- "${book.title}" left out: ${book.reason}`,
						),
					];
					if (result.imported.length > 0) {
						const embedded = await embedNew(
							library,
							config,
							catalogue.searchableCollections(),
							options,
						);
						if (embedded) lines.push(embedded);
					}
					return lines.join("\n");
				}
				return 'Say `action`: "export" or "import".';
			} catch (error) {
				options.onError?.(`[library] ${action} failed`, error);
				return `Not done: ${errorText(error)}`;
			}
		},
	});
}

function cleanLink(link: string): string | undefined {
	try {
		const url = new URL(link.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function createWebScrapeTool(options: CreateLibraryToolsOptions): AgentTool {
	return createTool({
		name: "web_scrape",
		description:
			'Look at the web before making a book from it. "search": find pages for a topic, with their titles and what they are about. "map": the pages of a site, by their links, without reading them. "read": one page as markdown, to judge whether it belongs in the book. Rendered in a browser, so pages built by JavaScript are read too. Use it to choose the links; library_web_book reads them into the Library.',
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["search", "map", "read"] },
				query: { type: "string", description: "search: what to find." },
				url: { type: "string", description: "map: a site. read: a page." },
				limit: {
					type: "integer",
					description:
						"search: results (default 10). map: links (default 200).",
				},
				max_chars: {
					type: "integer",
					description: "read: how much of the page to return (default 12000).",
				},
			},
			required: ["action"],
		},
		readOnly: true,
		timeoutMs: 5 * 60_000,
		retryable: false,
		execute: async (input: unknown, context): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return LIBRARY_OFF;
			if (!config.scrape) return NO_SCRAPER;
			const request = (input ?? {}) as Record<string, unknown>;
			const action = text(request.action);
			const limit = Number(request.limit);
			const signal = context?.signal;
			try {
				if (action === "search") {
					const query = text(request.query);
					if (!query) return "`search` needs a `query`.";
					const hits = await searchWeb(config.scrape, query, {
						limit:
							Number.isFinite(limit) && limit > 0 ? Math.min(50, limit) : 10,
						...(signal ? { signal } : {}),
					});
					if (hits.length === 0) return `Nothing found for "${query}".`;
					return [
						`${plural(hits.length, "result")} for "${query}":`,
						...hits.map(
							(hit) =>
								`- ${hit.url}\n  ${hit.title ?? ""}${hit.description ? ` — ${hit.description.slice(0, 240)}` : ""}`,
						),
					].join("\n");
				}
				const url = cleanLink(text(request.url));
				if (!url)
					return `\`${action}\` needs a \`url\` starting with http:// or https://.`;
				if (action === "map") {
					const links = await mapSite(config.scrape, url, {
						limit:
							Number.isFinite(limit) && limit > 0 ? Math.min(2000, limit) : 200,
						...(signal ? { signal } : {}),
					});
					if (links.length === 0) {
						return `No links found from ${url}. Try the site's front page, or read the page and follow what it links to.`;
					}
					return [`${plural(links.length, "page")} of ${url}:`, ...links].join(
						"\n",
					);
				}
				if (action === "read") {
					const page = await scrapePage(config.scrape, url, {
						...(signal ? { signal } : {}),
					});
					const max = Number(request.max_chars);
					const cut = Number.isFinite(max) && max > 0 ? max : 12_000;
					return [
						`${page.url}${page.title ? ` — ${page.title}` : ""} (${page.markdown.length.toLocaleString("en-US")} characters)`,
						"---",
						page.markdown.slice(0, cut),
						...(page.markdown.length > cut
							? [`[Cut at ${cut.toLocaleString("en-US")} characters.]`]
							: []),
					].join("\n");
				}
				return 'Say `action`: "search", "map" or "read".';
			} catch (error) {
				options.onError?.(`[library] web_scrape ${action} failed`, error);
				return `Not done: ${errorText(error)}`;
			}
		},
	});
}

interface Gathered {
	pages: ScrapedPage[];
	failed: ScrapeFailure[];
	notes: string[];
}

/** Read the links, and what they link to as deep as asked, within the page budget. */
async function gather(
	config: LibraryToolsConfig,
	links: readonly string[],
	depth: number,
	budget: number,
	signal?: AbortSignal,
): Promise<Gathered> {
	const scrape = config.scrape;
	if (!scrape) throw new Error(NO_SCRAPER);
	const gathered: Gathered = { pages: [], failed: [], notes: [] };
	const seen = new Set<string>();
	const take = (page: ScrapedPage) => {
		if (seen.has(page.url) || gathered.pages.length >= budget) return;
		seen.add(page.url);
		gathered.pages.push(page);
	};
	for (const link of links) {
		signal?.throwIfAborted();
		const left = budget - gathered.pages.length;
		if (left <= 0) {
			gathered.notes.push(
				`Stopped at ${budget} pages, the most one book takes in a call; ${link} and what follows were not read.`,
			);
			break;
		}
		try {
			if (depth <= 0) {
				take(await scrapePage(scrape, link, { ...(signal ? { signal } : {}) }));
			} else {
				const crawled = await crawlSite(scrape, link, {
					limit: left,
					depth,
					...(signal ? { signal } : {}),
				});
				for (const page of crawled.pages) take(page);
				gathered.failed.push(...crawled.failed);
				if (crawled.unfinished) {
					gathered.notes.push(
						`The crawl from ${link} was still running at the time limit; what it had read is kept.`,
					);
				}
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			gathered.failed.push({ url: link, reason: errorText(error) });
		}
	}
	return gathered;
}

function createLibraryWebBookTool(
	options: CreateLibraryToolsOptions,
): AgentTool {
	return createTool({
		name: "library_web_book",
		description: `Make a book from web pages, and keep it up to date. The book records the query it came from and the links it started at, so it can be checked for news later.
- create (title, description, section, shelf, links, query?, depth?, limit?): read the links into a new book. \`depth\` 0 reads just those pages; 1 or more also follows the links on them that far. \`query\` is what the user asked for or what you searched; give it whenever there was one.
- add (book, links, depth?, limit?): read more links into an existing book.
- check (book): read its links again and say what is new or changed. Changes nothing.
- update (book): the same, and bring the new and changed pages in. A page that is gone stays in the book.
If a book already has the same links or title, create adds nothing and says so.`,
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["create", "add", "check", "update"] },
				book: {
					type: "string",
					description: "An existing book, by title or number (#12).",
				},
				title: { type: "string" },
				description: {
					type: "string",
					description:
						"What the book is and what it covers, in two or three sentences.",
				},
				section: { type: "string" },
				shelf: { type: "string" },
				query: {
					type: "string",
					description: "What was asked for or searched, kept with the book.",
				},
				links: { type: "array", items: { type: "string" } },
				depth: {
					type: "integer",
					description:
						"How many links deep to follow from each link. Default 0.",
				},
				limit: {
					type: "integer",
					description: "Pages to read at most, within the user's own limit.",
				},
				tags: { type: "array", items: { type: "string" } },
				if_exists: {
					type: "string",
					enum: ["stop", "add_anyway"],
					description:
						'create: "add_anyway" makes the book although one looks the same. Only after the user said so.',
				},
			},
			required: ["action"],
		},
		timeoutMs: LONG_CALL_MS,
		retryable: false,
		execute: async (input: unknown, context): Promise<string> => {
			const config = activeConfig(options);
			if (!config) return LIBRARY_OFF;
			if (!config.scrape) return NO_SCRAPER;
			const request = (input ?? {}) as Record<string, unknown>;
			const library = options.library ?? sharedLibrary();
			const catalogue = library.catalogue;
			const action = text(request.action);
			const signal = context?.signal;
			const given = strings(request.links);
			const links = given
				.map(cleanLink)
				.filter((link): link is string => link !== undefined);
			const bad = given.filter((link) => !cleanLink(link));
			const askedDepth = Number(request.depth);
			const askedLimit = Number(request.limit);
			const clampDepth = (value: number) =>
				Math.max(0, Math.min(config.scrape?.maxDepth ?? 0, Math.round(value)));
			const clampLimit = (value: number) =>
				Math.max(1, Math.min(config.scrape?.maxPages ?? 1, Math.round(value)));

			const store = async (book: LibraryBook, gathered: Gathered) => {
				const counts = { added: 0, replaced: 0, unchanged: 0, passages: 0 };
				for (const page of gathered.pages) {
					const result = await catalogue.addSource(
						book.id,
						{
							kind: "web",
							name: page.title ?? page.url,
							url: page.url,
							text: page.markdown,
							title: page.title,
							metadata: {
								...(page.description ? { description: page.description } : {}),
								...(page.language ? { language: page.language } : {}),
								readAt: new Date().toISOString(),
							},
						},
						config.settings,
					);
					counts[result.outcome]++;
					counts.passages += result.passages;
				}
				return counts;
			};
			const failures = (gathered: Gathered) => [
				...gathered.notes,
				...gathered.failed.map(
					(failure) => `Not read: ${failure.url} (${failure.reason})`,
				),
			];

			try {
				if (action === "create" || action === "add") {
					if (links.length === 0) {
						return `\`${action}\` needs \`links\`: full http(s) addresses.${bad.length ? ` Not links: ${bad.join(", ")}.` : ""} web_scrape finds them for a topic.`;
					}
					const depth = clampDepth(
						Number.isFinite(askedDepth) ? askedDepth : 0,
					);
					const limit = clampLimit(
						Number.isFinite(askedLimit) && askedLimit > 0
							? askedLimit
							: depth > 0
								? config.scrape.maxPages
								: links.length,
					);
					let book: LibraryBook;
					const lines: string[] = [];
					if (action === "add") {
						const found = oneBook(catalogue, text(request.book));
						if (typeof found === "string") return found;
						book = found;
					} else {
						const title = text(request.title);
						if (!title) return "A new book needs a `title`.";
						if (!text(request.description)) {
							return "A new book needs a `description`: what it is and what it covers, in two or three sentences.";
						}
						if (text(request.if_exists) !== "add_anyway") {
							const matches = [
								...catalogue.findSimilar({ title }),
								...links.flatMap((link) =>
									catalogue.findSimilar({ url: link }),
								),
							];
							const books = [
								...new Map(
									matches.map((match) => [match.book.id, match.book]),
								).values(),
							];
							if (books.length > 0) {
								return [
									"Nothing was made. The Library already has:",
									...books.map(
										(found) =>
											`- ${describeBookLine(found)}, ${where(catalogue, found)}`,
									),
									'To bring one up to date use action "update" (or "add" for new links). To make this book regardless, ask the user, then call again with if_exists "add_anyway".',
								].join("\n");
							}
						}
						const place = placeFor(catalogue, request);
						if (typeof place === "string") return place;
						const tags = strings(request.tags);
						book = catalogue.createBook({
							shelfId: place.shelfId,
							title,
							description: text(request.description),
							metadata: {
								...(tags.length ? { tags } : {}),
								web: {
									...(text(request.query)
										? { query: text(request.query) }
										: {}),
									links: [],
									crawl: { depth, limit },
								},
							},
						});
						lines.push(
							`New book #${book.id} "${book.title}" on ${place.label}${place.made.length ? ` (made ${place.made.join(" and ")})` : ""}.`,
						);
					}
					const gathered = await gather(config, links, depth, limit, signal);
					const counts = await store(book, gathered);
					const web = book.metadata.web ?? { links: [] };
					catalogue.updateBook(book.id, {
						metadata: {
							web: {
								...web,
								...(text(request.query) && !web.query
									? { query: text(request.query) }
									: {}),
								links: [...new Set([...web.links, ...links])],
								crawl: web.crawl ?? { depth, limit },
								checkedAt: new Date().toISOString(),
							},
						},
					});
					const summary = [
						`"${book.title}" (#${book.id}): ${plural(counts.added + counts.replaced, "page")} read in${counts.unchanged ? `, ${counts.unchanged} already there` : ""}, ${plural(counts.passages, "passage")}, from ${plural(links.length, "link")}${depth > 0 ? ` followed ${depth} deep` : ""}.`,
						...lines,
						...failures(gathered),
						...(bad.length ? [`Not links, left out: ${bad.join(", ")}`] : []),
					];
					if (counts.added + counts.replaced === 0 && action === "create") {
						catalogue.trashBook(book.id);
						return [
							"No page could be read, so the book was not kept.",
							...failures(gathered),
						].join("\n");
					}
					const embedded = await embedNew(
						library,
						config,
						[book.collectionId],
						options,
						signal,
					);
					if (embedded) summary.push(embedded);
					return summary.join("\n");
				}
				if (action === "check" || action === "update") {
					const found = oneBook(catalogue, text(request.book));
					if (typeof found === "string") return found;
					const web = found.metadata.web;
					if (!web || web.links.length === 0) {
						return `"${found.title}" was not made from web links, so there is nothing to check it against. For a book made from files, library_check a newer file against it.`;
					}
					const depth = clampDepth(web.crawl?.depth ?? 0);
					const limit = clampLimit(
						Number.isFinite(askedLimit) && askedLimit > 0
							? askedLimit
							: (web.crawl?.limit ?? config.scrape.maxPages),
					);
					const gathered = await gather(
						config,
						web.links,
						depth,
						limit,
						signal,
					);
					const have = new Map(
						catalogue
							.sources(found.id)
							.filter((source) => source.url)
							.map((source) => [source.url as string, source]),
					);
					const fresh = gathered.pages.filter((page) => !have.has(page.url));
					const changed = gathered.pages.filter((page) => {
						const source = have.get(page.url);
						return source !== undefined && source.sha256 !== page.sha256;
					});
					const readNow = new Set(gathered.pages.map((page) => page.url));
					const gone = [...have.keys()].filter((url) => !readNow.has(url));
					const report = [
						`"${found.title}" (#${found.id}), ${plural(gathered.pages.length, "page")} read from ${plural(web.links.length, "link")}: ${fresh.length} new, ${changed.length} changed, ${gathered.pages.length - fresh.length - changed.length} the same${gone.length ? `, ${gone.length} no longer found` : ""}.`,
						...fresh.map(
							(page) =>
								`  new: ${page.url}${page.title ? ` — ${page.title}` : ""}`,
						),
						...changed.map((page) => `  changed: ${page.url}`),
						...gone.slice(0, 50).map((url) => `  not found now (kept): ${url}`),
						...failures(gathered),
					];
					if (action === "check") {
						if (fresh.length + changed.length > 0) {
							report.push(
								'Action "update" brings the new and changed pages in.',
							);
						}
						return report.join("\n");
					}
					const counts = await store(found, {
						...gathered,
						pages: [...fresh, ...changed],
					});
					catalogue.updateBook(found.id, {
						metadata: { web: { ...web, checkedAt: new Date().toISOString() } },
					});
					report.push(
						`Brought in: ${counts.added} new, ${counts.replaced} replaced, ${plural(counts.passages, "passage")}.`,
					);
					if (counts.added + counts.replaced > 0) {
						const embedded = await embedNew(
							library,
							config,
							[found.collectionId],
							options,
							signal,
						);
						if (embedded) report.push(embedded);
					}
					return report.join("\n");
				}
				return 'Say `action`: "create", "add", "check" or "update".';
			} catch (error) {
				options.onError?.(`[library] library_web_book ${action} failed`, error);
				return `Not done: ${errorText(error)}`;
			}
		},
	});
}

/**
 * The librarian's tools. The two web tools are there only when a scraping
 * endpoint is configured and the session's profile allows it.
 */
export function createLibrarianTools(
	options: CreateLibraryToolsOptions,
): AgentTool[] {
	const config = activeConfig(options);
	return [
		createLibraryCheckTool(options),
		createLibraryAddTool(options),
		createLibraryOrganizeTool(options),
		createLibraryTransferTool(options),
		...(config?.scrape
			? [createWebScrapeTool(options), createLibraryWebBookTool(options)]
			: []),
	];
}
