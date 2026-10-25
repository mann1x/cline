/**
 * Under a VS Code remote (Remote-SSH, WSL, a dev container) the extension host,
 * and every request a provider makes, runs on the remote machine. A provider URL
 * on `localhost` therefore reaches a server on that machine, not on the computer
 * the user is sitting at -- the usual surprise with a local Ollama or LM Studio.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"])

/** The URL's host is this machine's loopback, `localhost` or a `*.localhost` name. */
export function isLoopbackUrl(url: string | undefined): boolean {
	const trimmed = url?.trim()
	if (!trimmed) {
		return false
	}
	let hostname: string
	try {
		hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname.toLowerCase()
	} catch {
		return false
	}
	return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/** The port the URL names, or its scheme's default. */
export function urlPort(url: string): string {
	try {
		const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`)
		return parsed.port || (parsed.protocol === "https:" ? "443" : "80")
	} catch {
		return ""
	}
}

/** How the remote reads in a sentence: "the SSH host", "WSL", "the dev container". */
export function describeRemote(remoteName: string): string {
	switch (remoteName) {
		case "ssh-remote":
			return "the SSH host"
		case "wsl":
			return "WSL"
		case "dev-container":
		case "attached-container":
			return "the dev container"
		case "codespaces":
			return "the codespace"
		case "tunnel":
			return "the tunnel host"
		default:
			return "the remote machine"
	}
}
