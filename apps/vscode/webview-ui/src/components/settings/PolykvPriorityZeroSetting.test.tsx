import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	engine: undefined as string | undefined,
	askedFor: [] as Array<string | undefined>,
	updateSettings: vi.fn(async () => {}),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({ StateServiceClient: { updateSettings: mocks.updateSettings } }))
vi.mock("@shared/proto/cline/state", () => ({ UpdateSettingsRequest: { create: (patch: unknown) => patch } }))
// The probe itself (`/props` through the host) is ParallelSessionsField's and
// tested there; this suite asks what the toggle does with its answer.
vi.mock("./common/ParallelSessionsField", () => ({
	useOpencotiEngineMode: (providerId: string | undefined) => {
		mocks.askedFor.push(providerId)
		return providerId === "opencoti" ? mocks.engine : undefined
	},
}))
vi.mock("./common/SettingsCheckbox", () => ({
	SettingsCheckbox: ({
		checked,
		onChange,
		children,
	}: {
		checked: boolean
		onChange: (checked: boolean) => void
		children: React.ReactNode
	}) => (
		<label>
			<input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
			{children}
		</label>
	),
}))

import PolykvPriorityZeroSetting from "./PolykvPriorityZeroSetting"

const LABEL = "Use PolyKV agents as Priority 0"

function lead(provider: string, mode: "act" | "plan" = "act") {
	return {
		mode,
		apiConfiguration: { actModeApiProvider: provider, planModeApiProvider: provider },
	}
}

describe("Use PolyKV agents as Priority 0", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.askedFor.length = 0
		mocks.engine = undefined
	})

	it("is shown when the Model is opencoti and its server confirmed pools", () => {
		mocks.state = lead("opencoti")
		mocks.engine = "polykv"
		render(<PolykvPriorityZeroSetting />)
		expect(screen.getByText(LABEL)).toBeTruthy()
		// Off by default.
		expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
	})

	it("is hidden while the server has not answered, or answered without pools", () => {
		mocks.state = lead("opencoti")
		for (const engine of ["unknown", "elastic", "fixed", undefined]) {
			mocks.engine = engine
			const { unmount } = render(<PolykvPriorityZeroSetting />)
			expect(screen.queryByText(LABEL)).toBeNull()
			unmount()
		}
	})

	it("is hidden when the Model provider is not opencoti, even on a pooled server", () => {
		mocks.state = lead("ollama")
		mocks.engine = "polykv"
		render(<PolykvPriorityZeroSetting />)
		expect(screen.queryByText(LABEL)).toBeNull()
	})

	// The lead is the Model tab of the mode the session is in.
	it("asks about the current mode's Model provider", () => {
		mocks.state = {
			mode: "plan",
			apiConfiguration: { actModeApiProvider: "ollama", planModeApiProvider: "opencoti" },
		}
		mocks.engine = "polykv"
		render(<PolykvPriorityZeroSetting />)
		expect(mocks.askedFor).toContain("opencoti")
		expect(screen.getByText(LABEL)).toBeTruthy()
	})

	it("writes the setting when toggled, and shows it stored", async () => {
		mocks.state = { ...lead("opencoti"), polykvAgentsPriorityZero: true }
		mocks.engine = "polykv"
		render(<PolykvPriorityZeroSetting />)
		const box = screen.getByRole("checkbox") as HTMLInputElement
		expect(box.checked).toBe(true)

		fireEvent.click(box)
		await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith({ polykvAgentsPriorityZero: false }))
	})
})
