import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { DebouncedTextField } from "./DebouncedTextField"
import { PolykvStatusStrip } from "./PolykvStatusStrip"

/**
 * opencoti's PolyKV control plane, as one section with one switch.
 *
 * PolyKV is a tree of KV pools: a pool owns a token range and shares everything
 * before it with its parent, so the part of an agent's context that never
 * changes — the system prompt and the tool schemas — is prefilled once, pinned,
 * and attached by every later request instead of being re-sent. The rest of
 * what is here is the admission policy the engine enforces on this profile's
 * behalf, and how this client behaves when the engine says no.
 *
 * All of it hides behind the switch because none of it means anything to a
 * server without a pool tree, and most of it is a number nobody should have to
 * see to use the provider. The switch is read as off only when it says so: a
 * profile written before this section existed carries nothing, and treating
 * that as "disabled" would take pooling away from sessions that already had it.
 */

type PolykvSettings = NonNullable<NonNullable<ReturnType<typeof useProviderConfig>["config"]>["polykv"]>

/** Parse a typed number, treating an empty field as "not set" rather than zero. */
function parseNumber(value: string | number | undefined): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export const PolykvSection = ({ providerId }: { providerId: string }) => {
	const { config, write } = useProviderConfig(providerId as never)
	// Same reason the cap fields wait: the debounced inputs fire onChange for
	// their initial value shortly after mount, so rendering before the provider
	// config resolves would persist a blank over what is stored.
	if (config === undefined) {
		return null
	}
	const polykv: PolykvSettings = config.polykv ?? {}
	const enabled = polykv.enabled !== false

	// The section is written whole, never merged: the panel owns it and shows
	// the complete state, and a merge would make turning a knob back off
	// impossible.
	const patch = (changes: Record<string, unknown>) => {
		void write({ polykv: { ...polykv, ...changes } }).catch((error) =>
			console.error("Failed to update PolyKV settings:", error),
		)
	}

	const numberField = (key: string, label: string, placeholder: string, description: string) => (
		<div className="mb-[5px]" key={key}>
			<DebouncedTextField
				initialValue={polykv[key as keyof typeof polykv] !== undefined ? String(polykv[key as keyof typeof polykv]) : ""}
				onChange={(value) => {
					const next = parseNumber(value)
					if (next === polykv[key as keyof typeof polykv]) {
						return
					}
					patch({ [key]: next })
				}}
				placeholder={placeholder}
				style={{ width: "100%" }}>
				<span className="font-semibold">{label}</span>
			</DebouncedTextField>
			<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">{description}</p>
		</div>
	)

	const toggle = (key: string, label: string, description: string, defaultOn = false) => (
		<div className="flex flex-col gap-1 mb-[5px]" key={key}>
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor={`polykv-${key}`}>
					{label}
				</Label>
				<Switch
					checked={(polykv[key as keyof typeof polykv] as boolean | undefined) ?? defaultOn}
					className="shrink-0"
					id={`polykv-${key}`}
					onCheckedChange={(checked) => patch({ [key]: checked })}
					size="default"
				/>
			</div>
			<p className="text-xs mt-0 mb-0 text-description">{description}</p>
		</div>
	)

	return (
		<div className="mb-[5px] border-t border-(--vscode-panel-border) pt-[10px]">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor="polykv-enabled">
					PolyKV
				</Label>
				<Switch
					checked={enabled}
					className="shrink-0"
					id="polykv-enabled"
					onCheckedChange={(checked) => patch({ enabled: checked })}
					size="default"
				/>
			</div>
			<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
				Pins the system prompt and tool schemas on the server so every turn attaches to them instead of re-sending them,
				and lets the engine decide how many agents may run at once against real KV headroom. Needs a server started with{" "}
				<code>--polykv-max-pools</code>.
			</p>

			{enabled && (
				<div className="mt-[10px] pl-[10px] border-l border-(--vscode-panel-border)">
					{toggle(
						"pinPrefix",
						"Keep the prefix resident",
						"An unpinned pool that goes 60 seconds without a request is swept, and the next turn quietly pays the full prefill again.",
						true,
					)}
					{numberField(
						"compactionPressureThreshold",
						"Compact at pool pressure",
						"Default: 0.85",
						"How full the engine must say the pool is before compacting, 0 to 1. This is the one figure in the compaction path that is measured rather than estimated — it comes from the thing holding the cells.",
					)}
					{numberField(
						"targetTpsPerSession",
						"Per-session throughput floor",
						"Default: the engine's",
						"Tokens per second the engine protects for each session. A new session that would push the projected mean below this is refused rather than admitted, which is what stops one more agent making every agent slow.",
					)}
					{numberField(
						"guaranteeMinSessions",
						"Always admit at least",
						"Default: 1",
						"Sessions admitted regardless of the floor, so a busy pool can never refuse everything.",
					)}
					{numberField(
						"maxRetryAfterMs",
						"Wait at most (ms)",
						"Default: none",
						"The longest Retry-After this client honours before giving up. The engine says when to come back; this is the point past which waiting stops being better than failing.",
					)}
					{numberField(
						"prefillMaxSlots",
						"Slots kept for prefill",
						"Default: 0 (off)",
						"Caps how many slots may be prefilling at once. Prompt processing is what stands between a new session and its first token, so a backlog here looks like the pool being full when it is not.",
					)}
					{toggle(
						"overcommit",
						"Bypass admission",
						"Sends every request past the admission gate. The engine stops protecting the throughput floor, so sessions can make each other slow — deliberate, and visible here rather than silent.",
					)}
					{/* What the configured server is actually doing, read once.
					    It answers the question every field above raises — did
					    any of this take effect — which no amount of settings
					    copy can. */}
					<PolykvStatusStrip providerId={providerId} />
				</div>
			)}
		</div>
	)
}

export default PolykvSection
