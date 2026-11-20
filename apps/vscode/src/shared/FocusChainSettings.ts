export interface FocusChainSettings {
	// Enable/disable the focus chain feature
	enabled: boolean
	// Interval (in messages) to remind Cerebriline about focus chain
	remindClineInterval: number
	// The task graph (task_plan / task_update / task_view) in place of the
	// checklist. A preview, off by default until the switch-over.
	taskGraph?: boolean
}

export const DEFAULT_FOCUS_CHAIN_SETTINGS: FocusChainSettings = {
	enabled: true,
	remindClineInterval: 6,
	taskGraph: false,
}
