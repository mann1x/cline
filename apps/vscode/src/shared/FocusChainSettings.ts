/**
 * Legacy: the checklist's settings, kept only so state an older version saved
 * still loads and the proto field keeps its shape. Nothing reads them since
 * 4.100.292, when the task graph replaced the checklist and the switches for
 * both were removed; the board is always on.
 */
export interface FocusChainSettings {
	enabled: boolean
	remindClineInterval: number
	taskGraph?: boolean
}

export const DEFAULT_FOCUS_CHAIN_SETTINGS: FocusChainSettings = {
	enabled: true,
	remindClineInterval: 6,
	taskGraph: true,
}
