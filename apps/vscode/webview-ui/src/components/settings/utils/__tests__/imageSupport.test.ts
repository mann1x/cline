import { describe, expect, it } from "vitest"
import { modelsThatMayReadImages, profilesThatMayReadImages } from "../imageSupport"

describe("models offered for describing pictures", () => {
	const models = ["omnimerge-v6-mtp_tb:27b-q4km-128k", "v7-coder_tb:vision-iq4_nl", "glm-5.3-flash:cloud"]
	const reported = {
		reported: true,
		vision: ["v7-coder_tb:vision-iq4_nl"],
		notVision: ["omnimerge-v6-mtp_tb:27b-q4km-128k"],
	}

	it("leaves out what the server reports as unable to read images, and keeps what it says nothing about", () => {
		expect(modelsThatMayReadImages(models, reported, undefined)).toEqual(["v7-coder_tb:vision-iq4_nl", "glm-5.3-flash:cloud"])
	})

	it("keeps the selected model so a wrong choice stays visible", () => {
		expect(modelsThatMayReadImages(models, reported, "omnimerge-v6-mtp_tb:27b-q4km-128k")).toEqual(models)
	})

	it("hides nothing when the server does not say", () => {
		expect(modelsThatMayReadImages(models, { reported: false, vision: [], notVision: [] }, undefined)).toEqual(models)
		expect(modelsThatMayReadImages(models, undefined, undefined)).toEqual(models)
	})
})

describe("profiles offered for describing pictures", () => {
	const support = {
		profiles: [
			{ name: "coder", provider: "xollama", model: "omnimerge-v6-mtp_tb:27b-q4km-128k", images: "no" as const },
			{ name: "eyes", provider: "ollama", model: "qwen3-vl:4b", images: "yes" as const },
			{ name: "hosted", provider: "anthropic", model: "claude", images: "unknown" as const },
		],
	}

	it("leaves out a profile whose model reports no vision", () => {
		expect(profilesThatMayReadImages(["coder", "eyes", "hosted"], support, "").map((profile) => profile.name)).toEqual([
			"eyes",
			"hosted",
		])
	})

	it("keeps the picked profile, marked", () => {
		const offered = profilesThatMayReadImages(["coder", "eyes"], support, "coder")
		expect(offered[0]).toMatchObject({ name: "coder", images: "no" })
	})

	it("offers every profile before the answer arrives", () => {
		expect(profilesThatMayReadImages(["coder", "eyes"], undefined, "")).toHaveLength(2)
	})
})
