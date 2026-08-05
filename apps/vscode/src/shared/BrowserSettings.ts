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
	// On by default. Upstream shipped this off because its `browser_action`
	// was heavyweight and on the way out; here the tool is the point — a model
	// that has to be configured before it can check its own page will go on
	// asking the user whether the page works.
	disableToolUse: false,
	customArgs: "",
}

export const BROWSER_VIEWPORT_PRESETS = {
	"Large Desktop (1280x800)": { width: 1280, height: 800 },
	"Small Desktop (900x600)": { width: 900, height: 600 },
	"Tablet (768x1024)": { width: 768, height: 1024 },
	"Mobile (360x640)": { width: 360, height: 640 },
} as const
