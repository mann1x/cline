import { afterEach, beforeEach, describe, it } from "bun:test"
import "should"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import sinon from "sinon"
import { McpHub } from "../McpHub"

/**
 * Unit tests for McpHub.callTool() method.
 *
 * Focuses on the fix: `arguments: toolArguments ?? {}` ensuring that
 * undefined toolArguments are sent as an empty object `{}` to comply
 * with MCP SDK's Zod validation (ZodRecord<ZodString, ZodUnknown>).
 *
 * These tests exercise the real `McpHub.callTool` method by building a
 * partially-initialized `McpHub` instance (bypassing the constructor's
 * filesystem side-effects) and injecting only the state `callTool`
 * actually touches: `connections` and `telemetryService`.
 */

/** Minimal mock for MCP Client.request() */
function createMockClient(responseOverride?: any) {
	return {
		request: sinon.stub().resolves(
			responseOverride ?? {
				content: [{ type: "text", text: "success" }],
			},
		),
	}
}

/** Minimal mock for TelemetryService */
function createMockTelemetryService() {
	return {
		captureMcpToolCall: sinon.stub(),
	}
}

/**
 * Build a real `McpHub` instance without triggering the constructor's
 * filesystem watchers / server-initialization side effects, then inject
 * the minimum state required by `callTool`.
 *
 * We use `Object.create(McpHub.prototype)` so that invoking `hub.callTool`
 * dispatches to the actual production implementation rather than a
 * re-implementation.
 */
function createMcpHub(
	options: { client?: ReturnType<typeof createMockClient>; serverName?: string; disabled?: boolean; config?: string } = {},
) {
	const client = options.client ?? createMockClient()
	const serverName = options.serverName ?? "test-server"
	const telemetryService = createMockTelemetryService()

	const connection = {
		server: {
			name: serverName,
			config: options.config ?? JSON.stringify({ type: "stdio", command: "test", timeout: 60 }),
			status: "connected",
			disabled: options.disabled ?? false,
		},
		client,
		transport: {},
	}

	const hub = Object.create(McpHub.prototype) as McpHub
	;(hub as any).telemetryService = telemetryService
	;(hub as any).connections = [connection]

	return { hub, client, telemetryService, connection }
}

