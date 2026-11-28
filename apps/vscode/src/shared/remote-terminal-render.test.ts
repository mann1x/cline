import { describe, expect, it } from "vitest"
import { renderRemoteActivity, toTerminalText } from "./remote-terminal-render"

// Colour codes out of the way, so the assertions read as the tab does.
const plain = (text: string) =>
	text
		.split("\x1b[")
		.map((part, i) => (i === 0 ? part : part.replace(/^[0-9;]*m/, "")))
		.join("")

describe("renderRemoteActivity", () => {
	const base = { terminal: "bench-app", sessionId: "1790503776490_9jhpx" }

	it("shows a command with its folder and session", () => {
		const text = plain(
			renderRemoteActivity({ ...base, type: "command", cwd: "/home/u/cerebriline/x", command: "make bench" }, true),
		)
		expect(text).toBe("\r\n[776490_9jhpx] /home/u/cerebriline/x\r\n$ make bench\r\n")
	})

	it("passes output through with terminal line endings", () => {
		expect(renderRemoteActivity({ ...base, type: "output", data: "a\nb\r\nc" }, true)).toBe("a\r\nb\r\nc")
		expect(toTerminalText("x\ny")).toBe("x\r\ny")
	})

	it("ends a command on a fresh line, even after output without a newline", () => {
		expect(plain(renderRemoteActivity({ ...base, type: "exit", exitCode: 0, seconds: 1.25 }, false))).toBe(
			"\r\n── exit 0 after 1.3 s\r\n",
		)
		expect(plain(renderRemoteActivity({ ...base, type: "exit", exitCode: 2, seconds: 3 }, true))).toBe(
			"── exit 2 after 3.0 s\r\n",
		)
		expect(plain(renderRemoteActivity({ ...base, type: "running", processId: "p1", seconds: 300 }, true))).toContain(
			"still running as p1",
		)
	})

	it("shows reads, writes and copies as one line", () => {
		expect(plain(renderRemoteActivity({ ...base, type: "note", text: "remote_copy: uploaded proj" }, true))).toBe(
			"[776490_9jhpx] remote_copy: uploaded proj\r\n",
		)
	})
})
