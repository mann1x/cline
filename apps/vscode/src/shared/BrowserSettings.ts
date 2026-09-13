export interface BrowserSettings {
	// Viewport size settings
	viewport: {
		width: number
		height: number
	}
	// Chrome installation to use
	// chromeType: "chromium" | "system"
	remoteBrowserHost?: string
	remoteBrowserEnabled?: boolean
	chromeExecutablePath?: string
	disableToolUse?: boolean
	customArgs?: string
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
	viewport: {
		width: 900,
		height: 600,
	},
	remoteBrowserEnabled: false,
	remoteBrowserHost: "http://localhost:9222",
	chromeExecutablePath: "", // Changed from undefined to empty string
	// chromeType: "chromium",
	// Read by nobody since the SDK migration removed `browser_action`, and left
	// at upstream's value so the diff stays small. The `browser` tool answers to
	// `cline.browserTool` instead — see `hosts/vscode/browser-support.ts` for
	// why this flag could not be reused.
	disableToolUse: true,
	customArgs: "",
}

export const BROWSER_VIEWPORT_PRESETS = {
	"Large Desktop (1280x800)": { width: 1280, height: 800 },
	"Small Desktop (900x600)": { width: 900, height: 600 },
	"Tablet (768x1024)": { width: 768, height: 1024 },
	"Mobile (360x640)": { width: 360, height: 640 },
} as const
