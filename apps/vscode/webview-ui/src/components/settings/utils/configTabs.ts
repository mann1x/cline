import type { Mode } from "@shared/storage/types"

/**
 * The tabs the API configuration section can show.
 *
 * `plan` and `act` are the session's own model. The rest are scoped tabs, each
 * configuring a model or endpoint used for one particular job.
 */
export type ConfigTab = Mode | "vision" | "agents" | "escalation" | "imagegen"

/** The tabs that are not the session's model. */
export const SCOPED_TABS = ["vision", "agents", "escalation", "imagegen"] as const

/**
 * Is this tab the session's own model, rather than one of the scoped tabs?
 *
 * Asked in two places that must agree: whether to show the "Use a different
 * model for ..." toggles, and whether the Model tab button is the selected one.
 * They were written out longhand twice and drifted -- the button's copy omitted
 * `imagegen`, so standing on the Images tab rendered the Model button as both
 * selected and disabled, and there was no way back to Model without leaving the
 * section entirely.
 *
 * It is a type predicate, not a plain boolean: the code guarded by it passes
 * `activeTab` where a `Mode` is required, and narrowing is what made the longhand
 * comparisons safe there. Returning `boolean` compiles everywhere except that one
 * call, which only the webview's own `tsc -b` checks.
 */
export function isModelTab(activeTab: ConfigTab): activeTab is Mode {
	return !(SCOPED_TABS as readonly string[]).includes(activeTab)
}
