/**
 * Deciding whether a newer Cerebriline exists, and whether to say so.
 *
 * VS Code updates extensions it got from a gallery and only those. A build
 * installed from a `.vsix` is recorded with `source: "vsix"` and is never
 * checked again — which is why seven versions of this extension once sat
 * unpacked side by side on the test host, each one arriving by `--force` and
 * none of them ever superseding anything. This fork is not on the Marketplace
 * (upstream Cline is, and one of us there is enough), so the check has to be
 * ours.
 *
 * WHY THIS HALF IS PURE. Everything below is arithmetic over a version string
 * and a JSON body: no network, no `vscode`, no disk. The half that downloads
 * and installs is next door and is deliberately thin, because the decisions
 * worth getting right are all here — and every one of them has a way of being
 * wrong that looks exactly like working:
 *
 *   - comparing versions as text makes 4.100.9 newer than 4.100.115, and an
 *     updater that never fires is indistinguishable from one nobody shipped;
 *   - offering the latest RELEASE to a development build that is ahead of it
 *     downgrades the thing under test;
 *   - picking any asset rather than this extension's `.vsix` offers to install
 *     the migration script that is published beside it;
 *   - checking on every window open spends an unauthenticated GitHub quota of
 *     60 requests an hour on a version that changes once a day at most.
 *
 * ON GALLERY INSTALLS. This does not try to detect whether the install came
 * from a gallery, and does not need to: Open VSX users get updated by their
 * editor, after which the installed version equals the released one and this
 * says nothing. The only cost is a single notification in the window between a
 * release and the gallery catching up.
 */

import { compareVersions, type UpdateChannel } from "@shared/UpdateSettings"

// Re-exported so the updater's own tests and callers keep one import.
export { compareVersions }
export type { UpdateChannel }

export interface ReleaseAsset {
	name: string
	url: string
	size: number
	/** The hash GitHub computed at upload, without its `sha256:` prefix. */
	sha256?: string
}

export interface LatestRelease {
	/** The tag with any leading `v` removed. */
	version: string
	/** Where to read what changed. */
	notesUrl: string
	/** This extension's `.vsix`, where the release has one. */
	asset?: ReleaseAsset
}

export type UpdateDecision =
	| { kind: "disabled" }
	| { kind: "up-to-date" }
	| { kind: "skipped"; version: string }
	| { kind: "no-asset"; version: string }
	| { kind: "offer"; release: LatestRelease; install: boolean }

/** A day. Long enough that the quota is irrelevant, short enough to matter. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

function assetFrom(assets: unknown, extensionName: string): ReleaseAsset | undefined {
	if (!Array.isArray(assets)) {
		return undefined
	}
	for (const entry of assets) {
		if (!entry || typeof entry !== "object") {
			continue
		}
		const asset = entry as Record<string, unknown>
		const name = typeof asset.name === "string" ? asset.name : ""
		const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : ""
		// By name, not by position and not by "the first one". The release
		// carries the migration script as well, and `.vsix` is the only thing
		// `installExtension` can take.
		if (!name.startsWith(`${extensionName}-`) || !name.endsWith(".vsix") || !url) {
			continue
		}
		const digest = typeof asset.digest === "string" ? asset.digest : undefined
		return {
			name,
			url,
			size: typeof asset.size === "number" ? asset.size : 0,
			...(digest?.startsWith("sha256:") ? { sha256: digest.slice("sha256:".length) } : {}),
		}
	}
	return undefined
}

/** Read GitHub's `releases/latest` body. Nothing back means nothing to do. */
export function parseLatestRelease(body: unknown, extensionName: string): LatestRelease | undefined {
	if (!body || typeof body !== "object") {
		return undefined
	}
	const release = body as Record<string, unknown>
	const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : ""
	if (!tag) {
		return undefined
	}
	const asset = assetFrom(release.assets, extensionName)
	return {
		version: tag.replace(/^v/i, ""),
		notesUrl: typeof release.html_url === "string" ? release.html_url : "",
		...(asset ? { asset } : {}),
	}
}

/** Whether to spend a request. Answered before the network, never after. */
export function shouldCheckNow(input: {
	channel: UpdateChannel
	now: number
	lastCheckedAt?: number
	intervalMs?: number
}): boolean {
	if (input.channel === "off") {
		return false
	}
	if (input.lastCheckedAt === undefined) {
		return true
	}
	return input.now - input.lastCheckedAt >= (input.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
}

export function decideUpdate(input: {
	channel: UpdateChannel
	current: string
	latest: LatestRelease | undefined
	skippedVersion?: string
}): UpdateDecision {
	if (input.channel === "off") {
		return { kind: "disabled" }
	}
	const latest = input.latest
	if (!latest) {
		return { kind: "up-to-date" }
	}
	// `<= 0` rather than `!== 0`: the development tree spends most of its life
	// ahead of the last release, and offering it the release would replace the
	// build being tested with an older one.
	if (compareVersions(latest.version, input.current) <= 0) {
		return { kind: "up-to-date" }
	}
	if (input.skippedVersion && compareVersions(input.skippedVersion, latest.version) === 0) {
		return { kind: "skipped", version: latest.version }
	}
	if (!latest.asset) {
		return { kind: "no-asset", version: latest.version }
	}
	return { kind: "offer", release: latest, install: input.channel === "auto" }
}
