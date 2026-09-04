import { afterEach, beforeEach, describe, it, mock } from "bun:test"
import "should"
import * as actualDiskModule from "@core/storage/disk"
import fs, * as actualFsPromises from "fs/promises"
import os from "os"
import path from "path"
import sinon from "sinon"

// Same module-level mocking as McpHub.deleteServerRPC.test.ts: bun loads real
// ESM, so the settings path and the file writers have to be replaced on the
// exact specifiers the SUT imports.
const realWriteFile = actualFsPromises.writeFile
const getMcpSettingsFilePathStub: sinon.SinonStub = sinon.stub()
const writeFileStub: sinon.SinonStub = sinon.stub()
const diskMock = () => ({ ...actualDiskModule, getMcpSettingsFilePath: getMcpSettingsFilePathStub })
const fsPromisesNamespace = { ...actualFsPromises, writeFile: writeFileStub }
const fsPromisesMock = () => ({ ...fsPromisesNamespace, default: fsPromisesNamespace })
mock.module("@core/storage/disk", diskMock)
mock.module("@/core/storage/disk", diskMock)
mock.module("fs/promises", fsPromisesMock)
mock.module("node:fs/promises", fsPromisesMock)

// The failure path reports to the user through the host bridge, which no unit
// test stands up. Without this the dialog throws over whatever actually went
// wrong and the test reports the wrong error.
const shownMessages: string[] = []
mock.module("@/hosts/host-provider", () => ({
	HostProvider: { window: { showMessage: async (request: { message: string }) => shownMessages.push(request.message) } },
}))

import { McpHub } from "../McpHub"

/**
 * Setting the OAuth client on a server that already exists.
 *
 * The path that matters for a server which refuses to register one for us —
 * Figma's answers every anonymous registration with a bare 403 — where the
 * client the user creates in the provider's console is the only one that will
 * ever work.
 */
describe("McpHub.updateServerOAuthClientRPC", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let settingsPath: string
	let hub: McpHub

	const writeSettings = async (mcpServers: Record<string, unknown>) => {
		await fs.writeFile(settingsPath, JSON.stringify({ mcpServers }, null, 2))
	}
	const readSettings = async () => JSON.parse(await fs.readFile(settingsPath, "utf-8"))

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = path.join(os.tmpdir(), `mcp-oauth-client-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })
		settingsPath = path.join(tempDir, "cline_mcp_settings.json")
		getMcpSettingsFilePathStub.reset()
		getMcpSettingsFilePathStub.resolves(settingsPath)
		writeFileStub.reset()
		writeFileStub.callsFake((...args: unknown[]) => (realWriteFile as (...a: unknown[]) => Promise<void>)(...args))

		hub = Object.create(McpHub.prototype) as McpHub
		;(hub as any).getSettingsDirectoryPath = async () => tempDir
		;(hub as any).connections = []
		sandbox.stub(hub as any, "updateServerConnectionsRPC").resolves()
		sandbox.stub(hub as any, "getSortedMcpServers").returns([])
	})

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
	})

	it("writes the client the provider issued", async () => {
		await writeSettings({ figma: { url: "https://mcp.figma.com/mcp" } })

		await hub.updateServerOAuthClientRPC("figma", { clientId: "abc123", clientSecret: "s3cret" })

		const persisted = await readSettings()
		persisted.mcpServers.figma.oauthClient.should.deepEqual({ clientId: "abc123", clientSecret: "s3cret" })
		persisted.mcpServers.figma.url.should.equal("https://mcp.figma.com/mcp")
	})

	it("writes a public client with no secret at all", async () => {
		await writeSettings({ figma: { url: "https://mcp.figma.com/mcp" } })

		await hub.updateServerOAuthClientRPC("figma", { clientId: "abc123" })

		const persisted = await readSettings()
		persisted.mcpServers.figma.oauthClient.should.deepEqual({ clientId: "abc123" })
	})

	// A user who pasted the wrong id must not be stuck with it.
	it("clears the entry when the client id is empty", async () => {
		await writeSettings({
			figma: { url: "https://mcp.figma.com/mcp", oauthClient: { clientId: "old" } },
		})

		await hub.updateServerOAuthClientRPC("figma", { clientId: "  " })

		const persisted = await readSettings()
		Object.hasOwn(persisted.mcpServers.figma, "oauthClient").should.be.false()
		persisted.mcpServers.figma.url.should.equal("https://mcp.figma.com/mcp")
	})

	// Whatever a previous attempt registered or was issued belongs to the old
	// client. Left in place it sends the next connection back to the client the
	// user has just replaced, which fails in a way that reads like the new one
	// is wrong.
	it("drops the tokens and the registered client the old one left behind", async () => {
		await writeSettings({
			figma: {
				url: "https://mcp.figma.com/mcp",
				oauth: {
					clientInformation: { client_id: "registered-earlier" },
					tokens: { access_token: "stale" },
					redirectUrl: "http://127.0.0.1:14561/callback",
				},
			},
		})

		await hub.updateServerOAuthClientRPC("figma", { clientId: "abc123" })

		const persisted = await readSettings()
		const state = persisted.mcpServers.figma.oauth ?? {}
		Object.hasOwn(state, "tokens").should.be.false()
		Object.hasOwn(state, "clientInformation").should.be.false()
		// The redirect the server may already have registered is kept.
		state.redirectUrl.should.equal("http://127.0.0.1:14561/callback")
	})

	it("refuses a secret with no client id to belong to", async () => {
		await writeSettings({ figma: { url: "https://mcp.figma.com/mcp" } })

		let threw = false
		try {
			await hub.updateServerOAuthClientRPC("figma", { clientSecret: "orphan" })
		} catch (error) {
			threw = true
			String(error).should.match(/client ID/)
		}
		threw.should.be.true()
	})

	it("refuses a server that is not in the settings", async () => {
		await writeSettings({ figma: { url: "https://mcp.figma.com/mcp" } })

		let threw = false
		try {
			await hub.updateServerOAuthClientRPC("nowhere", { clientId: "abc" })
		} catch {
			threw = true
		}
		threw.should.be.true()
	})
})
