import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AgentsTab from "./AgentsTab"

const refreshAgents = vi.hoisted(() => vi.fn())
const saveAgentFile = vi.hoisted(() => vi.fn())
const deleteAgentFile = vi.hoisted(() => vi.fn())

const EMPTY = {
	agents: [],
	availableTools: ["editor", "read_files", "run_commands", "search_codebase"],
	searchPaths: ["/work/.cline/agents", "/home/you/.cline/agents"],
	errors: [],
	hasWorkspace: true,
}

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		refreshAgents: (...args: unknown[]) => refreshAgents(...args),
		saveAgentFile: (...args: unknown[]) => saveAgentFile(...args),
		deleteAgentFile: (...args: unknown[]) => deleteAgentFile(...args),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => ({ apiConfigurationProfiles: "" })),
}))

describe("AgentsTab", () => {
	beforeEach(() => {
		refreshAgents.mockReset().mockResolvedValue({ ...EMPTY })
		saveAgentFile.mockReset().mockResolvedValue({ ...EMPTY })
		deleteAgentFile.mockReset().mockResolvedValue({ ...EMPTY })
	})

	// The empty state is where the feature is won or lost: someone who has never
	// seen an agent file has to be able to get one without reading source.
	it("offers something to start from rather than an empty form", async () => {
		render(<AgentsTab />)

		expect(await screen.findByText("Reviewer")).toBeTruthy()
		expect(screen.getByText("Researcher")).toBeTruthy()
		expect(screen.getByText("Empty")).toBeTruthy()
	})

	it("prefills the form from the starter that was picked", async () => {
		render(<AgentsTab />)
		fireEvent.click(await screen.findByText("Reviewer"))

		const description = screen.getByLabelText("When to use it") as HTMLInputElement
		expect(description.value).toContain("Reviews a change")
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toContain("You review code")
	})

	// A name alone produces a file the loader rejects, so the button waits for
	// the three fields the schema actually requires.
	it("holds the save until it has a name, a description and a prompt", async () => {
		render(<AgentsTab />)
		fireEvent.click(await screen.findByText("Reviewer"))

		const save = screen.getByRole("button", { name: "Save agent" })
		expect(save).toHaveProperty("disabled", true)

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "reviewer" } })
		expect(save).toHaveProperty("disabled", false)
	})

	it("sends what the form holds", async () => {
		render(<AgentsTab />)
		fireEvent.click(await screen.findByText("Empty"))

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "reviewer" } })
		fireEvent.change(screen.getByLabelText("When to use it"), { target: { value: "Reviews a change." } })
		fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "You review code." } })
		fireEvent.click(screen.getByText("read_files"))
		fireEvent.click(screen.getByRole("button", { name: "Save agent" }))

		await waitFor(() => expect(saveAgentFile).toHaveBeenCalled())
		const sent = saveAgentFile.mock.calls[0][0]
		expect(sent.agent).toMatchObject({
			name: "reviewer",
			description: "Reviews a change.",
			systemPrompt: "You review code.",
			tools: ["read_files"],
		})
		// Empty on a create: there is no earlier file to remove.
		expect(sent.originalPath).toBe("")
	})

	// A rename or a move writes a new file, so the old path has to travel with
	// the edit or the agent is left on disk twice.
	it("carries the file an edit came from", async () => {
		refreshAgents.mockResolvedValue({
			...EMPTY,
			agents: [
				{
					name: "reviewer",
					description: "Reviews a change.",
					path: "/work/.cline/agents/reviewer.md",
					isGlobal: false,
					tools: [],
					skills: [],
					providerId: "",
					modelId: "",
					profile: "",
					maxIterations: 0,
					systemPrompt: "You review code.",
				},
			],
		})
		render(<AgentsTab />)

		fireEvent.click(await screen.findByLabelText("Edit reviewer"))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "critic" } })
		fireEvent.click(screen.getByRole("button", { name: "Save agent" }))

		await waitFor(() => expect(saveAgentFile).toHaveBeenCalled())
		expect(saveAgentFile.mock.calls[0][0].originalPath).toBe("/work/.cline/agents/reviewer.md")
	})

	// A file that will not parse is not a reason to hide the ones that will.
	it("shows a file it could not read without losing the list", async () => {
		refreshAgents.mockResolvedValue({
			...EMPTY,
			errors: ["/work/.cline/agents/broken.md: Missing YAML frontmatter block in agent config file."],
		})
		render(<AgentsTab />)

		expect(await screen.findByText(/broken\.md/)).toBeTruthy()
		expect(screen.getByText("Reviewer")).toBeTruthy()
	})
})
