import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
	createPkce,
	createShellSession,
	enterFolderCommand,
	exchangeSignIn,
	type OpenWebUiSession,
	RemoteShellConnection,
	refreshSignIn,
	requestSignIn,
	type ShellSocket,
	shellSocketUrl,
	tokenIsFresh,
} from "./remote-shell"

class FakeSocket implements ShellSocket {
	binaryType = "blob"
	readyState = 0
	onopen: ((event: unknown) => void) | null = null
	onmessage: ((event: { data: unknown }) => void) | null = null
	onclose: ((event: { code: number; reason: string }) => void) | null = null
	onerror: ((event: unknown) => void) | null = null
	sent: Array<string | Uint8Array> = []
	closed: number | undefined
	constructor(readonly url: string) {}
	open() {
		this.readyState = 1
		this.onopen?.({})
	}
	send(data: string | Uint8Array) {
		this.sent.push(data)
	}
	close(code?: number) {
		this.closed = code
		this.readyState = 3
	}
	output(start: number, text: string) {
		const bytes = new TextEncoder().encode(text)
		this.onmessage?.({ data: JSON.stringify({ type: "output", start, end: start + bytes.length, truncated: false }) })
		this.onmessage?.({ data: bytes.buffer })
	}
	drop(code: number, reason = "") {
		this.readyState = 3
		this.onclose?.({ code, reason })
	}
	json() {
		return this.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item))
	}
	typed() {
		return this.sent
			.filter((item): item is Uint8Array => typeof item !== "string")
			.map((item) => new TextDecoder().decode(item))
	}
}

