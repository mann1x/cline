import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { getTaskSizeOnDisk: vi.fn() } }))
vi.mock("@shared/proto/cline/common", () => ({ StringRequest: { create: (x: unknown) => x } }))

import { HistoryItemContextMenu } from "./HistoryItemContextMenu"

const renderMenu = (props: { tags?: string[]; recentTags?: string[]; onAddTag?: (tag: string) => void } = {}) =>
	render(
		<div style={{ position: "relative" }}>
			<HistoryItemContextMenu
				at={{ x: 10, y: 10 }}
				canDelete
				firstPrompt="fix it"
				onAddTag={props.onAddTag ?? vi.fn()}
				onClose={vi.fn()}
				onDelete={vi.fn()}
				recentTags={props.recentTags ?? []}
				tags={props.tags ?? []}
				taskId="task-1"
			/>
		</div>,
	)

describe("HistoryItemContextMenu, Add tag", () => {
	it("adds the typed tag on Enter, normalized", () => {
		const onAddTag = vi.fn()
		renderMenu({ onAddTag })
		fireEvent.click(screen.getByRole("menuitem", { name: /add tag/i }))
		const field = screen.getByLabelText("New tag")
		fireEvent.change(field, { target: { value: "  big   refactor " } })
		fireEvent.keyDown(field, { key: "Enter" })
		expect(onAddTag).toHaveBeenCalledWith("big refactor")
	})

	// Case does not make a new tag.
	it("does not add a tag the conversation already has", () => {
		const onAddTag = vi.fn()
		renderMenu({ onAddTag, tags: ["Work"] })
		fireEvent.click(screen.getByRole("menuitem", { name: /add tag/i }))
		const field = screen.getByLabelText("New tag")
		fireEvent.change(field, { target: { value: "work" } })
		fireEvent.keyDown(field, { key: "Enter" })
		expect(onAddTag).not.toHaveBeenCalled()
	})

	it("offers recent tags the conversation does not have, one click each", () => {
		const onAddTag = vi.fn()
		renderMenu({ onAddTag, tags: ["ui"], recentTags: ["work", "UI", "infra"] })
		fireEvent.click(screen.getByRole("menuitem", { name: /add tag/i }))
		const recent = screen.getByLabelText("Recent tags")
		expect(recent.textContent).toBe("workinfra")
		fireEvent.click(screen.getByText("infra"))
		expect(onAddTag).toHaveBeenCalledWith("infra")
	})
})
