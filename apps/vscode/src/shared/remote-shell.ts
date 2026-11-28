import { createHash, randomBytes, randomUUID } from "node:crypto"

/**
 * The parts of "Remote terminals: open a shell" that do not need VS Code:
 * signing in to Open WebUI as a desktop client, keeping that sign-in fresh,
 * and one interactive shell on a machine over Open WebUI's terminal socket.
 *
 * Why a sign-in and not the API key: Open WebUI's terminal socket accepts only
 * a signed-in session token (a JWT), and checks it again every ten seconds.
 * Open WebUI has a sign-in for desktop clients for this (`/api/v1/auths/sessions`):
 * the user approves it in the browser, the client gets a short access token
 * and a refresh token. Before the access token runs out, the connection signs
 * in again with a fresh one and resumes the shell where it left off, so the
 * user sees nothing.
 */

export interface OpenWebUiSession {
	/** The Open WebUI this sign-in belongs to (no trailing slash). */
	baseUrl: string
	token: string
	/** Epoch seconds. */
	expiresAt: number
	refreshToken: string
	/** Epoch seconds. */
	refreshExpiresAt: number
}

export interface PkcePair {
	verifier: string
	challenge: string
	state: string
}

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export function createPkce(): PkcePair {
	const verifier = base64url(randomBytes(48))
	return {
		verifier,
		challenge: base64url(createHash("sha256").update(verifier).digest()),
		state: base64url(randomBytes(32)),
	}
}

export function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "")
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown, token?: string): Promise<T> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	})
	const text = await response.text()
	if (!response.ok) {
		let detail = text
		try {
			const parsed = JSON.parse(text) as { detail?: unknown }
			if (typeof parsed.detail === "string") detail = parsed.detail
		} catch {}
		throw new Error(`Open WebUI answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`)
	}
	return (text ? JSON.parse(text) : {}) as T
}

/** Starts a sign-in; the user approves it at `approveUrl` in the browser. */
export async function requestSignIn(
	baseUrl: string,
	redirectUri: string,
	pkce: PkcePair,
	name: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ sessionId: string; approveUrl: string }> {
	const url = normalizeBaseUrl(baseUrl)
	const created = await postJson<{ session_id?: string }>(fetchImpl, `${url}/api/v1/auths/sessions/requests`, {
		name,
		redirect_uri: redirectUri,
		state: pkce.state,
		code_challenge: pkce.challenge,
	})
	if (!created.session_id) throw new Error("Open WebUI did not start a sign-in.")
	return { sessionId: created.session_id, approveUrl: `${url}/auth/sessions/${encodeURIComponent(created.session_id)}` }
}

interface Credentials {
	token?: string
	expires_at?: number
	refresh_token?: string
	refresh_expires_at?: number
}

function toSession(baseUrl: string, credentials: Credentials): OpenWebUiSession {
	if (!credentials.token || !credentials.refresh_token) throw new Error("Open WebUI did not return a sign-in.")
	const now = Math.floor(Date.now() / 1000)
	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		token: credentials.token,
		expiresAt: credentials.expires_at ?? now + 900,
		refreshToken: credentials.refresh_token,
		refreshExpiresAt: credentials.refresh_expires_at ?? now + 900,
	}
}

/** Trades the code the browser sent back for a session. */
export async function exchangeSignIn(
	baseUrl: string,
	sessionId: string,
	code: string,
	pkce: PkcePair,
	redirectUri: string,
	fetchImpl: typeof fetch = fetch,
): Promise<OpenWebUiSession> {
	const url = normalizeBaseUrl(baseUrl)
	const credentials = await postJson<Credentials>(fetchImpl, `${url}/api/v1/auths/sessions/exchange`, {
		session_id: sessionId,
		code,
		code_verifier: pkce.verifier,
		redirect_uri: redirectUri,
	})
	return toSession(url, credentials)
}

