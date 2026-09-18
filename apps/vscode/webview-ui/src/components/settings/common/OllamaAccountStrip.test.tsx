import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OllamaAccountStrip } from "./OllamaAccountStrip"

const readOllamaAccount = vi.fn()

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		readOllamaAccount: (...args: unknown[]) => readOllamaAccount(...args),
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href }: { children?: React.ReactNode; href?: string }) => <a href={href}>{children}</a>,
}))

/** The shape the host builds, with every optional field absent by default. */
function response(overrides: Record<string, unknown> = {}) {
	return {
		reachable: true,
		accountReachable: true,
		signedIn: true,
		plan: "pro",
		name: "mannix",
		models: [],
		...overrides,
	}
}

const CLOUD_MODEL = {
	name: "glm-5.3-flash-tpl2:latest",
	cloud: true,
	remoteHost: "https://ollama.com:443",
	remoteModel: "glm-5.3-flash",
	capabilities: [],
	recommendation: {
		model: "glm-5.3-flash:cloud",
		contextLength: 1048576,
		maxOutputTokens: 1048576,
		requiredPlan: "pro",
		thinkingValues: ["low", "high", "max"],
		thinkingDefault: "max",
	},
}

describe("what the panel says about an Ollama endpoint", () => {
	beforeEach(() => {
		readOllamaAccount.mockReset()
	})

	it("names the account and its plan", async () => {
		readOllamaAccount.mockResolvedValue(response())

		render(<OllamaAccountStrip providerId="ollama" />)

		expect(await screen.findByText(/Signed in as mannix · pro plan/)).toBeInTheDocument()
	})

	// The name is not the discriminator: this tag does not end in `:cloud` and
	// is served from ollama.com all the same.
	it("calls a re-templated cloud tag a cloud model", async () => {
		readOllamaAccount.mockResolvedValue(response({ models: [CLOUD_MODEL] }))

		render(<OllamaAccountStrip modelId="glm-5.3-flash-tpl2:latest" providerId="ollama" />)

		expect(await screen.findByText(/Cloud model · served from ollama.com/)).toBeInTheDocument()
	})

	it("shows the window and thinking settings the publisher states", async () => {
		readOllamaAccount.mockResolvedValue(response({ models: [CLOUD_MODEL] }))

		render(<OllamaAccountStrip modelId="glm-5.3-flash-tpl2:latest" providerId="ollama" />)

		expect(await screen.findByText(/1,048,576 token context/)).toBeInTheDocument()
		expect(screen.getByText(/Thinking: low, high, max \(default max\)/)).toBeInTheDocument()
	})

	// The point of reading the plan at all: say it before the request fails.
	it("warns when the account's plan is below what the model requires", async () => {
		readOllamaAccount.mockResolvedValue(response({ plan: "free", models: [CLOUD_MODEL] }))

		render(<OllamaAccountStrip modelId="glm-5.3-flash-tpl2:latest" providerId="ollama" />)

		expect(await screen.findByText(/needs a pro plan/)).toBeInTheDocument()
	})

	// An unreachable /api/me is not a verdict on the account, and warning on it
	// would tell a signed-in Pro user their plan is too low.
	it("does not warn when the account could not be read", async () => {
		readOllamaAccount.mockResolvedValue(
			response({ accountReachable: false, signedIn: false, plan: undefined, name: undefined, models: [CLOUD_MODEL] }),
		)

		render(<OllamaAccountStrip modelId="glm-5.3-flash-tpl2:latest" providerId="ollama" />)

		expect(await screen.findByText(/Account status unavailable/)).toBeInTheDocument()
		expect(screen.queryByText(/needs a pro plan/)).not.toBeInTheDocument()
	})

	it("offers the server's own sign-in link when nobody is signed in", async () => {
		readOllamaAccount.mockResolvedValue(
			response({
				signedIn: false,
				plan: undefined,
				name: undefined,
				signinUrl: "https://ollama.com/connect?name=x",
			}),
		)

		render(<OllamaAccountStrip providerId="ollama" />)

		const link = await screen.findByRole("link", { name: "sign in" })
		expect(link).toHaveAttribute("href", "https://ollama.com/connect?name=x")
	})

	// A server that is not there says nothing, rather than saying the account
	// is signed out.
	it("renders nothing for an unreachable server", async () => {
		readOllamaAccount.mockResolvedValue(response({ reachable: false }))

		const { container } = render(<OllamaAccountStrip providerId="ollama" />)

		await waitFor(() => expect(readOllamaAccount).toHaveBeenCalled())
		expect(container).toBeEmptyDOMElement()
	})
})
