import { AddLocalMcpServerRequest, type McpServers } from "@shared/proto/cline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { VSCodeButton, VSCodeTextArea, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { McpServiceClient } from "@/services/grpc-client"

type AddLocalServerFormProps = {
	onServerAdded: () => void
	onCancel?: () => void
}

/**
 * Split a command line into arguments the way a shell would, minus the shell.
 *
 * Arguments are one per line or space-separated, and quoting works so a path
 * with a space in it survives — which on Windows is most of them. Nothing here
 * is executed by a shell: the parts go into the settings file as a list, and
 * the server is spawned from that list directly.
 */
export function parseCommandArgs(input: string): string[] {
	const args: string[] = []
	let current = ""
	let quote: '"' | "'" | undefined
	let started = false

	const push = () => {
		if (started) {
			args.push(current)
			current = ""
			started = false
		}
	}

	for (const char of input) {
		if (quote) {
			if (char === quote) {
				quote = undefined
			} else {
				current += char
			}
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			started = true
			continue
		}
		if (/\s/.test(char)) {
			push()
			continue
		}
		current += char
		started = true
	}
	push()
	return args
}

/**
 * Parse `KEY=value` lines into an environment map.
 *
 * Everything after the first `=` is the value, so a value containing one is not
 * cut in half.
 */
export function parseEnvLines(input: string): Record<string, string> {
	const env: Record<string, string> = {}
	for (const line of input.split("\n")) {
		const trimmed = line.trim()
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue
		}
		const separator = trimmed.indexOf("=")
		if (separator <= 0) {
			continue
		}
		env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
	}
	return env
}

/**
 * Add a server Cline launches itself and talks to over stdio.
 *
 * The settings file has always taken these; the only way to add one was to open
 * the JSON and write it by hand. The fields are the same ones that file holds,
 * so what is added here reads the same afterwards and can still be edited
 * there.
 */
const AddLocalServerForm = ({ onCancel, onServerAdded }: AddLocalServerFormProps) => {
	const [serverName, setServerName] = useState("")
	const [command, setCommand] = useState("")
	const [args, setArgs] = useState("")
	const [env, setEnv] = useState("")
	const [cwd, setCwd] = useState("")
	const [isSubmitting, setIsSubmitting] = useState(false)
	const [error, setError] = useState("")
	const { setMcpServers } = useExtensionState()

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault()

		if (!serverName.trim()) {
			setError("Server name is required")
			return
		}
		if (!command.trim()) {
			setError("Command is required")
			return
		}

		setError("")
		setIsSubmitting(true)

		try {
			const servers: McpServers = await McpServiceClient.addLocalMcpServer(
				AddLocalMcpServerRequest.create({
					serverName: serverName.trim(),
					command: command.trim(),
					args: parseCommandArgs(args),
					env: parseEnvLines(env),
					...(cwd.trim() ? { cwd: cwd.trim() } : {}),
				}),
			)

			setIsSubmitting(false)
			setMcpServers(convertProtoMcpServersToMcpServers(servers.mcpServers))
			setServerName("")
			setCommand("")
			setArgs("")
			setEnv("")
			setCwd("")
			onServerAdded()
		} catch (error) {
			setIsSubmitting(false)
			setError(error instanceof Error ? error.message : "Failed to add server")
		}
	}

	return (
		<div className="p-4 px-5">
			<div className="text-(--vscode-foreground) mb-2">
				Add an MCP server that Cline runs on this machine. Give it the command that starts the server and any arguments it
				takes — for example <code>npx</code> with <code>-y @azure/mcp@latest</code>, or <code>dnx</code> with{" "}
				<code>NuGet.Mcp.Server</code>.
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
						placeholder="azure"
						value={serverName}>
						Server Name
					</VSCodeTextField>
				</div>

				<div className="mb-2">
					<VSCodeTextField
						className="w-full"
						disabled={isSubmitting}
						onChange={(e) => {
							setCommand((e.target as HTMLInputElement).value)
							setError("")
						}}
						placeholder="npx"
						value={command}>
						Command
					</VSCodeTextField>
				</div>

				<div className="mb-2">
					<VSCodeTextArea
						className="w-full"
						disabled={isSubmitting}
						onChange={(e) => {
							setArgs((e.target as HTMLTextAreaElement).value)
							setError("")
						}}
						placeholder={"-y\n@azure/mcp@latest"}
						resize="vertical"
						rows={3}
						value={args}>
						Arguments
					</VSCodeTextArea>
					<div className="text-(--vscode-descriptionForeground) text-xs mt-1">
						One per line, or separated by spaces. Quote anything containing a space.
					</div>
				</div>

				<div className="mb-2">
					<VSCodeTextArea
						className="w-full"
						disabled={isSubmitting}
						onChange={(e) => {
							setEnv((e.target as HTMLTextAreaElement).value)
							setError("")
						}}
						placeholder={"API_TOKEN=..."}
						resize="vertical"
						rows={2}
						value={env}>
						Environment (optional)
					</VSCodeTextArea>
					<div className="text-(--vscode-descriptionForeground) text-xs mt-1">One KEY=value per line.</div>
				</div>

				<div className="mb-3">
					<VSCodeTextField
						className="w-full"
						disabled={isSubmitting}
						onChange={(e) => {
							setCwd((e.target as HTMLInputElement).value)
							setError("")
						}}
						placeholder="Working directory (optional)"
						value={cwd}>
						Working Directory (optional)
					</VSCodeTextField>
				</div>

				{error && <div className="mb-3 text-(--vscode-errorForeground)">{error}</div>}

				<VSCodeButton className="w-full" disabled={isSubmitting} type="submit">
					{isSubmitting ? "Starting..." : "Add Server"}
				</VSCodeButton>

				{onCancel && (
					<VSCodeButton
						appearance="secondary"
						className="w-full"
						disabled={isSubmitting}
						onClick={onCancel}
						style={{ marginTop: "8px" }}>
						Cancel
					</VSCodeButton>
				)}
			</form>
		</div>
	)
}

export default AddLocalServerForm