/** A new access token; Open WebUI rotates the refresh token on every use. */
export async function refreshSignIn(session: OpenWebUiSession, fetchImpl: typeof fetch = fetch): Promise<OpenWebUiSession> {
	const credentials = await postJson<Credentials>(fetchImpl, `${session.baseUrl}/api/v1/auths/sessions/refresh`, {
		refresh_token: session.refreshToken,
		request_id: randomUUID(),
	})
	return toSession(session.baseUrl, credentials)
}

/** Whether the access token is still good for at least `marginSeconds`. */
export function tokenIsFresh(session: OpenWebUiSession, marginSeconds = 60, now = Date.now() / 1000): boolean {
	return session.expiresAt - marginSeconds > now
}

/** Opens a new shell on the machine and returns its session id. */
export async function createShellSession(
	baseUrl: string,
	machineId: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const created = await postJson<{ id?: string; error?: string }>(
		fetchImpl,
		`${normalizeBaseUrl(baseUrl)}/api/v1/machines/${encodeURIComponent(machineId)}/api/terminals`,
		{},
		token,
	)
	if (!created.id) throw new Error(created.error ?? "The machine did not open a shell.")
	return created.id
}

/** Ends a shell on the machine. Missing already is fine. */
export async function deleteShellSession(
	baseUrl: string,
	machineId: string,
	shellId: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await fetchImpl(
		`${normalizeBaseUrl(baseUrl)}/api/v1/machines/${encodeURIComponent(machineId)}/api/terminals/${encodeURIComponent(shellId)}`,
		{ method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
	)
}

export function shellSocketUrl(baseUrl: string, machineId: string, shellId: string): string {
	const ws = normalizeBaseUrl(baseUrl)
		.replace(/^https:/, "wss:")
		.replace(/^http:/, "ws:")
	return `${ws}/api/v1/machines/${encodeURIComponent(machineId)}/api/terminals/${encodeURIComponent(shellId)}`
}

/** What typing `cd` there would be: the shell starts in the conversation's folder, with HOME there like the model's commands. */
export function enterFolderCommand(path: string): string {
	const quoted = `'${path.replace(/'/g, `'\\''`)}'`
	return ` cd ${quoted} && export HOME=${quoted} && clear\r`
}

/** The few WebSocket members used, so tests can pass a fake. */
export interface ShellSocket {
	binaryType: string
	readyState: number
	onopen: ((event: unknown) => void) | null
	onmessage: ((event: { data: unknown }) => void) | null
	onclose: ((event: { code: number; reason: string }) => void) | null
	onerror: ((event: unknown) => void) | null
	send(data: string | Uint8Array): void
	close(code?: number, reason?: string): void
}

export interface RemoteShellOptions {
	url: string
	/** A token good for a while; called again for every reconnect. */
	getToken: () => Promise<{ token: string; expiresAt: number }>
	openSocket: (url: string) => ShellSocket
	onOutput: (text: string) => void
	/** Said in the terminal: reconnecting, ended. */
	onNotice: (text: string) => void
	/** The shell is gone for good (it exited, or the machine refused). */
	onEnded: (reason: string) => void
	/** Reconnect this long before the token runs out. */
	refreshMarginSeconds?: number
	setTimer?: (callback: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
	now?: () => number
}

/** Close codes after which reconnecting cannot help. */
const FINAL_CLOSE_CODES = new Set([4000, 4003, 4004])
const MAX_RECONNECTS = 5

/**
 * One interactive shell. Output frames come in pairs: a JSON header with the
 * output's end position, then the bytes. Reconnecting sends that position
 * back, so nothing is shown twice or lost.
 */
export class RemoteShellConnection {
	private socket: ShellSocket | undefined
	private cursor = 0
	private nextEnd: number | undefined
	private decoder = new TextDecoder()
	private closedByUs = false
	private failures = 0
	private renewTimer: unknown
	private size: { cols: number; rows: number } | undefined
	private pendingInput: string[] = []
	private readonly setTimer: (callback: () => void, ms: number) => unknown
	private readonly clearTimer: (handle: unknown) => void
	private readonly now: () => number

	constructor(private readonly options: RemoteShellOptions) {
		this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
		this.now = options.now ?? (() => Date.now() / 1000)
	}

	async connect(): Promise<void> {
		const { token, expiresAt } = await this.options.getToken()
		if (this.closedByUs) return
		const socket = this.options.openSocket(this.options.url)
		socket.binaryType = "arraybuffer"
		this.socket = socket
		let opened = false
		socket.onopen = () => {
			opened = true
			socket.send(JSON.stringify({ type: "auth", token, resume: true, cursor: this.cursor }))
			if (this.size) socket.send(JSON.stringify({ type: "resize", ...this.size }))
			for (const text of this.pendingInput.splice(0)) socket.send(new TextEncoder().encode(text))
			this.scheduleRenew(expiresAt)
		}
		socket.onmessage = (event) => this.receive(event.data)
		socket.onerror = () => {}
		socket.onclose = (event) => {
			if (this.socket !== socket) return
			this.socket = undefined
			this.clearTimer(this.renewTimer)
			if (this.closedByUs) return
			if (FINAL_CLOSE_CODES.has(event.code)) {
				this.options.onEnded(event.reason || `closed (${event.code})`)
				return
			}
			if (event.code === 4001) {
				// The token was refused: a fresh one may do.
				this.failures += 1
			} else if (!opened) {
				this.failures += 1
			} else {
				this.failures = 0
			}
			if (this.failures > MAX_RECONNECTS) {
				this.options.onEnded(event.reason || `could not reconnect (${event.code})`)
				return
			}
			this.options.onNotice(`reconnecting${event.reason ? ` (${event.reason})` : ""}`)
			this.setTimer(
				() => {
					this.connect().catch((error) => this.options.onEnded(error instanceof Error ? error.message : String(error)))
				},
				Math.min(500 * 2 ** this.failures, 8000),
			)
		}
	}

	/** Sign in again before the token runs out, and resume from the same place. */
	private scheduleRenew(expiresAt: number) {
		this.clearTimer(this.renewTimer)
		const margin = this.options.refreshMarginSeconds ?? 60
		const seconds = Math.max(5, expiresAt - margin - this.now())
		this.renewTimer = this.setTimer(() => this.renew(), seconds * 1000)
	}

	private renew() {
		const old = this.socket
		if (!old || this.closedByUs) return
		// Detach first, so the old socket's close does not count as a drop.
		this.socket = undefined
		old.onclose = null
		old.onmessage = null
		old.close(1000, "token renewal")
		this.connect().catch((error) => this.options.onEnded(error instanceof Error ? error.message : String(error)))
	}

	private receive(data: unknown) {
		if (typeof data === "string") {
			let message: { type?: string; end?: unknown; start?: unknown; truncated?: unknown }
			try {
				message = JSON.parse(data)
			} catch {
				return
			}
			if (message.type === "output" && typeof message.end === "number") {
				this.nextEnd = message.end
				if (message.truncated === true) this.options.onNotice("some earlier output was dropped")
			}
			return
		}
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: ArrayBuffer.isView(data)
					? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
					: undefined
		if (!bytes) return
		if (this.nextEnd !== undefined) {
			this.cursor = this.nextEnd
			this.nextEnd = undefined
		} else {
			this.cursor += bytes.length
		}
		const text = this.decoder.decode(bytes, { stream: true })
		if (text) this.options.onOutput(text)
	}

	/** Keystrokes. Typed while reconnecting, they wait for the new connection. */
	input(text: string) {
		if (this.socket && this.socket.readyState === 1) this.socket.send(new TextEncoder().encode(text))
		else this.pendingInput.push(text)
	}

	resize(cols: number, rows: number) {
		this.size = { cols, rows }
		if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify({ type: "resize", cols, rows }))
	}

	close() {
		this.closedByUs = true
		this.clearTimer(this.renewTimer)
		const socket = this.socket
		this.socket = undefined
		socket?.close(1000, "closed")
	}
}
