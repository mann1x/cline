import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SlashServiceClient } from "@/services/grpc-client"
import { NO_AGENTS_TEXT } from "@/utils/slash-commands"
import ChatTextArea from "./ChatTextArea"

const mocks = vi.hoisted(() => ({
	supportsImages: true as boolean | undefined,
	navigateToSettingsModelPicker: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mode: "act",
		apiConfiguration: {},
		openRouterModels: {},
		platform: "darwin",
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		remoteWorkflowToggles: {},
		remoteConfigSettings: undefined,
		navigateToSettingsModelPicker: mocks.navigateToSettingsModelPicker,
		mcpServers: [],
	}),
}))

vi.mock("@/context/PlatformContext", () => ({
	usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }),
}))

vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedProvider: "anthropic",
		selectedModelId: "text-only-model",
		selectedModelInfo: { supportsImages: mocks.supportsImages },
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		searchCommits: vi.fn(async () => ({ commits: [] })),
		searchFiles: vi.fn(async () => ({ results: [] })),
		getRelativePaths: vi.fn(async () => ({ paths: [] })),
		openImage: vi.fn(async () => ({})),
		openFile: vi.fn(async () => ({})),
		refreshSkills: vi.fn(async () => ({
			globalSkills: [
				{ name: "docker-compose-deploy", description: "Deploy a stack with docker compose", path: "/g/a", enabled: true },
				{ name: "QA Smoke Tests", description: "Run the smoke suite against a build", path: "/g/b", enabled: true },
				{ name: "tdd-coverage", description: "Measure test coverage", path: "/g/c", enabled: false },
			],
			localSkills: [],
			bundledSkills: [],
		})),
	},
	SlashServiceClient: {
		listAgents: vi.fn(async () => ({
			agents: [
				{ name: "qa", description: "Runs the QA skill" },
				{ name: "docs", description: "Writes the docs" },
			],
		})),
	},
	StateServiceClient: {
		togglePlanActModeProto: vi.fn(async () => ({})),
	},
}))

vi.mock("../cline-rules/ClineRulesToggleModal", () => ({ default: () => null }))
vi.mock("./ServersToggleModal", () => ({ default: () => null }))

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo="

function renderTextArea(selectedImages: string[] = []) {
	const setSelectedImages = vi.fn()
	render(
		<ChatTextArea
			activeQuote={null}
			inputValue=""
			onSelectFilesAndImages={vi.fn()}
			onSend={vi.fn()}
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={selectedImages}
			sendingDisabled={false}
			setInputValue={vi.fn()}
			setSelectedFiles={vi.fn()}
			setSelectedImages={setSelectedImages}
			shouldDisableFilesAndImages={false}
		/>,
	)
	return { textarea: screen.getByPlaceholderText("Type a message"), setSelectedImages }
}

function pasteImage(target: HTMLElement) {
	const file = new File(["png"], "screenshot.png", { type: "image/png" })
	return fireEvent.paste(target, {
		clipboardData: {
			items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
			getData: () => "",
		},
	})
}

