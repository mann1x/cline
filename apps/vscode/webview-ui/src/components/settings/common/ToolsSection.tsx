import { DEFAULT_READ_LIMIT_CHARS, SELECTABLE_TOOLS, SELECTABLE_TOOLS_TOTAL_TOKENS, TOOL_GROUPS } from "@shared/tool-selection"
import { useRef, useState } from "react"
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
 *
 * **Collapsed by default, and grouped when open.** Twelve switches and a
 * paragraph made this the longest thing in the API tab, ordered by price, so
 * finding one tool meant reading every label and the tool being toggled was
 * easy to mistake. The headings are what a reader is actually scanning for —
 * can this profile still write files — and the running total stays on the
 * collapsed header, because the price is the reason to open it.
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
	const [expanded, setExpanded] = useState(false)
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
	const offCount = SELECTABLE_TOOLS.length - offered.length
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
			<button
				aria-expanded={expanded}
				className="flex items-center gap-1 w-full bg-transparent border-0 p-0 cursor-pointer text-left text-foreground"
				onClick={() => setExpanded((open) => !open)}
				type="button">
				<span className={`codicon codicon-chevron-${expanded ? "down" : "right"} text-xs`} />
				<span className="text-xs font-medium text-foreground">Tools</span>
				{offCount > 0 && <span className="text-xs text-description">({offCount} off)</span>}
				{/* On the header rather than inside, because the price is the
				    reason to open the section at all. */}
				<span className="ml-auto text-xs text-description" data-testid="tools-section-total">
					{formatTokens(offeredTokens)} of {formatTokens(SELECTABLE_TOOLS_TOTAL_TOKENS)} tokens
				</span>
			</button>

			{expanded && (
				<>
					<p className="text-xs mt-[8px] mb-[10px] text-(--vscode-descriptionForeground)">
						Every tool offered here is sent with every request, whatever the model does with it, and no compaction can
						reclaim those tokens. On a small window that fixed price is worth spending deliberately. Tools that exist
						only when something else is configured — image generation, skills, delegation — are governed by that
						setting instead, and MCP servers are switched per server in the MCP panel.
					</p>

					{TOOL_GROUPS.map((group) => {
						const inGroup = SELECTABLE_TOOLS.filter((tool) => tool.group === group.id)
						// A group that has lost its last tool prints nothing
						// rather than an empty heading.
						if (inGroup.length === 0) {
							return null
						}
						const groupTotal = inGroup.reduce((total, tool) => total + tool.tokens, 0)
						const groupOffered = inGroup
							.filter((tool) => !disabled.has(tool.name))
							.reduce((total, tool) => total + tool.tokens, 0)
						return (
							<div className="mt-[14px]" key={group.id}>
								<div className="flex items-center justify-between w-full">
									<Label className="text-xs font-medium uppercase tracking-wider text-description">
										{group.label}
									</Label>
									<span className="text-xs text-description" data-testid={`tool-group-total-${group.id}`}>
										{formatTokens(groupOffered)} of {formatTokens(groupTotal)}
									</span>
								</div>
								<p className="text-xs mt-[2px] mb-[6px] text-description">{group.summary}</p>
								{inGroup.map((tool, index) => (
									// Striped, because the switch is at the far
									// right of a row whose label is at the far
									// left: with twelve of them and a summary
									// line each, the eye loses which row it is
									// on somewhere in the middle. Banded per
									// group so a group's first row always reads
									// as the unshaded one.
									<div
										className={`flex flex-col gap-1 px-[6px] py-[5px] rounded-sm ${
											index % 2 === 1 ? "bg-(--vscode-textBlockQuote-background)" : ""
										}`}
										data-testid={`tool-row-${tool.name}`}
										key={tool.name}>
										<div className="flex items-center justify-between w-full">
											<Label className="text-xs font-medium text-foreground" htmlFor={`tool-${tool.name}`}>
												<code>{tool.label}</code>
												<span className="ml-[6px] font-normal text-description">
													{formatTokens(tool.tokens)}
												</span>
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
							</div>
						)
					})}

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
							A read past the size below is refused with the number of lines that would fit, instead of being
							returned cut short. A tool result is re-sent on every later request, so one oversized read is paid for
							by the rest of the run — but a model that paginates on its own does not need to be made to, and for
							those the refusal only costs a turn. Off, an oversized read comes back truncated as it did before.
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
				</>
			)}
		</div>
	)
}

export default ToolsSection
