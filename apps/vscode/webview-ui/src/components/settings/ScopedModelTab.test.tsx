import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useApiConfigurationScope } from "./utils/ApiConfigurationScopeContext"

// Reported against agent nodes: loading a profile did not change the panel —
// the configuration only appeared after switching to another node and back.
//
// The panel does not read its prop directly. It holds the snapshot it is
// editing in a writer (so a second edit in one interaction builds on the
// first), takes an incoming prop through `adopt`, and renders from
// `writer.current()`. `adopt` ran in an effect while the read ran during
// render, so the read was always a render ahead of the adoption — and the
// writer keeps its snapshot in a closure variable, so adopting caused no
// re-render to correct it. Anything that changed the prop and nothing else
// left the old configuration on screen.

const held = vi.hoisted(() => {
	const react = require("react") as typeof import("react")
	const fixture = { apiConfiguration: {}, planActSeparateModelsSetting: true } as Record<string, unknown>
	return { react, context: react.createContext(fixture) }
})

const grpc = vi.hoisted(() => {
	const store: { release?: () => void } = {}
	return {
		store,
		/** Resolves only when the test says so, so a write can be left in flight. */
		updateSettings: vi.fn(() => new Promise<void>((resolve) => (store.release = resolve))),
	}
})

vi.mock("@/context/ExtensionStateContext", () => ({
	ExtensionStateContext: held.context,
	useExtensionState: () => held.react.useContext(held.context),
}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: grpc.updateSettings },
	ModelsServiceClient: { updateApiConfigurationProto: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock("@shared/proto/cline/state", () => ({ UpdateSettingsRequest: { create: (p: unknown) => p } }))
vi.mock("@shared/proto/cline/models", () => ({ UpdateApiConfigurationRequest: { create: (p: unknown) => p } }))
vi.mock("@shared/proto-conversions/models/api-configuration-conversion", () => ({
	convertApiConfigurationToProto: (c: unknown) => c,
}))

// Stands in for the provider form: reports what the panel handed it, and can
// make the edit the panel would make.
vi.mock("./ApiOptions", () => ({
	default: () => {
		const state = held.react.useContext(held.context) as { apiConfiguration?: Record<string, unknown> }
		const scope = useApiConfigurationScope()
		return (
			<>
				<div data-testid="model">{String(state.apiConfiguration?.actModeOllamaModelId ?? "none")}</div>
				<div data-testid="window">{String(scope?.providerSettings?.contextWindow ?? "none")}</div>
				<button onClick={() => void scope?.writeProviderSettings?.({ contextWindow: 131072 })} type="button">
					edit
				</button>
			</>
		)
	},
}))

import ScopedModelTab from "./ScopedModelTab"

const snapshotFor = (model: string, contextWindow?: number) =>
	JSON.stringify({
		global: {},
		mode: { apiProvider: "ollama", ollamaModelId: model },
		...(contextWindow === undefined ? {} : { providerConfig: { contextWindow } }),
	})

describe("a scoped model panel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		grpc.store.release = undefined
		grpc.updateSettings.mockImplementation(() => new Promise<void>((resolve) => (grpc.store.release = resolve)))
	})

	it("shows the configuration it was given", () => {
		render(<ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={snapshotFor("first:q8")} />)

		expect(screen.getByTestId("model").textContent).toBe("first:q8")
	})

	// The reported bug. A profile load replaces the stored snapshot and nothing
	// else; the panel has to follow on that render, not on some later one.
	it("follows a snapshot replaced from outside, on the same render", () => {
		const { rerender } = render(
			<ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={snapshotFor("first:q8")} />,
		)
		expect(screen.getByTestId("model").textContent).toBe("first:q8")

		rerender(<ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={snapshotFor("loaded:q4")} />)

		expect(screen.getByTestId("model").textContent).toBe("loaded:q4")
	})

	// The other half of the same cause, and the one with no prop change at all
	// to hide behind: an edit made in the panel updates the writer, and anything
	// reading the held snapshot — the sampler, the window the output-budget
	// slider sizes against — kept showing the value from before it until the
	// host echoed the write back, a whole round trip later.
	it("shows a local edit immediately, with no prop change", async () => {
		render(<ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={snapshotFor("first:q8", 8192)} />)
		expect(screen.getByTestId("window").textContent).toBe("8192")

		fireEvent.click(screen.getByText("edit"))
		await act(async () => {})

		// Still unacknowledged: the host has not answered, and must not need to.
		expect(grpc.store.release).toBeTypeOf("function")
		expect(screen.getByTestId("window").textContent).toBe("131072")
	})

	// What adoption is guarded for, and what moving it must not undo: while our
	// own write is unacknowledged, an arriving prop is the state from *before*
	// it, so taking it would roll the user's edit back under them. The prop has
	// to differ for the panel to look at it at all, which is why the echo below
	// carries a different model.
	it("refuses a prop that arrives while its own write is in flight", async () => {
		const { rerender } = render(
			<ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={snapshotFor("first:q8", 8192)} />,
		)
		expect(screen.getByTestId("window").textContent).toBe("8192")

		fireEvent.click(screen.getByText("edit"))
		await act(async () => {})
		expect(grpc.updateSettings).toHaveBeenCalled()
		expect(grpc.store.release).toBeTypeOf("function")

		rerender(<ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={snapshotFor("echo:q8", 8192)} />)

		// Neither half of the stale snapshot was taken.
		expect(screen.getByTestId("window").textContent).toBe("131072")
		expect(screen.getByTestId("model").textContent).toBe("first:q8")

		// Once the write lands, a newer snapshot is adopted as normal.
		await act(async () => {
			grpc.store.release?.()
		})
		rerender(<ScopedModelTab setting="agentsModeApiConfiguration" storedSnapshot={snapshotFor("later:q4", 65536)} />)
		expect(screen.getByTestId("window").textContent).toBe("65536")
		expect(screen.getByTestId("model").textContent).toBe("later:q4")
	})
})
