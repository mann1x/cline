import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { SkillGroupHeader } from "./ClineRulesToggleModal"

/** The two lists as the Skills tab wires them: one open at a time. */
const Pair = () => {
	const [open, setOpen] = useState<"bundled" | "global" | null>("global")
	return (
		<>
			<SkillGroupHeader
				count={15}
				enabledCount={2}
				onToggle={() => setOpen(open === "bundled" ? null : "bundled")}
				open={open === "bundled"}
				title="Built-in Skills"
			/>
			<SkillGroupHeader
				count={0}
				enabledCount={0}
				onToggle={() => setOpen(open === "global" ? null : "global")}
				open={open === "global"}
				title="Global Skills"
			/>
		</>
	)
}

const expanded = (title: string) => screen.getByText(title).closest("button")?.getAttribute("aria-expanded")

describe("the skill lists that open and close", () => {
	it("says how many skills a closed list holds and how many are on", () => {
		render(<Pair />)
		expect(screen.getByText("15, 2 on")).toBeTruthy()
		expect(screen.getByText("none")).toBeTruthy()
	})

	it("opens one and closes the other, and closes the open one on a second click", () => {
		render(<Pair />)
		expect(expanded("Global Skills")).toBe("true")
		expect(expanded("Built-in Skills")).toBe("false")
		fireEvent.click(screen.getByText("Built-in Skills"))
		expect(expanded("Built-in Skills")).toBe("true")
		expect(expanded("Global Skills")).toBe("false")
		fireEvent.click(screen.getByText("Built-in Skills"))
		expect(expanded("Built-in Skills")).toBe("false")
		expect(expanded("Global Skills")).toBe("false")
	})
})
