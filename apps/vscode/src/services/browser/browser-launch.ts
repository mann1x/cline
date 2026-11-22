/**
 * The launch chain lives in `@cline/core` (extensions/browser/browser-launch.ts),
 * shared with the SDK's own driver. Re-exported here for the extension's
 * `BrowserSession` and its tests.
 */
export {
	BrowserLaunchError,
	browserLabel,
	type LaunchCandidate,
	type LaunchOutcome,
	type LaunchWithFallbackOptions,
	launchWithFallback,
	readUpdateState,
	stagedUpdatePath,
	type UpdateEvidence,
	updateEvidence,
} from "@cline/core"
