import type { MemoryNoteView } from "@shared/retrieval-status"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { RetrievalStatusHandle } from "../utils/useRetrievalStatus"
import MemoryNotes from "./MemoryNotes"

const boardNote: MemoryNoteView = {
	id: "m4",
	text: "Task board: ledger\nSaved …",
	tags: ["taskboard"],
	createdAt: "2026-11-21T06:00:00Z",
	kind: "fact",
	status: "noted",
	places: [],
	evidence: [],
	history: [],
	merged: [],
	recalled: 0,
	board: { sessionId: "s1", title: "ledger", savedAt: "2026-11-21T06:00:00Z", keepUpdated: false, tasks: 3, open: 1 },
}

function handle(notes: MemoryNoteView[]) {
	const run = vi.fn(async () => ({ ok: true, notes, status: {} as never }))
	return {
		retrieval: {
			busy: false,
			run,
			ask: run,
			status: undefined,
			message: undefined,
			error: undefined,
		} as RetrievalStatusHandle,
		run,
	}
}

describe("MemoryNotes, saved task boards", () => {
	it("shows a board as a board, with its own actions instead of a verdict", async () => {
		const { retrieval, run } = handle([boardNote])
		render(<MemoryNotes label="Main" name="main" onClose={() => {}} retrieval={retrieval} />)
		expect(await screen.findByText("task board · 3 tasks, 1 open")).toBeTruthy()
		expect(screen.queryByText("Confirm…")).toBeNull()
		fireEvent.click(screen.getByText("Use in a new conversation"))
		expect(run).toHaveBeenCalledWith({ action: "useBoard", name: "main", id: "m4" })
		fireEvent.click(screen.getByLabelText("Keep it updated from the conversation working on it"))
		expect(run).toHaveBeenCalledWith({ action: "boardKeepUpdated", name: "main", id: "m4", keepUpdated: true })
	})
})
