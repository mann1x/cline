import { describe, expect, it } from "vitest"
import { applySshFsLayers, expandEnv, resolveSshFsConnection, SshFsConfigError } from "./sshfs-config"

describe("applySshFsLayers", () => {
	it("keeps the most important layer's config and ignores a duplicate below it", () => {
		const configs = applySshFsLayers([
			[{ name: "Box", host: "folder.example" }],
			[{ name: "box", host: "workspace.example", port: 2222 }],
			[{ name: "box", host: "user.example", username: "me" }],
		])

		expect(configs.get("box")).toMatchObject({ name: "box", host: "folder.example" })
		expect(configs.get("box")?.port).toBeUndefined()
	})

	it("fills a merging config's gaps from the duplicates below it", () => {
		const configs = applySshFsLayers([
			[{ name: "box", host: "folder.example", merge: true }],
			[{ name: "box", host: "user.example", username: "me", port: 2222 }],
		])

		expect(configs.get("box")).toMatchObject({ host: "folder.example", username: "me", port: 2222 })
	})

	it("takes an extended config's fields first and lets its own win", () => {
		const configs = applySshFsLayers([
			[
				{ name: "base", host: "base.example", username: "deploy", port: 2200 },
				{ name: "app", extend: "base", host: "app.example" },
			],
		])

		expect(configs.get("app")).toMatchObject({ host: "app.example", username: "deploy", port: 2200 })
	})

	it("skips a config that extends an unknown one, and every config on a cycle", () => {
		const configs = applySshFsLayers([
			[
				{ name: "orphan", extend: "missing", host: "x" },
				{ name: "a", extend: "b", host: "a" },
				{ name: "b", extend: "a", host: "b" },
				{ name: "fine", host: "fine.example" },
			],
		])

		expect([...configs.keys()]).toEqual(["fine"])
	})

	it("ignores entries that are not configs", () => {
		const configs = applySshFsLayers([[null, "text", { host: "no-name" }, { name: "ok", host: "h" }]])

		expect([...configs.keys()]).toEqual(["ok"])
	})
})

describe("expandEnv", () => {
	it("replaces $NAME from the environment, and unknown names with nothing", () => {
		expect(expandEnv("$HOME/.ssh/id_ed25519", { HOME: "/home/me" })).toBe("/home/me/.ssh/id_ed25519")
		expect(expandEnv("$NOPE-x", {})).toBe("-x")
	})
})

describe("resolveSshFsConnection", () => {
	const configs = applySshFsLayers([
		[
			{ name: "box", host: "$BOX_HOST", username: "$USERNAME", port: "2222", privateKeyPath: "$HOME/.ssh/id" },
			{ name: "pw", host: "pw.example", username: "root", password: true },
			{ name: "putty-only", putty: "My Session" },
			{ name: "bad-port", host: "h", port: "99999" },
		],
	])
	const env = { BOX_HOST: "10.0.0.12", HOME: "/home/me", USER: "me" }

	it("expands variables and reads $USERNAME as the local user", () => {
		expect(resolveSshFsConnection(configs, "BOX", env, "fallback")).toMatchObject({
			name: "box",
			host: "10.0.0.12",
			username: "me",
			port: 2222,
			privateKeyPath: "/home/me/.ssh/id",
			usesPassword: false,
		})
	})

	it("falls back to the given local user when the environment has none", () => {
		expect(resolveSshFsConnection(configs, "box", { BOX_HOST: "h" }, "fallback").username).toBe("fallback")
	})

	it("marks a config with a password, or with neither key nor agent, as a password login", () => {
		expect(resolveSshFsConnection(configs, "pw", env, "me").usesPassword).toBe(true)
	})

	it("explains a config whose host comes from a PuTTY session", () => {
		expect(() => resolveSshFsConnection(configs, "putty-only", env, "me")).toThrow(/PuTTY session/)
	})

	it("refuses an unknown name and an invalid port", () => {
		expect(() => resolveSshFsConnection(configs, "nope", env, "me")).toThrow(SshFsConfigError)
		expect(() => resolveSshFsConnection(configs, "bad-port", env, "me")).toThrow(/invalid port/)
	})
})
