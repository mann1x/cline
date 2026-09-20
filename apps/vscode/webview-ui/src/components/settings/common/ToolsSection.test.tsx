import { SELECTABLE_TOOLS, TOOL_GROUPS } from "@shared/tool-selection"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ToolsSection } from "./ToolsSection"

type Config = { tools?: { disabled?: string[]; readLimitEnabled?: boolean; readLimitChars?: number } }

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Config } }))

// The host round trip behind the hook: the panel does not see its own write
// until the answer comes back, so anything clicked in between is composed from
// the list as it stood before.
vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Config>(mocks.config.current)
			const write = useCallback(async (patch: Config) => {
				mocks.write(patch)
				await Promise.resolve()
				setConfig((previous) => ({ ...previous, ...(patch.tools !== undefined ? { tools: patch.tools } : {}) }))
			}, [])
			return { config, write }
		},
	}
})

vi.mock("@/components/ui/label", () => ({
	Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@/components/ui/switch", () => ({
	Switch: ({ checked, onCheckedChange, id }: { checked?: boolean; onCheckedChange?: (v: boolean) => void; id?: string }) => (
		<input
			checked={checked ?? false}
			data-testid={id}
			onChange={(event) => onCheckedChange?.(event.target.checked)}
			type="checkbox"
		/>
	),
}))

/**
 * The panel ships collapsed, so almost every test here is about what is inside
 * it. Opening it is a click on the only button rendered while it is shut.
 */
function renderExpanded() {
	const result = render(<ToolsSection providerId="ollama" />)
	fireEvent.click(screen.getByRole("button"))
	return result
}

describe("the tools section", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = {}
	})

	it("offers every tool when the profile names none", () => {
		renderExpanded()

		expect((screen.getByTestId("tool-grep") as HTMLInputElement).checked).toBe(true)
		expect((screen.getByTestId("tool-editor") as HTMLInputElement).checked).toBe(true)
	})

	it("writes the tool the user switched off", async () => {
		renderExpanded()

		fireEvent.click(screen.getByTestId("tool-grep"))

		expect(mocks.write).toHaveBeenCalledWith({ tools: { disabled: ["grep"] } })
		await act(async () => {})
	})

	it("keeps the first switch off when a second is flipped in the same round trip", async () => {
		renderExpanded()

		// Both inside one round trip. Composed from the config rather than from
		// what was last sent, the second write would carry only `awk` and put
		// `grep` back -- the fault the PolyKV section was reported for.
		fireEvent.click(screen.getByTestId("tool-grep"))
		fireEvent.click(screen.getByTestId("tool-awk"))

		expect(mocks.write).toHaveBeenLastCalledWith({ tools: { disabled: ["awk", "grep"] } })
		await act(async () => {})
	})

	it("switches a tool back on by dropping it from the list", async () => {
		mocks.config.current = { tools: { disabled: ["grep", "awk"] } }
		renderExpanded()
		expect((screen.getByTestId("tool-grep") as HTMLInputElement).checked).toBe(false)

		fireEvent.click(screen.getByTestId("tool-grep"))

		expect(mocks.write).toHaveBeenCalledWith({ tools: { disabled: ["awk"] } })
		await act(async () => {})
	})

	it("shows what the selection costs without being opened", () => {
		mocks.config.current = { tools: { disabled: ["editor"] } }
		render(<ToolsSection providerId="ollama" />)

		// The editor is 1,860 of the 8,647 tokens on offer, so dropping it has
		// to move the number the panel prints.
		const total = screen.getByTestId("tools-section-total").textContent ?? ""
		expect(total).toContain("6.8k of 8.6k tokens")
		// On the collapsed header, deliberately: the price is the reason to
		// open the section, so it cannot be behind it.
		expect(screen.queryByTestId("tool-editor")).toBeNull()
	})

	// The read limit defaults to on: a model that reads a whole file pays for
	// it in every later request, because a tool result is re-sent for the rest
	// of the run. A capable model paginates on its own and does not need it.
	it("has the read limit on for a profile that says nothing", () => {
		renderExpanded()

		expect((screen.getByTestId("tool-read-limit") as HTMLInputElement).checked).toBe(true)
		expect(screen.getByLabelText(/Read size limit/)).toBeTruthy()
	})

	it("stores only the off switch, never the default", async () => {
		renderExpanded()

		await act(async () => {
			fireEvent.click(screen.getByTestId("tool-read-limit"))
		})
		expect(mocks.write).toHaveBeenCalledWith({ tools: { disabled: [], readLimitEnabled: false } })

		// And back on: the field is dropped rather than written as `true`, so an
		// untouched profile and one that chose the default stay the same thing.
		await act(async () => {
			fireEvent.click(screen.getByTestId("tool-read-limit"))
		})
		expect(mocks.write).toHaveBeenLastCalledWith({ tools: { disabled: [] } })
	})

	// The section is written whole. A switch that carried only its own field
	// would clear the other one, which is how this panel's sibling sections
	// each lost a setting before they were written to compose at call time.
	it("keeps the tool selection when the read limit changes", async () => {
		mocks.config.current = { tools: { disabled: ["awk"] } }
		renderExpanded()

		await act(async () => {
			fireEvent.click(screen.getByTestId("tool-read-limit"))
		})

		expect(mocks.write).toHaveBeenCalledWith({ tools: { disabled: ["awk"], readLimitEnabled: false } })
	})

	it("keeps the read limit when a tool is switched off", async () => {
		mocks.config.current = { tools: { readLimitChars: 30_000 } }
		renderExpanded()

		await act(async () => {
			fireEvent.click(screen.getByTestId("tool-grep"))
		})

		expect(mocks.write).toHaveBeenCalledWith({ tools: { disabled: ["grep"], readLimitChars: 30_000 } })
	})

	it("hides the threshold when the limit is off, since it applies to nothing", () => {
		mocks.config.current = { tools: { readLimitEnabled: false } }
		renderExpanded()

		expect((screen.getByTestId("tool-read-limit") as HTMLInputElement).checked).toBe(false)
		expect(screen.queryByLabelText(/Read size limit/)).toBeNull()
	})
})

