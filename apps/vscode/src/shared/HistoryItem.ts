export type HistoryItem = {
	id: string
	ulid?: string // ULID for better tracking and metrics
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number

	size?: number
	cwdOnTaskInitialization?: string
	conversationHistoryDeletedRange?: [number, number]
	isFavorited?: boolean

	modelId?: string
	/**
	 * Provider id the task ran on (from the SDK session record). Absent for
	 * tasks recorded before this field existed and for legacy imports —
	 * cost-display consumers treat an absent provider as "show", since
	 * there is nothing to key suppression on.
	 */
	apiProvider?: string
	isLegacy?: boolean

	/**
	 * What the session ran with, as label/value rows ready to display.
	 *
	 * Rendered on the host rather than carried raw, because deciding which
	 * settings are worth showing needs the shape of providers.json and the
	 * webview has no business knowing it. Empty for sessions recorded before
	 * the snapshot existed; the provider and model rows are still present,
	 * since those come from the session record itself.
	 */
	settings?: Array<{ label: string; value: string }>
}
