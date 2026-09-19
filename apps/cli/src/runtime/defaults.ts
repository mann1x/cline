/**
 * Default loop detection thresholds for the CLI.
 * The agent core leaves loop detection off by default;
 * the CLI enables it with these settings.
 */
export const CLI_DEFAULT_LOOP_DETECTION = {
	softThreshold: 3,
	hardThreshold: 5,
} as const;

/**
 * Default checkpoint configuration for the CLI.
 * Core leaves checkpoints disabled by default (opt-in);
 * the CLI enables them so every run gets a restorable git snapshot.
 */
export const CLI_DEFAULT_CHECKPOINT_CONFIG = {
	enabled: true,
} as const;

/**
 * The CLI's Checkpoints switch, which is the extension's.
 *
 * The switch now owns more than the git snapshot: it also decides whether the
 * session keeps a file revision log, offers `restore_file`, and appends the
 * tool ledger to each compaction summary. That made the CLI's lack of an off
 * switch a real divergence rather than a missing convenience -- the extension
 * could turn the machinery off and the CLI could not.
 *
 * Default on, because the extension's default is on: "if enabled on Plugin by
 * default it's the same for CLI unless disabled."
 */
export function resolveCliCheckpointConfig(
	options:
		| {
				checkpoints?: boolean;
		  }
		| undefined,
): { enabled: boolean } {
	return { enabled: options?.checkpoints !== false };
}
