/**
 * Reading SSH FS's connection configs the way SSH FS itself does.
 *
 * SSH FS (`Kelvin.vscode-sshfs`) opens a folder as `ssh://<config>/<path>` and
 * serves its files over SFTP from the extension host on the user's computer.
 * Cerebriline's tools act on the files and processes of the machine they run
 * on, so for such a folder they would act on this computer; the way to reach
 * the remote is to reopen the folder with Remote-SSH (see sshfs-bridge.ts),
 * and for that the SSH FS config has to be turned into an OpenSSH host entry.
 *
 * SSH FS publishes no API, so this reproduces its config resolution from its
 * source (v1.27.0, src/config.ts and src/connect.ts):
 *
 * - Layers, most important first: workspace-folder settings (and the
 *   `configpaths` files they name), workspace settings and their files, then
 *   user settings and their files. Names are compared lowercased.
 * - A duplicate name in a less important layer is ignored, unless the more
 *   important one sets `merge`: it then takes the fields it does not set
 *   itself from the other.
 * - `extend` names one or more configs whose fields are taken first; the
 *   config's own fields win. Unknown names and cycles skip the config.
 * - `host`, `username`, `port`, `agent` and `privateKeyPath` expand `$NAME`
 *   from the environment; `$USERNAME` is read as `$USER`, and `$USER` falls
 *   back to the local user name.
 *
 * Pure: no `vscode` import, so the resolution is testable on its own.
 */

/** The fields of an SSH FS config this bridge reads. SSH FS has more. */
export interface SshFsConfig {
	name: string
	label?: string
	host?: string
	port?: number | string
	username?: string
	password?: string | boolean
	passphrase?: string | boolean
	privateKeyPath?: string
	agent?: string
	hop?: string
	proxy?: { type?: string; host?: string; port?: number | string }
	putty?: string | boolean
	root?: string
	merge?: boolean
	extend?: string | string[]
	[key: string]: unknown
}

/** Why a config could not be resolved, as a sentence for the user. */
export class SshFsConfigError extends Error {}

function isConfig(value: unknown): value is SshFsConfig {
	return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string"
}

/**
 * Merge the layers into one config per name, as SSH FS's applyConfigLayers
 * does, then apply `extend`. Layers come most important first.
 */
export function applySshFsLayers(layers: readonly (readonly unknown[])[]): Map<string, SshFsConfig> {
	const loaded: SshFsConfig[] = []
	for (const layer of layers) {
		for (const raw of layer) {
			if (!isConfig(raw) || !raw.name) {
				continue
			}
			const conf: SshFsConfig = { ...raw, name: raw.name.toLowerCase() }
			const dup = loaded.find((d) => d.name === conf.name)
			if (!dup) {
				loaded.push(conf)
			} else if (dup.merge) {
				// The more important config's own fields win; it only fills gaps.
				Object.assign(dup, { ...conf, ...dup })
			}
		}
	}

	const sources = new Map(loaded.map((c) => [c.name, c]))
	const built = new Map<string, SshFsConfig>()
	const skipped = new Set<string>()
	// `stack` is the chain of configs being extended right now; meeting a name
	// already on it is a cycle, and every config on the cycle is skipped.
	const build = (name: string, stack: readonly string[] = []): SshFsConfig | undefined => {
		if (built.has(name)) {
			return built.get(name)
		}
		const source = sources.get(name)
		if (!source || skipped.has(name)) {
			return undefined
		}
		if (stack.includes(name)) {
			for (const member of stack.slice(stack.indexOf(name))) {
				skipped.add(member)
			}
			return undefined
		}
		const result: SshFsConfig = { ...source }
		const extend = typeof source.extend === "string" ? [source.extend] : (source.extend ?? [])
		for (const dep of extend) {
			const depConfig = build(dep.toLowerCase(), [...stack, name])
			if (!depConfig) {
				// An unknown, skipped or cyclic dependency skips this config too.
				skipped.add(name)
				return undefined
			}
			Object.assign(result, depConfig)
		}
		if (skipped.has(name)) {
			return undefined
		}
		const final = Object.assign(result, source)
		built.set(name, final)
		return final
	}
	for (const name of sources.keys()) {
		build(name)
	}
	return built
}

/** `$NAME` from the environment, as SSH FS's connect.ts expands it. */
export function expandEnv(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (typeof value !== "string") {
		return value
	}
	return value.replace(/\$\w+/g, (key) => env[key.slice(1)] || "")
}

/** The connection a config describes, with variables expanded. */
export interface SshFsConnection {
	name: string
	host: string
	port: number
	/** Undefined when the config names none: SSH FS then asks, ssh uses the local user. */
	username?: string
	privateKeyPath?: string
	agent?: string
	hop?: string
	/** The config stores or asks for a password; Remote-SSH asks for it too. */
	usesPassword: boolean
	proxy?: SshFsConfig["proxy"]
	putty?: string | boolean
}

/** Resolve one config by name (a folder's URI authority) into its connection. */
export function resolveSshFsConnection(
	configs: ReadonlyMap<string, SshFsConfig>,
	name: string,
	env: NodeJS.ProcessEnv,
	localUser: string,
): SshFsConnection {
	const config = configs.get(name.toLowerCase())
	if (!config) {
		throw new SshFsConfigError(
			`No SSH FS config is named "${name}". It may be defined only in a place this bridge does not read, such as a config file given by a relative path.`,
		)
	}
	const host = expandEnv(config.host, env)?.trim()
	if (!host) {
		throw new SshFsConfigError(
			config.putty
				? `The SSH FS config "${config.name}" takes its host from a PuTTY session, which OpenSSH cannot read. Add the host to the config, or create the Remote-SSH entry by hand.`
				: `The SSH FS config "${config.name}" has no host.`,
		)
	}
	const rawUser = config.username === "$USERNAME" ? "$USER" : config.username
	const username = rawUser === "$USER" ? env.USER || env.USERNAME || localUser : expandEnv(rawUser, env)?.trim() || undefined
	const portText = expandEnv(config.port == null ? "" : String(config.port), env)?.trim()
	const port = portText ? Number(portText) : 22
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new SshFsConfigError(`The SSH FS config "${config.name}" has an invalid port: ${portText}.`)
	}
	const privateKeyPath = expandEnv(config.privateKeyPath, env)?.trim() || undefined
	const agent = expandEnv(config.agent, env)?.trim() || undefined
	return {
		name: config.name,
		host,
		port,
		username,
		privateKeyPath,
		agent,
		hop: config.hop?.toLowerCase() || undefined,
		usesPassword: !!config.password || (!privateKeyPath && !agent),
		proxy: config.proxy,
		putty: config.putty,
	}
}
