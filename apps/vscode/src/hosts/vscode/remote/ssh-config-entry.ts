/**
 * The OpenSSH host entry Remote-SSH connects through, built from an SSH FS
 * connection (sshfs-config.ts).
 *
 * Remote-SSH runs the system `ssh` and reads hosts from the user's SSH config
 * file, so the bridge adds one `Host` block per SSH FS config it needs -- the
 * folder's own and every `hop` it jumps through -- and opens the folder as
 * `vscode-remote://ssh-remote+<alias>/<path>`. What OpenSSH cannot express
 * (a stored password, Pageant, a SOCKS or HTTP proxy, a PuTTY session) is not
 * guessed at: it goes into the notes shown with the entry.
 *
 * Pure: no `vscode` import.
 */

import { SshFsConfigError, type SshFsConnection } from "./sshfs-config"

export interface SshHostEntry {
	alias: string
	/** The block as it goes into the config file, ending in a newline. */
	text: string
}

export interface SshBridgePlan {
	/** The alias the folder is opened through. */
	alias: string
	/** The folder's own entry and those of its hops, hops first. */
	entries: SshHostEntry[]
	/** What could not be carried over, one sentence each. */
	notes: string[]
}

/**
 * `sshfs-<name>`, with anything a Host alias or Remote-SSH's authority cannot
 * hold replaced. SSH FS names allow `/` and `@`; `@` would read as user@host.
 */
export function hostAliasFor(configName: string): string {
	return `sshfs-${configName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`
}

/**
 * A path as ssh_config reads it. Recent OpenSSH treats `\` as an escape, so a
 * Windows path is written with `/`, which Windows OpenSSH accepts; a path with
 * a space is quoted.
 */
export function sshConfigPath(path: string, platform: NodeJS.Platform): string {
	const normalized = platform === "win32" ? path.replace(/\\/g, "/") : path
	return /\s/.test(normalized) ? `"${normalized}"` : normalized
}

/**
 * The entries for one SSH FS config and every config it hops through.
 * `lookup` resolves a config name to its connection and throws
 * SshFsConfigError when it cannot.
 */
export function buildSshBridgePlan(
	configName: string,
	lookup: (name: string) => SshFsConnection,
	options: { platform: NodeJS.Platform; defaultAgent?: string },
): SshBridgePlan {
	const entries: SshHostEntry[] = []
	const notes: string[] = []
	const visit = (name: string, chain: readonly string[]): string => {
		if (chain.includes(name)) {
			throw new SshFsConfigError(`The SSH FS configs hop in a circle: ${[...chain, name].join(" → ")}.`)
		}
		const alias = hostAliasFor(name)
		if (entries.some((e) => e.alias === alias)) {
			return alias
		}
		const connection = lookup(name)
		const jump = connection.hop ? visit(connection.hop, [...chain, name]) : undefined
		const lines = [`# Added by Cerebriline from the SSH FS config "${connection.name}"`, `Host ${alias}`]
		lines.push(`    HostName ${connection.host}`)
		if (connection.username) {
			lines.push(`    User ${connection.username}`)
		}
		if (connection.port !== 22) {
			lines.push(`    Port ${connection.port}`)
		}
		if (connection.privateKeyPath) {
			lines.push(`    IdentityFile ${sshConfigPath(connection.privateKeyPath, options.platform)}`)
		}
		if (connection.agent && connection.agent.toLowerCase() !== "pageant" && connection.agent !== options.defaultAgent) {
			lines.push(`    IdentityAgent ${sshConfigPath(connection.agent, options.platform)}`)
		}
		if (jump) {
			lines.push(`    ProxyJump ${jump}`)
		}
		entries.push({ alias, text: `${lines.join("\n")}\n` })

		const where = connection.username ? `${connection.username}@${connection.host}` : connection.host
		if (connection.usesPassword) {
			notes.push(
				`"${connection.name}" logs in with a password: Remote-SSH asks for it when it connects to ${where}. SSH FS's stored password is not copied.`,
			)
		}
		if (connection.agent?.toLowerCase() === "pageant") {
			notes.push(
				`"${connection.name}" uses Pageant. The ssh that Remote-SSH runs reads it only when Pageant was started with its OpenSSH option (--openssh-config); otherwise add an IdentityFile to the entry.`,
			)
		}
		if (connection.proxy?.host) {
			const kind = connection.proxy.type ? `${connection.proxy.type} proxy` : "proxy"
			notes.push(
				`"${connection.name}" connects through a ${kind} at ${connection.proxy.host}, which is not carried over: OpenSSH needs a ProxyCommand for it.`,
			)
		}
		if (connection.putty) {
			notes.push(
				`"${connection.name}" reads settings from a PuTTY session; only its host, user, port and key are carried over.`,
			)
		}
		if (!connection.username) {
			notes.push(`"${connection.name}" names no user, so ssh connects to ${connection.host} as your local user name.`)
		}
		return alias
	}
	const alias = visit(configName.toLowerCase(), [])
	return { alias, entries, notes }
}

/** The aliases a config file's `Host` lines declare. Patterns are kept as written. */
export function declaredHostAliases(configText: string): Set<string> {
	const aliases = new Set<string>()
	for (const line of configText.split(/\r?\n/)) {
		const match = /^\s*Host\s+(.+?)\s*$/i.exec(line)
		if (!match) {
			continue
		}
		for (const token of match[1].split(/\s+/)) {
			aliases.add(token.replace(/^"|"$/g, ""))
		}
	}
	return aliases
}

/**
 * The config text with the entries it does not declare yet appended, and the
 * aliases that were already there (left as the user wrote them).
 */
export function appendMissingEntries(
	configText: string,
	entries: readonly SshHostEntry[],
): { text: string; added: string[]; existing: string[] } {
	const declared = declaredHostAliases(configText)
	const missing = entries.filter((e) => !declared.has(e.alias))
	const existing = entries.filter((e) => declared.has(e.alias)).map((e) => e.alias)
	if (missing.length === 0) {
		return { text: configText, added: [], existing }
	}
	const eol = configText.includes("\r\n") ? "\r\n" : "\n"
	const separator = configText.length === 0 ? "" : configText.endsWith("\n") ? eol : eol + eol
	const block = missing.map((e) => e.text.replace(/\n/g, eol)).join(eol)
	return { text: `${configText}${separator}${block}`, added: missing.map((e) => e.alias), existing }
}
