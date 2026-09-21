#!/usr/bin/env node

// Build apps/vscode/CHANGELOG.md from this fork's release notes.
//
// The Marketplace/Open VSX listing has two tabs: Overview renders the README
// baked into the .vsix, Changelog renders CHANGELOG.md from the same place.
// The repo-root CHANGELOG.md is *upstream Cline's* (4.1.x) and describes
// releases this extension never shipped, so it must not be used here.
//
// Past releases come from the GitHub API. The release being built does not
// exist there yet — the workflow packages the .vsix before it creates the
// release — so its notes are resolved locally, in this order:
//
//   1. --pending-notes <file>
//   2. release-notes/<version>.md at the repo root
//   3. the annotated tag message for v<version>
//
// Whatever is found is written back out via --emit-notes so the workflow can
// use the same text as the GitHub release body. One text, written once at tag
// time, feeds both the listing's Changelog tab and the release page.
//
//   node scripts/generate-fork-changelog.mjs \
//       [--repo owner/name] [--out path] \
//       [--pending-version X.Y.Z] [--pending-notes file] [--emit-notes file]
//
// Requires `gh` authenticated (GH_TOKEN in CI). With --offline, past releases
// are skipped and only the pending entry is rendered.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, "..")
const repoRoot = path.join(projectRoot, "..", "..")