/**
 * Twelve switches and a summary line each made this the longest thing in the
 * API tab. Collapsed, and grouped by what a tool does to the workspace, because
 * the question a reader arrives with is "can this profile still write files",
 * not "which tool is dearest".
 */
describe("the tools section, shut", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = {}
	})

	it("starts collapsed", () => {
		render(<ToolsSection providerId="ollama" />)

		expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false")
		expect(screen.queryByTestId("tool-grep")).toBeNull()
		expect(screen.queryByTestId("tool-read-limit")).toBeNull()
	})

	it("says how many are off without being opened", () => {
		mocks.config.current = { tools: { disabled: ["awk", "sed"] } }
		render(<ToolsSection providerId="ollama" />)

		expect(screen.getByRole("button").textContent).toContain("(2 off)")
	})

	it("says nothing about the count when none are off", () => {
		render(<ToolsSection providerId="ollama" />)

		expect(screen.getByRole("button").textContent).not.toContain("off)")
	})

	it("opens and shuts again", () => {
		render(<ToolsSection providerId="ollama" />)

		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByTestId("tool-grep")).toBeTruthy()

		fireEvent.click(screen.getByRole("button"))
		expect(screen.queryByTestId("tool-grep")).toBeNull()
	})
})

describe("the tools section, grouped", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = {}
	})

	it("puts every selectable tool under exactly one heading", () => {
		// The catalog and the panel cannot disagree about what is on screen: a
		// tool with a group nothing renders would vanish from the UI while
		// staying in the profile, which is the silent half of this feature.
		renderExpanded()

		for (const tool of SELECTABLE_TOOLS) {
			expect(screen.getByTestId(`tool-row-${tool.name}`), `${tool.name} is not rendered`).toBeTruthy()
		}
	})

	it("shows the groups least-dangerous first", () => {
		const { container } = renderExpanded()

		const text = container.textContent ?? ""
		const order = TOOL_GROUPS.map((group) => text.indexOf(group.label))
		expect(order.every((index) => index >= 0)).toBe(true)
		expect([...order]).toEqual([...order].sort((a, b) => a - b))
	})

	it("prices each group on its own", () => {
		// The per-group figure is what makes "switching both write tools off
		// buys 2.5k" answerable without arithmetic across twelve rows.
		mocks.config.current = { tools: { disabled: ["editor"] } }
		renderExpanded()

		// editor is 1,860 of the write group's 2,497.
		expect(screen.getByTestId("tool-group-total-write").textContent).toContain("637 of 2.5k")
		// And a group it does not belong to is untouched.
		expect(screen.getByTestId("tool-group-total-check").textContent).toContain("1.7k of 1.7k")
	})

	it("bands alternate rows inside a group, starting unshaded", () => {
		renderExpanded()

		const stripe = "bg-(--vscode-textBlockQuote-background)"
		for (const group of TOOL_GROUPS) {
			const inGroup = SELECTABLE_TOOLS.filter((tool) => tool.group === group.id)
			inGroup.forEach((tool, index) => {
				const row = screen.getByTestId(`tool-row-${tool.name}`)
				expect(row.className.includes(stripe), `${tool.name} banding`).toBe(index % 2 === 1)
			})
		}
	})
})
