import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import {
	duplicateRemoteTerminalNames,
	parseRemoteTerminals,
	type StoredRemoteTerminal,
	type StoredRemoteTerminals,
	serializeRemoteTerminals,
} from "@shared/remote-terminals"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"

/**
 * Remote terminals: Open Terminal machines, reached through Open WebUI.
 *
 * Cerebriline signs in to Open WebUI with the user's API key and names each
 * machine by its connection id there; the machine's own key stays in Open
 * WebUI. Each terminal here is one name the model can use.
 */
const RemoteTerminalsTab = () => {
	const { remoteTerminals, openWebUiApiKeySet } = useExtensionState()
	const stored = useMemo(() => parseRemoteTerminals(remoteTerminals), [remoteTerminals])
	// Every field saves the whole record, and the fields debounce on their own
	// clocks: two edited in quick succession must not each start from the
	// record as it was before both. The latest record is held here.
	const latest = useRef<StoredRemoteTerminals>(stored)
	useEffect(() => {
		latest.current = stored
	}, [stored])

	const save = useCallback(async (next: StoredRemoteTerminals) => {
		latest.current = next
		try {
			await StateServiceClient.updateSettings(
				UpdateSettingsRequest.create({ remoteTerminals: serializeRemoteTerminals(next) }),
			)
		} catch (error) {
			console.error("Failed to save the remote terminals:", error)
		}
	}, [])

	const patch = (change: Partial<StoredRemoteTerminals>) => void save({ ...latest.current, ...change })
	const patchTerminal = (index: number, change: Partial<StoredRemoteTerminal>) => {
		const terminals = latest.current.terminals.map((terminal, at) => (at === index ? { ...terminal, ...change } : terminal))
		void save({ ...latest.current, terminals })
	}

	const saveApiKey = useCallback(async (value: string) => {
		try {
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ openWebUiApiKey: value }))
		} catch (error) {
			console.error("Failed to save the Open WebUI API key:", error)
		}
	}, [])

	const duplicates = duplicateRemoteTerminalNames(stored.terminals)

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs m-0 text-(--vscode-descriptionForeground)">
				Open Terminal machines registered in Open WebUI (Admin Settings → Integrations → Open Terminal). The model runs
				commands and reads and writes files there with <code>remote_run</code>, <code>remote_read</code> and{" "}
				<code>remote_write</code>, under the same auto-approve settings as on this machine. Each conversation works in a
				folder of its own on each machine.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.openWebUiUrl}
				onChange={(value) => patch({ openWebUiUrl: value.trim() })}
				placeholder="http://192.168.1.10:3000">
				<span className="font-medium">Open WebUI URL</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				The address you open Open WebUI at. Requests go to its machine proxy,{" "}
				<code>/api/v1/machines/&lt;machine ID&gt;/…</code>; the terminals themselves never need to be reachable from here.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue=""
				onChange={(value) => void saveApiKey(value)}
				placeholder={openWebUiApiKeySet ? "Stored — type to replace, clear to remove" : "sk-…"}
				type="password">
				<span className="font-medium">Open WebUI API key</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Create it in Open WebUI under Settings → Account → API Keys (an admin first turns on Admin Settings → General →
				Enable API Keys). It acts as you in Open WebUI. Kept in the editor's secret storage and never sent back to this
				panel — which is why the field looks empty even when a key is stored.
			</p>

			<div className="flex flex-col gap-2">
				<span className="font-medium text-sm">Terminals</span>
				{stored.terminals.length === 0 ? (
					<p className="text-xs m-0 text-(--vscode-descriptionForeground)">
						No terminal yet. Add one for each machine.
					</p>
				) : null}
				{stored.terminals.map((terminal, index) => (
					<div
						className="flex flex-col gap-1 p-2 rounded border border-solid border-(--vscode-panel-border)"
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place; a name being typed cannot be the key.
						key={index}>
						<div className="flex items-center gap-2 flex-wrap">
							<DebouncedTextField
								className="flex-1 min-w-[120px]"
								initialValue={terminal.name}
								onChange={(value) => patchTerminal(index, { name: value.trim() })}
								placeholder="bench-app">
								<span className="text-xs">Name</span>
							</DebouncedTextField>
							<DebouncedTextField
								className="flex-1 min-w-[120px]"
								initialValue={terminal.machineId}
								onChange={(value) => patchTerminal(index, { machineId: value.trim() })}
								placeholder="solidpc-bench-app">
								<span className="text-xs">Machine ID in Open WebUI</span>
							</DebouncedTextField>
						</div>
						<DebouncedTextField
							className="w-full"
							initialValue={terminal.description ?? ""}
							onChange={(value) => patchTerminal(index, { description: value.trim() || undefined })}
							placeholder="Builds and benchmarks the app">
							<span className="text-xs">What it is for (shown to the model)</span>
						</DebouncedTextField>
						<div className="flex items-center justify-between gap-2">
							<SettingsCheckbox
								checked={terminal.enabled !== false}
								onChange={(checked) => patchTerminal(index, { enabled: checked ? undefined : false })}>
								Offer to the model
							</SettingsCheckbox>
							<VSCodeButton
								appearance="secondary"
								onClick={() =>
									void save({
										...latest.current,
										terminals: latest.current.terminals.filter((_, at) => at !== index),
									})
								}>
								Remove
							</VSCodeButton>
						</div>
					</div>
				))}
				{duplicates.length > 0 ? (
					<p className="text-xs m-0 text-(--vscode-errorForeground)">
						Two terminals are called “{duplicates.join("”, “")}”. The model asks for a terminal by name, so only the
						first is offered; rename the other.
					</p>
				) : null}
				<div>
					<VSCodeButton
						appearance="secondary"
						onClick={() =>
							void save({
								...latest.current,
								terminals: [...latest.current.terminals, { name: "", machineId: "" }],
							})
						}>
						Add terminal
					</VSCodeButton>
				</div>
			</div>

			<DebouncedTextField
				className="w-full"
				initialValue={String(stored.retentionDays)}
				onChange={(value) => {
					const days = Number(value.trim())
					if (Number.isFinite(days) && days >= 0) patch({ retentionDays: Math.floor(days) })
				}}
				placeholder="7">
				<span className="font-medium">Keep a deleted conversation's folders (days)</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				When you delete a conversation, its folders on the terminals stay this many days, so you can still copy something
				out, then they are removed. Folders of conversations you keep are never removed.
			</p>
		</div>
	)
}

export default RemoteTerminalsTab