function arg(name, fallback) {
	const i = process.argv.indexOf(name)
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(name)

const REPO = arg("--repo", "mann1x/cline")
const OUT = path.resolve(arg("--out", path.join(projectRoot, "CHANGELOG.md")))
const PENDING_VERSION = arg("--pending-version", "")
const PENDING_NOTES = arg("--pending-notes", "")
const EMIT_NOTES = arg("--emit-notes", "")
const OFFLINE = has("--offline")

// Auto-generated compare links add nothing to a listing page.
const FULL_CHANGELOG_LINE = /^\s*\*\*Full Changelog\*\*:.*$/gm

// Bodies use `##` for their own sections, which is the level we use for the
// version itself. Demote everything by one so the nesting is correct.
const demoteHeadings = (md) => md.replace(/^(#{1,5}) /gm, (_, h) => `${h}# `)
const clean = (md) => demoteHeadings((md || "").replace(FULL_CHANGELOG_LINE, "").trim())
const tagToVersion = (tag) => tag.replace(/^v/, "")

function fetchReleases(repo) {
	const raw = execFileSync("gh", ["api", "--paginate", `repos/${repo}/releases`], {
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	})
	// `gh --paginate` concatenates one JSON array per page.
	const joined = raw.replace(/\]\s*\[/g, ",")
	try {
		return JSON.parse(joined)
	} catch {
		return joined
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.flatMap((l) => JSON.parse(l))
	}
}

// --- the release being built -------------------------------------------------

function resolvePendingNotes(version) {
	if (PENDING_NOTES) {
		if (!fs.existsSync(PENDING_NOTES)) {
			throw new Error(`--pending-notes ${PENDING_NOTES} does not exist`)
		}
		return { source: PENDING_NOTES, text: fs.readFileSync(PENDING_NOTES, "utf-8") }
	}

	const notesFile = path.join(repoRoot, "release-notes", `${version}.md`)
	if (fs.existsSync(notesFile)) {
		return { source: path.relative(repoRoot, notesFile), text: fs.readFileSync(notesFile, "utf-8") }
	}

	try {
		const msg = execFileSync("git", ["tag", "-l", "--format=%(contents)", `v${version}`], {
			cwd: repoRoot,
			encoding: "utf-8",
		}).trim()
		if (msg) {
			return { source: `annotated tag v${version}`, text: msg }
		}
	} catch {
		// not a tag, or not a git tree — fall through
	}

	return null
}

// --- render ------------------------------------------------------------------

const entries = []

if (PENDING_VERSION) {
	const pending = resolvePendingNotes(PENDING_VERSION)
	if (!pending) {
		throw new Error(
			`No notes found for ${PENDING_VERSION}. Add release-notes/${PENDING_VERSION}.md, ` +
				`annotate the tag (git tag -a v${PENDING_VERSION} -m "..."), or pass --pending-notes.`,
		)
	}
	const body = clean(pending.text)
	if (!body) {
		throw new Error(`Notes for ${PENDING_VERSION} (${pending.source}) are empty.`)
	}
	console.log(`pending ${PENDING_VERSION}: notes from ${pending.source} (${body.length} chars)`)
	entries.push({ version: PENDING_VERSION, date: new Date().toISOString().slice(0, 10), body })
	if (EMIT_NOTES) {
		fs.writeFileSync(EMIT_NOTES, `${pending.text.trim()}\n`, "utf-8")
		console.log(`emitted release body -> ${EMIT_NOTES}`)
	}
}

/** 4.100.150 -> [4, 100, 150], for ordering that does not depend on a date. */
const versionKey = (v) => v.split(".").map((n) => Number.parseInt(n, 10) || 0)

function compareVersionsDesc(a, b) {
	const x = versionKey(a)
	const y = versionKey(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (y[i] ?? 0) - (x[i] ?? 0)
		if (d !== 0) {
			return d
		}
	}
	return 0
}

/** When a version's notes were committed, which is when that build was cut. */
function noteFileDate(file) {
	try {
		const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%ad", "--date=short", "-1", "--", file], {
			cwd: repoRoot,
			encoding: "utf-8",
		}).trim()
		if (out) {
			return out
		}
	} catch {
		// not a git tree, or the file is not committed yet
	}
	return fs.statSync(path.join(repoRoot, file)).mtime.toISOString().slice(0, 10)
}

if (!OFFLINE) {
	const past = fetchReleases(REPO)
		.filter((r) => !r.draft)
		.sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
	for (const r of past) {
		const version = tagToVersion(r.tag_name)
		if (version === PENDING_VERSION) {
			continue // the local notes win; the release may not exist yet
		}
		// A committed note file wins over the published body: it is how a past
		// release whose notes were auto-generated gets corrected, and the repo
		// is the source of truth. Sync the release body when you add one.
		const local = path.join(repoRoot, "release-notes", `${version}.md`)
		const body = fs.existsSync(local) ? clean(fs.readFileSync(local, "utf-8")) : clean(r.body)
		entries.push({
			version,
			date: (r.published_at || "").slice(0, 10),
			body,
			tag: r.tag_name,
		})
	}
}

// Versions that were built and tested but never published as a GitHub release
// still shipped, and their notes are committed here. Taking past entries from
// the API alone dropped every one of them: the listing jumped .150 straight to
// .118 with sixteen builds' worth of changes missing, none of which a reader
// can find anywhere else. The same rule the API loop already follows applies --
// a committed note file is the source of truth -- so any note file with no
// release behind it is an entry in its own right.
{
	const dir = path.join(repoRoot, "release-notes")
	const known = new Set(entries.map((e) => e.version))
	const orphans = fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".md"))
				.map((f) => f.slice(0, -3))
				.filter((v) => !known.has(v))
		: []
	for (const version of orphans) {
		const file = path.join("release-notes", `${version}.md`)
		const body = clean(fs.readFileSync(path.join(repoRoot, file), "utf-8"))
		if (!body) {
			continue
		}
		entries.push({ version, date: noteFileDate(file), body })
	}
}

// Ordered by version rather than by date: an unpublished build has no
// published_at, and a changelog is read by version anyway.
entries.sort((a, b) => compareVersionsDesc(a.version, b.version))

const out = [
	"# Changelog",
	"",
	"Releases of **Cerebriline**, a fork of [Cline](https://github.com/cline/cline)",
	"built for local and small models.",
	"",
	"Upstream Cline's own changelog is a separate document and is not reproduced here.",
	"",
]

for (const e of entries) {
	out.push(`## [${e.version}] — ${e.date}`, "")
	out.push(e.body || `Maintenance release. [Compare](https://github.com/${REPO}/releases/tag/${e.tag})`, "")
}

fs.writeFileSync(
	OUT,
	`${out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`,
	"utf-8",
)
console.log(`wrote ${OUT} — ${entries.length} releases, ${fs.statSync(OUT).size} bytes`)
