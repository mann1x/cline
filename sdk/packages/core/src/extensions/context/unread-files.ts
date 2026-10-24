/**
 * Cut the summary lines that state facts about files no call opened.
 *
 * Measured by claude-hooks on compaction-v7-g2 / -cite (qwen3.6 27B,
 * 2026-10-24): on every first fold, in both flows, the writer or a reviewer
 * completed the module table the task asked for -- fields for 66 to 118
 * modules not yet read, one line each, uncited, and 1 of 98 right. The
 * summary is the session's only record of the fold, so a session that
 * trusts it works from invented facts.
 *
 * Deterministic: the record knows which files each call put in front of the
 * model, so a line whose every file is one no call opened says nothing that
 * was read, whatever it claims.
 *
 * A file counts as seen when a call that shows content named it, in its
 * arguments (a `read_files` path, a command that prints it) or in its result
 * (a search match). A listing proves a file exists, not what it holds, so it
 * never makes one seen. A file the user's own requests name is never cut:
 * an instruction that names it is not an invention. The names the cut lines
 * mentioned are kept, as one note, so a legitimate list of what is still to
 * read survives as names.
 *
 * Ported from claude-hooks consultants/engine/unread_files.py (209185b).
 */

import {
	normaliseCall,
	normaliseResult,
	type ToolLedgerMessage,
} from "./tool-ledger";

/** Tools whose results name files without showing what they contain. */
export const LISTING_TOOLS = new Set([
	"list_files",
	"glob",
	"list_dir",
	"list_directory",
	"survey_project",
]);

/** The most names the note lists; the rest are counted. */
const NOTE_NAMES = 60;

/** The most seen files carried to the next generation. */
export const MAX_SEEN_FILES = 5000;

export const UNREAD_NOTE_HEAD = "Not yet read";

/**
 * A file path: segments of word characters, dots and dashes, ending in an
 * extension of lower-case letters or digits with at least one letter.
 * `limits.RETRY_WINDOW` (upper case) and `1.5` (no letter) are not files.
 */
const FILE =
	/(?<![\w./-])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,6})(?![\w/-])/g;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * A name with no directory is a file only with one of these: without the
 * list, `os.path.join` or `this.store.ack` would read as files.
 */
const EXTENSIONS = new Set(
	`py pyi ts tsx js jsx mjs cjs go rs c h cc cpp cxx hpp hh cs java kt kts
	rb php sh bash zsh ps1 bat cmd md rst txt json jsonl yaml yml toml ini
	cfg conf xml html htm css scss sql proto lua swift mm scala ex exs erl
	hs ml vue svelte dart jl zig nim tf gradle lock env log csv tsv ipynb`
		.split(/\s+/)
		.filter(Boolean),
);

/** The file paths `text` names, in order, once each. */
export function filesIn(text: string): string[] {
	const found = new Set<string>();
	for (const match of (text ?? "").replace(URL_PATTERN, " ").matchAll(FILE)) {
		const name = match[1];
		const extension = name.slice(name.lastIndexOf(".") + 1);
		if (name.includes("/") || EXTENSIONS.has(extension)) {
			found.add(name.replace(/^(?:\.\/)+/, ""));
		}
	}
	return [...found];
}

function* strings(value: unknown): Iterable<string> {
	if (typeof value === "string") {
		yield value;
	} else if (Array.isArray(value)) {
		for (const item of value) yield* strings(item);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) yield* strings(item);
	}
}

/** Files a call put in front of the model, in its arguments or its result. */
export function seenFiles(messages: readonly ToolLedgerMessage[]): Set<string> {
	const listings = new Set<string>();
	const seen = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const call = normaliseCall(part);
			if (!call) continue;
			if (LISTING_TOOLS.has(call.name)) {
				listings.add(call.id);
				continue;
			}
			for (const text of strings(call.input)) {
				for (const file of filesIn(text)) seen.add(file);
			}
		}
	}
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const result = normaliseResult(part);
			if (!result || listings.has(result.id)) continue;
			for (const text of strings(result.serialized ?? result.output)) {
				for (const file of filesIn(text)) seen.add(file);
			}
		}
	}
	return seen;
}

/**
 * `name` is a seen file, or a path suffix of one (`net/backoff.py` for
 * `src/net/backoff.py`), or one is a suffix of it.
 */
function known(name: string, seen: ReadonlySet<string>): boolean {
	if (seen.has(name)) return true;
	for (const file of seen) {
		if (file.endsWith(`/${name}`) || name.endsWith(`/${file}`)) return true;
	}
	return false;
}

/**
 * `text` without the lines whose every named file is unseen, the names those
 * lines mentioned, and how many lines went. The files `exempt` names (the
 * user's requests) are never cut, and fenced code is left alone.
 */
export function dropUnreadLines(
	text: string,
	seen: ReadonlySet<string>,
	exempt = "",
): { text: string; names: string[]; cut: number } {
	const allowed = new Set([...seen, ...filesIn(exempt)]);
	const kept: string[] = [];
	const names: string[] = [];
	let cut = 0;
	let fenced = false;
	for (const line of (text ?? "").split("\n")) {
		if (line.trimStart().startsWith("```")) fenced = !fenced;
		const named = fenced ? [] : filesIn(line);
		if (named.length > 0 && !named.some((name) => known(name, allowed))) {
			cut += 1;
			for (const name of named) if (!names.includes(name)) names.push(name);
			continue;
		}
		kept.push(line);
	}
	return { text: kept.join("\n"), names, cut };
}

/** What the cut leaves in the summary: the names, never the claims. */
export function unreadNote(names: readonly string[], cut: number): string {
	const shown = names.slice(0, NOTE_NAMES);
	const more = names.length - shown.length;
	return `${UNREAD_NOTE_HEAD} (${cut} line${cut === 1 ? "" : "s"} about these files were removed from this summary: no call in the record opened them, so what the lines said about them was not read from the files): ${shown.map((name) => `\`${name}\``).join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

/** The seen set for the summary's metadata, newest kept when over the bound. */
export function carrySeenFiles(
	previous: readonly string[],
	next: Iterable<string>,
): string[] {
	const merged = [...new Set([...previous, ...[...next].sort()])];
	return merged.slice(-MAX_SEEN_FILES);
}
