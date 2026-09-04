import { beforeEach, describe, expect, it, vi } from "vitest"

/** Only the fields these tests read back off the mock. */
interface ShownMessage {
	message: string
	options?: { items?: string[]; modal?: boolean }
}

const mocks = vi.hoisted(() => ({
	listAgents: vi.fn(),
	writeAgent: vi.fn(async () => undefined),
	showMessage: vi.fn(async (_request: ShownMessage) => ({ selectedOption: undefined as string | undefined })),
	openFile: vi.fn(async (_request: { filePath: string }) => ({})),
}))

vi.mock("@/core/controller/file/agent-files", () => ({
	listAgents: mocks.listAgents,
	writeAgent: mocks.writeAgent,
}))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: { window: { showMessage: mocks.showMessage, openFile: mocks.openFile } },
}))

vi.mock("@/shared/services/Logger", () => ({ Logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn() } }))

import { offerAgentProfileRepair, resetAgentProfileRepairOffers } from "./agent-profile-repair"

const AGENT = {
	name: "reviewer",
	description: "Reviews a change",
	path: "/work/.cline/agents/reviewer.md",
	isGlobal: false,
	tools: [],
	skills: [],
	providerId: "",
	modelId: "",
	profile: "vision-box",
	maxIterations: 0,
	systemPrompt: "You review code",
}

const PROFILES = JSON.stringify([
	{ name: "cheap-and-fast", snapshot: {} },
	{ name: "big-context", snapshot: {} },
])

/** The notification, then the modal, in the order they are shown. */
function messages(): string[] {
	return mocks.showMessage.mock.calls.map((call) => call[0].message)
}

describe("offerAgentProfileRepair", () => {
	beforeEach(() => {
		resetAgentProfileRepairOffers()
		mocks.listAgents.mockReset().mockResolvedValue({ agents: [AGENT] })
		mocks.writeAgent.mockReset().mockResolvedValue(undefined)
		mocks.openFile.mockReset().mockResolvedValue({})
		mocks.showMessage.mockReset().mockResolvedValue({ selectedOption: undefined })
	})

	it("says nothing when every profile an agent names still exists", async () => {
		await offerAgentProfileRepair(JSON.stringify([{ name: "vision-box", snapshot: {} }]))

		expect(mocks.showMessage).not.toHaveBeenCalled()
	})

	it("says nothing when no agent names a profile at all", async () => {
		mocks.listAgents.mockResolvedValue({ agents: [{ ...AGENT, profile: "" }] })

		await offerAgentProfileRepair(PROFILES)

		expect(mocks.showMessage).not.toHaveBeenCalled()
	})

	it("names the agent and the profile that is gone", async () => {
		await offerAgentProfileRepair(PROFILES)

		expect(messages()[0]).toContain('Subagent "reviewer"')
		expect(messages()[0]).toContain("vision-box")
	})

	// The whole point of the button: the file is rewritten, so the next call
	// works without the user opening anything.
	it("rewrites the agent file with the profile that was picked", async () => {
		mocks.showMessage
			.mockResolvedValueOnce({ selectedOption: "Pick a profile" })
			.mockResolvedValueOnce({ selectedOption: "big-context" })
			.mockResolvedValueOnce({ selectedOption: undefined })

		await offerAgentProfileRepair(PROFILES)

		expect(mocks.writeAgent).toHaveBeenCalledWith(
			expect.objectContaining({ name: "reviewer", profile: "big-context" }),
			"/work/.cline/agents/reviewer.md",
		)
	})

	// Absence is what the loader reads as "the session's own configuration",
	// so this has to clear the key rather than write the label into it.
	it("clears the profile when the session's own model is picked", async () => {
		mocks.showMessage
			.mockResolvedValueOnce({ selectedOption: "Pick a profile" })
			.mockResolvedValueOnce({ selectedOption: "Use the session's own model" })
			.mockResolvedValueOnce({ selectedOption: undefined })

		await offerAgentProfileRepair(PROFILES)

		expect(mocks.writeAgent).toHaveBeenCalledWith(expect.objectContaining({ profile: "" }), expect.anything())
	})

	it("writes nothing when the offer is dismissed", async () => {
		mocks.showMessage.mockResolvedValue({ selectedOption: undefined })

		await offerAgentProfileRepair(PROFILES)

		expect(mocks.writeAgent).not.toHaveBeenCalled()
	})

	it("writes nothing when the pick itself is dismissed", async () => {
		mocks.showMessage
			.mockResolvedValueOnce({ selectedOption: "Pick a profile" })
			.mockResolvedValueOnce({ selectedOption: undefined })

		await offerAgentProfileRepair(PROFILES)

		expect(mocks.writeAgent).not.toHaveBeenCalled()
	})

	// A prompt that returns every session for something the user declined is
	// worse than the silence it replaced.
	it("offers the same broken agent only once", async () => {
		await offerAgentProfileRepair(PROFILES)
		await offerAgentProfileRepair(PROFILES)

		expect(mocks.showMessage).toHaveBeenCalledTimes(1)
	})

	it("offers again once the agent names a different dead profile", async () => {
		await offerAgentProfileRepair(PROFILES)
		mocks.listAgents.mockResolvedValue({ agents: [{ ...AGENT, profile: "also-gone" }] })

		await offerAgentProfileRepair(PROFILES)

		expect(mocks.showMessage).toHaveBeenCalledTimes(2)
	})

	// Nothing to point them at, so there is no button worth offering.
	it("states the problem without a button when there are no profiles saved", async () => {
		await offerAgentProfileRepair(undefined)

		expect(mocks.showMessage).toHaveBeenCalledTimes(1)
		expect(messages()[0]).toContain("no saved profiles")
		expect(mocks.showMessage.mock.calls[0][0].options?.items).toEqual([])
	})

	it("sends a long profile list to the file instead of an unreadable dialog", async () => {
		const many = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({ name: `profile-${index}`, snapshot: {} })))
		mocks.showMessage
			.mockResolvedValueOnce({ selectedOption: "Pick a profile" })
			.mockResolvedValueOnce({ selectedOption: "Open the agent file" })

		await offerAgentProfileRepair(many)

		const items = mocks.showMessage.mock.calls[1][0].options?.items ?? []
		expect(items).toHaveLength(7)
		expect(items.at(-1)).toBe("Open the agent file")
		expect(mocks.openFile).toHaveBeenCalledWith({ filePath: "/work/.cline/agents/reviewer.md" })
		expect(mocks.writeAgent).not.toHaveBeenCalled()
	})

	// A session has to start whether or not the agent directory can be read.
	it("never throws when the agent list cannot be read", async () => {
		mocks.listAgents.mockRejectedValue(new Error("EACCES"))

		await expect(offerAgentProfileRepair(PROFILES)).resolves.toBeUndefined()
	})

	it("lists every broken agent in one notice", async () => {
		mocks.listAgents.mockResolvedValue({
			agents: [AGENT, { ...AGENT, name: "researcher", path: "/work/.cline/agents/researcher.md" }],
		})

		await offerAgentProfileRepair(PROFILES)

		expect(messages()[0]).toContain("2 subagents")
		expect(messages()[0]).toContain('"researcher"')
	})
})
