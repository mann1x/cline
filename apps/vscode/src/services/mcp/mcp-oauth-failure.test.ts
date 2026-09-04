import { describe, expect, it, vi } from "vitest"
import { describeMcpOAuthFailure, watchMcpOAuthFetch } from "./mcp-oauth-failure"

const RESOURCE = "https://example.test/mcp"

function responding(...responses: Array<{ url: string; status: number }>): typeof fetch {
	const queue = [...responses]
	return vi.fn(async () => {
		const next = queue.shift()
		return new Response(next?.status === 200 ? "{}" : "Forbidden", { status: next?.status ?? 200 })
	}) as unknown as typeof fetch
}

describe("watchMcpOAuthFetch", () => {
	// The 401 on the resource is how the whole flow starts -- it is the server
	// saying "authenticate first". Recording it as a failure would report the
	// handshake's opening move as the reason it did not finish.
	it("ignores the resource's own 401", async () => {
		const watched = watchMcpOAuthFetch(RESOURCE, responding({ url: RESOURCE, status: 401 }))

		await watched.fetch(RESOURCE, { method: "POST" })

		expect(watched.lastFailure()).toBeUndefined()
	})

	it("ignores the resource's query string when deciding that", async () => {
		const watched = watchMcpOAuthFetch(RESOURCE, responding({ url: RESOURCE, status: 401 }))

		await watched.fetch(`${RESOURCE}?sessionId=abc`, { method: "POST" })

		expect(watched.lastFailure()).toBeUndefined()
	})

	it("records a failing endpoint in the handshake", async () => {
		const watched = watchMcpOAuthFetch(RESOURCE, responding({ url: "x", status: 403 }))

		await watched.fetch("https://example.test/register", { method: "POST", body: "{}" })

		expect(watched.lastFailure()).toEqual({
			url: "https://example.test/register",
			status: 403,
			registration: false,
		})
	})

	// redirect_uris in a JSON body is unique to the registration request, and
	// naming that request is what turns "403" into something actionable.
	it("recognises the registration request by what it sends", async () => {
		const watched = watchMcpOAuthFetch(RESOURCE, responding({ url: "x", status: 403 }))

		await watched.fetch("https://example.test/register", {
			method: "POST",
			body: JSON.stringify({ client_name: "Cline", redirect_uris: ["http://127.0.0.1:1456/cb"] }),
		})

		expect(watched.lastFailure()?.registration).toBe(true)
	})

	it("keeps the most recent failure", async () => {
		const watched = watchMcpOAuthFetch(RESOURCE, responding({ url: "a", status: 404 }, { url: "b", status: 500 }))

		await watched.fetch("https://example.test/.well-known/oauth-authorization-server")
		await watched.fetch("https://example.test/token", { method: "POST", body: "grant_type=..." })

		expect(watched.lastFailure()).toMatchObject({ url: "https://example.test/token", status: 500 })
	})

	it("records nothing while everything succeeds", async () => {
		const watched = watchMcpOAuthFetch(RESOURCE, responding({ url: "a", status: 200 }))

		await watched.fetch("https://example.test/token", { method: "POST" })

		expect(watched.lastFailure()).toBeUndefined()
	})
})

describe("describeMcpOAuthFailure", () => {
	it("says a refused registration sent no credentials", () => {
		const message = describeMcpOAuthFailure("figma", {
			url: "https://example.test/register",
			status: 403,
			registration: true,
		})

		expect(message).toContain("refused to register Cline")
		expect(message).toContain("no credentials were sent")
		expect(message).toContain("oauthClient")
	})

	// Any other endpoint: name it and its status rather than guess, because
	// guessing which endpoint answered is what went wrong twice already.
	it("names the endpoint and status for anything else", () => {
		const message = describeMcpOAuthFailure("acme", {
			url: "https://example.test/token",
			status: 401,
			registration: false,
		})

		expect(message).toContain("HTTP 401")
		expect(message).toContain("https://example.test/token")
		expect(message).not.toContain("refused to register")
	})
})
