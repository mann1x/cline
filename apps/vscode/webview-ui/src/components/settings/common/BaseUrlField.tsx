import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useDebouncedInput } from "../utils/useDebouncedInput"
import { describeRemote, isLoopbackUrl, urlPort } from "./loopbackOnRemote"

/**
 * Props for the BaseUrlField component
 */
interface BaseUrlFieldProps {
	initialValue: string | undefined
	onChange: (value: string) => void
	/** Clears the persisted value. Reject to restore the authoritative enabled state. */
	onClear?: () => Promise<void>
	defaultValue?: string
	label?: string
	placeholder?: string
	disabled?: boolean
	showLockIcon?: boolean
}

/**
 * A reusable component for toggling and entering custom base URLs
 */
export const BaseUrlField = ({
	initialValue,
	onChange,
	onClear,
	defaultValue,
	label = "Use custom base URL",
	placeholder = "Default: https://api.example.com",
	disabled = false,
	showLockIcon = false,
}: BaseUrlFieldProps) => {
	const [isEnabled, setIsEnabled] = useState(!!initialValue)
	const [isClearing, setIsClearing] = useState(false)
	const userToggledRef = useRef(false)
	const [localValue, setLocalValue, syncLocalValue] = useDebouncedInput(initialValue || "", (value: string) =>
		onChange(value.trim()),
	)
	const { remoteName } = useExtensionState()
	const effectiveUrl = isEnabled && localValue.trim() ? localValue : defaultValue
	const loopbackOnRemote = !!remoteName && isLoopbackUrl(effectiveUrl)

	// Provider config loads asynchronously, so a saved base URL usually arrives
	// after mount (initialValue starts undefined). Reflect it in the checkbox
	// once it lands, unless the user has already toggled the box themselves.
	useEffect(() => {
		if (!userToggledRef.current) {
			setIsEnabled(!!initialValue)
		}
	}, [initialValue])

	const handleToggle = (e: any) => {
		const checked = e.target.checked === true
		userToggledRef.current = true
		setIsEnabled(checked)
		if (!checked) {
			// Cancel any pending debounced edit before starting the clear. Otherwise
			// its timer or unmount cleanup could restore the non-empty URL while the
			// clear write is in flight.
			syncLocalValue("")
			let clearResult: Promise<void> | undefined
			try {
				clearResult = onClear?.()
			} catch {
				userToggledRef.current = false
				setIsEnabled(!!initialValue)
				syncLocalValue(initialValue || "")
				return
			}
			if (clearResult) {
				setIsClearing(true)
				void clearResult
					.catch(() => {
						userToggledRef.current = false
						setIsEnabled(!!initialValue)
						syncLocalValue(initialValue || "")
					})
					.finally(() => setIsClearing(false))
			} else {
				onChange("")
			}
		}
	}

	return (
		<div>
			<div className="flex items-center gap-2">
				<VSCodeCheckbox checked={isEnabled} disabled={disabled || isClearing} onChange={handleToggle}>
					{label}
				</VSCodeCheckbox>
				{showLockIcon && <i className="codicon codicon-lock text-(--vscode-descriptionForeground) text-sm" />}
			</div>

			{isEnabled && (
				<VSCodeTextField
					disabled={disabled}
					onInput={(e: any) => setLocalValue(e.target.value)}
					placeholder={placeholder}
					style={{ width: "100%", marginTop: 3 }}
					type="text"
					value={localValue}
				/>
			)}

			{loopbackOnRemote && remoteName && effectiveUrl && (
				<LoopbackOnRemoteNotice port={urlPort(effectiveUrl)} remoteName={remoteName} />
			)}
		</div>
	)
}

/**
 * Shown when the provider URL is on localhost while the extension runs on a
 * remote: the requests go out from the remote, so "localhost" is that machine.
 */
const LoopbackOnRemoteNotice = ({ remoteName, port }: { remoteName: string; port: string }) => {
	const where = describeRemote(remoteName)
	return (
		<div
			className="mt-2 flex gap-2 rounded-xs border border-(--vscode-inputValidation-warningBorder) bg-(--vscode-inputValidation-warningBackground) p-2 text-xs"
			data-testid="loopback-on-remote-notice"
			role="note">
			<i className="codicon codicon-warning mt-0.5 text-(--vscode-editorWarning-foreground)" />
			<div className="flex flex-col gap-1">
				<span>
					Cerebriline is running on {where}, so <code>localhost</code> here is {where}, not this computer. A server
					running on this computer is not reached at this address.
				</span>
				{remoteName === "ssh-remote" ? (
					<span>
						To use one, forward its port to the SSH host: add{" "}
						<code>
							RemoteForward {port || "11434"} localhost:{port || "11434"}
						</code>{" "}
						to the host's entry in your SSH config and reconnect, or enter this computer's network address.
					</span>
				) : (
					<span>To use one, enter an address {where} can reach, such as this computer's network address.</span>
				)}
			</div>
		</div>
	)
}
