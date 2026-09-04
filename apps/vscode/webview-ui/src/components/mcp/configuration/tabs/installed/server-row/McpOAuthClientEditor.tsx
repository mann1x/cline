import type { McpServer } from "@shared/mcp"
import type { McpServers } from "@shared/proto/cline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { McpServiceClient } from "@/services/grpc-client"

/**
 * Set the OAuth client a server issued, on a server that already exists.
 *
 * The fields were on the *Add Remote Server* form only, which helps nobody:
 * a user finds out their server refuses to register Cline by adding it and
 * watching it fail, and at that point the only way to supply a client the
 * provider issued was to hand-edit `cline_mcp_settings.json` — for a server
 * sitting right there in the list with a red error under it (mann1x/cline#63).
 *
 * Measured against Figma's server, which is the one this was reported on: its
 * registration endpoint answers every anonymous registration with a bare
 * `403 Forbidden`, for any body, any client name, and with or without
 * credentials. Dynamic registration is not going to start working there, so
 * this path is the only one, and it belongs next to the failure.
 */

interface OAuthClientEditorProps {
	server: McpServer
}

function readConfiguredClient(config: string): { clientId: string; clientSecret: string } {
	try {
		const parsed = JSON.parse(config) as {
			oauthClient?: { clientId?: string; clientSecret?: string }
		}
		return {
			clientId: parsed.oauthClient?.clientId ?? "",
			// Never round-tripped into the field: showing a stored secret back
			// is how one gets copied somewhere it should not be. An empty field
			// with a saved secret keeps the secret; clearing needs the button.
			clientSecret: "",
		}
	} catch {
		return { clientId: "", clientSecret: "" }
	}
}

function hasConfiguredClient(config: string): boolean {
	return readConfiguredClient(config).clientId !== ""
}

export function McpOAuthClientEditor({ server }: OAuthClientEditorProps) {
	const { setMcpServers } = useExtensionState()
	const configured = hasConfiguredClient(server.config)
	const [isOpen, setIsOpen] = useState(false)
	const [clientId, setClientId] = useState(() => readConfiguredClient(server.config).clientId)
	const [clientSecret, setClientSecret] = useState("")
	const [isSaving, setIsSaving] = useState(false)
	const [error, setError] = useState("")

	const submit = async (next: { clientId: string; clientSecret: string }) => {
		setIsSaving(true)
		setError("")
		try {
			const response: McpServers = await McpServiceClient.updateMcpServerOAuthClient({
				serverName: server.name,
				clientId: next.clientId,
				clientSecret: next.clientSecret,
			} as never)
			setMcpServers(convertProtoMcpServersToMcpServers(response.mcpServers))
			setClientSecret("")
			setIsOpen(false)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught))
		} finally {
			setIsSaving(false)
		}
	}

	if (!isOpen) {
		return (
			<Button
				className="m-2.5 mt-0 max-w-[calc(100%-20px)]"
				onClick={(event) => {
					event.stopPropagation()
					setIsOpen(true)
				}}
				variant="secondary">
				{configured ? "Edit OAuth client" : "Use an OAuth client I already have"}
			</Button>
		)
	}

	return (
		// The row this sits in toggles expansion on click, and a click on a text
		// field is not a click on the row.
		// biome-ignore lint/a11y/noStaticElementInteractions: containment, not a control
		// biome-ignore lint/a11y/useKeyWithClickEvents: containment, not a control
		<div className="m-2.5 mt-0" onClick={(event) => event.stopPropagation()}>
			<div className="mb-2 text-xs text-(--vscode-descriptionForeground)">
				For a server that only accepts clients it issued itself. Register Cline in the provider's own developer settings,
				then paste what it gave you.
			</div>

			<VSCodeTextField
				className="w-full mb-2"
				disabled={isSaving}
				onChange={(event) => {
					setClientId((event.target as HTMLInputElement).value)
					setError("")
				}}
				placeholder="client-id"
				value={clientId}>
				OAuth Client ID
			</VSCodeTextField>

			<VSCodeTextField
				className="w-full"
				disabled={isSaving}
				onChange={(event) => {
					setClientSecret((event.target as HTMLInputElement).value)
					setError("")
				}}
				placeholder={configured ? "unchanged" : "leave empty for a public client"}
				type="password"
				value={clientSecret}>
				OAuth Client Secret
			</VSCodeTextField>
			<div className="mt-1 mb-2 text-xs text-(--vscode-descriptionForeground)">
				Stored in the MCP settings file. Use ${"{"}env:VAR{"}"} to read it from an environment variable instead.
			</div>

			{error && <div className="mb-2 text-xs text-failed-icon break-words">{error}</div>}

			<div className="flex gap-2">
				<Button
					disabled={isSaving || clientId.trim() === ""}
					onClick={() => submit({ clientId, clientSecret })}
					variant="default">
					{isSaving ? "Saving..." : "Save and reconnect"}
				</Button>
				<Button disabled={isSaving} onClick={() => setIsOpen(false)} variant="secondary">
					Cancel
				</Button>
				{configured && (
					<Button
						disabled={isSaving}
						onClick={() => {
							setClientId("")
							return submit({ clientId: "", clientSecret: "" })
						}}
						variant="danger">
						Clear
					</Button>
				)}
			</div>
		</div>
	)
}

export default McpOAuthClientEditor