describe("McpHub.callTool", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
	})

	// ── Core fix: undefined arguments → empty object ────────────────────

	describe("arguments fallback to empty object", () => {
		it("should pass empty object {} when toolArguments is undefined", async () => {
			const { hub, client } = createMcpHub()

			await hub.callTool("test-server", "list_pages", undefined, "ulid-001")

			client.request.calledOnce.should.be.true()
			const requestArgs = client.request.firstCall.args[0]
			requestArgs.params.arguments.should.deepEqual({})
		})

		it("should pass the provided arguments object when toolArguments is defined", async () => {
			const { hub, client } = createMcpHub()
			const args = { url: "https://example.com", verbose: true }

			await hub.callTool("test-server", "navigate_page", args, "ulid-002")

			client.request.calledOnce.should.be.true()
			const requestArgs = client.request.firstCall.args[0]
			requestArgs.params.arguments.should.deepEqual({ url: "https://example.com", verbose: true })
		})

		it("should pass empty object {} when toolArguments is explicitly passed as undefined", async () => {
			const { hub, client } = createMcpHub()

			await hub.callTool("test-server", "take_screenshot", undefined, "ulid-003")

			const requestArgs = client.request.firstCall.args[0]
			requestArgs.params.arguments.should.deepEqual({})
			// Ensure it's an object, not null or undefined
			;(typeof requestArgs.params.arguments).should.equal("object")
			;(requestArgs.params.arguments === null).should.be.false()
		})

		it("should preserve arguments with falsy values inside the object", async () => {
			const { hub, client } = createMcpHub()
			const args = { enabled: false, count: 0, name: "" }

			await hub.callTool("test-server", "configure", args, "ulid-004")

			const requestArgs = client.request.firstCall.args[0]
			requestArgs.params.arguments.should.deepEqual({ enabled: false, count: 0, name: "" })
		})

		it("should pass an already-empty object through unchanged", async () => {
			const { hub, client } = createMcpHub()

			await hub.callTool("test-server", "list_pages", {}, "ulid-005")

			const requestArgs = client.request.firstCall.args[0]
			requestArgs.params.arguments.should.deepEqual({})
		})
	})

	// ── Request structure validation ────────────────────────────────────

	describe("request structure", () => {
		it("should always include method 'tools/call' in the request", async () => {
			const { hub, client } = createMcpHub()

			await hub.callTool("test-server", "any_tool", undefined, "ulid-006")

			const requestArgs = client.request.firstCall.args[0]
			requestArgs.method.should.equal("tools/call")
		})

		it("should set the tool name in params.name", async () => {
			const { hub, client } = createMcpHub()

			await hub.callTool("test-server", "list_pages", undefined, "ulid-007")

			const requestArgs = client.request.firstCall.args[0]
			requestArgs.params.name.should.equal("list_pages")
		})

		it("should pass timeout in request options", async () => {
			const { hub, client } = createMcpHub()

			await hub.callTool("test-server", "slow_tool", { query: "test" }, "ulid-008")

			const requestOptions = client.request.firstCall.args[2]
			requestOptions.should.have.property("timeout")
			requestOptions.timeout.should.be.a.Number()
			requestOptions.timeout.should.be.above(0)
		})

		it("should pass the abort signal in request options", async () => {
			const { hub, client } = createMcpHub()
			const controller = new AbortController()

			await hub.callTool("test-server", "slow_tool", undefined, "ulid-signal", controller.signal)

			client.request.firstCall.args[2].signal.should.equal(controller.signal)
		})
	})

	// ── Per-server timeout resolution ─────────────────────────────────

	describe("timeout resolution", () => {
		it("should pass the configured per-server timeout (seconds) as ms", async () => {
			const { hub, client } = createMcpHub({
				config: JSON.stringify({ type: "stdio", command: "test", timeout: 120 }),
			})

			await hub.callTool("test-server", "slow_tool", undefined, "ulid-t01")

			const requestOptions = client.request.firstCall.args[2]
			requestOptions.timeout.should.equal(120_000)
		})

		it("should clamp a milliseconds/seconds mix-up to the maximum", async () => {
			const { hub, client } = createMcpHub({
				config: JSON.stringify({ type: "stdio", command: "test", timeout: 60000 }),
			})

			await hub.callTool("test-server", "slow_tool", undefined, "ulid-t02")

			const requestOptions = client.request.firstCall.args[2]
			requestOptions.timeout.should.equal(3_600_000)
		})

		it("should fall back to the default when the config is malformed", async () => {
			const { hub, client } = createMcpHub({ config: "not-json" })

			await hub.callTool("test-server", "slow_tool", undefined, "ulid-t03")

			const requestOptions = client.request.firstCall.args[2]
			requestOptions.timeout.should.equal(60_000)
		})

		it("should apply the per-server timeout to metadata requests (tools/list)", async () => {
			const { hub, client } = createMcpHub({
				client: createMockClient({ tools: [] }),
				config: JSON.stringify({ type: "stdio", command: "test", timeout: 120 }),
			})

			await (hub as any).fetchToolsList("test-server")

			client.request.calledOnce.should.be.true()
			const requestArgs = client.request.firstCall.args[0]
			requestArgs.method.should.equal("tools/list")
			const requestOptions = client.request.firstCall.args[2]
			requestOptions.timeout.should.equal(120_000)
		})

		it("should fetch the four capability lists in parallel", async () => {
			// Each request resolves on the next macrotask and records how many
			// requests were in flight when it started. Sequential awaits would
			// observe one in-flight request each; parallel dispatch observes all
			// four before the first resolves.
			let inFlight = 0
			const inFlightAtStart: number[] = []
			const client = {
				request: sinon.stub().callsFake((request: { method: string }) => {
					inFlight += 1
					inFlightAtStart.push(inFlight)
					return new Promise((resolve) => {
						setTimeout(() => {
							inFlight -= 1
							resolve(
								request.method === "tools/list"
									? { tools: [] }
									: request.method === "resources/list"
										? { resources: [] }
										: request.method === "resources/templates/list"
											? { resourceTemplates: [] }
											: { prompts: [] },
							)
						}, 0)
					})
				}),
			}
			const { hub, connection } = createMcpHub({ client: client as never })

			await (hub as any).fetchServerCapabilities(connection)

			client.request.callCount.should.equal(4)
			Math.max(...inFlightAtStart).should.equal(4)
		})

		it("should augment request-timeout errors with how to raise the bound", async () => {
			const failingClient = {
				request: sinon.stub().rejects(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
			}
			const { hub } = createMcpHub({
				client: failingClient,
				config: JSON.stringify({ type: "stdio", command: "test", timeout: 120 }),
			})

			let thrown: any
			try {
				await hub.callTool("test-server", "slow_tool", undefined, "ulid-t04")
			} catch (error) {
				thrown = error
			}

			thrown.should.be.instanceOf(McpError)
			thrown.code.should.equal(ErrorCode.RequestTimeout)
			thrown.message.should.match(/timed out after 120s/)
			thrown.message.should.match(/"timeout" field \(in seconds\)/)
		})
	})

	// ── Error handling ──────────────────────────────────────────────────

	describe("error handling", () => {
		it("should throw when server connection is not found", async () => {
			const { hub } = createMcpHub({ serverName: "existing-server" })

			let threw = false
			try {
				await hub.callTool("nonexistent-server", "some_tool", undefined, "ulid-009")
			} catch (error: any) {
				threw = true
				error.message.should.containEql("No connection found for server: nonexistent-server")
			}
			threw.should.be.true()
		})

		it("should throw when server is disabled", async () => {
			const { hub } = createMcpHub({ disabled: true })

			let threw = false
			try {
				await hub.callTool("test-server", "some_tool", undefined, "ulid-010")
			} catch (error: any) {
				threw = true
				error.message.should.containEql("disabled")
			}
			threw.should.be.true()
		})

		it("should throw a controlled error when the connection has no client (failed reconnect)", async () => {
			// A failed (re)connect registers a disconnected entry with a null
			// client; a tool wrapper captured by an active session can still
			// call it and must get a controlled error, not a TypeError.
			const { hub, connection } = createMcpHub()
			connection.server.status = "disconnected"
			;(connection.server as any).error = "spawn broken-command ENOENT"
			;(connection as any).client = null

			let threw = false
			try {
				await hub.callTool("test-server", "some_tool", undefined, "ulid-018")
			} catch (error: any) {
				threw = true
				error.message.should.containEql('Server "test-server" is not connected')
				error.message.should.containEql("spawn broken-command ENOENT")
			}
			threw.should.be.true()
		})

		it("should reconnect and retry once when the transport died before the call", async () => {
			// A stdio server that exits clears the client's transport but leaves the
			// client in place, so every later call rejected with a bare `Not connected`
			// that reached the model as the tool's own result. The SDK raises this
			// before the request is written, so nothing was sent and the retry cannot
			// duplicate a side effect.
			const deadClient = createMockClient()
			deadClient.request.rejects(new Error("Not connected"))
			const { hub, telemetryService } = createMcpHub({ client: deadClient })
			const freshClient = createMockClient({ content: [{ type: "text", text: "back" }] })
			const reconnect = sinon.stub(hub as any, "reconnectForToolCall").callsFake(async () => ({
				server: { name: "test-server", status: "connected" },
				client: freshClient,
			}))

			const result = await hub.callTool("test-server", "memory_read_graph", { a: 1 }, "ulid-nc1")

			reconnect.calledOnceWith("test-server").should.be.true()
			freshClient.request.calledOnce.should.be.true()
			freshClient.request.firstCall.args[0].params.name.should.equal("memory_read_graph")
			;(result.content[0] as { type: "text"; text: string }).text.should.equal("back")
			telemetryService.captureMcpToolCall.secondCall.args[3].should.equal("success")
		})

		it("should not retry a call that was aborted", async () => {
			const deadClient = createMockClient()
			deadClient.request.rejects(new Error("Not connected"))
			const { hub } = createMcpHub({ client: deadClient })
			const reconnect = sinon.stub(hub as any, "reconnectForToolCall")
			const controller = new AbortController()
			controller.abort()

			let threw = false
			try {
				await hub.callTool("test-server", "some_tool", undefined, "ulid-nc2", controller.signal)
			} catch {
				threw = true
			}

			threw.should.be.true()
			reconnect.called.should.be.false()
		})

		it("should say the server went away when the reconnect fails", async () => {
			// `Not connected` on its own told neither the model nor the user anything.
			const deadClient = createMockClient()
			deadClient.request.rejects(new Error("Not connected"))
			const { hub, connection } = createMcpHub({ client: deadClient })
			;(connection.server as any).error = "spawn npx ENOENT"
			sinon.stub(hub as any, "reconnectForToolCall").resolves(undefined)

			let threw = false
			try {
				await hub.callTool("test-server", "memory_read_graph", undefined, "ulid-nc3")
			} catch (error: any) {
				threw = true
				error.message.should.containEql('Server "test-server" disconnected and could not be reconnected')
				error.message.should.containEql("memory_read_graph was not run")
				error.message.should.containEql("spawn npx ENOENT")
			}
			threw.should.be.true()
		})

		it("should not retry a failure that reached the server", async () => {
			// Anything but the pre-send `Not connected` may have run already.
			const client = createMockClient()
			client.request.rejects(new Error("Tool execution failed"))
			const { hub } = createMcpHub({ client })
			const reconnect = sinon.stub(hub as any, "reconnectForToolCall")

			let threw = false
			try {
				await hub.callTool("test-server", "some_tool", undefined, "ulid-nc4")
			} catch {
				threw = true
			}

			threw.should.be.true()
			reconnect.called.should.be.false()
			client.request.calledOnce.should.be.true()
		})

		it("should capture error telemetry when client.request fails", async () => {
			const client = createMockClient()
			client.request.rejects(new Error("Network timeout"))
			const { hub, telemetryService } = createMcpHub({ client })

			let threw = false
			try {
				await hub.callTool("test-server", "failing_tool", { key: "value" }, "ulid-011")
			} catch {
				threw = true
			}

			threw.should.be.true()
			telemetryService.captureMcpToolCall.calledTwice.should.be.true()

			// First call: "started"
			const startedCall = telemetryService.captureMcpToolCall.firstCall.args
			startedCall[3].should.equal("started")

			// Second call: "error"
			const errorCall = telemetryService.captureMcpToolCall.secondCall.args
			errorCall[3].should.equal("error")
			errorCall[4].should.equal("Network timeout")
		})
	})

	// ── Reconnect used by a tool call ───────────────────────────────────

	describe("reconnectForToolCall", () => {
		it("should rebuild the connection from its in-memory config", async () => {
			const { hub, connection } = createMcpHub()
			connection.server.status = "disconnected"
			const deleteConnection = sinon.stub(hub as any, "deleteConnection").callsFake(async () => {
				;(hub as any).connections = []
			})
			const connectToServer = sinon.stub(hub as any, "connectToServer").callsFake(async () => {
				;(hub as any).connections = [{ ...connection, server: { ...connection.server, status: "connected" } }]
			})
			sinon.stub(hub as any, "notifyWebviewOfServerChanges").resolves()

			const result = await (hub as any).reconnectForToolCall("test-server")

			deleteConnection.calledOnceWith("test-server").should.be.true()
			connectToServer.firstCall.args[1].should.have.property("command", "test")
			connectToServer.firstCall.args[2].should.equal("internal")
			result.server.status.should.equal("connected")
			;(hub as any).isConnecting.should.be.false()
		})

		it("should report failure rather than hand back a half-built connection", async () => {
			const { hub } = createMcpHub()
			sinon.stub(hub as any, "deleteConnection").callsFake(async () => {
				;(hub as any).connections = []
			})
			sinon.stub(hub as any, "connectToServer").rejects(new Error("spawn npx ENOENT"))
			const notify = sinon.stub(hub as any, "notifyWebviewOfServerChanges").resolves()

			const result = await (hub as any).reconnectForToolCall("test-server")

			should(result).be.undefined()
			// The failure still reaches the server list, so the panel does not keep
			// showing a server as connecting forever.
			notify.calledOnce.should.be.true()
			;(hub as any).isConnecting.should.be.false()
		})
	})

	// ── Telemetry ───────────────────────────────────────────────────────

	describe("telemetry", () => {
		it("should capture 'started' telemetry before request and 'success' after", async () => {
			const { hub, telemetryService } = createMcpHub()

			await hub.callTool("test-server", "list_pages", undefined, "ulid-012")

			telemetryService.captureMcpToolCall.calledTwice.should.be.true()
			telemetryService.captureMcpToolCall.firstCall.args[3].should.equal("started")
			telemetryService.captureMcpToolCall.secondCall.args[3].should.equal("success")
		})

		it("should report undefined for argument keys when toolArguments is undefined", async () => {
			const { hub, telemetryService } = createMcpHub()

			await hub.callTool("test-server", "list_pages", undefined, "ulid-013")

			// Both started and success should report undefined argument keys
			const startedArgKeys = telemetryService.captureMcpToolCall.firstCall.args[5]
			should(startedArgKeys).be.undefined()

			const successArgKeys = telemetryService.captureMcpToolCall.secondCall.args[5]
			should(successArgKeys).be.undefined()
		})

		it("should report argument keys when toolArguments is provided", async () => {
			const { hub, telemetryService } = createMcpHub()

			await hub.callTool("test-server", "navigate", { url: "https://x.com", timeout: 5000 }, "ulid-014")

			const startedArgKeys = telemetryService.captureMcpToolCall.firstCall.args[5]
			startedArgKeys.should.deepEqual(["url", "timeout"])
		})
	})

	// ── Response handling ───────────────────────────────────────────────

	describe("response handling", () => {
		it("should return content array from successful response", async () => {
			const client = createMockClient({
				content: [{ type: "text", text: "page list result" }],
			})
			const { hub } = createMcpHub({ client })

			const result = await hub.callTool("test-server", "list_pages", undefined, "ulid-015")

			result.content.should.be.an.Array()
			result.content.should.have.length(1)
			;(result.content[0] as { type: "text"; text: string }).text.should.equal("page list result")
		})

		it("should default content to empty array when response content is undefined", async () => {
			const client = createMockClient({ content: undefined })
			const { hub } = createMcpHub({ client })

			const result = await hub.callTool("test-server", "list_pages", undefined, "ulid-016")

			result.content.should.be.an.Array()
			result.content.should.have.length(0)
		})
	})
})