function harness(tokens = ["t1", "t2", "t3", "t4"]) {
	const sockets: FakeSocket[] = []
	const timers: Array<{ callback: () => void; ms: number }> = []
	const output: string[] = []
	const notices: string[] = []
	const ended: string[] = []
	let issued = 0
	const connection = new RemoteShellConnection({
		url: "ws://owui/api/v1/machines/m/api/terminals/s1",
		getToken: async () => ({ token: tokens[issued++] ?? "late", expiresAt: 1000 }),
		openSocket: (url) => {
			const socket = new FakeSocket(url)
			sockets.push(socket)
			return socket
		},
		onOutput: (text) => output.push(text),
		onNotice: (text) => notices.push(text),
		onEnded: (reason) => ended.push(reason),
		setTimer: (callback, ms) => {
			timers.push({ callback, ms })
			return timers.length
		},
		clearTimer: () => {},
		now: () => 100,
	})
	return { connection, sockets, timers, output, notices, ended }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("RemoteShellConnection", () => {
	it("signs in first, sizes the shell, sends typing as bytes and shows output", async () => {
		const { connection, sockets, output } = harness()
		connection.resize(120, 40)
		connection.input(" cd '/w' && clear\r")
		await connection.connect()
		const socket = sockets[0]
		socket.open()
		expect(socket.json()[0]).toEqual({ type: "auth", token: "t1", resume: true, cursor: 0 })
		expect(socket.json()[1]).toEqual({ type: "resize", cols: 120, rows: 40 })
		expect(socket.typed()).toEqual([" cd '/w' && clear\r"])
		socket.output(0, "user@box:~$ ")
		connection.input("ls\r")
		expect(socket.typed().at(-1)).toBe("ls\r")
		expect(output.join("")).toBe("user@box:~$ ")
	})

	it("renews the token before it runs out and resumes where the output stopped", async () => {
		const { connection, sockets, timers, output } = harness()
		await connection.connect()
		sockets[0].open()
		sockets[0].output(0, "hello ")
		// Token expires at 1000, now is 100, margin 60: renew in 840 s.
		const renew = timers.at(-1)
		expect(renew?.ms).toBe(840_000)
		renew?.callback()
		await flush()
		expect(sockets[0].closed).toBe(1000)
		sockets[1].open()
		expect(sockets[1].json()[0]).toEqual({ type: "auth", token: "t2", resume: true, cursor: 6 })
		sockets[1].output(6, "world")
		expect(output.join("")).toBe("hello world")
	})

	it("reconnects after a dropped connection, keeping what was typed meanwhile", async () => {
		const { connection, sockets, timers, notices } = harness()
		await connection.connect()
		sockets[0].open()
		sockets[0].output(0, "abc")
		sockets[0].drop(1011, "Terminal connection interrupted. Reconnecting.")
		expect(notices[0]).toContain("reconnecting")
		connection.input("pwd\r")
		timers.at(-1)?.callback()
		await flush()
		sockets[1].open()
		expect(sockets[1].json()[0].cursor).toBe(3)
		expect(sockets[1].typed()).toEqual(["pwd\r"])
	})

	it("stops when the shell has ended or the machine refuses", async () => {
		const { connection, sockets, timers, ended } = harness()
		await connection.connect()
		sockets[0].open()
		const before = timers.length
		sockets[0].drop(4004, "Session has ended")
		expect(ended).toEqual(["Session has ended"])
		expect(timers.length).toBe(before)
	})

	it("decodes characters split across frames", async () => {
		const { connection, sockets, output } = harness()
		await connection.connect()
		sockets[0].open()
		const bytes = new TextEncoder().encode("é")
		sockets[0].onmessage?.({ data: bytes.slice(0, 1).buffer })
		sockets[0].onmessage?.({ data: bytes.slice(1).buffer })
		expect(output.join("")).toBe("é")
	})
})

describe("Open WebUI sign-in", () => {
	it("uses PKCE S256 and the desktop-client endpoints", async () => {
		const pkce = createPkce()
		expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"))
		const calls: Array<{ url: string; body: Record<string, unknown> }> = []
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
			if (url.endsWith("/requests"))
				return new Response(JSON.stringify({ session_id: "11111111-2222-3333-4444-555555555555" }))
			return new Response(JSON.stringify({ token: "jwt", expires_at: 2000, refresh_token: "r1", refresh_expires_at: 9000 }))
		}) as typeof fetch
		const started = await requestSignIn("http://owui:3003/", "http://127.0.0.1:5000/callback", pkce, "VS Code", fetchImpl)
		expect(started.approveUrl).toBe("http://owui:3003/auth/sessions/11111111-2222-3333-4444-555555555555")
		expect(calls[0].body).toEqual({
			name: "VS Code",
			redirect_uri: "http://127.0.0.1:5000/callback",
			state: pkce.state,
			code_challenge: pkce.challenge,
		})
		const session = await exchangeSignIn(
			"http://owui:3003",
			started.sessionId,
			"code",
			pkce,
			"http://127.0.0.1:5000/callback",
			fetchImpl,
		)
		expect(calls[1].url).toBe("http://owui:3003/api/v1/auths/sessions/exchange")
		expect(calls[1].body.code_verifier).toBe(pkce.verifier)
		expect(session).toEqual({
			baseUrl: "http://owui:3003",
			token: "jwt",
			expiresAt: 2000,
			refreshToken: "r1",
			refreshExpiresAt: 9000,
		})
		await refreshSignIn(session, fetchImpl)
		expect(calls[2].url).toBe("http://owui:3003/api/v1/auths/sessions/refresh")
		expect(calls[2].body.refresh_token).toBe("r1")
	})

	it("reports Open WebUI's reason when it refuses", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ detail: "Invalid refresh token. Sign in again." }), {
				status: 401,
			})) as unknown as typeof fetch
		const session: OpenWebUiSession = {
			baseUrl: "http://o",
			token: "t",
			expiresAt: 0,
			refreshToken: "r",
			refreshExpiresAt: 0,
		}
		await expect(refreshSignIn(session, fetchImpl)).rejects.toThrow("401: Invalid refresh token. Sign in again.")
	})

	it("knows when a token is about to run out", () => {
		const session: OpenWebUiSession = { baseUrl: "", token: "", expiresAt: 1000, refreshToken: "", refreshExpiresAt: 0 }
		expect(tokenIsFresh(session, 60, 900)).toBe(true)
		expect(tokenIsFresh(session, 60, 950)).toBe(false)
	})
})

describe("shell plumbing", () => {
	it("opens shells through the machine proxy and quotes the folder", async () => {
		let seen = ""
		const fetchImpl = (async (url: string) => {
			seen = url
			return new Response(JSON.stringify({ id: "ab12cd34", pid: 7 }))
		}) as unknown as typeof fetch
		expect(await createShellSession("https://owui/", "solidpc-bench-app", "jwt", fetchImpl)).toBe("ab12cd34")
		expect(seen).toBe("https://owui/api/v1/machines/solidpc-bench-app/api/terminals")
		expect(shellSocketUrl("https://owui", "m 1", "s")).toBe("wss://owui/api/v1/machines/m%201/api/terminals/s")
		expect(enterFolderCommand("/home/u/cerebriline/it's")).toBe(
			" cd '/home/u/cerebriline/it'\\''s' && export HOME='/home/u/cerebriline/it'\\''s' && clear\r",
		)
	})
})
