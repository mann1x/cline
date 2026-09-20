import { useRef } from "react"
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

/**
 * Parse a typed number, treating an empty field as "not set" rather than zero.
 *
 * `Number("")` is 0, so the empty check has to come first: without it an
 * emptied field stored a configured zero, and zero is a real setting for three
 * of these -- it is how "off" is spelled for the prefill cap.
 */
function parseNumber(value: string | number | undefined): number | undefined {
	if (value === undefined || (typeof value === "string" && value.trim() === "")) {
		return undefined
	}
	const parsed = typeof value === "string" ? Number(value) : value
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export const PolykvSection = ({ providerId }: { providerId: string }) => {
	const { config, write } = useProviderConfig(providerId as never)
	// What this panel has sent and not yet seen answered.
	//
	// The section is written whole, so every write is only as correct as the
	// section it was composed from -- and the panel does not see its own write
	// until the host answers. Two controls touched inside that window both
	// composed from the pre-write section, and the second write put the first
	// one's field back: reported as a PolyKV switch that would not stay off,
	// with four whole-section writes in twenty seconds in the host log and the
	// switch on again at the end. Composing from what was last sent, and
	// drawing from it too, makes the panel's own writes the thing it builds on.
	const pending = useRef<PolykvSettings | undefined>(undefined)
	const inFlight = useRef(0)
	// Same reason the cap fields wait: rendering before the provider config
	// resolves would show defaults over what is stored.
	if (config === undefined) {
		return null
	}
	const polykv: PolykvSettings = pending.current ?? config.polykv ?? {}
	const enabled = polykv.enabled !== false

	// Returns the write, so a field flushed at a boundary can be awaited.
	const patch = (changes: Record<string, unknown>) => {
		// Read at call time, not from the render this closure was made in: two
		// clicks inside one round trip share a closure, so a section captured at
		// render is the stale one by the second of them.
		const next = { ...(pending.current ?? config.polykv ?? {}), ...changes } as PolykvSettings
		pending.current = next
		inFlight.current += 1
		return write({ polykv: next })
			.catch((error) => console.error("Failed to update PolyKV settings:", error))
			.finally(() => {
				inFlight.current -= 1
				// Only the last answer hands the section back to the config: an
				// earlier one landing first would drop everything typed since.
				if (inFlight.current === 0) {
					pending.current = undefined
				}
			})
	}

	const numberField = (key: string, label: string, placeholder: string, description: string) => (
		<div className="mb-[5px]" key={key}>
			<DebouncedTextField
				initialValue={polykv[key as keyof typeof polykv] !== undefined ? String(polykv[key as keyof typeof polykv]) : ""}
				numeric
				onChange={(value) => {
					const next = parseNumber(value)
					if (next === polykv[key as keyof typeof polykv]) {
						return
					}
					return patch({ [key]: next })
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
					{toggle(
						"swarm",
						"Allow swarms",
						"Lets the model fan a task out across several agents that share a snapshot of this session's context and report one merged digest. Off by default: a swarm spends several agents' worth of tokens on a single turn.",
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
