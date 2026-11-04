import { afterEach, beforeEach, describe, it, mock } from "bun:test"
import "should"
import sinon from "sinon"

// Sign-out reports through the host bridge, which no unit test stands up.
const shownMessages: string[] = []
mock.module("@/hosts/host-provider", () => ({
	HostProvider: { window: { showMessage: async (request: { message: string }) => shownMessages.push(request.message) } },
}))

// What the manager hands to @cline/core is checked against a stand-in for it.
const authorizeStub: sinon.SinonStub = sinon.stub()
const signOutStub: sinon.SinonStub = sinon.stub()
const actualCore = await import("@cline/core")
mock.module("@cline/core", () => ({
	...actualCore,
	authorizeMcpServerOAuth: authorizeStub,
	signOutMcpServerOAuth: signOutStub,
}))

const { McpHub } = await import("../McpHub")
const { McpOAuthManager } = await import("../McpOAuthManager")

/**
 * Changing the account an OAuth server is signed in with. Authenticate is
 * answered by stored tokens that still work, so before these a server signed
 * in with the wrong account stayed that way until its tokens expired.
 */
describe("MCP OAuth: sign out and another account", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		shownMessages.length = 0
		authorizeStub.reset()
		signOutStub.reset()
		authorizeStub.resolves({ serverName: "docs", authorized: true, message: "done" })
	})

	afterEach(() => {
		sandbox.restore()
	})

	function createHub(signOutResult = { hadTokens: true, revoked: true }) {
		const hub = Object.create(McpHub.prototype) as InstanceType<typeof McpHub>
		const manager = {
			signOut: sandbox.stub().resolves(signOutResult),
			startOAuthFlow: sandbox.stub().resolves(),
		}
		;(hub as any).connections = [
			{
				server: {
					name: "docs",
					config: JSON.stringify({ type: "streamableHttp", url: "https://mcp.example.test/mcp" }),
					status: "connected",
					disabled: false,
					oauthRequired: true,
					oauthAuthStatus: "authenticated",
				},
				client: {},
				transport: {},
			},
		]
		;(hub as any).mcpOAuthManager = manager
		const restart = sandbox.stub(hub as any, "restartConnection").resolves()
		sandbox.stub(hub as any, "notifyWebviewOfServerChanges").resolves()
		return { hub, manager, restart }
	}

	it("signs out, then reconnects so the server asks to be authenticated", async () => {
		const { hub, manager, restart } = createHub()
		await hub.signOutMcpServer("docs")
		manager.signOut.calledOnceWithExactly("docs").should.be.true()
		restart.calledOnceWithExactly("docs").should.be.true()
		manager.signOut.calledBefore(restart).should.be.true()
		shownMessages.should.eql(["Signed out of docs."])
	})

	it("says when the server could not be asked to revoke the sign-in", async () => {
		const { hub } = createHub({ hadTokens: true, revoked: false })
		await hub.signOutMcpServer("docs")
		shownMessages[0].should.match(/lasts on its side until it expires/)
	})

	it("says when there was nothing to sign out of", async () => {
		const { hub } = createHub({ hadTokens: false, revoked: false })
		await hub.signOutMcpServer("docs")
		shownMessages.should.eql(["docs was not signed in."])
	})

	it("refuses a server it does not know", async () => {
		const { hub, manager } = createHub()
		await hub.signOutMcpServer("other").should.be.rejectedWith(/No connection found/)
		manager.signOut.called.should.be.false()
	})

	it("passes 'another account' through to the flow", async () => {
		const { hub, manager, restart } = createHub()
		await hub.initiateOAuth("docs", { switchAccount: true })
		manager.startOAuthFlow.calledOnceWithExactly("docs", { switchAccount: true }).should.be.true()
		restart.calledOnceWithExactly("docs").should.be.true()
	})

	it("asks core to forget the tokens and show the account chooser for another account", async () => {
		const manager = new McpOAuthManager(async () => "/tmp/settings.json")
		await manager.startOAuthFlow("docs", { switchAccount: true })
		const options = authorizeStub.firstCall.args[0]
		options.serverName.should.equal("docs")
		options.reauthorize.should.be.true()
		options.prompt.should.equal("select_account")
	})

	it("leaves a plain Authenticate as it was", async () => {
		const manager = new McpOAuthManager(async () => "/tmp/settings.json")
		await manager.startOAuthFlow("docs")
		const options = authorizeStub.firstCall.args[0]
		;(options.reauthorize === undefined).should.be.true()
		;(options.prompt === undefined).should.be.true()
	})

	it("signs out through core with the settings file", async () => {
		signOutStub.resolves({ serverName: "docs", hadTokens: true, revoked: true })
		const manager = new McpOAuthManager(async () => "/tmp/settings.json")
		const result = await manager.signOut("docs")
		result.should.eql({ serverName: "docs", hadTokens: true, revoked: true })
		const options = signOutStub.firstCall.args[0]
		options.serverName.should.equal("docs")
		options.filePath.should.equal("/tmp/settings.json")
	})
})
