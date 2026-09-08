import { EmptyRequest } from "@shared/proto/cline/common"
import { AddRemoteMcpServerRequest, McpServers } from "@shared/proto/cline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { VSCodeButton, VSCodeLink, VSCodeRadio, VSCodeRadioGroup, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { LINKS } from "@/constants"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { McpServiceClient } from "@/services/grpc-client"

type TransportType = "streamableHttp" | "sse"

// "dynamic" lets the server register Cline itself, which is what most servers
// want. "preregistered" is for servers that refuse to: GitHub, Slack and Entra
// publish no registration endpoint at all, and Figma answers 403 to anyone
// outside its allowlist. Without a way to say so here, those servers fail with
// a 403 that reads as rejected credentials — credentials that were in fact
// never sent, because the flow stopped at registration.
type AuthMode = "dynamic" | "preregistered"

type AddRemoteServerFormProps = {
	onServerAdded: () => void
	onCancel?: () => void
	showEditConfiguration?: boolean
}

const AddRemoteServerForm = ({ onCancel, onServerAdded, showEditConfiguration = true }: AddRemoteServerFormProps) => {
	const [serverName, setServerName] = useState("")
	const [serverUrl, setServerUrl] = useState("")
	const [transportType, setTransportType] = useState<TransportType>("streamableHttp")
	const [authMode, setAuthMode] = useState<AuthMode>("dynamic")
	const [oauthClientId, setOauthClientId] = useState("")
	const [oauthClientSecret, setOauthClientSecret] = useState("")
	const [isSubmitting, setIsSubmitting] = useState(false)
	const [error, setError] = useState("")
	const { setMcpServers } = useExtensionState()

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault()

		if (!serverName.trim()) {
			setError("Server name is required")
			return
		}

		if (!serverUrl.trim()) {
			setError("Server URL is required")
			return
		}

		try {
			new URL(serverUrl)
		} catch (_err) {
			setError("Invalid URL format")
			return
		}

		if (authMode === "preregistered" && !oauthClientId.trim()) {
			setError("Client ID is required for a pre-registered OAuth client")
			return
		}

		setError("")
		setIsSubmitting(true)

		try {
			const servers: McpServers = await McpServiceClient.addRemoteMcpServer(
				AddRemoteMcpServerRequest.create({
					serverName: serverName.trim(),
					serverUrl: serverUrl.trim(),
					transportType: transportType,
					...(authMode === "preregistered"
						? {
								oauthClientId: oauthClientId.trim(),
								...(oauthClientSecret.trim() ? { oauthClientSecret: oauthClientSecret.trim() } : {}),
							}
						: {}),
				}),
			)

			setIsSubmitting(false)

			const mcpServers = convertProtoMcpServersToMcpServers(servers.mcpServers)
			setMcpServers(mcpServers)

			setServerName("")
			setServerUrl("")
			setAuthMode("dynamic")
			setOauthClientId("")
			setOauthClientSecret("")
			onServerAdded()
		} catch (error) {
			setIsSubmitting(false)
			setError(error instanceof Error ? error.message : "Failed to add server")
		}
	}

	return (
		<div className="p-4 px-5">
			<div className="text-(--vscode-foreground) mb-2">
				Add a remote MCP server by providing a name and its URL endpoint. Learn more{" "}
				<VSCodeLink href={LINKS.DOCUMENTATION.REMOTE_MCP_SERVER_DOCS} style={{ display: "inline" }}>
					here.
				</VSCodeLink>
			</div>

			<form onSubmit={handleSubmit}>
				<div className="mb-2">
					<VSCodeTextField
						className="w-full"
						disabled={isSubmitting}
						onChange={(e) => {
							setServerName((e.target as HTMLInputElement).value)
							setError("")
						}}
						placeholder="mcp-server"
						value={serverName}>
						Server Name
					</VSCodeTextField>
				</div>

				<div className="mb-2">
					<VSCodeTextField
						className="w-full mr-4"
						disabled={isSubmitting}
						onChange={(e) => {
							setServerUrl((e.target as HTMLInputElement).value)
							setError("")
						}}
						placeholder="https://example.com/mcp-server"
						value={serverUrl}>
						Server URL
					</VSCodeTextField>
				</div>

				<div className="mb-3">
					<label
						className={`block text-sm font-medium mb-2 ${isSubmitting ? "opacity-50" : ""}`}
						id="transport-type-label">
						Transport Type
					</label>
					<VSCodeRadioGroup
						aria-labelledby="transport-type-label"
						disabled={isSubmitting}
						onChange={(e) => {
							const value = (e.target as HTMLInputElement).value as TransportType
							setTransportType(value)
						}}
						value={transportType}>
						<VSCodeRadio checked={transportType === "streamableHttp"} value="streamableHttp">
							Streamable HTTP
						</VSCodeRadio>
						<VSCodeRadio checked={transportType === "sse"} value="sse">
							SSE (Legacy)
						</VSCodeRadio>
					</VSCodeRadioGroup>
				</div>

				<div className="mb-3">
					<label className={`block text-sm font-medium mb-2 ${isSubmitting ? "opacity-50" : ""}`} id="auth-mode-label">
						Authentication
					</label>
					<VSCodeRadioGroup
						aria-labelledby="auth-mode-label"
						disabled={isSubmitting}
						onChange={(e) => {
							setAuthMode((e.target as HTMLInputElement).value as AuthMode)
							setError("")
						}}
						value={authMode}>
						<VSCodeRadio checked={authMode === "dynamic"} value="dynamic">
							Automatic
						</VSCodeRadio>
						<VSCodeRadio checked={authMode === "preregistered"} value="preregistered">
							Use an OAuth client I already have
						</VSCodeRadio>
					</VSCodeRadioGroup>
					<div className="mt-1 text-xs text-(--vscode-descriptionForeground)">
						{authMode === "dynamic"
							? "Cline registers itself with the server when you authenticate. Most servers work this way."
							: "For servers that only accept clients they issued themselves — GitHub, Slack, Microsoft Entra, Figma. Register Cline there first, then paste what it gave you."}
					</div>
				</div>

				{authMode === "preregistered" && (
					<>
						<div className="mb-2">
							<VSCodeTextField
								className="w-full"
								disabled={isSubmitting}
								onChange={(e) => {
									setOauthClientId((e.target as HTMLInputElement).value)
									setError("")
								}}
								placeholder="client-id"
								value={oauthClientId}>
								OAuth Client ID
							</VSCodeTextField>
						</div>

						<div className="mb-2">
							<VSCodeTextField
								className="w-full"
								disabled={isSubmitting}
								onChange={(e) => {
									setOauthClientSecret((e.target as HTMLInputElement).value)
									setError("")
								}}
								placeholder="leave empty for a public client"
								type="password"
								value={oauthClientSecret}>
								OAuth Client Secret
							</VSCodeTextField>
							<div className="mt-1 text-xs text-(--vscode-descriptionForeground)">
								Stored in the MCP settings file. Use ${"{"}env:VAR{"}"} to read it from an environment variable
								instead.
							</div>
						</div>
					</>
				)}

				{error && <div className="mb-3 text-(--vscode-errorForeground)">{error}</div>}

				<VSCodeButton className="w-full" disabled={isSubmitting} type="submit">
					{isSubmitting ? "Connecting..." : "Add Server"}
				</VSCodeButton>

				{onCancel && (
					<VSCodeButton
						appearance="secondary"
						className="w-full"
						disabled={isSubmitting}
						onClick={onCancel}
						style={{ marginTop: "8px" }}
						type="button">
						Cancel
					</VSCodeButton>
				)}

				{showEditConfiguration && (
					<VSCodeButton
						appearance="secondary"
						onClick={() => {
							McpServiceClient.openMcpSettings(EmptyRequest.create({})).catch((error) => {
								console.error("Error opening MCP settings:", error)
							})
						}}
						style={{ width: "100%", marginBottom: "5px", marginTop: 15 }}>
						Edit Configuration
					</VSCodeButton>
				)}
			</form>
		</div>
	)
}

export default AddRemoteServerForm
