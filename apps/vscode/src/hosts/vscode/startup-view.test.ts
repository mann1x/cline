import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"
import { StartupView } from "./startup-view"

function fakeView() {
	const view = {
		webview: { html: "", options: {}, onDidReceiveMessage: () => ({ dispose() {} }) },
		onDidDispose: () => ({ dispose() {} }),
	}
	return view as unknown as vscode.WebviewView & { webview: { html: string } }
}

const context = {} as vscode.WebviewViewResolveContext
const token = {} as vscode.CancellationToken
const logs = () => ["/home/u/.cerebriline/data/logs/extension.log"]

describe("the sidebar while the extension starts (#112)", () => {
	let gate: StartupView

	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		gate.dispose()
		vi.useRealTimers()
	})

	it("resolves the view at once instead of leaving it blank", () => {
		gate = new StartupView(logs)
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		expect(view.webview.html).toContain("Cerebriline is starting")
	})

	it("hands the view to the real provider when start-up finishes", async () => {
		gate = new StartupView(logs)
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		const real = { resolveWebviewView: vi.fn() }
		await gate.ready(real)
		expect(real.resolveWebviewView).toHaveBeenCalledWith(view, context, token)
	})

	it("passes a later resolve straight to the real provider", async () => {
		gate = new StartupView(logs)
		const real = { resolveWebviewView: vi.fn() }
		await gate.ready(real)
		expect(real.resolveWebviewView).not.toHaveBeenCalled()
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		expect(real.resolveWebviewView).toHaveBeenCalledWith(view, context, token)
		expect(view.webview.html).toBe("")
	})

	it("shows a failed start-up, its step, the error and the log", () => {
		gate = new StartupView(logs)
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		gate.setStep("reading settings")
		vi.spyOn(console, "error").mockImplementation(() => {})
		gate.fail(new Error("EACCES <globalState.json>"))
		expect(view.webview.html).toContain("could not start")
		expect(view.webview.html).toContain("while reading settings")
		expect(view.webview.html).toContain("EACCES &lt;globalState.json&gt;")
		expect(view.webview.html).toContain("/home/u/.cerebriline/data/logs/extension.log")
		expect(view.webview.html).toContain('id="reload"')
	})

	it("shows a failure that came before the view was opened", () => {
		gate = new StartupView(logs)
		vi.spyOn(console, "error").mockImplementation(() => {})
		gate.fail(new Error("boom"))
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		expect(view.webview.html).toContain("could not start")
	})

	it("says where a stalled start-up is waiting", () => {
		gate = new StartupView(logs, 20_000)
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		gate.setStep("copying VS Code storage to the data folder")
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.advanceTimersByTime(20_000)
		expect(view.webview.html).toContain("still starting")
		expect(view.webview.html).toContain("copying VS Code storage to the data folder")
		gate.setStep("reading settings")
		expect(view.webview.html).toContain("at: reading settings")
	})

	it("does not report a stall once the real provider has the view", async () => {
		gate = new StartupView(logs, 20_000)
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		await gate.ready({ resolveWebviewView: vi.fn() })
		vi.advanceTimersByTime(30_000)
		expect(view.webview.html).not.toContain("still starting")
	})

	it("shows the error when the real provider fails to take the view", async () => {
		gate = new StartupView(logs)
		const view = fakeView()
		gate.resolveWebviewView(view, context, token)
		vi.spyOn(console, "error").mockImplementation(() => {})
		await gate.ready({
			resolveWebviewView: () => Promise.reject(new Error("no webview html")),
		})
		expect(view.webview.html).toContain("no webview html")
	})
})
