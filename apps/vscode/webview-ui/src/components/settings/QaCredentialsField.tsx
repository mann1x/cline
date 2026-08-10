import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { memo, useState } from "react"
import { Label } from "@/components/ui/label"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

/**
 * The same rule the extension enforces, applied early so the user is told at
 * the keyboard rather than by a QA run that quietly never had the credential.
 * Kept literal rather than imported: the store lives in `@cline/core`, which
 * the webview cannot import (it pulls in undici, which does not resolve in a
 * browser bundle). The extension side stays the authority — anything that gets
 * past this is still validated there.
 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MIN_VALUE_LENGTH = 8

function describeProblem(name: string, value: string, existing: string[]): string | undefined {
	if (name.length === 0 || value.length === 0) {
		return undefined
	}
	if (!NAME_PATTERN.test(name)) {
		return "Use a name that works as an environment variable: letters, digits and underscore, not starting with a digit."
	}
	if (value.length < MIN_VALUE_LENGTH) {
		return `A value under ${MIN_VALUE_LENGTH} characters cannot be masked out of command output reliably, so it is not accepted.`
	}
	if (existing.includes(name)) {
		return `${name} is already set. Adding it again replaces the stored value.`
	}
	return undefined
}

/**
 * Credentials a QA run may use, entered once and never shown again.
 *
 * There is no "reveal" and no edit-in-place: the extension sends the settings
 * view the names and keeps the values in secret storage, so there is nothing
 * here to reveal. Replacing a value means entering it again under the same
 * name, which is also the only operation a write-only store can honestly offer.
 */
const QaCredentialsField = () => {
	const { qaCredentialNames } = useExtensionState()
	const names = qaCredentialNames ?? []
	const [name, setName] = useState("")
	const [value, setValue] = useState("")

	const problem = describeProblem(name.trim(), value, names)
	const replaces = names.includes(name.trim())
	const canSubmit = name.trim().length > 0 && value.length >= MIN_VALUE_LENGTH && NAME_PATTERN.test(name.trim())

	const add = () => {
		if (!canSubmit) {
			return
		}
		updateSetting("qaCredentials", { set: [{ name: name.trim(), value }], remove: [] })
		setName("")
		setValue("")
	}

	const remove = (credentialName: string) => {
		updateSetting("qaCredentials", { set: [], remove: [credentialName] })
	}

	return (
		<div className="space-y-2 py-3">
			<Label className="text-sm font-medium text-foreground">QA Credentials</Label>
			<p className="text-xs text-muted-foreground">
				Named secrets a command can ask for when it needs to log in. The model is told the names and never the values; a
				value is set only for the command that asks for it, and is masked out of anything that prints it. Use test or
				sandbox credentials only.
			</p>

			{names.length > 0 && (
				<div className="space-y-1">
					{names.map((credentialName) => (
						<div className="flex items-center justify-between gap-2 text-xs" key={credentialName}>
							<code className="font-mono">{credentialName}</code>
							<VSCodeButton appearance="secondary" onClick={() => remove(credentialName)}>
								Remove
							</VSCodeButton>
						</div>
					))}
				</div>
			)}

			<div className="flex items-end gap-2">
				<VSCodeTextField
					className="flex-1"
					onInput={(event) => setName((event.target as HTMLInputElement).value)}
					placeholder="QA_PASSWORD"
					value={name}>
					Name
				</VSCodeTextField>
				<VSCodeTextField
					className="flex-1"
					onInput={(event) => setValue((event.target as HTMLInputElement).value)}
					placeholder="value"
					type="password"
					value={value}>
					Value
				</VSCodeTextField>
				<VSCodeButton disabled={!canSubmit} onClick={add}>
					{replaces ? "Replace" : "Add"}
				</VSCodeButton>
			</div>

			{problem && <p className="text-xs text-[var(--vscode-errorForeground)]">{problem}</p>}
		</div>
	)
}

export default memo(QaCredentialsField)
