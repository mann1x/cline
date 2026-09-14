import { describe, expect, it } from "vitest"
import { compareVersions, decideUpdate, parseLatestRelease, shouldCheckNow } from "./update-check"

const release = (version: string, withAsset = true) => ({
	tag_name: `v${version}`,
	html_url: `https://github.com/mann1x/cline/releases/tag/v${version}`,
	assets: withAsset
		? [
				{
					name: `cerebriline-${version}.vsix`,
					size: 14209008,
					digest: "sha256:a1676783fe9c27a1ad1f2d67238707794fca0cb551b918aaf080da1096c8a464",
					browser_download_url: `https://github.com/mann1x/cline/releases/download/v${version}/cerebriline-${version}.vsix`,
				},
				{ name: "Migrate-ToCerebriline.ps1", size: 29539, browser_download_url: "https://example.invalid/x.ps1" },
			]
		: [],
})

describe("compareVersions", () => {
	it("compares each field as a number, not as text", () => {
		// The classic: "4.100.9" sorts after "4.100.115" as a string, and a
		// release that never offers itself is indistinguishable from one that
		// never shipped.
		expect(compareVersions("4.100.115", "4.100.9")).toBeGreaterThan(0)
		expect(compareVersions("4.100.9", "4.100.115")).toBeLessThan(0)
	})

	it("is zero for the same version", () => {
		expect(compareVersions("4.100.115", "4.100.115")).toBe(0)
	})

	it("tolerates a leading v and trailing junk", () => {
		expect(compareVersions("v4.100.115", "4.100.115")).toBe(0)
		expect(compareVersions("4.100.115-dev", "4.100.115")).toBe(0)
	})
})

describe("parseLatestRelease", () => {
	it("takes the version from the tag and the vsix from the assets", () => {
		const latest = parseLatestRelease(release("4.100.115"), "cerebriline")

		expect(latest?.version).toBe("4.100.115")
		expect(latest?.asset?.name).toBe("cerebriline-4.100.115.vsix")
		expect(latest?.asset?.sha256).toBe("a1676783fe9c27a1ad1f2d67238707794fca0cb551b918aaf080da1096c8a464")
	})

	it("ignores assets that are not this extension's vsix", () => {
		// The migration script is published beside the build. Offering to
		// install a PowerShell file as an extension is the failure this avoids.
		const latest = parseLatestRelease(release("4.100.115"), "cerebriline")

		expect(latest?.asset?.name?.endsWith(".vsix")).toBe(true)
	})

	it("returns the release with no asset when the vsix is missing", () => {
		const latest = parseLatestRelease(release("4.100.115", false), "cerebriline")

		expect(latest?.version).toBe("4.100.115")
		expect(latest?.asset).toBeUndefined()
	})

	it("returns nothing for a body that is not a release", () => {
		expect(parseLatestRelease({ message: "Not Found" }, "cerebriline")).toBeUndefined()
		expect(parseLatestRelease(null, "cerebriline")).toBeUndefined()
	})
})

describe("shouldCheckNow", () => {
	const day = 24 * 60 * 60 * 1000

	it("never checks when updates are off", () => {
		expect(shouldCheckNow({ channel: "off", now: day * 10, lastCheckedAt: 0, intervalMs: day })).toBe(false)
	})

	it("checks when it never has", () => {
		expect(shouldCheckNow({ channel: "notify", now: day * 10, intervalMs: day })).toBe(true)
	})

	it("stays quiet inside the interval", () => {
		// Unauthenticated GitHub allows 60 requests an hour per IP. A check on
		// every window open would spend that on nothing.
		expect(shouldCheckNow({ channel: "notify", now: day * 10, lastCheckedAt: day * 10 - 60_000, intervalMs: day })).toBe(
			false,
		)
	})

	it("checks again once the interval has passed", () => {
		expect(shouldCheckNow({ channel: "auto", now: day * 10, lastCheckedAt: day * 9 - 1, intervalMs: day })).toBe(true)
	})
})

describe("decideUpdate", () => {
	const latest = parseLatestRelease(release("4.100.115"), "cerebriline")

	it("offers a newer release without installing it, on the notify channel", () => {
		const decision = decideUpdate({ channel: "notify", current: "4.100.114", latest })

		expect(decision.kind).toBe("offer")
		expect(decision.kind === "offer" && decision.install).toBe(false)
	})

	it("installs it on the auto channel", () => {
		const decision = decideUpdate({ channel: "auto", current: "4.100.114", latest })

		expect(decision.kind === "offer" && decision.install).toBe(true)
	})

	it("says nothing when the installed version is the released one", () => {
		expect(decideUpdate({ channel: "notify", current: "4.100.115", latest }).kind).toBe("up-to-date")
	})

	it("never offers to go backwards from a local build", () => {
		// The development tree runs ahead of the last release for most of its
		// life. An updater that offered to downgrade it would undo the build
		// under test.
		expect(decideUpdate({ channel: "auto", current: "4.100.116", latest }).kind).toBe("up-to-date")
	})

	it("honours a skipped version, but not for the one after it", () => {
		expect(decideUpdate({ channel: "notify", current: "4.100.114", latest, skippedVersion: "4.100.115" }).kind).toBe(
			"skipped",
		)
		expect(decideUpdate({ channel: "notify", current: "4.100.114", latest, skippedVersion: "4.100.113" }).kind).toBe("offer")
	})

	it("reports a release whose vsix is missing rather than offering it", () => {
		const noAsset = parseLatestRelease(release("4.100.115", false), "cerebriline")

		expect(decideUpdate({ channel: "notify", current: "4.100.114", latest: noAsset }).kind).toBe("no-asset")
	})

	it("is disabled when the channel is off, whatever the versions say", () => {
		expect(decideUpdate({ channel: "off", current: "4.0.0", latest }).kind).toBe("disabled")
	})

	it("says nothing when the check produced no release", () => {
		expect(decideUpdate({ channel: "notify", current: "4.100.114", latest: undefined }).kind).toBe("up-to-date")
	})
})
