export interface AutoApprovalSettings {
	// Version for race condition prevention (incremented on every change)
	version: number
	// Legacy field - kept for backward compatibility with older extension versions
	// Auto-approve is now always enabled by default
	enabled: boolean
	// Legacy field - kept for backward compatibility with older extension versions
	// Favorites feature has been removed
	favorites: string[]
	// Legacy field - kept for backward compatibility with older extension versions
	// Max requests limit feature has been removed
	maxRequests: number
	// Individual action permissions
	actions: {
		readFiles: boolean // Read files and directories
		readFilesExternally?: boolean // Legacy field - kept for backward compatibility with older extension versions
		editFiles: boolean // Edit files
		editFilesExternally?: boolean // Legacy field - kept for backward compatibility with older extension versions
		executeSafeCommands?: boolean // Execute commands
		executeAllCommands?: boolean // Legacy field - kept for backward compatibility with older extension versions
		useBrowser: boolean // Fetch web content
		// Drive a real browser. Separate from useBrowser because the two are not
		// the same risk: fetching a URL returns text, while this launches a
		// browser process that executes whatever the page contains. Someone can
		// reasonably want the first without approval and the second with it.
		// Optional, so settings written before this existed still parse; the
		// policy falls back to useBrowser when it is absent.
		useBrowserTool?: boolean
		useMcp: boolean // Use MCP servers
	}
	// Global settings
	enableNotifications: boolean // Show notifications for approval and task completion
}

export const DEFAULT_AUTO_APPROVAL_SETTINGS: AutoApprovalSettings = {
	version: 1,
	enabled: true, // Legacy field - always true by default
	favorites: [], // Legacy field - kept as empty array
	maxRequests: 20, // Legacy field - kept for backward compatibility
	actions: {
		readFiles: true,
		readFilesExternally: true,
		editFiles: true,
		editFilesExternally: true,
		executeSafeCommands: false,
		executeAllCommands: true,
		useBrowser: true,
		useBrowserTool: true,
		useMcp: true,
	},
	enableNotifications: false,
}
