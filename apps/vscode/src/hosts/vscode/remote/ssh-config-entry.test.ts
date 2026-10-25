import { describe, expect, it } from "vitest"
import { appendMissingEntries, buildSshBridgePlan, declaredHostAliases, hostAliasFor, sshConfigPath } from "./ssh-config-entry"
import { applySshFsLayers, resolveSshFsConnection } from "./sshfs-config"

const lookupFrom = (configs: unknown[]) => {
	const map = applySshFsLayers([configs])
	return (name: string) => resolveSshFsConnection(map, name, {}, "me")
}

describe("hostAliasFor", () => {
	it("prefixes the name and replaces what an alias cannot hold", () => {
		expect(hostAliasFor("Build/Box@lab")).toBe("sshfs-build-box-lab")
	})
})

describe("sshConfigPath", () => {
	it("writes a Windows path with forward slashes and quotes one with a space", () => {
		expect(sshConfigPath("C:\\Users\\Me\\.ssh\\id_ed25519", "win32")).toBe("C:/Users/Me/.ssh/id_ed25519")
		expect(sshConfigPath("C:\\Users\\Jo Me\\.ssh\\id", "win32")).toBe('"C:/Users/Jo Me/.ssh/id"')
		expect(sshConfigPath("/home/me/.ssh/id", "linux")).toBe("/home/me/.ssh/id")
	})
})

describe("buildSshBridgePlan", () => {
	it("writes host, user, port and key, leaving out the default port", () => {
		const plan = buildSshBridgePlan(
			"box",
			lookupFrom([{ name: "box", host: "10.0.0.12", username: "dev", port: 2222, privateKeyPath: "C:\\k\\id" }]),
			{ platform: "win32" },
		)

		expect(plan.alias).toBe("sshfs-box")
		expect(plan.entries).toHaveLength(1)
		expect(plan.entries[0].text).toBe(
			[
				'# Added by Cerebriline from the SSH FS config "box"',
				"Host sshfs-box",
				"    HostName 10.0.0.12",
				"    User dev",
				"    Port 2222",
				"    IdentityFile C:/k/id",
				"",
			].join("\n"),
		)
		expect(plan.notes).toEqual([])
	})

	it("turns a hop into its own entry and a ProxyJump", () => {
		const plan = buildSshBridgePlan(
			"inner",
			lookupFrom([
				{ name: "inner", host: "10.1.0.5", username: "dev", agent: "/run/agent.sock", hop: "bastion" },
				{ name: "bastion", host: "bastion.example", username: "jump", agent: "/run/agent.sock" },
			]),
			{ platform: "linux", defaultAgent: "/run/agent.sock" },
		)

		expect(plan.entries.map((e) => e.alias)).toEqual(["sshfs-bastion", "sshfs-inner"])
		expect(plan.entries[1].text).toContain("    ProxyJump sshfs-bastion\n")
		// The default agent is the one ssh uses anyway; no IdentityAgent line.
		expect(plan.entries[1].text).not.toContain("IdentityAgent")
	})

	it("refuses hops in a circle", () => {
		expect(() =>
			buildSshBridgePlan(
				"a",
				lookupFrom([
					{ name: "a", host: "a", hop: "b", agent: "x" },
					{ name: "b", host: "b", hop: "a", agent: "x" },
				]),
				{ platform: "linux" },
			),
		).toThrow(/circle/)
	})

	it("explains what it cannot carry over instead of guessing", () => {
		const plan = buildSshBridgePlan(
			"box",
			lookupFrom([{ name: "box", host: "h", password: true, agent: "pageant", proxy: { type: "socks5", host: "p" } }]),
			{ platform: "win32" },
		)

		expect(plan.entries[0].text).not.toContain("IdentityAgent")
		expect(plan.notes.join("\n")).toMatch(/password/)
		expect(plan.notes.join("\n")).toMatch(/Pageant/)
		expect(plan.notes.join("\n")).toMatch(/socks5 proxy at p/)
		expect(plan.notes.join("\n")).toMatch(/names no user/)
	})
})

describe("appendMissingEntries", () => {
	const entries = [
		{ alias: "sshfs-bastion", text: "Host sshfs-bastion\n    HostName b\n" },
		{ alias: "sshfs-box", text: "Host sshfs-box\n    HostName h\n" },
	]

	it("appends only the aliases the file does not declare, after a blank line", () => {
		const current = "Host github.com\n    User git\n\nHost other sshfs-bastion\n    HostName x\n"
		const result = appendMissingEntries(current, entries)

		expect(result.added).toEqual(["sshfs-box"])
		expect(result.existing).toEqual(["sshfs-bastion"])
		expect(result.text).toBe(`${current}\nHost sshfs-box\n    HostName h\n`)
	})

	it("writes into an empty file without leading blank lines, and keeps CRLF files CRLF", () => {
		expect(appendMissingEntries("", entries.slice(1)).text).toBe("Host sshfs-box\n    HostName h\n")
		expect(appendMissingEntries("Host a\r\n    HostName a\r\n", entries.slice(1)).text).toBe(
			"Host a\r\n    HostName a\r\n\r\nHost sshfs-box\r\n    HostName h\r\n",
		)
	})

	it("leaves a file that already declares everything untouched", () => {
		const current = "Host sshfs-box\n    HostName mine\n"
		expect(appendMissingEntries(current, entries.slice(1))).toEqual({ text: current, added: [], existing: ["sshfs-box"] })
	})
})

describe("declaredHostAliases", () => {
	it("reads every alias of a Host line, case-insensitive keyword, quotes dropped", () => {
		expect([...declaredHostAliases('host a "b"\n  HOST c\nHostName d\n')]).toEqual(["a", "b", "c"])
	})
})