describe("ChatTextArea image attachments vs. model capability", () => {
	beforeEach(() => {
		mocks.supportsImages = true
		mocks.navigateToSettingsModelPicker.mockReset()
	})

	it("still takes the image attach path on paste for a text-only model, without a refusal message", () => {
		mocks.supportsImages = false
		const { textarea } = renderTextArea()

		const notCanceled = pasteImage(textarea)

		expect(notCanceled).toBe(false) // preventDefault: the paste was handled as an image, not as text
		expect(screen.queryByText(/ignored/)).not.toBeInTheDocument()
	})

	it("badges attached images and offers a model switch when the model is text-only", () => {
		mocks.supportsImages = false
		renderTextArea([PNG_DATA_URL, PNG_DATA_URL])

		const notice = screen.getByTestId("images-unsupported-notice")
		expect(notice).toHaveTextContent("text-only-model doesn't support images, so the 2 attached images will be ignored.")
		expect(screen.getAllByTestId("image-unsupported-badge")).toHaveLength(2)

		// A native button, so keyboard users get Enter/Space activation without extra handlers.
		const chooseModel = screen.getByRole("button", { name: "Choose an image-capable model" })
		expect(chooseModel.tagName).toBe("BUTTON")
		fireEvent.click(chooseModel)
		expect(mocks.navigateToSettingsModelPicker).toHaveBeenCalledWith({ targetSection: "api-config" })
	})

	it("uses singular wording for one image", () => {
		mocks.supportsImages = false
		renderTextArea([PNG_DATA_URL])

		expect(screen.getByTestId("images-unsupported-notice")).toHaveTextContent("the attached image will be ignored")
		expect(screen.getByTestId("images-unsupported-notice")).toHaveTextContent("or remove it.")
	})

	it("shows nothing extra when the model supports images", () => {
		renderTextArea([PNG_DATA_URL])

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
		expect(screen.queryByTestId("image-unsupported-badge")).not.toBeInTheDocument()
	})

	it("fails open when the model's image support is unknown", () => {
		mocks.supportsImages = undefined
		renderTextArea([PNG_DATA_URL])

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
	})

	it("shows nothing for a text-only model while no images are attached", () => {
		mocks.supportsImages = false
		renderTextArea()

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
	})
})

describe("ChatTextArea /delegate agent names", () => {
	function renderWith(initial: string) {
		const setInputValue = vi.fn()
		const view = render(
			<ChatTextArea
				activeQuote={null}
				inputValue={initial}
				onSelectFilesAndImages={vi.fn()}
				onSend={vi.fn()}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={setInputValue}
				setSelectedFiles={vi.fn()}
				setSelectedImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)
		return { textarea: screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement, setInputValue, view }
	}

	function type(textarea: HTMLTextAreaElement, value: string) {
		fireEvent.change(textarea, { target: { value, selectionStart: value.length } })
	}

	it("offers the agents after the command and fills in the one chosen", async () => {
		const { textarea, setInputValue } = renderWith("/delegate q")
		type(textarea, "/delegate q")

		expect(await screen.findByText("qa")).toBeInTheDocument()
		expect(screen.queryByText("docs")).not.toBeInTheDocument()

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(setInputValue).toHaveBeenLastCalledWith("/delegate qa ")
	})

	it("stops offering them when Escape is pressed, so Enter sends", async () => {
		const { textarea } = renderWith("/delegate-background ")
		type(textarea, "/delegate-background ")

		expect(await screen.findByText("docs")).toBeInTheDocument()
		fireEvent.keyDown(textarea, { key: "Escape" })
		expect(screen.queryByText("docs")).not.toBeInTheDocument()
	})
})

// Chris, 2026-11-22: a way to find a skill from the chat box, as /delegate
// finds an agent.
describe("ChatTextArea skills", () => {
	function renderWith(initial: string) {
		const setInputValue = vi.fn()
		const onSend = vi.fn()
		render(
			<ChatTextArea
				activeQuote={null}
				inputValue={initial}
				onSelectFilesAndImages={vi.fn()}
				onSend={onSend}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={setInputValue}
				setSelectedFiles={vi.fn()}
				setSelectedImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)
		const textarea = screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: initial, selectionStart: initial.length } })
		return { textarea, setInputValue, onSend }
	}

	it("/skill offers the skills whose name or description has every word, and fills in the one chosen", async () => {
		const { textarea, setInputValue } = renderWith("/skill suite build")

		expect(await screen.findByText("/qa-smoke-tests")).toBeInTheDocument()
		expect(screen.queryByText("/docker-compose-deploy")).not.toBeInTheDocument()

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(setInputValue).toHaveBeenLastCalledWith("/qa-smoke-tests ")
	})

	it("/skill leaves out a skill that is switched off", async () => {
		renderWith("/skill ")
		expect(await screen.findByText("/docker-compose-deploy")).toBeInTheDocument()
		expect(screen.queryByText("/tdd-coverage")).not.toBeInTheDocument()
	})

	it("/skill says so when nothing matches, and Enter does not send", async () => {
		const { textarea, onSend } = renderWith("/skill kubernetes")
		expect(await screen.findByText("No skill matches “kubernetes”")).toBeInTheDocument()
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).not.toHaveBeenCalled()
	})

	it("the / menu lists skills, matched anywhere in the name", async () => {
		// Opened by a change, so it starts empty: a value set to what it already
		// holds fires none.
		const { textarea } = renderWith("")
		fireEvent.change(textarea, { target: { value: "/deploy", selectionStart: 7 } })
		expect(await screen.findByText("/docker-compose-deploy")).toBeInTheDocument()
		expect(screen.getByText("Skills")).toBeInTheDocument()
	})
})

