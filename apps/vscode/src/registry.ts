import { name, publisher, version } from "../package.json"
import { HostProvider } from "./hosts/host-provider"

/**
 * The namespace every contribution of this extension lives under: command IDs,
 * context keys, the settings section, and the sidebar view ID.
 *
 * It is derived from the manifest `name` rather than written out, so the
 * manifest is the single place the identity is decided. Anything that spells
 * the namespace out a second time -- a `setContext` call, a
 * `getConfiguration()` section -- silently stops matching package.json the
 * moment the name changes, and VS Code reports nothing: the command is simply
 * never found and the menu item never appears. Import this instead.
 */
export const ID_PREFIX = name

/** The settings section, i.e. what `getConfiguration()` is called with. */
export const CONFIG_SECTION = ID_PREFIX

const prefix = ID_PREFIX

/**
 * List of commands with the name of the extension they are registered under.
 * These should match the command IDs defined in package.json, which they do by
 * construction: both sides are the manifest `name` plus the suffix.
 */
const ClineCommands = {
	PlusButton: prefix + ".plusButtonClicked",
	McpButton: prefix + ".mcpButtonClicked",
	MarketplaceButton: prefix + ".marketplaceButtonClicked",
	SettingsButton: prefix + ".settingsButtonClicked",
	HistoryButton: prefix + ".historyButtonClicked",
	AccountButton: prefix + ".accountButtonClicked",
	WorktreesButton: prefix + ".worktreesButtonClicked",
	TerminalOutput: prefix + ".addTerminalOutputToChat",
	AddToChat: prefix + ".addToChat",
	FixWithCline: prefix + ".fixWithCline",
	ExplainCode: prefix + ".explainCode",
	ImproveCode: prefix + ".improveCode",
	FocusChatInput: prefix + ".focusChatInput",
	Walkthrough: prefix + ".openWalkthrough",
	GenerateCommit: prefix + ".generateGitCommitMessage",
	AbortCommit: prefix + ".abortGitCommitMessage",
	// Jupyter Notebook commands
	JupyterGenerateCell: prefix + ".jupyterGenerateCell",
	JupyterExplainCell: prefix + ".jupyterExplainCell",
	JupyterImproveCell: prefix + ".jupyterImproveCell",
}

/**
 * IDs for the views registered by the extension.
 * These should match the name + view IDs defined in package.json.
 */
const ClineViewIds = {
	Sidebar: prefix + ".SidebarProvider",
}

/** The `contributes.walkthroughs[].id` this extension declares. */
const WALKTHROUGH_ID = "CerebrilineWalkthrough"

/**
 * `when`-clause context keys set with `setContext`. Must match the `when`
 * expressions in package.json.
 */
const ClineContextKeys = {
	DevMode: prefix + ".isDevMode",
	GeneratingCommit: prefix + ".isGeneratingCommit",
}

/**
 * The registry info for the extension, including its ID, name, version, commands, and views
 * registered for the current host.
 */
export const ExtensionRegistryInfo = {
	id: publisher + "." + name,
	name,
	version,
	publisher,
	commands: ClineCommands,
	views: ClineViewIds,
	contextKeys: ClineContextKeys,
	/** What `workbench.action.openWalkthrough` takes: `<publisher>.<name>#<id>`. */
	walkthrough: publisher + "." + name + "#" + WALKTHROUGH_ID,
	configSection: CONFIG_SECTION,
}

export interface HostInfo {
	/**
	 * The name of the host platform, e.g VSCode, IntelliJ Ultimate Edition, etc.
	 */
	platform: string
	/**
	 * The operating system platform, e.g. linux, darwin, win32
	 */
	os: string
	/**
	 * The type of the cline host environment, e.g. 'VSCode Extension', 'Cline for JetBrains', 'CLI'
	 * This is different from the platform because there are many JetBrains IDEs, but they all use the same
	 * plugin.
	 */
	ide: string
	/**
	 * A distinct ID for this installation of the host client
	 */
	distinctId: string
	/**
	 * The version of the host platform, e.g. 1.103.0 for VSCode, or 2025.1.1.1 for JetBrains IDEs.
	 */
	hostVersion?: string
	/**
	 * The version of Cline that the host client is running
	 */
	extensionVersion: string
}

let hostInfo = null as HostInfo | null

export const HostRegistryInfo = {
	init: async (distinctId: string) => {
		const host = await HostProvider.env.getHostVersion({})
		const hostVersion = host.version
		const extensionVersion = host.clineVersion || ExtensionRegistryInfo.version
		const platform = host.platform || "unknown"
		const os = process.platform || "unknown"
		const ide = host.clineType || "unknown"
		hostInfo = { hostVersion, extensionVersion, platform, os, ide, distinctId }
	},
	get: () => hostInfo,
}
