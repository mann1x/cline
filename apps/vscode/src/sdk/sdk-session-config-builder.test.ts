import { describe, expect, it, vi } from "vitest"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	buildAgentHooks: vi.fn(() => ({})),
	// Stands in for the real stack assembler: passes the file-hook layer
	// through so the beforeModel assertions below still see it, and marks the
	// result so a test can tell the builder went through it rather than
	// assigning `config.hooks` itself.
	composeSessionHooks: vi.fn((fileHooks: object | undefined, _cwd: string) => ({ ...fileHooks, composed: true })),
}))

vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: mocks.buildSessionConfig,
	composeSessionHooks: mocks.composeSessionHooks,
}))

vi.mock("./hooks-adapter", () => ({
	buildAgentHooks: mocks.buildAgentHooks,
}))

describe("SdkSessionConfigBuilder", () => {
	it("adds the CLI plan-mode switch_to_act_mode tool only in plan mode", async () => {
		const stateManager = {
			getGlobalSettingsKey: vi.fn(() => "plan"),
		}
		const onSwitchToActMode = vi.fn()
		const builder = new SdkSessionConfigBuilder({
			stateManager: stateManager as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode,
		})

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const planConfig = await builder.build({ cwd: "/workspace", mode: "plan" })
		const switchTool = planConfig.extraTools?.find((tool) => tool.name === "switch_to_act_mode")
		expect(switchTool).toBeDefined()
		// Ends the run cleanly after the tool result so the loop never starts an
		// iteration that the stop hook would abort (which surfaced in the webview
		// as "API Request Cancelled").
		expect(switchTool?.lifecycle?.completesRun).toBe(true)
		expect(await switchTool?.execute({}, {} as never)).toBe(
			"You successfully switched to act mode, proceed with the plan. You now have access to editing files and running commands. (The switch_to_act_mode tool is only available in plan mode.)",
		)
		expect(onSwitchToActMode).toHaveBeenCalledOnce()

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [switchTool],
			hooks: {},
		})
		const actConfig = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(actConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)
	})

	it("stops before the next model call after switch_to_act_mode queues a mode change", async () => {
		const baseBeforeModel = vi.fn(async () => ({ metadata: "base" }))
		mocks.buildAgentHooks.mockReturnValueOnce({ beforeModel: baseBeforeModel })
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

		const builder = new SdkSessionConfigBuilder({
			stateManager: {} as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode: vi.fn(),
			shouldStopAfterModeSwitch: () => true,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		await expect(config.hooks?.beforeModel?.({} as never)).resolves.toEqual({
			metadata: "base",
			stop: true,
		})
		expect(baseBeforeModel).toHaveBeenCalledOnce()
	})

	it("passes the mistake-limit callback into the SDK config without overriding SDK execution defaults", async () => {
		const onConsecutiveMistakeLimitReached = vi.fn()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, execution: { maxRetries: 1 } })

		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => 3) } as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode: vi.fn(),
			onConsecutiveMistakeLimitReached,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.execution).toEqual({ maxRetries: 1 })
		expect(config.onConsecutiveMistakeLimitReached).toBe(onConsecutiveMistakeLimitReached)
	})

	// Regression: this class used to assign `config.hooks` outright, which threw
	// away every layer `buildSessionConfig` had composed — the editor's
	// diagnostics never reached the model in a real session, and no test caught
	// it because the tests call `buildSessionConfig` directly. Rebuilding the
	// stack, rather than replacing it, is the contract.
	it("rebuilds the whole hook stack around the emitter-aware file hooks", async () => {
		const discarded = vi.fn()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: { beforeTool: discarded } })
		const baseBeforeModel = vi.fn(async () => undefined)
		mocks.buildAgentHooks.mockReturnValueOnce({ beforeModel: baseBeforeModel })

		const builder = new SdkSessionConfigBuilder({
			stateManager: {} as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode: vi.fn(),
		})

		// The mocks are shared across this file's tests, which each build a config.
		mocks.composeSessionHooks.mockClear()
		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(mocks.composeSessionHooks).toHaveBeenCalledOnce()
		const [fileHooks, cwd] = mocks.composeSessionHooks.mock.calls[0]
		expect(cwd).toBe("/workspace")
		// The layer handed to the assembler is the emitter-aware one this class
		// builds, not the one the factory used.
		expect(typeof (fileHooks as { beforeModel?: unknown }).beforeModel).toBe("function")
		expect(config.hooks).toBe(mocks.composeSessionHooks.mock.results[0].value)
	})
})
