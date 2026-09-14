/**
 * Fetch a release's `.vsix` and prove it is the one that was published.
 *
 * The verification is the reason this is its own file rather than four lines
 * inside the service. What follows a successful download is
 * `workbench.extensions.installExtension`, which will install whatever is at
 * the path it is given — so the moment between "bytes arrived" and "extension
 * installed" is the only place anything can be checked, and a truncated
 * download, a proxy's error page saved as a file, or a substituted asset all
 * look identical to a caller that only checked the HTTP status.
 *
 * GitHub has published a `digest` per release asset since 2025, so the hash is
 * available from the same API response that named the download. That makes
 * this an integrity check rather than a provenance one — both halves come from
 * GitHub over TLS, and nothing here would detect a compromised account. It
 * catches the failures that actually happen.
 *
 * Nothing is written unless it verifies, and the destination is removed on a
 * mismatch rather than left for someone to install by hand later.
 */

import { createHash } from "node:crypto"
import type { ReleaseAsset } from "./update-check"

export interface DownloadDeps {
	fetch: (url: string) => Promise<Response>
	writeFile: (path: string, body: Uint8Array) => Promise<void>
	remove: (path: string) => Promise<void>
}

export type DownloadResult = { ok: true; path: string; verified: boolean } | { ok: false; reason: string }

export async function downloadVsix(asset: ReleaseAsset, destPath: string, deps: DownloadDeps): Promise<DownloadResult> {
	let body: Buffer
	try {
		const response = await deps.fetch(asset.url)
		if (!response.ok) {
			return { ok: false, reason: `the download answered ${response.status} ${response.statusText}`.trimEnd() }
		}
		body = Buffer.from(await response.arrayBuffer())
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) }
	}

	// Cheap, and it fails earlier than the hash on the most common cause of a
	// bad download — a connection that ended early.
	if (asset.size > 0 && body.byteLength !== asset.size) {
		await deps.remove(destPath).catch(() => undefined)
		return {
			ok: false,
			reason: `the download is ${body.byteLength} bytes and the published size is ${asset.size} — the transfer did not complete`,
		}
	}

	let verified = false
	if (asset.sha256) {
		const actual = createHash("sha256").update(body).digest("hex")
		if (actual !== asset.sha256.toLowerCase()) {
			await deps.remove(destPath).catch(() => undefined)
			return {
				ok: false,
				reason: `the download's sha256 does not match the one published with the release (got ${actual.slice(0, 16)}…, expected ${asset.sha256.slice(0, 16)}…)`,
			}
		}
		verified = true
	}

	try {
		await deps.writeFile(destPath, body)
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) }
	}
	return { ok: true, path: destPath, verified }
}
