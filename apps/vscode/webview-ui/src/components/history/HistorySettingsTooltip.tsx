import type { HistoryItem } from "@shared/HistoryItem"

/**
 * How long the pointer has to rest on a row before its settings appear.
 *
 * Long on purpose. The list is scanned far more often than it is interrogated,
 * and a card that opens while the eye is still travelling is noise on every
 * row but the one wanted. Two seconds is past the point where resting on a row
 * is accidental.
 */
export const HISTORY_SETTINGS_HOVER_DELAY_MS = 2000

/**
 * What a session ran with, as a definition list.
 *
 * The rows arrive already chosen and formatted (`describeSessionSettings` on
 * the host) because deciding which settings are worth showing needs the shape
 * of providers.json. Here they are only laid out.
 */
export const HistorySettingsTooltip = ({ settings }: { settings: HistoryItem["settings"] }) => {
	if (!settings || settings.length === 0) {
		return null
	}
	return (
		<div className="flex flex-col gap-0.5">
			{settings.map((row) => (
				<div className="flex gap-3 justify-between items-baseline" key={row.label}>
					<span className="text-description shrink-0">{row.label}</span>
					<span className="text-right break-all font-mono text-[0.95em]">{row.value}</span>
				</div>
			))}
		</div>
	)
}
