import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import PromptTemplatesSection from "./PromptTemplatesSection"

const mocks = vi.hoisted(() => ({
	getPromptTemplates: vi.fn(),
	openPromptTemplate: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		getPromptTemplates: mocks.getPromptTemplates,
		openPromptTemplate: mocks.openPromptTemplate,
	},
}))

function template(overrides: Record<string, unknown> = {}) {
	return {
		name: "gemma",
		fileName: "gemma.md",
		source: "builtin",
		filePath: undefined,
		active: false,
		shadowed: false,
		match: ["family: gemma*"],
		tools: ["editor"],
		hasSystem: true,
		warnings: [],
		error: undefined,
		...overrides,
	}
}

function state(overrides: Record<string, unknown> = {}) {
	return {
		providerId: "ollama",
		modelId: "v7-coder",
		family: "gemma4",
		activeName: "gemma",
		overlaid: true,
		globalDirectory: "/home/me/.cline/data/templates",
		workspaceDirectory: undefined,
		templates: [template({ active: true })],
		...overrides,
	}
}

beforeEach(() => {
	mocks.getPromptTemplates.mockReset()
	mocks.openPromptTemplate.mockReset()
	mocks.getPromptTemplates.mockResolvedValue(state())
	mocks.openPromptTemplate.mockResolvedValue({})
})

describe("PromptTemplatesSection", () => {
	it("says which template the current model resolves to", async () => {
		render(<PromptTemplatesSection />)

		// The question the panel exists to answer.
		await waitFor(() => expect(screen.getByText(/v7-coder \(gemma4\) on ollama/)).toBeTruthy())
		expect(screen.getByText("Active")).toBeTruthy()
	})

	it("shows what a template matches on and what it overrides", async () => {
		render(<PromptTemplatesSection />)

		await waitFor(() => expect(screen.getByText(/family: gemma\*/)).toBeTruthy())
		expect(screen.getByText(/tools: editor/)).toBeTruthy()
	})

	it("opens a template for editing and reloads afterwards", async () => {
		render(<PromptTemplatesSection />)
		await waitFor(() => expect(screen.getByLabelText("Edit gemma.md")).toBeTruthy())

		await userEvent.click(screen.getByLabelText("Edit gemma.md"))

		expect(mocks.openPromptTemplate).toHaveBeenCalledWith(expect.objectContaining({ fileName: "gemma.md" }))
		// Editing a built-in writes a copy, so the list is stale the moment the
		// file opens.
		await waitFor(() => expect(mocks.getPromptTemplates).toHaveBeenCalledTimes(2))
	})

	it("shows a file that failed to parse instead of hiding it", async () => {
		mocks.getPromptTemplates.mockResolvedValue(
			state({
				activeName: "default",
				templates: [
					template({ name: "broken", fileName: "broken.md", source: "global", error: "match: expected a map" }),
				],
			}),
		)

		render(<PromptTemplatesSection />)

		await waitFor(() => expect(screen.getByText(/broken\.md: match: expected a map/)).toBeTruthy())
		expect(screen.getByText("Not loaded")).toBeTruthy()
	})

	it("surfaces a warning without treating the template as broken", async () => {
		mocks.getPromptTemplates.mockResolvedValue(
			state({ templates: [template({ warnings: ["system prompt is missing {{CWD}}"] })] }),
		)

		render(<PromptTemplatesSection />)

		await waitFor(() => expect(screen.getByText("system prompt is missing {{CWD}}")).toBeTruthy())
		expect(screen.queryByText("Not loaded")).toBeNull()
	})

	it("reports a failure to read the templates at all", async () => {
		mocks.getPromptTemplates.mockRejectedValue(new Error("host is not listening"))

		render(<PromptTemplatesSection />)

		await waitFor(() => expect(screen.getByText("host is not listening")).toBeTruthy())
	})
})