// The owner, 2026-11-26: "/agent reviewer /media" completed neither the
// agent's name nor, after it, the skill. Typed one keystroke at a time into a
// box that holds its own value, as the chat's does.
describe("ChatTextArea /agent", () => {
	function Typed({ onSend }: { onSend: () => void }) {
		const [value, setValue] = useState("")
		return (
			<ChatTextArea
				activeQuote={null}
				inputValue={value}
				onSelectFilesAndImages={vi.fn()}
				onSend={onSend}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={setValue}
				setSelectedFiles={vi.fn()}
				setSelectedImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>
		)
	}

	function typeEach(textarea: HTMLTextAreaElement, text: string) {
		for (const char of text) {
			const value = textarea.value + char
			fireEvent.change(textarea, { target: { value, selectionStart: value.length } })
		}
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

	it("offers the agents as soon as /agent is picked from the / menu", async () => {
		render(<Typed onSend={vi.fn()} />)
		const textarea = screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement
		typeEach(textarea, "/agen")
		fireEvent.keyDown(textarea, { key: "Enter" })
		await settle()
		expect(textarea.value).toBe("/agent ")
		// No keystroke since the pick: the pick's own refocus must not close it.
		expect(await screen.findByText("qa")).toBeInTheDocument()
		expect(screen.getByText("docs")).toBeInTheDocument()
	})

	it("completes the agent's name, then offers its skills at once", async () => {
		render(<Typed onSend={vi.fn()} />)
		const textarea = screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement
		typeEach(textarea, "/agent q")
		expect(await screen.findByText("qa")).toBeInTheDocument()
		fireEvent.keyDown(textarea, { key: "Tab" })
		await settle()
		expect(textarea.value).toBe("/agent qa ")
		expect(await screen.findByText("/qa-smoke-tests")).toBeInTheDocument()
		typeEach(textarea, "/smo")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea.value).toBe("/agent qa /qa-smoke-tests ")
	})

	// The owner, 2026-11-27, again: pandorum had no agent file at all, and the
	// menus showed nothing, which read as completion being broken.
	describe("with no agent set up", () => {
		beforeEach(() => {
			vi.mocked(SlashServiceClient.listAgents).mockResolvedValue({ agents: [] } as never)
		})
		afterEach(() => {
			vi.mocked(SlashServiceClient.listAgents).mockResolvedValue({
				agents: [
					{ name: "qa", description: "Runs the QA skill" },
					{ name: "docs", description: "Writes the docs" },
				],
			} as never)
		})

		it("/delegate says there is none and where to make one", async () => {
			render(<Typed onSend={vi.fn()} />)
			const textarea = screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement
			typeEach(textarea, "/delegate rev")
			expect(await screen.findByText(NO_AGENTS_TEXT)).toBeInTheDocument()
			// Nothing to pick: Enter is not taken by the menu.
			fireEvent.keyDown(textarea, { key: "Tab" })
			expect(textarea.value).toBe("/delegate rev")
		})

		it("/agent says so above the skills it still offers, and after an unknown name", async () => {
			render(<Typed onSend={vi.fn()} />)
			const textarea = screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement
			typeEach(textarea, "/agent ")
			expect(await screen.findByText(NO_AGENTS_TEXT)).toBeInTheDocument()
			expect(screen.getByText("/docker-compose-deploy")).toBeInTheDocument()
			typeEach(textarea, "reviewer /me")
			expect(await screen.findByText(NO_AGENTS_TEXT)).toBeInTheDocument()
			fireEvent.keyDown(textarea, { key: "Escape" })
			expect(screen.queryByText(NO_AGENTS_TEXT)).not.toBeInTheDocument()
		})
	})
})
