import "@testing-library/jest-dom"
import { vi } from "vitest"

// "Official" jest workaround for mocking window.matchMedia()
// https://jestjs.io/docs/manual-mocks#mocking-methods-which-are-not-implemented-in-jsdom

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(), // Deprecated
		removeListener: vi.fn(), // Deprecated
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
})

// Same shape of gap as matchMedia above: jsdom implements no ResizeObserver, and
// Radix measures its own track with one. Without this a component that renders a
// Slider throws during the commit phase — which surfaces as an unhandled error
// in whichever test happened to be running, not as a failure pointing at the
// slider. The real webview has it; only the test DOM does not.
vi.stubGlobal(
	"ResizeObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
)

// Mock VSCode API for webview tests
vi.stubGlobal("acquireVsCodeApi", () => ({
	postMessage: vi.fn(),
	getState: vi.fn(),
	setState: vi.fn(),
}))
