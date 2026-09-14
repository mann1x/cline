/**
 * How the extension keeps itself current.
 *
 * Cerebriline is distributed as a `.vsix` from GitHub releases and through Open
 * VSX, not the VS Code Marketplace. VS Code auto-updates extensions it
 * installed from a *gallery* and nothing else, so a `.vsix` install is never
 * looked at again — which is why several versions of this extension once sat
 * unpacked side by side on one machine, each arriving by `--force` and none
 * superseding anything.
 *
 * The type lives here rather than beside the updater because the stored
 * settings registry reads it, and `shared` must not depend on `services`.
 */

export type UpdateChannel = "off" | "notify" | "auto"

/**
 * Notify, not auto.
 *
 * Replacing a running extension is not something to do to somebody without
 * asking, and an editor that restarts itself mid-task is worse than one that is
 * a version behind. Auto is there for whoever wants it.
 */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "notify"

/** Narrow whatever is stored, so an unknown value reads as the default. */
export function asUpdateChannel(value: unknown): UpdateChannel {
	return value === "off" || value === "auto" || value === "notify" ? value : DEFAULT_UPDATE_CHANNEL
}

function fields(version: string): number[] {
	// Tolerant on purpose. A tag may carry a leading `v`, and a local build may
	// carry a `-dev` suffix; neither changes which release is newer, and
	// refusing to parse one would disable the check on exactly the machines
	// that are furthest from the release.
	const core = version.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? ""
	return core.split(".").map((part) => {
		const parsed = Number.parseInt(part, 10)
		return Number.isFinite(parsed) ? parsed : 0
	})
}

/**
 * Negative when `a` is older, positive when newer, zero when the same.
 *
 * Here rather than beside the updater because the home-page banner needs it
 * too: it is handed the version the last check found, and that string outlives
 * the install it was about -- so "is there something newer" has to be asked
 * again at render time, not assumed from the field being non-empty.
 *
 * Field by field as numbers, never as text. `4.100.9` sorts after `4.100.115`
 * as a string, and a check that never fires is indistinguishable from a feature
 * nobody shipped.
 */
export function compareVersions(a: string, b: string): number {
	const left = fields(a)
	const right = fields(b)
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0)
		if (difference !== 0) {
			return difference
		}
	}
	return 0
}
