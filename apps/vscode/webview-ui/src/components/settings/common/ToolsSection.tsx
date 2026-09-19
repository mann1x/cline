import { DEFAULT_READ_LIMIT_CHARS, SELECTABLE_TOOLS, SELECTABLE_TOOLS_TOTAL_TOKENS } from "@shared/tool-selection"
import { useRef } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { DebouncedTextField } from "./DebouncedTextField"

/**
 * Which tools this configuration brings into a session.
 *
 * The schemas are a fixed price. They are serialized into every request before
 * a single message exists, and compaction cannot touch one token of them —
 * measured on a 65,536-token window, the system prompt and the schemas ran
 * 21,000–24,000 tokens, about a third of the window gone before the
 * conversation starts. Dropping a tool is the only thing that buys that room
 * back, which is why the price is printed beside each one.
 *
 * Per configuration and not global, because the answer depends on the window:
 * a profile pointed at a small local model and one pointed at a 400k cloud
 * model want opposite selections, and only the profile knows which is which.
 *
 * A deny list underneath: what the profile stores is what it withholds, so a
 * tool added in a later release arrives switched on rather than silently
 * missing from every profile written before it existed.
 */

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

/** The section as it goes to the store: written whole, every time. */
interface ToolsPatch {
	disabled: string[]
	readLimitEnabled?: boolean
	readLimitChars?: number
}

export const ToolsSection = ({ providerId }: { providerId: string }) => {
	const { config, write } = useProviderConfig(providerId as never)
	// What this panel has sent and not yet seen answered. The list is written
	// whole, so two switches flipped inside one round trip would otherwise both
	// compose from the pre-write list and the second would undo the first —
	// the same fault the PolyKV section documents at length.
	//
	// The whole section, not just the list: it is written whole, so a write
	// that carried only the switch would clear the read limit and a write that
	// carried only the read limit would put every tool back.
	const pending = useRef<ToolsPatch | undefined>(undefined)
	const inFlight = useRef(0)
	// Rendering before the provider config resolves would show every tool on
	// over a profile that has switched three of them off.
	if (config === undefined) {
		return null
	}

	// Read at call time, never captured at render: two changes inside one round
	// trip share a closure, and what render saw is the stale copy by the second.
	const current = (): ToolsPatch =>
		pending.current ?? {
			disabled: [...(config.tools?.disabled ?? [])],
			...(config.tools?.readLimitEnabled === false ? { readLimitEnabled: false } : {}),
			...(config.tools?.readLimitChars !== undefined ? { readLimitChars: config.tools.readLimitChars } : {}),
		}

	const section = current()
	const disabled = new Set(section.disabled)
	const offered = SELECTABLE_TOOLS.filter((tool) => !disabled.has(tool.name))
	const offeredTokens = offered.reduce((total, tool) => total + tool.tokens, 0)
	const readLimitOn = section.readLimitEnabled !== false

	const writeTools = (next: ToolsPatch) => {
		pending.current = next
		inFlight.current += 1
		void write({ tools: next })
			.catch((error) => console.error("Failed to update the tool selection:", error))
			.finally(() => {
				inFlight.current -= 1
				// Only the last answer hands the section back to the config: an
				// earlier one landing first would drop everything changed since.
				if (inFlight.current === 0) {
					pending.current = undefined
				}
			})
	}

	const setDisabled = (name: string, isDisabled: boolean) => {
		const next = new Set(current().disabled)
		if (isDisabled) {
			next.add(name)
		} else {
			next.delete(name)
		}
		writeTools({ ...current(), disabled: [...next].sort() })
	}

	const setReadLimitEnabled = (enabled: boolean) => {
		const { readLimitEnabled: _was, ...rest } = current()
		writeTools(enabled ? rest : { ...rest, readLimitEnabled: false })
	}

	const setReadLimitChars = (value: string) => {
		const parsed = Number.parseInt(value, 10)
		const { readLimitChars: _was, ...rest } = current()
		// Blank means the default, which is the only way to get back to it once
		// a number has been typed — so an unparseable value clears rather than
		// being stored or silently ignored.
		writeTools(Number.isFinite(parsed) && parsed > 0 ? { ...rest, readLimitChars: parsed } : rest)
	}

	return (
		<div className="mb-[5px] border-t border-(--vscode-panel-border) pt-[10px]">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground">Tools</Label>
				<span className="text-xs text-description" data-testid="tools-section-total">
					{formatTokens(offeredTokens)} of {formatTokens(SELECTABLE_TOOLS_TOTAL_TOKENS)} tokens
				</span>
			</div>
			<p className="text-xs mt-[5px] mb-[10px] text-(--vscode-descriptionForeground)">
				Every tool offered here is sent with every request, whatever the model does with it, and no compaction can reclaim
				those tokens. On a small window that fixed price is worth spending deliberately. Tools that exist only when
				something else is configured — image generation, skills, delegation — are governed by that setting instead, and
				MCP servers are switched per server in the MCP panel.
			</p>

			{SELECTABLE_TOOLS.map((tool) => (
				<div className="flex flex-col gap-1 mb-[8px]" key={tool.name}>
					<div className="flex items-center justify-between w-full">
						<Label className="text-xs font-medium text-foreground" htmlFor={`tool-${tool.name}`}>
							<code>{tool.label}</code>
							<span className="ml-[6px] font-normal text-description">{formatTokens(tool.tokens)}</span>
						</Label>
						<Switch
							checked={!disabled.has(tool.name)}
							className="shrink-0"
							id={`tool-${tool.name}`}
							onCheckedChange={(checked) => setDisabled(tool.name, !checked)}
							size="default"
						/>
					</div>
					<p className="text-xs mt-0 mb-0 text-description">{tool.summary}</p>
				</div>
			))}

			<div className="flex flex-col gap-1 mt-[14px] pt-[10px] border-t border-(--vscode-panel-border)">
				<div className="flex items-center justify-between w-full">
					<Label className="text-xs font-medium text-foreground" htmlFor="tool-read-limit">
						Refuse oversized reads
					</Label>
					<Switch
						checked={readLimitOn}
						className="shrink-0"
						id="tool-read-limit"
						onCheckedChange={setReadLimitEnabled}
						size="default"
					/>
				</div>
				<p className="text-xs mt-0 mb-[6px] text-description">
					A read past the size below is refused with the number of lines that would fit, instead of being returned cut
					short. A tool result is re-sent on every later request, so one oversized read is paid for by the rest of the
					run — but a model that paginates on its own does not need to be made to, and for those the refusal only costs
					a turn. Off, an oversized read comes back truncated as it did before.
				</p>
				{readLimitOn && (
					<DebouncedTextField
						initialValue={section.readLimitChars ? String(section.readLimitChars) : ""}
						numeric
						onChange={setReadLimitChars}
						placeholder={`Default: ${DEFAULT_READ_LIMIT_CHARS}`}
						style={{ width: "100%" }}>
						<span className="text-xs font-medium">Read size limit (characters)</span>
					</DebouncedTextField>
				)}
			</div>
		</div>
	)
}

export default ToolsSection
