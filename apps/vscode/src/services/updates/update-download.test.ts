import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ReleaseAsset } from "./update-check"
import { downloadVsix } from "./update-download"

const body = Buffer.from("pretend this is a vsix")
const goodHash = createHash("sha256").update(body).digest("hex")

function deps(over: Partial<Parameters<typeof downloadVsix>[2]> = {}) {
	const written: string[] = []
	const removed: string[] = []
	return {
		written,
		removed,
		deps: {
			fetch: async () => new Response(body, { status: 200 }),
			writeFile: async (path: string) => {
				written.push(path)
			},
			remove: async (path: string) => {
				removed.push(path)
			},
			...over,
		} as Parameters<typeof downloadVsix>[2],
	}
}

const asset = (over: Partial<ReleaseAsset> = {}): ReleaseAsset => ({
	name: "cerebriline-4.100.116.vsix",
	url: "https://github.com/mann1x/cline/releases/download/v4.100.116/cerebriline-4.100.116.vsix",
	size: body.byteLength,
	sha256: goodHash,
	...over,
})

describe("downloading the vsix", () => {
	it("writes it when the hash is the one GitHub published", async () => {
		const { deps: d, written } = deps()

		const result = await downloadVsix(asset(), "/tmp/x.vsix", d)

		expect(result.ok).toBe(true)
		expect(result.ok && result.verified).toBe(true)
		expect(written).toEqual(["/tmp/x.vsix"])
	})

	it("refuses a body whose hash does not match, and leaves nothing behind", async () => {
		// The one check that matters. A half-written or substituted file that
		// reaches `installExtension` is an install of something nobody chose.
		const { deps: d, written, removed } = deps()

		const result = await downloadVsix(asset({ sha256: "0".repeat(64) }), "/tmp/x.vsix", d)

		expect(result.ok).toBe(false)
		expect(result.ok === false && result.reason).toContain("does not match")
		expect(written).toEqual([])
		expect(removed).toEqual(["/tmp/x.vsix"])
	})

	it("says so rather than failing when the release carries no hash", async () => {
		// GitHub has published a digest per asset since 2025. If that ever
		// stops, refusing every update would be worse than installing over
		// HTTPS and saying the check could not be made.
		const { deps: d } = deps()

		const result = await downloadVsix(asset({ sha256: undefined }), "/tmp/x.vsix", d)

		expect(result.ok).toBe(true)
		expect(result.ok && result.verified).toBe(false)
	})

	it("refuses a response that is not a download", async () => {
		const { deps: d, written } = deps({
			fetch: async () => new Response("not found", { status: 404 }),
		})

		const result = await downloadVsix(asset(), "/tmp/x.vsix", d)

		expect(result.ok).toBe(false)
		expect(result.ok === false && result.reason).toContain("404")
		expect(written).toEqual([])
	})

	it("refuses a body that is not the size that was published", async () => {
		const { deps: d } = deps()

		const result = await downloadVsix(asset({ size: 999_999 }), "/tmp/x.vsix", d)

		expect(result.ok).toBe(false)
		expect(result.ok === false && result.reason).toContain("size")
	})
})
